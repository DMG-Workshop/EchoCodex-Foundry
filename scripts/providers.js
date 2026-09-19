import { NOTE_DOCUMENT_SCHEMA } from './noteDocumentSchema.js';
import { inlineRefs, toGeminiSchema } from './schemaTools.js';
import { buildClipPrompt, renderVocabularySection } from './vocabulary.js';
import { renderSessionLog } from './sessionLog.js';
import { renderPreviousSession } from './campaignHistory.js';
import {
  extensionFor,
  offsetSegments,
  parseNoteDocument,
  renderTranscript
} from './transcript.js';

const MODULE_ID = 'echo-codex-notes';

const setting = (key) => game.settings.get(MODULE_ID, key);
const trimUrl = (url) => String(url || '').replace(/\/+$/, '');

const FLAT_SCHEMA = inlineRefs(NOTE_DOCUMENT_SCHEMA, NOTE_DOCUMENT_SCHEMA.$defs || {});
const GEMINI_SCHEMA = toGeminiSchema(FLAT_SCHEMA);

/** api.openai.com caps uploads at 25 MB; local servers generally do not. */
export const OPENAI_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

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
 * Audio clips -> transcript segments on one continuous timeline.
 *
 * A session arrives as a list of `{ blob, offsetMs }` clips rather than one
 * file: the recorder rotates every few minutes so no single upload approaches
 * the 25 MB limit, and each clip's segments are shifted back onto the session
 * clock here. The OpenAI path is also the local path — any OpenAI-compatible
 * server (whisper.cpp's server, LM Studio) works by pointing the base URL at
 * it, which is how a table records without a cloud key.
 */
export async function transcribeClip(clip, { vocabulary = [], previousTail = '' } = {}) {
  const provider = setting('sttProvider');
  const options = {
    prompt: buildClipPrompt({ vocabulary, previousTail }),
    language: String(setting('sttLanguage') || '').trim()
  };
  return provider === 'gemini'
    ? transcribeGemini(clip.blob, options)
    : transcribeOpenAiCompatible(clip.blob, options);
}

export async function transcribe(clips, { onProgress, vocabulary = [] } = {}) {
  const provider = setting('sttProvider');
  const list = normalizeClips(clips);
  const segments = [];

  // Every clip gets the same biasing prompt: a name is no less likely to be
  // spoken in hour three than in hour one.
  let previousTail = '';

  for (const [index, clip] of list.entries()) {
    onProgress?.(list.length > 1
      ? `Transcribing part ${index + 1} of ${list.length}…`
      : 'Transcribing audio…');

    const options = {
      prompt: buildClipPrompt({ vocabulary, previousTail }),
      language: String(setting('sttLanguage') || '').trim()
    };
    const runClip = () => (provider === 'gemini'
      ? transcribeGemini(clip.blob, options)
      : transcribeOpenAiCompatible(clip.blob, options));

    // A long session is twenty-odd sequential uploads; one blip on clip seven
    // should not cost the other nineteen. A second failure is real and stops
    // the run, which still hands the GM every clip to retry by hand.
    let part;
    try {
      part = await runClip();
    } catch (error) {
      console.warn(`${MODULE_ID} | Clip ${index + 1} failed, retrying once`, error);
      onProgress?.(`Retrying part ${index + 1} of ${list.length}…`);
      try {
        part = await runClip();
      } catch (retryError) {
        throw new Error(`Part ${index + 1} of ${list.length} failed: ${retryError.message}`);
      }
    }

    segments.push(...offsetSegments(part, clip.offsetMs ?? 0));
    previousTail = part.map(p => p.text ?? '').join(' ').trim().slice(-220);
  }

  return segments;
}

function normalizeClips(clips) {
  const list = Array.isArray(clips) ? clips : [{ blob: clips, offsetMs: 0 }];
  return list.filter(clip => clip?.blob && clip.blob.size > 0);
}

async function transcribeOpenAiCompatible(audioBlob, { prompt, language } = {}) {
  const baseUrl = trimUrl(setting('sttBaseUrl')) || 'https://api.openai.com';
  const apiKey = setting('sttApiKey');
  const model = setting('sttModel') || 'whisper-1';

  // Clip rotation keeps uploads under this, but a GM who set the clip length
  // very high deserves the specific error rather than a 413 from the provider.
  if (audioBlob.size > OPENAI_UPLOAD_LIMIT_BYTES) {
    throw new Error(
      `A recording clip is ${(audioBlob.size / 1048576).toFixed(1)} MB; the transcription limit is 25 MB. ` +
      `Lower "Clip length" in the module settings, or point the base URL at a local server without that limit.`
    );
  }

  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('file', audioBlob, `session.${extensionFor(audioBlob)}`);
  // Whisper biases decoding toward words in the prompt, which is the only
  // chance to get an invented name right before it becomes a transcript error.
  if (prompt) form.append('prompt', prompt);
  // Left blank Whisper detects per clip, and a quiet clip can be detected as a
  // different language than the rest of the session.
  if (language) form.append('language', language);

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

async function transcribeGemini(audioBlob, { prompt } = {}) {
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
            {
              text: [
                'Transcribe this audio verbatim. Return only the transcript text.',
                prompt
              ].filter(Boolean).join(' ')
            },
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

  let raw;
  if (provider === 'anthropic') raw = await structureAnthropic(system, user);
  else if (provider === 'gemini') raw = await structureGemini(system, user);
  else raw = await structureOpenAiCompatible(system, user);

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
  // A truncated response is still valid HTTP; it only fails at JSON.parse, by
  // which point the cause is unrecoverable from the error.
  if (data.stop_reason === 'max_tokens') {
    throw new Error('The notes were cut off at the model\'s output limit. Record shorter sessions.');
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
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error('The notes were cut off at the model\'s output limit. Record shorter sessions.');
  }
  return choice?.message?.content ?? '';
}

async function structureGemini(system, user) {
  const apiKey = setting('structureApiKey');
  if (!apiKey) throw new Error('Gemini structuring needs an API key.');
  const model = setting('structureModel') || 'gemini-2.5-pro';
  const base = trimUrl(setting('structureBaseUrl')) || 'https://generativelanguage.googleapis.com';

  const response = await fetch(
    `${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_SCHEMA,
          maxOutputTokens: 16000
        }
      })
    }
  );
  if (!response.ok) throw new Error(`Structuring failed (${response.status}): ${await readError(response)}`);

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  // MAX_TOKENS here means a truncated JSON object, which parses as a syntax
  // error three steps later; name the real cause instead.
  if (candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new Error(`The model stopped early (${candidate.finishReason}).`);
  }
  return candidate?.content?.parts?.map(p => p.text).join('') ?? '';
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
Return null for keyConcepts, flashcards and quiz — they are not used here.${renderVocabularySection(context.vocabulary)}${renderPreviousSession(context.previousSession)}${renderSessionLog(context.sessionLog)}`;
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the recording.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(blob);
  });
}
