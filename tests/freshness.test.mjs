import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/runtime.mjs';
import { parsePostedAt, freshness, dedupeByIdentity, openingKey, workableViewId } from '../lib/signals.mjs';
import { searchWorkable, applyFreshness, rankCompanies } from '../buyer-signals/workable.mjs';

const NOW = new Date('2026-10-08T12:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86_400_000).toISOString();
let seq = 0;
function job({ id, title, company = 'Acme', website = 'https://www.acme.example/', city = 'Riga', country = 'Latvia', created = daysAgo(3) } = {}) {
  const viewId = id ?? `View${++seq}`;
  return { id: viewId, title, created, url: `https://jobs.workable.com/view/${viewId}/${title.toLowerCase().replace(/\W+/g, '-')}`,
    company: { title: company, website }, location: { city, countryName: country } };
}
const searchFetcher = byQuery => async url => {
  const q = new URL(url).searchParams.get('query');
  return { ok: true, json: async () => ({ jobs: byQuery[q] ?? [] }) };
};
const collect = async (byQuery, opts = {}) => {
  const { rows, errors } = await searchWorkable({ queries: Object.keys(byQuery), pages: 1, fetcher: searchFetcher(byQuery), now: () => NOW, sleep: async () => {} });
  assert.deepEqual(errors, []);
  return applyFreshness(dedupeByIdentity(rows), { now: NOW, ...opts });
};

test('posting dates parse strictly; old postings fetched today stay old and bad dates are flagged', async () => {
  assert.equal(parsePostedAt('2026-03-19T20:42:42.549Z', NOW), '2026-03-19T20:42:42.549Z');
  assert.equal(parsePostedAt(1759900000, NOW), new Date(1759900000 * 1000).toISOString());
  for (const bad of ['', null, undefined, 'yesterday', '1', 'not-a-date', '2099-01-01T00:00:00Z', '1970-01-01']) assert.equal(parsePostedAt(bad, NOW), null, String(bad));
  assert.equal(freshness(null, NOW).freshness, 'unknown');
  assert.equal(freshness(daysAgo(31), NOW, 30).freshness, 'stale');
  assert.equal(freshness(daysAgo(30), NOW, 30).freshness, 'fresh');

  const { kept, excluded } = await collect({ 'lead generation': [
    job({ id: 'Old', title: 'Lead Generation Specialist', company: 'Old Co', created: '2026-03-19T20:42:42.549Z' }),
    job({ id: 'Bad', title: 'Lead Generation Specialist', company: 'Bad Date Co', created: 'soon' }),
    job({ id: 'None', title: 'Lead Generation Specialist', company: 'No Date Co', created: null }),
    job({ id: 'New', title: 'Lead Generation Specialist', company: 'New Co' }),
  ] });
  // Collected today, but the posting date decides.
  assert.deepEqual(excluded.map(r => [r.sourceId, r.freshness, r.ageDays]), [["Old", "stale", 202]]);
  assert.match(excluded[0].excludedReason, /202 days ago \(cutoff 30\)/);
  assert.equal(excluded[0].fetchedAt, NOW.toISOString());
  const byId = Object.fromEntries(kept.map(r => [r.sourceId, r]));
  for (const id of ['Bad', 'None']) {
    assert.equal(byId[id].freshness, 'unknown');
    assert.equal(byId[id].postedAt, null, 'no invented posting date');
    assert.match(byId[id].freshnessReason, /review/);
  }
  assert.equal(byId.New.freshness, 'fresh');
  assert.equal((await collect({ q: [job({ title: 'Data Entry Clerk', created: daysAgo(40) })] }, { maxAgeDays: 60 })).kept.length, 1);
});

test('one job hit by several queries appears once; distinct same-title jobs remain distinct', async () => {
  const shared = job({ id: 'Same', title: 'Data Entry Clerk' });
  const twinA = job({ id: 'TwinA', title: 'Back Office Specialist', city: 'Sofia', country: 'Bulgaria' });
  const twinB = job({ id: 'TwinB', title: 'Back Office Specialist', city: 'Sofia', country: 'Bulgaria' });
  const { kept } = await collect({ 'data entry': [shared, twinA], 'back office': [shared, twinA, twinB] });
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.find(r => r.sourceId === 'Same').queries, ['data entry', 'back office']);
  assert.deepEqual(kept.filter(r => r.title === 'Back Office Specialist').map(r => r.jobId).sort(), ['workable:TwinA', 'workable:TwinB']);
  assert.equal(workableViewId('https://jobs.workable.com/view/abc123XYZ/some-slug'), 'abc123XYZ');
  assert.throws(() => dedupeByIdentity([{ title: 'x' }]), /stable jobId/);
});

test('regional copies of one opening do not raise company priority through count', async () => {
  const regions = [['Lagos', 'Nigeria', 'Africa'], ['Budapest', 'Hungary', 'Europe'], ['Kyiv', 'Ukraine', 'Europe'], ['Dubai', 'United Arab Emirates', 'MENA'], ['Cairo', 'Egypt', 'Africa']];
  const copies = regions.map(([city, country, region], i) => job({ id: `Copy${i}`, title: `Lead Generation Representative - ${region}`, company: 'Copycat', website: 'copycat.example', city, country }));
  const single = job({ id: 'Solo', title: 'Lead Generation Representative', company: 'Solo Co', website: 'solo.example', created: daysAgo(1) });
  const { kept } = await collect({ 'lead generation': [...copies, single] });
  assert.equal(new Set(copies.map(c => openingKey({ ...c, company: c.company.title, website: c.company.website, location: `${c.location.city}, ${c.location.countryName}` }))).size, 1);
  const ranked = rankCompanies(kept);
  // Equal title strength: the fresher single posting wins; five copies are one opening.
  assert.deepEqual(ranked.map(c => c.company), ['Solo Co', 'Copycat']);
  const copycat = ranked[1];
  assert.equal(copycat.roles.length, 5, 'copies are retained as evidence');
  assert.equal(copycat.openings, 1);
  // Two genuinely different openings count as two.
  const two = rankCompanies((await collect({ q: [job({ id: 'D1', title: 'Data Entry Clerk', company: 'Two', website: 'two.example' }), job({ id: 'D2', title: 'Invoice Processing Clerk', company: 'Two', website: 'two.example' })] })).kept);
  assert.equal(two[0].openings, 2);
});

