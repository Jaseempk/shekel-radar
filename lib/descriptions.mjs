/**
 * Bounded, deterministic job-description fetching for Workable postings.
 *
 * Order of attempts for one job:
 *   1. Workable's public job API, `https://jobs.workable.com/api/v1/jobs/<viewId>`
 *      (the same host and API family as the search collector). Accepted only when
 *      it returns an object with a non-empty `description`.
 *   2. The public job page, parsing its schema.org JobPosting JSON-LD block.
 *
 * Every outcome is explicit. Only `ok` is evidence for qualification:
 *   ok         description text extracted
 *   removed    page answered 404/410
 *   closed     JobPosting validThrough has passed, or the page says the job is closed
 *   missing    page has no JobPosting, or JobPosting has no description
 *   malformed  JSON-LD present but not valid JSON / not an object
 *   too-large  response body over the byte cap
 *   retry      timeout, network error, HTTP 429 or 5xx (retryable; never cached as a result)
 *   skipped    request budget exhausted before this job was attempted
 *
 * Network bounds: per-request timeout, response byte cap and a per-run request
 * budget shared by all jobs. Results are cached under state/ with status, source
 * URL and timestamp; retryable outcomes are recorded but never served from cache.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWrite } from './runtime.mjs';

export const DESCRIPTION_LIMITS = {
  timeoutMs: 15_000,          // per request
  maxBytes: 1_500_000,        // per response body
  maxTextChars: 20_000,       // stored description text
  cacheTtlDays: 7,            // definitive outcomes are reused this long
};
export const DEFINITIVE = new Set(['ok', 'removed', 'closed', 'missing', 'malformed', 'too-large']);
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (shekel-radar description check)' };

class TooLarge extends Error {}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new TooLarge(`body ${declared} bytes exceeds ${maxBytes}`);
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new TooLarge(`body exceeds ${maxBytes} bytes`); }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new TooLarge(`body exceeds ${maxBytes} bytes`);
  return text;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** HTML fragment -> plain text. Deterministic and dependency-free; good enough for duty matching. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|li|ul|ol|br|h[1-6]|tr|section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
      if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

function findJobPosting(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findJobPosting(n, depth + 1); if (f) return f; } return null; }
  const type = node['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return node;
  return findJobPosting(node['@graph'], depth + 1);
}

function posting(fields, { via, sourceUrl, now }) {
  const parts = [fields.description, fields.requirementsSection ?? fields.requirements].filter(v => typeof v === 'string' && v.trim());
  if (!parts.length) return { status: 'missing', via, sourceUrl, error: 'no description in source data' };
  const text = htmlToText(parts.join('\n')).slice(0, DESCRIPTION_LIMITS.maxTextChars);
  if (!text) return { status: 'missing', via, sourceUrl, error: 'description is empty' };
  const validThrough = Date.parse(fields.validThrough ?? '');
  if (Number.isFinite(validThrough) && validThrough < now.getTime()) return { status: 'closed', via, sourceUrl, error: `validThrough ${fields.validThrough}` };
  if (typeof fields.state === 'string' && !/^(published|open|active)$/i.test(fields.state)) return { status: 'closed', via, sourceUrl, error: `state ${fields.state}` };
  return { status: 'ok', via, sourceUrl, title: typeof fields.title === 'string' ? fields.title : null,
    datePosted: typeof (fields.datePosted ?? fields.created) === 'string' ? (fields.datePosted ?? fields.created) : null,
    language: typeof fields.language === 'string' ? fields.language : null,
    text, chars: text.length, fingerprint: createHash('sha256').update(text.toLowerCase().replace(/\s+/g, ' ')).digest('hex') };
}

/** Parse a Workable job page. Exported for fixtures. */
export function parseJobPage(html, { sourceUrl, now = new Date() } = {}) {
  const blocks = [...String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  let sawMalformed = false;
  for (const raw of blocks) {
    let data;
    try { data = JSON.parse(raw); } catch { sawMalformed = true; continue; }
    const jp = findJobPosting(data);
    if (jp) return posting(jp, { via: 'jsonld', sourceUrl, now });
  }
  if (sawMalformed) return { status: 'malformed', via: 'jsonld', sourceUrl, error: 'JSON-LD block is not valid JSON' };
  if (/no longer (accepting|available|open)|job (is|has been) closed|position has been filled|job not found/i.test(html)) return { status: 'closed', via: 'page', sourceUrl, error: 'page says the job is closed' };
  return { status: 'missing', via: 'page', sourceUrl, error: 'no JobPosting data on page' };
}

const isRetryableHttp = s => s === 429 || s >= 500;

/**
 * Fetch one Workable job's description. `budget` is a shared { remaining } counter;
 * each HTTP request costs one.
 */
export async function fetchWorkableDescription(row, { fetcher = fetch, now = () => new Date(), budget = { remaining: Infinity }, limits = DESCRIPTION_LIMITS } = {}) {
  const at = () => now().toISOString();
  const request = async url => {
    if (budget.remaining <= 0) return { skipped: true };
    budget.remaining -= 1;
    try {
      const response = await fetcher(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(limits.timeoutMs) });
      if (!response.ok) return { httpStatus: response.status };
      return { httpStatus: response.status, body: await readLimited(response, limits.maxBytes) };
    } catch (e) {
      if (e instanceof TooLarge) return { tooLarge: e.message };
      return { error: e.name === 'TimeoutError' || e.name === 'AbortError' ? `timeout after ${limits.timeoutMs}ms` : e.message };
    }
  };

  const attempts = [];
  if (row.viewId) {
    const apiUrl = `https://jobs.workable.com/api/v1/jobs/${encodeURIComponent(row.viewId)}`;
    const r = await request(apiUrl);
    if (r.skipped) return { status: 'skipped', sourceUrl: row.url, fetchedAt: at(), error: 'description request budget exhausted' };
    attempts.push({ url: apiUrl, httpStatus: r.httpStatus ?? null, error: r.error ?? r.tooLarge ?? null });
    if (r.body !== undefined) {
      let data = null;
      try { data = JSON.parse(r.body); } catch { /* not the API shape; fall back to the page */ }
      if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.description === 'string' && data.description.trim()) {
        return { ...posting(data, { via: 'api', sourceUrl: apiUrl, now: now() }), fetchedAt: at(), attempts };
      }
    }
    // Any other API outcome (404, unexpected shape, timeout) falls back to the page, which decides.
  }

  if (!row.url) return { status: 'missing', sourceUrl: null, fetchedAt: at(), error: 'no job URL', attempts };
  const r = await request(row.url);
  if (r.skipped) return { status: 'skipped', sourceUrl: row.url, fetchedAt: at(), error: 'description request budget exhausted', attempts };
  attempts.push({ url: row.url, httpStatus: r.httpStatus ?? null, error: r.error ?? r.tooLarge ?? null });
  const base = { sourceUrl: row.url, fetchedAt: at(), attempts };
  if (r.tooLarge) return { ...base, status: 'too-large', error: r.tooLarge };
  if (r.error) return { ...base, status: 'retry', error: r.error };
  if (r.httpStatus === 404 || r.httpStatus === 410) return { ...base, status: 'removed', httpStatus: r.httpStatus, error: `HTTP ${r.httpStatus}` };
  if (r.body === undefined) return { ...base, status: isRetryableHttp(r.httpStatus) ? 'retry' : 'missing', httpStatus: r.httpStatus, error: `HTTP ${r.httpStatus}` };
  return { ...parseJobPage(r.body, { sourceUrl: row.url, now: now() }), fetchedAt: base.fetchedAt, attempts };
}

