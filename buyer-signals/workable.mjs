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
 * -> bounded description fetch for a shortlist -> deterministic duty rules
 * (lib/buyers.mjs qualifyDescription) -> rank companies without counting
 * regional copies of one opening.
 *
 * Run:  node workable.mjs [--pages N] [--max-age-days N] [--descriptions N | --no-descriptions] [--query Q ...]
 * Out:  workable_RUN.json           qualified companies only (input for `outreach prepare`)
 *       workable_RUN.review.json    same shape; needs a person (review, retry, insufficient, not fetched)
 *       workable_RUN.md             readable summary with freshness and duty evidence
 *       workable_RUN.evidence.json  excluded jobs (stale, no website, rejected by duties) and reasons
 *       workable_RUN.status.json    counts and collection errors
 * Description cache: state/buyer-signals/workable-descriptions.json
 */
import path from 'node:path';
import { classify, qualifyDescription } from '../lib/buyers.mjs';
import { exportPath, statePath, atomicWrite, integerOption, runStamp } from '../lib/runtime.mjs';
import { DEFAULT_MAX_AGE_DAYS, parsePostedAt, freshness, workableViewId, normalizeWebsite, dedupeByIdentity, openingKey, assignOpenings } from '../lib/signals.mjs';
import { DESCRIPTION_LIMITS, DescriptionCache, fetchDescriptions } from '../lib/descriptions.mjs';
import { fileURLToPath } from 'node:url';

export const QUERIES = [
  'data entry', 'lead generation', 'list building', 'prospect research',
  'back office', 'data processing', 'order processing', 'invoice processing',
  'billing specialist', 'claims processing', 'sales development representative',
  'appointment setter', 'data annotation', 'document processing',
];
const SEARCH_TIMEOUT_MS = 25_000;
const PAGE_SIZE = 20;
/** Jobs per run whose descriptions are fetched (each costs at most 2 requests: API, then page). */
export const DEFAULT_DESCRIPTION_LIMIT = 25;

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
const STATUS_RANK = { qualified: 0, review: 1, retry: 2, insufficient: 3, 'not-fetched': 4, rejected: 5 };
const statusRank = r => STATUS_RANK[r.qualification?.status] ?? 0;
const roleOrder = (a, b) => (statusRank(a) - statusRank(b)) || (FRESHNESS_RANK[a.freshness] - FRESHNESS_RANK[b.freshness]) || (b.score - a.score)
  || String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? ''));

/**
 * Description shortlist order: the strongest listing of each distinct opening
 * first, then remaining listings (e.g. regional copies) if the limit allows.
 */
export function descriptionShortlist(rows) {
  const ordered = [...rows].sort(roleOrder);
  const seen = new Set(), first = [], rest = [];
  for (const r of ordered) { const k = openingKey(r); (seen.has(k) ? rest : first).push(r); seen.add(k); }
  return [...first, ...rest];
}

const UNAVAILABLE = {
  removed: 'job removed at source', closed: 'job closed at source', missing: 'no description in source data',
  malformed: 'source JobPosting data is malformed', 'too-large': 'description response exceeded the size cap',
};

/** Map a description outcome (or its absence) onto a qualification for one row. */
export function qualifyRow(row, outcome) {
  const description = outcome ? Object.fromEntries(Object.entries({
    status: outcome.status, via: outcome.via, sourceUrl: outcome.sourceUrl, fetchedAt: outcome.fetchedAt, cached: outcome.cached || undefined,
    chars: outcome.chars, fingerprint: outcome.fingerprint, datePosted: outcome.datePosted, httpStatus: outcome.httpStatus, error: outcome.error, attempts: outcome.attempts,
  }).filter(([, v]) => v !== undefined)) : null;
  const base = { offer: row.offer, offerSource: 'title', evidence: null, description };
  if (!outcome || outcome.status === 'skipped') {
    return { ...base, status: 'not-fetched', reasons: [outcome ? 'description request budget exhausted' : 'outside the description shortlist for this run'] };
  }
  if (outcome.status === 'retry') return { ...base, status: 'retry', reasons: [`description fetch failed (retryable): ${outcome.error}`] };
  if (outcome.status !== 'ok') return { ...base, status: 'insufficient', reasons: [`${UNAVAILABLE[outcome.status] ?? outcome.status}${outcome.error ? ` (${outcome.error})` : ''}`] };
  const q = qualifyDescription(outcome.text, row);
  const out = { ...base, ...q, description };
  if (q.status === 'qualified' && row.freshness !== 'fresh') {
    return { ...out, status: 'review', reasons: [...q.reasons, row.freshnessReason ?? 'posting date unknown'] };
  }
  return out;
}

