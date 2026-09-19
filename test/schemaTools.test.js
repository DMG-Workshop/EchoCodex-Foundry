import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineRefs, toGeminiSchema } from '../scripts/schemaTools.js';
import { NOTE_DOCUMENT_SCHEMA } from '../scripts/noteDocumentSchema.js';

const FLAT = inlineRefs(NOTE_DOCUMENT_SCHEMA, NOTE_DOCUMENT_SCHEMA.$defs);

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach(n => walk(n, visit));
  if (!node || typeof node !== 'object') return;
  visit(node);
  Object.values(node).forEach(v => walk(v, visit));
}

test('inlineRefs resolves every $ref in the real schema', () => {
  walk(FLAT, node => assert.ok(!('$ref' in node), 'no $ref may survive inlining'));
  assert.ok(!('$defs' in FLAT));
});

test('inlined sourceRefs keep their own properties', () => {
  const taskRef = FLAT.properties.tasks.items.properties.sourceRef;
  assert.deepEqual(Object.keys(taskRef.properties).sort(), ['endMs', 'quote', 'startMs']);
});

test('inlineRefs throws on a reference it cannot resolve', () => {
  assert.throws(
    () => inlineRefs({ a: { $ref: '#/$defs/missing' } }, {}),
    /Unresolved schema reference/
  );
});

test('the strict-mode contract holds: every property is required', () => {
  walk(FLAT, node => {
    if (node.type !== 'object' || !node.properties) return;
    assert.deepEqual(
      Object.keys(node.properties).sort(),
      [...(node.required ?? [])].sort(),
      'OpenAI strict mode rejects an object whose required list is not exhaustive'
    );
  });
});

test('toGeminiSchema strips keywords Gemini rejects', () => {
  const gemini = toGeminiSchema(FLAT);
  walk(gemini, node => {
    assert.ok(!('additionalProperties' in node), 'Gemini rejects additionalProperties');
    assert.ok(!('$ref' in node));
    assert.ok(!('$defs' in node));
  });
});

test('toGeminiSchema uppercases every type to the proto enum name', () => {
  const gemini = toGeminiSchema(FLAT);
  walk(gemini, node => {
    if (!('type' in node)) return;
    assert.equal(typeof node.type, 'string');
    assert.equal(node.type, node.type.toUpperCase());
  });
});

test('toGeminiSchema converts a ["string","null"] union to nullable', () => {
  const converted = toGeminiSchema({ type: ['string', 'null'], description: 'maybe' });
  assert.deepEqual(converted, { type: 'STRING', description: 'maybe', nullable: true });
});

test('a non-nullable field gets no nullable flag', () => {
  assert.deepEqual(toGeminiSchema({ type: 'string' }), { type: 'STRING' });
});

test('toGeminiSchema keeps enums, required lists and nested items', () => {
  const converted = toGeminiSchema({
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['severity'],
      properties: { severity: { type: 'string', enum: ['low', 'high'] } }
    }
  });
  assert.equal(converted.type, 'ARRAY');
  assert.deepEqual(converted.items.required, ['severity']);
  assert.deepEqual(converted.items.properties.severity, { type: 'STRING', enum: ['low', 'high'] });
});

test('the real schema converts with its nullable fields intact', () => {
  const gemini = toGeminiSchema(FLAT);
  assert.equal(gemini.properties.tasks.items.properties.dueDate.nullable, true);
  assert.equal(gemini.properties.tasks.items.properties.title.nullable, undefined);
  assert.equal(gemini.properties.meta.properties.recordingType.type, 'STRING');
  assert.ok(gemini.properties.meta.properties.recordingType.enum.includes('other'));
});

test('a nullable object keeps its own properties', () => {
  const estimate = toGeminiSchema(FLAT).properties.tasks.items.properties.estimate;
  assert.equal(estimate.type, 'OBJECT');
  assert.equal(estimate.nullable, true);
  assert.deepEqual(Object.keys(estimate.properties).sort(), ['unit', 'value']);
});
