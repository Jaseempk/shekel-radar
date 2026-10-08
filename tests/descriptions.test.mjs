import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/runtime.mjs';
import { classify, qualifyDescription } from '../lib/buyers.mjs';
import { DescriptionCache, fetchWorkableDescription, parseJobPage, htmlToText } from '../lib/descriptions.mjs';
import { qualifyRoles, rankCompanies } from '../buyer-signals/workable.mjs';

// Synthetic descriptions modelled on live-pilot outcomes (no real postings copied).
const KIOSK = `<p>Love talking to people? Join our team at retail kiosks and in-store events across the city.</p>
<ul><li>Engage shoppers face-to-face at our mall kiosk and at local events and home shows.</li>
<li>Generate leads by starting conversations and booking in-home appointments for our design consultants.</li>
<li>Be comfortable on your feet for a full shift, including weekends.</li></ul>
<p>Weekly pay plus bonuses. No experience required; we train you in our proven approach.</p>`;
const RESEARCH = `<p>We are looking for a Sales Research Specialist to support our growth team.</p>
<ul><li>Research target accounts and identify decision makers using LinkedIn Sales Navigator and Apollo.</li>
<li>Build and maintain prospect lists for outbound campaigns.</li>
<li>Keep our HubSpot CRM clean: deduplicate records, enrich contact data and run data quality checks every week.</li>
<li>Report on list coverage and hand qualified accounts to the sales team.</li></ul>
<p>You enjoy structured, detail-oriented work and are comfortable with spreadsheets.</p>`;
const SUPPORT_BACK_OFFICE = `<p>As a Back Office Agent you will join our customer care team.</p>
<ul><li>Handle inbound calls and live chat from customers about their bookings.</li>
<li>Respond to customer inquiries by email and resolve complaints quickly.</li>
<li>Work in our customer support help desk tool and escalate support tickets when needed.</li>
<li>Deliver a friendly, professional customer service experience on every contact.</li></ul>`;
const OUTSOURCED_REGULATED = `<p>We are a business process outsourcing (BPO) provider delivering services on behalf of our clients in the financial sector.</p>
<ul><li>Process documents for debt collection cases and update records in the client's systems.</li>
<li>Check the accuracy of case data and prepare correspondence.</li>
<li>Work with our RPA team to improve throughput.</li></ul><p>Fluent Greek required.</p>`;

const NOW = new Date('2026-10-08T12:00:00Z');
const page = (fields, extra = '') => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org/', '@type': 'JobPosting', datePosted: '2026-10-01T00:00:00Z', ...fields })}</script></head><body>${extra}</body></html>`;
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => body });
let seq = 0;
function role(title, { id = `V${++seq}`, company = 'Acme', freshness = 'fresh', location = 'Riga, Latvia' } = {}) {
  return { company, website: `${company.toLowerCase().replace(/\W/g, '')}.example`, title, location, url: `https://jobs.workable.com/view/${id}/job`, viewId: id,
    jobId: `workable:${id}`, sourceId: id, postedAt: freshness === 'fresh' ? '2026-10-01T00:00:00.000Z' : null, freshness, ageDays: freshness === 'fresh' ? 7 : null,
    ...(freshness === 'unknown' ? { freshnessReason: 'posting date missing or invalid; review before use' } : {}), queries: ['q'], ...classify(title) };
}
/** Fetcher keyed by URL; the job API answers 404 unless given, so the page is used. */
function router(routes) {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (r) return r;
    if (url.startsWith('https://jobs.workable.com/api/v1/jobs/')) return response(404, 'not found');
    throw new Error(`unexpected request ${url}`);
  };
  return { fetcher, calls };
}
const judge = async (rows, routes, opts = {}) => {
  const r = router(routes);
  const out = await qualifyRoles(rows, { limit: 10, fetcher: r.fetcher, now: () => NOW, ...opts });
  return { ...out, calls: r.calls, byId: Object.fromEntries(out.rows.map(x => [x.sourceId, x])) };
};