/** Fetch bounded descriptions for a shortlist and attach `qualification` to every row. */
export async function qualifyRoles(rows, { limit = DEFAULT_DESCRIPTION_LIMIT, maxRequests = limit * 2, cache, fetcher = fetch, now = () => new Date(), limits = DESCRIPTION_LIMITS } = {}) {
  const shortlist = descriptionShortlist(rows);
  const { results, requestsUsed } = limit > 0
    ? await fetchDescriptions(shortlist, { limit, maxRequests, cache, fetcher, now, limits })
    : { results: new Map(), requestsUsed: 0 };
  const firstOfOpening = new Map();
  for (const r of shortlist) if (!firstOfOpening.has(openingKey(r))) firstOfOpening.set(openingKey(r), r.jobId);
  const judged = rows.map(row => {
    const qualification = qualifyRow(row, results.get(row.jobId));
    const rep = firstOfOpening.get(openingKey(row));
    const extra = qualification.status === 'not-fetched' && rep !== row.jobId ? { possibleCopyOf: rep } : {};
    const offer = qualification.status === 'qualified' ? qualification.offer : row.offer;
    return { ...row, ...extra, ...(offer !== row.offer ? { titleOffer: row.offer } : {}), offer, qualification };
  });
  const cacheHits = [...results.values()].filter(o => o.cached).length;
  return { rows: judged, requestsUsed, shortlisted: Math.min(limit, shortlist.length), cacheHits };
}

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
  const q = r.qualification;
  const lines = [`- ${r.title}${r.location ? ` · ${r.location}` : ''} · ${age}${q ? ` · **${q.status}** (offer ${r.offer})` : ''}`, `  ${r.url}`];
  if (q) {
    for (const reason of q.reasons ?? []) lines.push(`  - ${reason}`);
    for (const d of (q.evidence?.duties ?? []).slice(0, 3)) lines.push(`  - duty: ${d.duty} — "${d.quote}"`);
    if (r.possibleCopyOf) lines.push(`  - possible copy of ${r.possibleCopyOf}`);
  }
  return lines.join('\n');
}

function renderCompanies(lines, companies) {
  for (const r of companies) {
    lines.push(`### ${r.company}  ·  ${r.score}pts  ·  ${r.why}`);
    lines.push(`**${r.website}**${r.location ? ` · ${r.location}` : ''} · ${r.openings} distinct opening${r.openings > 1 ? 's' : ''} across ${r.roles.length} listing${r.roles.length > 1 ? 's' : ''}`);
    for (const j of r.roles.slice(0, 3)) lines.push(describeRole(j));
    if (r.roles.length > 3) lines.push(`- ...${r.roles.length - 3} more listings in the JSON snapshot`);
    lines.push('');
  }
}

