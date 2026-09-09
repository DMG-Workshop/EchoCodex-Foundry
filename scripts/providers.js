import { NOTE_DOCUMENT_SCHEMA } from './noteDocumentSchema.js';

const MODULE_ID = 'echo-codex-notes';

const setting = (key) => game.settings.get(MODULE_ID, key);
const trimUrl = (url) => String(url || '').replace(/\/+$/, '');

/** Resolves $ref/$defs into a self-contained schema — provider strict modes vary in $ref support. */
function inlineRefs(node, defs) {
  if (Array.isArray(node)) return node.map(n => inlineRefs(n, defs));
  if (!node || typeof node !== 'object') return node;

  if (typeof node.$ref === 'string') {
    const name = node.$ref.replace('#/$defs/', '');
    return inlineRefs(defs[name], defs);
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$defs') continue;
    out[key] = inlineRefs(value, defs);
  }
  return out;
}

const FLAT_SCHEMA = inlineRefs(NOTE_DOCUMENT_SCHEMA, NOTE_DOCUMENT_SCHEMA.$defs || {});

async function readError(response) {
  try {
    const body = await response.json();
    return body?.error?.message || JSON.stringify(body).slice(0, 300);
  } catch {
    return response.statusText;
  }
}

/* ------------------------------------------------------------------ *
 * Stage 1 — transcription
 * ------------------------------------------------------------------ */

/**
 * Audio -> transcript segments. The OpenAI path is also the local path: any
 * OpenAI-compatible server (whisper.cpp's server, LM Studio) works by pointing
 * the base URL at it, which is how a table records without a cloud key.
 */
export async function transcribe(audioBlob, { onProgress } = {}) {
  const provider = setting('sttProvider');
  onProgress?.('Transcribing audio…');

  if (provider === 'gemini') return transcribeGemini(audioBlob);
  return transcribeOpenAiCompatible(audioBlob);
}

async function transcribeOpenAiCompatible(audioBlob) {
  const baseUrl = trimUrl(setting('sttBaseUrl')) || 'https://api.openai.com';
  const apiKey = setting('sttApiKey');
  const model = setting('sttModel') || 'whisper-1';

  const maxBytes = 25 * 1024 * 1024;
  if (audioBlob.size > maxBytes) {
    throw new Error(
      `Recording is ${(audioBlob.size / 1048576).toFixed(1)} MB; the transcription limit is 25 MB. ` +
      `Record shorter sessions, or point the base URL at a local server without that limit.`
    );
  }

  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('file', audioBlob, `session.${extensionFor(audioBlob)}`);

  const headers = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form
  });
  if (!response.ok) throw new Error(`Transcription failed (${response.status}): ${await readError(response)}`);

  const data = await response.json();
  if (!Array.isArray(data.segments)) {
    return [{ startMs: null, endMs: null, text: data.text ?? '' }];
  }
  return data.segments.map(s => ({
    startMs: Math.round((s.start ?? 0) * 1000),
    endMs: Math.round((s.end ?? 0) * 1000),
    text: s.text ?? ''
  }));
}