test('in-person kiosk/event lead generation does not qualify for digital list building', async () => {
  const kiosk = role('Entry Level Sales (Lead Generation) Specialist', { id: 'Kiosk' });
  assert.equal(kiosk.offer, 'B', 'the title alone looks like Offer B');
  const { byId } = await judge([kiosk], { [kiosk.url]: response(200, page({ title: kiosk.title, description: KIOSK })) });
  const q = byId.Kiosk.qualification;
  assert.equal(q.status, 'rejected');
  assert.match(q.reasons[0], /in-person retail\/event/);
  assert.ok(q.evidence.inPerson.length >= 2);
  assert.equal(q.description.via, 'jsonld');
  assert.equal(q.description.sourceUrl, kiosk.url);
  assert.equal(q.description.fetchedAt, NOW.toISOString());
});

test('research and CRM data-hygiene duties qualify with evidence and offer B', async () => {
  const r = role('Sales Research & Lead Generation Specialist', { id: 'Research' });
  const { byId } = await judge([r], { [r.url]: response(200, page({ description: RESEARCH })) });
  const q = byId.Research.qualification;
  assert.equal(q.status, 'qualified', q.reasons.join('; '));
  assert.equal(byId.Research.offer, 'B');
  assert.equal(q.offerSource, 'description');
  const duties = q.evidence.duties.map(d => d.duty);
  for (const d of ['CRM work', 'prospect/account research', 'list building', 'data hygiene/enrichment']) assert.ok(duties.includes(d), d);
  assert.ok(q.evidence.duties.every(d => typeof d.quote === 'string' && d.quote.length > 0));
  assert.match(q.description.fingerprint, /^[0-9a-f]{64}$/);
});

test('back-office titles that are customer support are rejected; outsourced or regulated work is held for review', async () => {
  const support = role('Back Office Agent', { id: 'Support', company: 'Helpdesk Co' });
  const bpo = role('Back Office Specialist', { id: 'Bpo', company: 'Bpo Co' });
  const { byId } = await judge([support, bpo], { [support.url]: response(200, page({ description: SUPPORT_BACK_OFFICE })), [bpo.url]: response(200, page({ description: OUTSOURCED_REGULATED })) });
  assert.equal(byId.Support.qualification.status, 'rejected');
  assert.match(byId.Support.qualification.reasons[0], /customer support/);
  assert.equal(byId.Bpo.qualification.status, 'review');
  const reasons = byId.Bpo.qualification.reasons.join('; ');
  assert.match(reasons, /outsourced/); assert.match(reasons, /regulated/);
  assert.equal(byId.Bpo.offer, 'ops', 'offer codes stay A/B/ops');
});

test('description rules hold non-English, strategic, unclear and short descriptions for review', () => {
  const sig = classify('Data Entry Clerk');
  const greek = 'Αναζητούμε υπάλληλο για καταχώρηση δεδομένων στο σύστημα της εταιρείας μας και έλεγχο εγγράφων. '.repeat(8);
  assert.match(qualifyDescription(greek, sig).reasons.join(';'), /non-English/);
  const strategic = `${RESEARCH} You will own the pipeline, carry a quota, close deals and manage a team of SDRs while you develop the sales strategy.`;
  assert.match(qualifyDescription(strategic, sig).reasons.join(';'), /strategic/);
  assert.equal(qualifyDescription('We are a friendly team. '.repeat(20), sig).status, 'review');
  assert.equal(qualifyDescription('Short text.', sig).status, 'insufficient');
});