export function renderMarkdown({ day, companies, review = [], excluded, postings, matched, maxAgeDays }) {
  const lines = [`# Workable buyer signals — ${day}`,
    `${companies.length} qualified companies and ${review.length} needing review, from ${matched} distinct matching jobs (${postings} postings scanned).`,
    `Posting-age cutoff: ${maxAgeDays} days by posting date; ${excluded.length} jobs excluded (stale, no company website, or duties rejected; see .evidence.json).`,
    `Qualification reads each shortlisted job description with deterministic duty rules. It is a workflow-fit hypothesis: a job opening does not establish buying intent, budget or a wish to replace staff.`,
    `Company websites come straight from the API, so no domain guessing. Regional copies of one opening count once.\n`,
    `## Qualified\n`];
  renderCompanies(lines, companies);
  lines.push(`## Needs review\n`);
  renderCompanies(lines, review);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), { fetcher = fetch, now = () => new Date(), sleep } = {}) {
  if (argv.includes('--help')) {
    console.log([
      'Workable buyer signals. Results: exports/buyer-signals.',
      '  --pages N            search pages per query (default 6)',
      `  --max-age-days N     exclude postings older than N days by posting date (default ${DEFAULT_MAX_AGE_DAYS})`,
      `  --descriptions N     fetch and qualify descriptions for up to N jobs, at most 2 requests each (default ${DEFAULT_DESCRIPTION_LIMIT})`,
      '  --no-descriptions    skip description fetching; every job then needs review',
      '  --query Q            repeatable; replaces the default queries',
    ].join('\n'));
    return;
  }
  const pages = integerOption('--pages', 6, 1, argv);
  const maxAgeDays = integerOption('--max-age-days', DEFAULT_MAX_AGE_DAYS, 0, argv);
  const descriptionLimit = argv.includes('--no-descriptions') ? 0 : integerOption('--descriptions', DEFAULT_DESCRIPTION_LIMIT, 0, argv);
  const queries = argv.flatMap((a, i) => a === '--query' ? [argv[i + 1]] : []);
  if (queries.some(q => !q || q.startsWith('--'))) throw new Error('--query requires a value');

  const { rows, errors, postings } = await searchWorkable({ queries: queries.length ? queries : QUERIES, pages, fetcher, now, sleep, log: m => console.log(m) });
  const unique = dedupeByIdentity(rows);
  const fresh = applyFreshness(unique, { now: now(), maxAgeDays });
  const excluded = [...fresh.excluded, ...fresh.kept.filter(r => !r.website).map(r => ({ ...r, excludedReason: 'no company website in source data' }))];
  const cache = new DescriptionCache(statePath('buyer-signals', 'workable-descriptions.json'));
  const judged = await qualifyRoles(fresh.kept.filter(r => r.website), { limit: descriptionLimit, cache, fetcher, now });
  cache.save();
  const rejected = judged.rows.filter(r => r.qualification.status === 'rejected');
  excluded.push(...rejected.map(r => ({ ...r, excludedReason: r.qualification.reasons.join('; ') })));
  const companies = rankCompanies(judged.rows.filter(r => r.qualification.status === 'qualified'));
  const review = rankCompanies(judged.rows.filter(r => !['qualified', 'rejected'].includes(r.qualification.status)));
  const byStatus = {};
  for (const r of judged.rows) byStatus[r.qualification.status] = (byStatus[r.qualification.status] ?? 0) + 1;
  const retry = byStatus.retry ?? 0;

  const day = runStamp();
  const out = exportPath('buyer-signals', `workable_${day}.md`);
  const json = out.replace(/\.md$/, '.json');
  atomicWrite(out, renderMarkdown({ day, companies, review, excluded, postings, matched: unique.length, maxAgeDays }));
  atomicWrite(json, JSON.stringify(companies, null, 2));
  atomicWrite(out.replace(/\.md$/, '.review.json'), JSON.stringify(review, null, 2));
  atomicWrite(out.replace(/\.md$/, '.evidence.json'), JSON.stringify({ maxAgeDays, collectedAt: now().toISOString(),
    descriptionLimits: { ...DESCRIPTION_LIMITS, jobs: descriptionLimit, requests: descriptionLimit * 2 }, excluded }, null, 2));
  const status = { errors, postings, matchedObservations: rows.length, distinctJobs: unique.length,
    excludedStale: fresh.excluded.length, excludedNoWebsite: fresh.kept.filter(r => !r.website).length, excludedRejected: rejected.length,
    unknownDates: fresh.kept.filter(r => r.freshness === 'unknown').length,
    descriptions: { shortlisted: judged.shortlisted, requestsUsed: judged.requestsUsed, cacheHits: judged.cacheHits, retryable: retry, ...(cache.corrupt ? { cacheReset: true } : {}) },
    qualification: byStatus, companies: companies.length, reviewCompanies: review.length, maxAgeDays };
  atomicWrite(out.replace(/\.md$/, '.status.json'), JSON.stringify(status, null, 2));
  console.log(`\n${unique.length} distinct jobs -> ${fresh.excluded.length} older than ${maxAgeDays}d excluded -> ${judged.shortlisted} descriptions checked -> ${companies.length} qualified companies, ${review.length} for review`);
  console.log(`Snapshot: ${json}`);
  console.log(`Review: ${out.replace(/\.md$/, '.review.json')}`);
  if (errors.length) console.error(`${errors.length} searches failed; see status snapshot`);
  if (retry) console.error(`${retry} description fetches failed retryably; rerun to retry them`);
  if (errors.length || retry) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
