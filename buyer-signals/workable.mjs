/**
 * Funnel 2 — Workable global job search.
 *
 * Unlike the ATS sweep this needs no slug enumeration: Workable exposes a
 * cross-company keyword search, and every hit carries the company's own website,
 * which removes the domain-guessing step that sent one draft to the wrong Kojo.
 *
 * Population skews SMB and Europe, so it surfaces the businesses that actually
 * employ people to do data entry, rather than venture-backed tech.
 *
 * Pipeline: search (title rules) -> dedupe by job identity -> posting-age filter
 * -> rank companies without counting regional copies of one opening.
 *
 * Run:  node workable.mjs [--pages N] [--max-age-days N] [--query Q ...]
 * Out:  workable_RUN.md + .json (+ .status.json, .evidence.json)
 */
import path from 'node:path';
import { classify } from '../lib/buyers.mjs';
import { exportPath, atomicWrite, integerOption, runStamp } from '../lib/runtime.mjs';
import { DEFAULT_MAX_AGE_DAYS, parsePostedAt, freshness, workableViewId, normalizeWebsite, dedupeByIdentity, assignOpenings } from '../lib/signals.mjs';
import { fileURLToPath } from 'node:url';

export const QUERIES = [
  'data entry', 'lead generation', 'list building', 'prospect research',
  'back office', 'data processing', 'order processing', 'invoice processing',
  'billing specialist', 'claims processing', 'sales development representative',
  'appointment setter', 'data annotation', 'document processing',
];
const SEARCH_TIMEOUT_MS = 25_000;
const PAGE_SIZE = 20;

/** Normalize one Workable search hit. Returns null when the title rules reject it. */
export function workableRow(job, { query, fetchedAt, now }) {
  const c = classify(job.title ?? '');
  if (!c) return null;
  const loc = job.location ?? {};
  const viewId = workableViewId(job.url);
  const sourceId = job.id ? String(job.id) : viewId;
  return {
    company: job.company?.title ?? '?',
    website: normalizeWebsite(job.company?.website),
    title: job.title,
    url: job.url,
    location: [loc.city, loc.countryName].filter(Boolean).join(', '),
    created: job.created ?? '',
    source: 'workable',
    sourceId: sourceId ?? null,
    viewId,
    jobId: `workable:${sourceId ?? job.url}`,
    postedAt: parsePostedAt(job.created, now),
    fetchedAt,
    queries: [query],
    ...c,
  };
}

/** Search every query. Search failures are collection errors (nonzero exit). */
export async function searchWorkable({ queries = QUERIES, pages = 6, fetcher = fetch, now = () => new Date(), sleep = ms => new Promise(r => setTimeout(r, ms)), delayMs = 400, log = () => {} } = {}) {
  const errors = [];
  const rows = [];
  let postings = 0;
  for (const q of queries) {
    let token = null, got = 0;
    for (let p = 0; p < pages; p++) {
      const url = `https://jobs.workable.com/api/v1/jobs?query=${encodeURIComponent(q)}&limit=${PAGE_SIZE}`
                + (token ? `&pageToken=${encodeURIComponent(token)}` : '');
      let d;
      const fetchedAt = now().toISOString();
      try {
        const r = await fetcher(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        d = await r.json();
        if (!d || !Array.isArray(d.jobs)) throw new Error('Unexpected Workable response');
      } catch (e) { errors.push({ query: q, page: p, error: e.message }); break; }
      if (!d.jobs.length) break;
      postings += d.jobs.length;
      for (const j of d.jobs) {
        const row = workableRow(j, { query: q, fetchedAt, now: now() });
        if (row) { rows.push(row); got++; }
      }
      token = d.nextPageToken;
      if (!token) break;
      await sleep(delayMs);
    }
    log(`  ${q.padEnd(34)} +${got}`);
    await sleep(delayMs);
  }
  return { rows, errors, postings };
}

/** Split identity-deduplicated rows by posting age. Stale rows are kept as excluded evidence. */
export function applyFreshness(rows, { now = new Date(), maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const kept = [], excluded = [];
  for (const row of rows) {
    const f = freshness(row.postedAt, now, maxAgeDays);
    const out = { ...row, freshness: f.freshness, ageDays: f.ageDays, ...(f.reason ? { freshnessReason: f.reason } : {}) };
    if (f.freshness === 'stale') excluded.push({ ...out, excludedReason: f.reason });
    else kept.push(out);
  }
  return { kept, excluded };
}

const FRESHNESS_RANK = { fresh: 0, unknown: 1, stale: 2 };
const roleOrder = (a, b) => (FRESHNESS_RANK[a.freshness] - FRESHNESS_RANK[b.freshness]) || (b.score - a.score)
  || String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? ''));

