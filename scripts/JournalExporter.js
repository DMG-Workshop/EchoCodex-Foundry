import { groupRows, formatRow, GROUPS } from './curationModel.js';
import { escapeHtml } from './html.js';

const MODULE_ID = 'echo-codex-notes';

/**
 * Curated rows -> Journal Entries, in the same page shape the JSON importer
 * produces (Summary / narrative / campaign actions), plus the GM/player split.
 */
export async function exportToJournals({ doc, meta, rows }) {
  const separate = game.settings.get(MODULE_ID, 'separateGMNotes');
  const dateLabel = new Date(meta.startTime).toLocaleDateString();
  const title = doc?.meta?.title || meta.sceneName || 'Session';
  const folder = await getOrCreateFolder(meta.campaignName);

  if (!separate) {
    const journal = await createJournal({
      name: `${title} — ${dateLabel}`,
      doc, meta, rows, folder, gmOnly: false
    });
    return { gmJournal: journal, playerJournal: null };
  }

  const gmJournal = await createJournal({
    name: `${title} — ${dateLabel} (GM Notes)`,
    doc, meta, rows, folder, gmOnly: true
  });

  const playerRows = rows.filter(r => !r.gmOnly);
  const playerJournal = playerRows.length
    ? await createJournal({
        name: `${title} — ${dateLabel}`,
        doc, meta, rows: playerRows, folder, gmOnly: false
      })
    : null;

  return { gmJournal, playerJournal };
}

async function getOrCreateFolder(campaignName) {
  const name = `Echo Codex — ${campaignName}`;
  const existing = game.folders.find(f => f.type === 'JournalEntry' && f.name === name);
  if (existing) return existing;
  try {
    return await Folder.create({ name, type: 'JournalEntry' });
  } catch (error) {
    // Filing is a convenience; losing it is not a reason to lose the notes.
    console.warn(`${MODULE_ID} | Could not create the journal folder`, error);
    return null;
  }
}

async function createJournal({ name, doc, meta, rows, folder, gmOnly }) {
  const ownership = {
    default: gmOnly
      ? CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE
      : CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER
  };

  const journal = await JournalEntry.create({
    name,
    folder: folder?.id ?? null,
    ownership,
    flags: { [MODULE_ID]: { source: 'Echo Codex', gmOnly, recordedAt: meta.startTime } }
  });

  const pages = buildPages({ doc, meta, rows, gmOnly });
  if (pages.length) await journal.createEmbeddedDocuments('JournalEntryPage', pages);
  return journal;
}

export function buildPages({ doc, meta, rows, gmOnly }) {
  const pages = [];
  const page = (pageName, content) => pages.push({
    name: pageName,
    type: 'text',
    sort: (pages.length + 1) * 100,
    text: { format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML, content }
  });

  const summary = doc?.meta?.summary;
  const players = (meta.players ?? []).join(', ');
  page('Summary', [
    summary ? `<p>${escapeHtml(summary)}</p>` : '',
    `<p><em>${escapeHtml(meta.sceneName)} — ${escapeHtml(new Date(meta.startTime).toLocaleString())}</em></p>`,
    players ? `<p><strong>Players:</strong> ${escapeHtml(players)}</p>` : ''
  ].filter(Boolean).join('\n'));

  const narrative = rows.filter(r => r.kind === 'section');
  if (narrative.length) {
    const body = groupRows(narrative)
      .map(group => `<h2>${escapeHtml(group.label)}</h2>\n${list(group.rows, gmOnly)}`)
      .join('\n');
    page('Notes', body);
  }

  const actionKinds = ['decision', 'task', 'openQuestion'];
  const actions = rows.filter(r => actionKinds.includes(r.kind));
  if (actions.length) {
    const body = groupRows(actions)
      .map(group => `<h2>${escapeHtml(GROUPS[group.kind])}</h2>\n${list(group.rows, gmOnly)}`)
      .join('\n');
    page('Campaign actions', body);
  }

  const asides = rows.filter(r => r.kind === 'risk' || r.kind === 'timelineAnchor');
  if (asides.length) {
    const body = groupRows(asides)
      .map(group => `<h2>${escapeHtml(GROUPS[group.kind])}</h2>\n${list(group.rows, gmOnly)}`)
      .join('\n');
    page('Threats & dates', body);
  }

  return pages;
}

function list(rows, gmOnly) {
  const items = rows.map(row => {
    // The tag only appears on the GM copy; the player copy never contains these rows.
    const tag = gmOnly && row.gmOnly ? ' <span class="echo-codex-gm-tag">(GM)</span>' : '';
    const quote = row.sourceRef?.quote
      ? `<br><span class="echo-codex-quote">“${escapeHtml(row.sourceRef.quote)}”</span>`
      : '';
    return `<li>${escapeHtml(formatRow(row))}${tag}${quote}</li>`;
  }).join('\n');
  return `<ul>${items}</ul>`;
}
