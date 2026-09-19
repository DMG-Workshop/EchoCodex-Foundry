/**
 * The campaign's proper nouns, assembled once and spent on both pipeline stages.
 *
 * Invented names are what transcription gets wrong most often, and a misheard
 * name is not a cosmetic problem: "Ser Aldric" heard as "sir all drick" becomes
 * a new character in the journal. Foundry already knows the real names — the
 * actor directory is the cast list — and the GM can add the rest. Feeding them
 * to the transcriber biases recognition before the error happens; feeding them
 * to the structuring model lets it correct what still slipped through.
 */

const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 40;

/** Default cap on how many names reach the structuring prompt. */
export const DEFAULT_TERM_LIMIT = 200;

/**
 * Whisper's prompt is capped at 224 tokens and silently truncated past it.
 * ~700 characters keeps a comma-separated list comfortably inside that, so the
 * names we chose to send are the names that arrive.
 */
export const WHISPER_PROMPT_MAX_CHARS = 700;

/** Splits a GM-typed list on the separators people actually use. */
export function parseTermList(raw) {
  return String(raw ?? '')
    .split(/[\n,;]+/)
    .map(term => term.trim())
    .filter(Boolean);
}

function normalizeTerm(term) {
  const clean = String(term ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length < MIN_TERM_LENGTH || clean.length > MAX_TERM_LENGTH) return null;
  // A term with no letters ("3", "???") biases nothing and wastes the budget.
  if (!/\p{L}/u.test(clean)) return null;
  return clean;
}

/**
 * Merges the name sources into one ordered, deduplicated list.
 *
 * Order is priority order, because both consumers are budget-limited and drop
 * from the end: the GM's own glossary first (explicit intent), then the names
 * most likely to be spoken aloud — the party, then whoever is on the current
 * scene — and only then the rest of the actor directory, which in a mature
 * world is mostly monsters nobody names out loud.
 */
export function collectVocabulary({
  glossary = [],
  playerCharacters = [],
  sceneActors = [],
  otherActors = []
} = {}, { limit = DEFAULT_TERM_LIMIT } = {}) {
  const seen = new Set();
  const terms = [];

  for (const raw of [...glossary, ...playerCharacters, ...sceneActors, ...otherActors]) {
    if (terms.length >= limit) break;
    const term = normalizeTerm(raw);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }

  return terms;
}

/** Stage 1: the biasing prompt handed to Whisper, trimmed to fit its budget. */
export function buildWhisperPrompt(terms, { maxChars = WHISPER_PROMPT_MAX_CHARS } = {}) {
  if (!terms?.length) return '';

  const lead = 'Proper nouns spoken in this recording: ';
  const budget = maxChars - lead.length - 1; // the trailing full stop
  const kept = [];
  let used = 0;

  for (const term of terms) {
    const cost = term.length + (kept.length ? 2 : 0); // ", "
    if (used + cost > budget) break;
    kept.push(term);
    used += cost;
  }

  return kept.length ? `${lead}${kept.join(', ')}.` : '';
}

/** Stage 2: the section spliced into the structuring system prompt. */
export function renderVocabularySection(terms) {
  if (!terms?.length) return '';
  return `

KNOWN NAMES
These are the campaign's real spellings, from the world's actor directory and the
GM's glossary:
${terms.join(', ')}.

When a transcript span is plainly one of these misheard, use the spelling above and
record the heard form in that participant's \`aliases\`. Do not force a match: a name
that is not on this list is not evidence of an error, and inventing a correction is
worse than leaving the transcript's own wording alone.`;
}