/**
 * One row per company, carrying its strongest role. Priority is the best role's
 * strength and freshness. Only distinct openings count, and only as a final
 * tie-break, so regional copies of one posting cannot buy priority.
 */
export function rankCompanies(rows) {
  assignOpenings(rows);
  const byCo = new Map();
  for (const r of rows) {
    if (!r.website) continue;
    const k = `${(r.company || '').toLowerCase()}::${r.website}`;
    (byCo.get(k) ?? byCo.set(k, []).get(k)).push(r);
  }
  const companies = [];
  for (const roles of byCo.values()) {
    roles.sort(roleOrder);
    const top = roles[0];
    const openings = new Set(roles.map(r => r.opening)).size;
    companies.push({ ...top, roles, openings, newestPostedAt: roles.map(r => r.postedAt).filter(Boolean).sort().at(-1) ?? null });
  }
  return companies.sort((a, b) => roleOrder(a, b) || (b.openings - a.openings) || a.company.localeCompare(b.company));
}

function describeRole(r) {
  const age = r.freshness === 'fresh' ? `posted ${r.ageDays}d ago` : r.freshnessReason;
  return `- ${r.title}${r.location ? ` · ${r.location}` : ''} · ${age}\n  ${r.url}`;
}

export function renderMarkdown({ day, companies, excluded, postings, matched, maxAgeDays }) {
  const lines = [`# Workable buyer signals — ${day}`,
    `${companies.length} companies with a website attached, from ${matched} distinct matching jobs (${postings} postings scanned).`,
    `Posting-age cutoff: ${maxAgeDays} days by posting date; ${excluded.length} jobs excluded (older than the cutoff or without a company website; see .evidence.json).`,
    `Company websites come straight from the API, so no domain guessing. Regional copies of one opening count once.\n`];
  for (const r of companies) {
    lines.push(`## ${r.company}  ·  ${r.score}pts  ·  ${r.why}`);
    lines.push(`**${r.website}**${r.location ? ` · ${r.location}` : ''} · ${r.openings} distinct opening${r.openings > 1 ? 's' : ''} across ${r.roles.length} listing${r.roles.length > 1 ? 's' : ''}`);
    for (const j of r.roles.slice(0, 3)) lines.push(describeRole(j));
    lines.push('');
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), { fetcher = fetch, now = () => new Date(), sleep } = {}) {
  if (argv.includes('--help')) {
    console.log(`Workable buyer signals: --pages N (default 6), --max-age-days N (default ${DEFAULT_MAX_AGE_DAYS}, by posting date), --query Q (repeatable; replaces the default queries). Results: exports/buyer-signals.`);
    return;
  }
  const pages = integerOption('--pages', 6, 1, argv);
  const maxAgeDays = integerOption('--max-age-days', DEFAULT_MAX_AGE_DAYS, 0, argv);
  const queries = argv.flatMap((a, i) => a === '--query' ? [argv[i + 1]] : []);
  if (queries.some(q => !q || q.startsWith('--'))) throw new Error('--query requires a value');

  const { rows, errors, postings } = await searchWorkable({ queries: queries.length ? queries : QUERIES, pages, fetcher, now, sleep, log: m => console.log(m) });
  const unique = dedupeByIdentity(rows);
  const fresh = applyFreshness(unique, { now: now(), maxAgeDays });
  const excluded = [...fresh.excluded, ...fresh.kept.filter(r => !r.website).map(r => ({ ...r, excludedReason: 'no company website in source data' }))];
  const kept = fresh.kept.filter(r => r.website);
  const companies = rankCompanies(kept);

  const day = runStamp();
  const out = exportPath('buyer-signals', `workable_${day}.md`);
  const json = out.replace(/\.md$/, '.json');
  atomicWrite(out, renderMarkdown({ day, companies, excluded, postings, matched: unique.length, maxAgeDays }));
  atomicWrite(json, JSON.stringify(companies, null, 2));
  atomicWrite(out.replace(/\.md$/, '.evidence.json'), JSON.stringify({ maxAgeDays, collectedAt: now().toISOString(), excluded }, null, 2));
  const status = { errors, postings, matchedObservations: rows.length, distinctJobs: unique.length, excludedStale: fresh.excluded.length, excludedNoWebsite: excluded.length - fresh.excluded.length,
    unknownDates: kept.filter(r => r.freshness === 'unknown').length, companies: companies.length, maxAgeDays };
  atomicWrite(out.replace(/\.md$/, '.status.json'), JSON.stringify(status, null, 2));
  console.log(`\n${unique.length} distinct jobs -> ${fresh.excluded.length} older than ${maxAgeDays}d excluded -> ${companies.length} companies`);
  console.log(`Snapshot: ${json}`);
  if (errors.length) { console.error(`${errors.length} searches failed; see status snapshot`); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
