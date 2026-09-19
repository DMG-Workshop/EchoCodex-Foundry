import { escapeHtml } from './html.js';

/**
 * Turns names the world already knows into Foundry links.
 *
 * A journal of flat text is a dead end; the same journal with the party and the
 * NPCs linked is navigable. Matching is deliberately conservative — whole words,
 * longest name first, one link per entity per line — because a journal riddled
 * with links to the wrong goblin is worse than plain text.
 */

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const MIN_NAME_LENGTH = 3;

const escapeRegExp = (value) => value.replace(ESCAPE_RE, '\\$&');

/**
 * `\b` is defined against word characters, so a name ending in a bracket or a
 * full stop has no boundary after it and would never match. The guard is only
 * applied on the side where it means something.
 */
function bounded(name) {
  const body = escapeRegExp(name);
  const lead = /^\w/.test(name) ? '\\b' : '';
  const tail = /\w$/.test(name) ? '\\b' : '';
  return `${lead}${body}${tail}`;
}

/** Builds the lookup once per export rather than once per row. */
export function buildLinkIndex(entities = []) {
  const seen = new Set();
  return (entities ?? [])
    .filter(entity => entity?.name && entity?.uuid && entity.name.length >= MIN_NAME_LENGTH)
    .filter(entity => {
      const key = entity.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // Longest first: regex alternation takes the first branch that matches, so
    // this is what makes "Ser Aldric the Grey" win over "Ser Aldric".
    .sort((a, b) => b.name.length - a.name.length)
    .map(entity => ({ name: entity.name, uuid: entity.uuid }));
}

/**
 * Links names inside already-escaped HTML.
 *
 * Takes escaped input on purpose: linking before escaping would let the escaper
 * mangle the markup it had just produced, and linking raw text would mean
 * re-escaping around it.
 *
 * One pass over the string, never a pass per name. Replacing name by name meant
 * a later, shorter name matching inside a link an earlier one had just written
 * — the exact failure "longest wins" is supposed to prevent.
 */
export function linkEntities(escapedHtml, index) {
  if (!index?.length) return escapedHtml;

  const pattern = new RegExp(index.map(entry => bounded(entry.name)).join('|'), 'gi');
  const byName = new Map(index.map(entry => [entry.name.toLowerCase(), entry.uuid]));
  const linked = new Set();

  return String(escapedHtml).replace(pattern, (match) => {
    const uuid = byName.get(match.toLowerCase());
    // A repeat mention reads as noise, so only the first becomes a link.
    if (!uuid || linked.has(uuid)) return match;
    linked.add(uuid);
    return `@UUID[${uuid}]{${escapeHtml(match)}}`;
  });
}