test('missing, removed, closed, timed-out, malformed, oversized and over-budget descriptions have explicit outcomes', async () => {
  const rows = ['Missing', 'Removed', 'Closed', 'Timeout', 'Malformed', 'Large', 'Server'].map(id => role('Data Entry Clerk', { id, company: `${id} Co` }));
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const routes = {
    [rows[0].url]: response(200, page({ title: 'x' })),
    [rows[1].url]: response(404, ''),
    [rows[2].url]: response(200, page({ description: RESEARCH, validThrough: '2026-09-01T00:00:00Z' })),
    [rows[3].url]: timeout,
    [rows[4].url]: response(200, '<script type="application/ld+json">{"@type": "JobPosting", "description": </script>'),
    [rows[5].url]: { ok: true, status: 200, headers: new Headers({ 'content-length': '999999999' }), text: async () => assert.fail('body read despite cap') },
    [rows[6].url]: response(503, ''),
  };
  const { byId } = await judge(rows, routes);
  const outcome = id => [byId[id].qualification.status, byId[id].qualification.description.status];
  assert.deepEqual(outcome('Missing'), ['insufficient', 'missing']);
  assert.deepEqual(outcome('Removed'), ['insufficient', 'removed']);
  assert.deepEqual(outcome('Closed'), ['insufficient', 'closed']);
  assert.deepEqual(outcome('Timeout'), ['retry', 'retry']);
  assert.match(byId.Timeout.qualification.reasons[0], /timeout/);
  assert.deepEqual(outcome('Malformed'), ['insufficient', 'malformed']);
  assert.deepEqual(outcome('Large'), ['insufficient', 'too-large']);
  assert.deepEqual(outcome('Server'), ['retry', 'retry']);
  for (const id of Object.keys(byId)) assert.notEqual(byId[id].qualification.status, 'qualified');

  // Request budget: 3 jobs x (API + page) with a budget of 3 requests.
  const budgeted = ['B1', 'B2', 'B3'].map(id => role('Invoice Processing Clerk', { id, company: `${id} Co` }));
  const pages = Object.fromEntries(budgeted.map(r => [r.url, response(200, page({ description: RESEARCH }))]));
  const b = await judge(budgeted, pages, { maxRequests: 3 });
  assert.equal(b.calls.length, 3);
  assert.equal(b.requestsUsed, 3);
  assert.equal(b.byId.B2.qualification.status, 'not-fetched');
  assert.match(b.byId.B2.qualification.reasons[0], /budget/);
  // Shortlist limit: jobs beyond it are visibly not fetched.
  const limited = await judge(budgeted, pages, { limit: 1 });
  assert.deepEqual(limited.rows.map(r => r.qualification.status), ['qualified', 'not-fetched', 'not-fetched']);
});

test('the Workable job API is preferred when it answers with a description', async () => {
  const r = role('Data Entry Clerk', { id: 'Api' });
  const api = `https://jobs.workable.com/api/v1/jobs/Api`;
  const { byId, calls } = await judge([r], { [api]: response(200, JSON.stringify({ title: r.title, state: 'published', description: RESEARCH, created: '2026-10-01T00:00:00Z' })) });
  assert.deepEqual(calls, [api]);
  assert.equal(byId.Api.qualification.description.via, 'api');
  // A closed API job is not qualified and does not need the page.
  const closed = role('Data Entry Clerk', { id: 'ApiClosed' });
  const c = await judge([closed], { 'https://jobs.workable.com/api/v1/jobs/ApiClosed': response(200, JSON.stringify({ state: 'closed', description: RESEARCH })) });
  assert.equal(c.byId.ApiClosed.qualification.description.status, 'closed');
  // An unexpected API shape falls back to the page.
  const shape = role('Data Entry Clerk', { id: 'Shape' });
  const s = await judge([shape], { 'https://jobs.workable.com/api/v1/jobs/Shape': response(200, '[]'), [shape.url]: response(200, page({ description: RESEARCH })) });
  assert.equal(s.byId.Shape.qualification.description.via, 'jsonld');
  assert.equal(s.calls.length, 2);
});