test('workable CLI writes freshness evidence offline and exits nonzero on search failures', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'income-workable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date();
  const ago = n => new Date(now.getTime() - n * 86_400_000).toISOString();
  const stub = path.join(dir, 'stub.json');
  const run = (routes, ...args) => {
    fs.writeFileSync(stub, JSON.stringify({ routes }));
    return spawnSync(process.execPath, ['--import', path.join(ROOT, 'tests/fixtures/fetch-stub.mjs'), path.join(ROOT, 'buyer-signals/workable.mjs'), ...args],
      { cwd: dir, env: { ...process.env, INCOME_DATA_DIR: dir, FETCH_STUB: stub }, encoding: 'utf8', timeout: 15000 });
  };
  const ok = run({ 'search:data entry': { json: { jobs: [
    job({ id: 'Fresh1', title: 'Data Entry Clerk', created: ago(2) }),
    job({ id: 'Old1', title: 'Data Entry Clerk', company: 'Old Co', website: 'old.example', created: ago(90) }),
  ] } } }, '--query', 'data entry', '--pages', '1', '--no-descriptions');
  assert.equal(ok.status, 0, ok.stderr);
  const snapshot = ok.stdout.match(/Snapshot: (.+\.json)/)[1];
  const companies = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  const evidence = JSON.parse(fs.readFileSync(snapshot.replace(/\.json$/, '.evidence.json'), 'utf8'));
  const status = JSON.parse(fs.readFileSync(snapshot.replace(/\.json$/, '.status.json'), 'utf8'));
  assert.equal(evidence.maxAgeDays, 30);
  assert.deepEqual(evidence.excluded.map(r => r.sourceId), ['Old1']);
  assert.equal(status.excludedStale, 1);
  assert.deepEqual(status.errors, []);
  // Without description evidence nothing qualifies; the fresh job waits for review.
  assert.deepEqual(companies, []);
  const review = JSON.parse(fs.readFileSync(snapshot.replace(/\.json$/, '.review.json'), 'utf8'));
  assert.deepEqual(review.map(c => [c.company, c.website, c.freshness, c.roles[0].sourceId, c.qualification.status]), [['Acme', 'acme.example', 'fresh', 'Fresh1', 'not-fetched']]);
  assert.equal(fs.readFileSync(path.join(dir, 'stub.json.log'), 'utf8').trim().split('\n').length, 1, 'only the search request ran');

  const failed = run({}, '--query', 'data entry', '--pages', '1', '--no-descriptions');
  assert.equal(failed.status, 1);
  const failedStatus = JSON.parse(fs.readFileSync(failed.stdout.match(/Snapshot: (.+\.json)/)[1].replace(/\.json$/, '.status.json'), 'utf8'));
  assert.equal(failedStatus.errors.length, 1);
  assert.equal(run({}, '--max-age-days', 'abc').status, 1);
});

test('feed collector dedupes by source identity, keeps same-title jobs and filters by posting age', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'income-feeds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const stub = path.join(dir, 'stub.json');
  fs.writeFileSync(stub, JSON.stringify({ routes: {
    'https://remoteok.com/api': { json: [{ legal: 'notice' },
      { id: 1, company: 'Feed Co', position: 'Data Entry Clerk', url: 'https://remoteok.com/1', date: new Date(now - 2 * 86_400_000).toISOString() },
      { id: 2, company: 'Feed Co', position: 'Data Entry Clerk', url: 'https://remoteok.com/2', date: new Date(now - 3 * 86_400_000).toISOString() },
      { id: 3, company: 'Old Feed', position: 'Data Entry Clerk', url: 'https://remoteok.com/3', date: new Date(now - 90 * 86_400_000).toISOString() }] },
    'https://www.arbeitnow.com/api/job-board-api': { json: { data: [{ slug: 'a1', company_name: 'Undated', title: 'Invoice Processing Clerk', url: 'https://arbeitnow.example/a1' }] } },
    'https://remotive.com/api/remote-jobs': { json: { jobs: [] } },
    'https://himalayas.app/jobs/api': { json: { jobs: [] } },
  } }));
  const r = spawnSync(process.execPath, ['--import', path.join(ROOT, 'tests/fixtures/fetch-stub.mjs'), path.join(ROOT, 'buyer-signals/find-buyers.mjs')],
    { cwd: dir, env: { ...process.env, INCOME_DATA_DIR: dir, FETCH_STUB: stub }, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  const snapshot = r.stdout.match(/-> (.+\.json)/)[1];
  const rows = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  assert.deepEqual(rows.map(x => [x.jobId, x.freshness]).sort(), [['Arbeitnow:a1', 'unknown'], ['RemoteOK:1', 'fresh'], ['RemoteOK:2', 'fresh']]);
  assert.ok(rows.every(x => x.qualification.status === 'title-only'));
  const evidence = JSON.parse(fs.readFileSync(snapshot.replace(/\.json$/, '.evidence.json'), 'utf8'));
  assert.deepEqual(evidence.excluded.map(x => x.jobId), ['RemoteOK:3']);
});