/** JSON cache: { version: 1, entries: { [jobId]: outcome } } under state/. */
export class DescriptionCache {
  constructor(file, { ttlDays = DESCRIPTION_LIMITS.cacheTtlDays } = {}) {
    this.file = file; this.ttlMs = ttlDays * 86_400_000; this.entries = {}; this.dirty = false;
    if (file && fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data?.version === 1 && data.entries && typeof data.entries === 'object') this.entries = data.entries;
      } catch { this.corrupt = true; } // an unreadable cache is ignored and rebuilt, never trusted
    }
  }
  get(jobId, now = new Date()) {
    const e = this.entries[jobId];
    if (!e || !DEFINITIVE.has(e.status)) return null;
    if (now.getTime() - Date.parse(e.fetchedAt) > this.ttlMs) return null;
    return e;
  }
  set(jobId, outcome) { this.entries[jobId] = outcome; this.dirty = true; }
  save() { if (this.file && this.dirty) atomicWrite(this.file, JSON.stringify({ version: 1, entries: this.entries }, null, 2)); this.dirty = false; }
}

/**
 * Fetch descriptions for an ordered shortlist, at most `limit` jobs and
 * `maxRequests` HTTP requests. Returns Map(jobId -> outcome); jobs beyond the
 * shortlist get no entry. Cache hits cost no requests.
 */
export async function fetchDescriptions(rows, { limit, maxRequests = limit * 2, cache, fetcher = fetch, now = () => new Date(), limits = DESCRIPTION_LIMITS } = {}) {
  const budget = { remaining: maxRequests };
  const results = new Map();
  for (const row of rows.slice(0, limit)) {
    const cached = cache?.get(row.jobId, now());
    if (cached) { results.set(row.jobId, { ...cached, cached: true }); continue; }
    const outcome = await fetchWorkableDescription(row, { fetcher, now, budget, limits });
    if (outcome.status !== 'skipped') cache?.set(row.jobId, outcome);
    results.set(row.jobId, outcome);
  }
  return { results, requestsUsed: maxRequests - budget.remaining };
}
