import test from 'node:test';
import assert from 'node:assert/strict';

// buildPages reads Foundry's CONST for the page format enum; nothing else in it
// touches the global game state.
globalThis.CONST = {
  JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1, MARKDOWN: 2 },
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2 }
};

const { buildPages } = await import('../scripts/JournalExporter.js');

const meta = {
  campaignName: 'Redbridge',
  sceneName: 'The toll road',
  players: ['Mira', 'Tolen'],
  startTime: '2026-04-01T18:00:00.000Z'
};
const doc = { meta: { title: 'Ambush at Redbridge', summary: 'They took the toll road.' } };

const row = (over) => ({ id: 'r0', kind: 'section', heading: 'Ambush', text: 'A thing happened.', gmOnly: false, sourceRef: null, ...over });

const pageNamed = (pages, name) => pages.find(p => p.name === name);

test('a summary page is always produced', () => {
  const pages = buildPages({ doc, meta, rows: [], gmOnly: false });
  assert.deepEqual(pages.map(p => p.name), ['Summary']);
  assert.match(pages[0].text.content, /They took the toll road\./);
  assert.match(pages[0].text.content, /Mira, Tolen/);
});

test('pages appear only for the kinds that have rows', () => {
  const pages = buildPages({
    doc, meta, gmOnly: false,
    rows: [row({}), row({ id: 'r1', kind: 'task', text: 'Return the seal', dueDate: null })]
  });
  assert.deepEqual(pages.map(p => p.name), ['Summary', 'Notes', 'Campaign actions']);
  assert.equal(pageNamed(pages, 'Threats & dates'), undefined);
});

test('risks and timeline anchors share the asides page', () => {
  const pages = buildPages({
    doc, meta, gmOnly: true,
    rows: [
      row({ id: 'r1', kind: 'risk', text: 'The baron knows', severity: 'high' }),
      row({ id: 'r2', kind: 'timelineAnchor', text: 'Festival', date: '2026-05-01' })
    ]
  });
  const asides = pageNamed(pages, 'Threats & dates');
  assert.match(asides.text.content, /The baron knows \(high\)/);
  assert.match(asides.text.content, /2026-05-01 — Festival/);
});

test('pages sort in the order they were built', () => {
  const pages = buildPages({ doc, meta, gmOnly: false, rows: [row({})] });
  assert.deepEqual(pages.map(p => p.sort), [100, 200]);
  assert.ok(pages.every(p => p.text.format === CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML));
});

test('row text is escaped, so a player name cannot inject markup', () => {
  const pages = buildPages({
    doc, meta, gmOnly: false,
    rows: [row({ text: '<script>alert(1)</script> & "quoted"' })]
  });
  const notes = pageNamed(pages, 'Notes').text.content;
  assert.ok(!notes.includes('<script>'), 'raw markup must not survive into the journal');
  assert.match(notes, /&lt;script&gt;/);
  assert.match(notes, /&amp; &quot;quoted&quot;/);
});

test('a summary is escaped too', () => {
  const pages = buildPages({
    doc: { meta: { summary: '<img onerror=x>' } }, meta, gmOnly: false, rows: []
  });
  assert.ok(!pages[0].text.content.includes('<img'));
});

test('the GM tag marks hidden rows on the GM copy only', () => {
  const rows = [row({ gmOnly: true, text: 'The baron is the traitor' })];
  const gm = pageNamed(buildPages({ doc, meta, rows, gmOnly: true }), 'Notes').text.content;
  const shared = pageNamed(buildPages({ doc, meta, rows, gmOnly: false }), 'Notes').text.content;
  assert.match(gm, /echo-codex-gm-tag/);
  assert.ok(!shared.includes('echo-codex-gm-tag'));
});

test('a source quote is rendered under its row when present', () => {
  const pages = buildPages({
    doc, meta, gmOnly: false,
    rows: [row({ sourceRef: { quote: 'we take the river' } })]
  });
  assert.match(pageNamed(pages, 'Notes').text.content, /echo-codex-quote/);
});

test('section rows group under their own headings', () => {
  const pages = buildPages({
    doc, meta, gmOnly: false,
    rows: [row({ heading: 'Ambush' }), row({ id: 'r1', heading: 'Aftermath' })]
  });
  const notes = pageNamed(pages, 'Notes').text.content;
  assert.match(notes, /<h2>Ambush<\/h2>/);
  assert.match(notes, /<h2>Aftermath<\/h2>/);
});