test('JSON-LD parsing tolerates @graph and arrays, ignores unrelated blocks and decodes HTML', () => {
  const html = `<script type="application/ld+json">{"@type":"Organization"}</script>
    <script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":["JobPosting"],"description":"<p>Data entry &amp; CRM &#8211; checks</p>"}]}</script>`;
  const out = parseJobPage(html, { sourceUrl: 'https://x.example', now: NOW });
  assert.equal(out.status, 'ok');
  assert.equal(out.text, 'Data entry & CRM – checks');
  assert.equal(parseJobPage('<p>This job is no longer accepting applications</p>', { now: NOW }).status, 'closed');
  assert.equal(htmlToText('<script>alert(1)</script><b>A</b>&nbsp;B'), 'A B');
});

test('descriptions are cached with status, source URL and timestamp; retryable failures are retried', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'income-desc-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state', 'workable-descriptions.json');
  const ok = role('Data Entry Clerk', { id: 'Cached' });
  const flaky = role('Data Entry Clerk', { id: 'Flaky', company: 'Flaky Co' });
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  let cache = new DescriptionCache(file);
  const first = await judge([ok, flaky], { [ok.url]: response(200, page({ description: RESEARCH })), [flaky.url]: timeout }, { cache });
  cache.save();
  assert.equal(first.calls.length, 4);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.entries['workable:Cached'].status, 'ok');
  assert.equal(stored.entries['workable:Cached'].sourceUrl, ok.url);
  assert.equal(stored.entries['workable:Cached'].fetchedAt, NOW.toISOString());
  assert.equal(stored.entries['workable:Flaky'].status, 'retry');

  cache = new DescriptionCache(file);
  const second = await judge([ok, flaky], { [flaky.url]: response(200, page({ description: RESEARCH })) }, { cache });
  assert.deepEqual(second.calls, ['https://jobs.workable.com/api/v1/jobs/Flaky', flaky.url], 'cached job costs no request; retry is re-fetched');
  assert.equal(second.byId.Cached.qualification.description.cached, true);
  assert.equal(second.cacheHits, 1);

  // Entries expire; a corrupt cache file is ignored rather than trusted.
  const later = new Date(NOW.getTime() + 8 * 86_400_000);
  assert.equal(new DescriptionCache(file).get('workable:Cached', later), null);
  fs.writeFileSync(file, '{not json');
  assert.equal(new DescriptionCache(file).corrupt, true);
});

test('unknown posting dates block automatic qualification; description fingerprints separate same-title roles', async () => {
  const undated = role('Data Entry Clerk', { id: 'Undated', freshness: 'unknown' });
  const u = await judge([undated], { [undated.url]: response(200, page({ description: RESEARCH })) });
  assert.equal(u.byId.Undated.qualification.status, 'review');
  assert.match(u.byId.Undated.qualification.reasons.at(-1), /posting date/);

  const a = role('Data Entry Clerk', { id: 'SameA', company: 'Twin' });
  const b = role('Data Entry Clerk', { id: 'SameB', company: 'Twin' });
  const c = role('Data Entry Clerk', { id: 'SameC', company: 'Twin' });
  const other = RESEARCH.replace('Sales Research Specialist', 'Data Entry Clerk for the finance team').replace('outbound campaigns', 'supplier onboarding');
  const out = await judge([a, b, c], { [a.url]: response(200, page({ description: RESEARCH })), [b.url]: response(200, page({ description: RESEARCH })), [c.url]: response(200, page({ description: other })) });
  const [twin] = rankCompanies(out.rows.filter(r => r.qualification.status === 'qualified'));
  assert.equal(twin.roles.length, 3, 'distinct jobs stay distinct');
  assert.equal(twin.openings, 2, 'identical descriptions are one opening; different duties are another');
});

