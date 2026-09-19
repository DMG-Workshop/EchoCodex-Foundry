/**
 * Schema shaping for the three structuring providers. They agree on JSON Schema
 * only in outline: Anthropic and OpenAI take the strict-mode subset the
 * NoteDocument schema is already written in, while Gemini takes an OpenAPI
 * dialect that rejects `$ref`, `additionalProperties` and type unions outright.
 */

/** Resolves $ref/$defs into a self-contained schema — provider strict modes vary in $ref support. */
export function inlineRefs(node, defs) {
  if (Array.isArray(node)) return node.map(n => inlineRefs(n, defs));
  if (!node || typeof node !== 'object') return node;

  if (typeof node.$ref === 'string') {
    const name = node.$ref.replace('#/$defs/', '');
    const target = defs[name];
    if (!target) throw new Error(`Unresolved schema reference: ${node.$ref}`);
    return inlineRefs(target, defs);
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$defs') continue;
    out[key] = inlineRefs(value, defs);
  }
  return out;
}

const GEMINI_KEYS = new Set([
  'type', 'format', 'description', 'nullable', 'enum',
  'items', 'properties', 'required', 'propertyOrdering'
]);

/**
 * JSON Schema -> Gemini's `responseSchema` dialect.
 *
 * Three incompatibilities, all load-bearing: type names are proto enum names
 * (STRING, not string), optionality is `nullable: true` rather than a
 * ["string", "null"] union, and any unknown keyword — `additionalProperties`
 * above all — is a hard rejection rather than an ignored hint.
 */
export function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== 'object') return node;

  const out = {};
  let nullable = false;

  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') {
      const types = Array.isArray(value) ? value : [value];
      const concrete = types.filter(t => t !== 'null');
      if (types.length !== concrete.length) nullable = true;
      // A union of two real types has no Gemini equivalent; the NoteDocument
      // schema never uses one, so the first is the honest answer rather than a
      // silent widening.
      out.type = String(concrete[0] ?? 'string').toUpperCase();
      continue;
    }
    if (!GEMINI_KEYS.has(key)) continue;

    if (key === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, toGeminiSchema(schema)])
      );
    } else if (key === 'items') {
      out.items = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }

  if (nullable) out.nullable = true;
  return out;
}
