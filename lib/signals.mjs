/**
 * Posting freshness and stable identity for buyer signals.
 *
 * Freshness is judged from the posting date the source reports, never from the
 * time we happened to collect it. A missing or unparseable date is "unknown"
 * and needs review; it is never replaced with an invented fresh date.
 */

/** Default posting-age cutoff in days. Override per run with `--max-age-days N`. */
export const DEFAULT_MAX_AGE_DAYS = 30;

const DAY_MS = 86_400_000;
// Plausibility window: anything outside it is a malformed date, not a real posting.
const MIN_YEAR = 2000;
const FUTURE_SLACK_MS = 2 * DAY_MS;

/**
 * Parse a source posting date. Accepts ISO/RFC strings and Unix epoch seconds or
 * milliseconds (numbers or digit strings). Returns an ISO string, or null when the
 * value is missing, malformed or implausible.
 */
export function parsePostedAt(value, now = new Date()) {
  if (value === null || value === undefined || value === '') return null;
  let ms;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{9,13}$/.test(value.trim()))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    ms = n < 1e11 ? n * 1000 : n; // seconds vs milliseconds
  } else if (typeof value === 'string') {
    // Require something date-shaped; Date.parse alone accepts odd inputs like "1".
    if (!/\d{4}-\d{2}-\d{2}|\b\d{1,2} \w{3,9} \d{4}\b|\w{3}, \d{1,2} \w{3} \d{4}/.test(value)) return null;
    ms = Date.parse(value);
  } else return null;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (d.getUTCFullYear() < MIN_YEAR || ms > now.getTime() + FUTURE_SLACK_MS) return null;
  return d.toISOString();
}

/** Classify a posting by age relative to `now` (the collection clock). */
export function freshness(postedAt, now = new Date(), maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  if (!postedAt) return { freshness: 'unknown', ageDays: null, reason: 'posting date missing or invalid; review before use' };
  const ageDays = Math.max(0, Math.floor((now.getTime() - Date.parse(postedAt)) / DAY_MS));
  if (ageDays > maxAgeDays) return { freshness: 'stale', ageDays, reason: `posted ${ageDays} days ago (cutoff ${maxAgeDays})` };
  return { freshness: 'fresh', ageDays, reason: null };
}

/** The opaque job ID inside a jobs.workable.com/view/<id>/<slug> URL. */
export function workableViewId(url) {
  return String(url ?? '').match(/^https?:\/\/jobs\.workable\.com\/view\/([A-Za-z0-9]+)(?:[/?#]|$)/)?.[1] ?? null;
}

export function normalizeWebsite(value) {
  return String(value ?? '').trim().replace(/^https?:\/\/(www\.)?/i, '').replace(/[/?#].*$/, '').toLowerCase();
}

/**
 * Collapse repeated observations of one job (e.g. the same posting returned by
 * several queries) by stable identity. Jobs with distinct identities stay
 * distinct even when their titles match. Query hits are merged into `queries`.
 */
export function dedupeByIdentity(rows) {
  const byId = new Map();
  for (const row of rows) {
    const key = row.jobId;
    if (!key) throw new Error('Signal row is missing a stable jobId');
    const prev = byId.get(key);
    if (!prev) { byId.set(key, { ...row, queries: [...(row.queries ?? [])] }); continue; }
    for (const q of row.queries ?? []) if (!prev.queries.includes(q)) prev.queries.push(q);
  }
  return [...byId.values()];
}

const REGION_WORDS = [
  'remote', 'hybrid', 'onsite', 'on-site', 'global', 'worldwide', 'international',
  'emea', 'apac', 'latam', 'mena', 'dach', 'nordics', 'benelux', 'cee',
  'europe', 'eu', 'uk', 'us', 'usa', 'na', 'africa', 'asia', 'americas', 'north america', 'south america', 'latin america', 'middle east',
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * A key for recognizing regional copies of one opening: same company and the
 * same title once location/region qualifiers are removed. This is only used to
 * stop copies inflating priority; copies remain separate rows with their own
 * evidence, and description fingerprints split a group whose duties differ.
 */
export function openingKey(row) {
  let title = String(row.title ?? '').toLowerCase();
  const places = String(row.location ?? '').toLowerCase().split(/\s*,\s*/).filter(p => p.length > 1);
  for (const word of [...places, ...REGION_WORDS].sort((a, b) => b.length - a.length)) {
    title = title.replace(new RegExp(`(^|[^a-z])${escapeRe(word)}(?=$|[^a-z])`, 'g'), '$1');
  }
  title = title.replace(/[()[\]|/\\,–—-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${String(row.company ?? '').toLowerCase().trim()}::${normalizeWebsite(row.website)}::${title}`;
}

/** Assign `opening` group keys, splitting groups whose fetched descriptions differ. */
export function assignOpenings(rows) {
  for (const row of rows) {
    const base = openingKey(row);
    const fp = row.qualification?.description?.fingerprint;
    row.opening = base;
    row._fp = fp ?? null;
  }
  // Within a title group, distinct description fingerprints are distinct openings.
  const groups = new Map();
  for (const row of rows) (groups.get(row.opening) ?? groups.set(row.opening, []).get(row.opening)).push(row);
  for (const [key, members] of groups) {
    const fps = [...new Set(members.map(m => m._fp).filter(Boolean))];
    if (fps.length > 1) for (const m of members) if (m._fp) m.opening = `${key}#${m._fp.slice(0, 12)}`;
  }
  for (const row of rows) delete row._fp;
  return rows;
}