test('workable CLI qualifies from descriptions offline and its snapshot stays outreach-compatible', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'income-workable-desc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ago = n => new Date(Date.now() - n * 86_400_000).toISOString();
  const hit = (id, title, company, created = ago(2)) => ({ id, title, created, url: `https://jobs.workable.com/view/${id}/job`,
    company: { title: company, website: `https://www.${company.toLowerCase().replace(/\W/g, '')}.example/` }, location: { city: 'Riga', countryName: 'Latvia' } });
  const stub = path.join(dir, 'stub.json');
  const routes = {
    'search:lead generation': { json: { jobs: [
      hit('R1', 'Sales Research & Lead Generation Specialist', 'Research Co'),
      hit('K1', 'Entry Level Sales (Lead Generation) Specialist', 'Kiosk Co'),
      hit('T1', 'Lead Generation Specialist', 'Timeout Co'),
      hit('O1', 'Lead Generation Specialist', 'Old Co', ago(120)),
    ] } },
    'https://jobs.workable.com/api/v1/jobs/R1': { status: 404, text: '' },
    'https://jobs.workable.com/api/v1/jobs/K1': { status: 404, text: '' },
    'https://jobs.workable.com/api/v1/jobs/T1': { status: 404, text: '' },
    'https://jobs.workable.com/view/R1/job': { text: page({ description: RESEARCH }) },
    'https://jobs.workable.com/view/K1/job': { text: page({ description: KIOSK }) },
    'https://jobs.workable.com/view/T1/job': { error: 'TimeoutError' },
  };
  fs.writeFileSync(stub, JSON.stringify({ routes }));
  const run = () => spawnSync(process.execPath, ['--import', path.join(ROOT, 'tests/fixtures/fetch-stub.mjs'), path.join(ROOT, 'buyer-signals/workable.mjs'), '--query', 'lead generation', '--pages', '1', '--descriptions', '5'],
    { cwd: dir, env: { ...process.env, INCOME_DATA_DIR: dir, FETCH_STUB: stub }, encoding: 'utf8', timeout: 15000 });
  const result = run();
  assert.equal(result.status, 1, 'a retryable description failure makes the run partial');
  assert.match(result.stderr, /1 description fetches failed retryably/);
  const snapshot = result.stdout.match(/Snapshot: (.+\.json)/)[1];
  const read = suffix => JSON.parse(fs.readFileSync(snapshot.replace(/\.json$/, suffix), 'utf8'));
  const qualified = read('.json'), review = read('.review.json'), evidence = read('.evidence.json'), status = read('.status.json');
  assert.deepEqual(qualified.map(c => [c.company, c.website, c.offer, c.qualification.status]), [['Research Co', 'researchco.example', 'B', 'qualified']]);
  assert.deepEqual(review.map(c => [c.company, c.qualification.status]), [['Timeout Co', 'retry']]);
  assert.deepEqual(evidence.excluded.map(r => [r.company, r.excludedReason.slice(0, 20)]).sort(), [['Kiosk Co', 'duties are in-person'], ['Old Co', 'posted 120 days ago ']]);
  assert.deepEqual(status.qualification, { qualified: 1, rejected: 1, retry: 1 });
  assert.equal(status.descriptions.requestsUsed, 6);
  const md = fs.readFileSync(snapshot.replace(/\.json$/, '.md'), 'utf8');
  assert.match(md, /duty: CRM work/); assert.match(md, /posted 2d ago/);
  assert.ok(fs.existsSync(path.join(dir, 'state', 'buyer-signals', 'workable-descriptions.json')));

  // The unchanged outreach stage accepts the qualified snapshot.
  const py = spawnSync('python3', ['-c', `import json,sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); from lib.outreach import prepare_prospects
p,u = prepare_prospects(json.load(open(sys.argv[1])), {}); print(json.dumps([[x['domain'], [r['offer'] for r in x['roles']]] for x in p]), len(u))`, snapshot],
  { cwd: dir, env: { ...process.env, INCOME_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  assert.equal(py.stdout.trim(), '[["researchco.example", ["B"]]] 0');

  // Second run: cached descriptions cost nothing; only the timed-out job is retried.
  fs.writeFileSync(stub + '.log', '');
  run();
  const calls = fs.readFileSync(stub + '.log', 'utf8').trim().split('\n');
  assert.deepEqual(calls.filter(u => !u.includes('query=')), ['https://jobs.workable.com/api/v1/jobs/T1', 'https://jobs.workable.com/view/T1/job']);
});