async function transcribeGemini(audioBlob) {
  const apiKey = setting('sttApiKey');
  if (!apiKey) throw new Error('Gemini transcription needs an API key.');
  const model = setting('sttModel') || 'gemini-2.0-flash';
  const base = trimUrl(setting('sttBaseUrl')) || 'https://generativelanguage.googleapis.com';

  const response = await fetch(
    `${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: 'Transcribe this audio verbatim. Return only the transcript text.' },
            { inline_data: { mime_type: audioBlob.type || 'audio/webm', data: await toBase64(audioBlob) } }
          ]
        }]
      })
    }
  );
  if (!response.ok) throw new Error(`Transcription failed (${response.status}): ${await readError(response)}`);

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
  // Gemini returns prose, not timed segments, so there is nothing to anchor sourceRefs to.
  return [{ startMs: null, endMs: null, text }];
}

/* ------------------------------------------------------------------ *
 * Stage 2 — structuring
 * ------------------------------------------------------------------ */

/** Transcript -> NoteDocument, using the same contract and rules as the mobile app. */
export async function structure(segments, context, { onProgress } = {}) {
  onProgress?.('Structuring notes…');
  const provider = setting('structureProvider');
  const transcript = renderTranscript(segments);
  const system = buildSystemPrompt(context);
  const user = `<transcript>\n${transcript}\n</transcript>`;

  const raw = provider === 'anthropic'
    ? await structureAnthropic(system, user)
    : await structureOpenAiCompatible(system, user);

  return parseNoteDocument(raw);
}

async function structureAnthropic(system, user) {
  const apiKey = setting('structureApiKey');
  if (!apiKey) throw new Error('Anthropic structuring needs an API key.');
  const model = setting('structureModel') || 'claude-opus-5';
  const base = trimUrl(setting('structureBaseUrl')) || 'https://api.anthropic.com';

  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Foundry runs in a browser; without this the API rejects the call outright.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema: FLAT_SCHEMA } }
    })
  });
  if (!response.ok) throw new Error(`Structuring failed (${response.status}): ${await readError(response)}`);

  const data = await response.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('The model declined to structure this recording.');
  }
  return data.content?.find(b => b.type === 'text')?.text ?? '';
}

async function structureOpenAiCompatible(system, user) {
  const apiKey = setting('structureApiKey');
  const model = setting('structureModel') || 'gpt-4o';
  const base = trimUrl(setting('structureBaseUrl')) || 'https://api.openai.com';

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'note_document', strict: true, schema: FLAT_SCHEMA }
      }
    })
  });
  if (!response.ok) throw new Error(`Structuring failed (${response.status}): ${await readError(response)}`);

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function parseNoteDocument(raw) {
  const text = String(raw || '').trim();
  // Local models ignore response_format often enough to be worth unwrapping fences.
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new Error('The model did not return valid JSON. Try a model with structured-output support.');
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.meta) {
    throw new Error('The model returned JSON that is not a NoteDocument.');
  }
  return parsed;
}

function renderTranscript(segments) {
  return segments.map(s => {
    if (s.startMs == null) return s.text.trim();
    return `[${formatTimestamp(s.startMs)}] ${s.text.trim()}`;
  }).join('\n');
}

function formatTimestamp(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * The app's production structuring prompt, plus the table context Foundry knows.
 * The anti-fabrication rules are the point of it — a game session invites
 * embellishment far more than a standup does.
 */
function buildSystemPrompt(context) {
  return `You convert a raw audio transcript into a structured note document.

CONTEXT
- Recording date: ${context.referenceDate} (${context.timeZone})
- Recording duration: ${context.durationHuman}
- Transcript source: ${context.sttProviderName}, diarization unavailable
- This is a tabletop roleplaying game session for the campaign "${context.campaignName}", scene "${context.sceneName}".
- Game master: ${context.gm}. Players present: ${context.players.join(', ') || 'unknown'}.

OUTPUT
Return a single JSON object conforming to the NoteDocument schema you have been given.
No prose, no markdown fences, no commentary.

THE ONE RULE THAT MATTERS
Extract only what is present in the transcript. You are a structurer, not an author.
If nothing was decided, return an empty decisions array. An empty array is a correct
answer. Inventing a plausible plot beat is the single worst failure mode here, because
a fabricated detail ends up in the campaign journal and becomes canon.

TABLETOP SPECIFICS
- Treat in-character events as the narrative body: sections[].heading should name the
  scene or beat ("Ambush at the Redbridge toll"), bullets the things that actually happened.
- Out-of-character table talk (rules arguments, snack runs, scheduling) is not the session.
  Keep it out of sections unless it changed the game.
- decisions are choices the party actually committed to, not options weighed aloud.
- tasks are what the party said they would do next — leads to follow, promises made to NPCs.
- openQuestions are mysteries the table left hanging.
- Set meta.recordingType to "other" and write meta.title as the session's own name.

PROVENANCE
Every task, decision, risk, open question, section, and timeline anchor carries a sourceRef
whose \`quote\` is a verbatim span copied character-for-character from the transcript. If you
cannot produce a real quote for an item, do not emit the item.

DATES
Set \`dateBasis\` honestly for every task: "explicit" when a date was spoken, "inferred" when
timing exists only as relative language, "absent" when no timing was discussed (both date
fields null). In-world time ("we ride at dawn") is not a real-world date — use "absent".

OWNERSHIP
Assign a task only when a player or character accepted it. Do not distribute unowned work
to whoever spoke last. Use participants[] for the people at the table.

TRANSCRIPT QUALITY
Transcripts contain STT errors, and invented fantasy names are hit hardest. Silently correct
obvious mishearings using surrounding context and record the misheard form in the
participant's \`aliases\`. If a passage is too garbled to interpret, omit it rather than
guessing, and set meta.extractionConfidence to "medium" or "low".

DEDUPLICATION
The same commitment restated three times is one task. Merge, and cite the clearest statement.

STUDY AIDS
Return null for keyConcepts, flashcards and quiz — they are not used here.`;
}

function extensionFor(blob) {
  const type = blob.type || '';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('wav')) return 'wav';
  return 'webm';
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the recording.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(blob);
  });
}
