import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpportunityStore, qualifyPending } from '../lib/opportunities.mjs';
import { validateVerdicts, modelJSON } from '../lib/qualification.mjs';
import { atomicWrite, integerOption } from '../lib/runtime.mjs';

const record = id => ({ id, text: 'Need CRM help', url: `https://example.com/${id}` });
const verdict = i => ({ i, score: 80, buyer: true, offer: 'B', reason: 'Needs help', angle: 'Ask about CRM' });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'income-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'state.sqlite') };
}
test('partial, duplicate and incorrectly typed verdicts never consume pending records', t => {
  const { file } = fixture(t); const store = new OpportunityStore(file); t.after(() => store.close());
  const batch = [record('1'), record('2')]; store.ingest('x:buyers', batch);
  for (const values of [[], [verdict(0)], [verdict(0), verdict(0)], [verdict(0), { ...verdict(1), buyer: 'false' }]]) {
    assert.throws(() => store.complete('x:buyers', batch, values));
    assert.equal(store.pending('x:buyers').length, 2);
    assert.equal(store.results('x:buyers', new Date().toISOString().slice(0, 10)).length, 0);
  }
});
test('results survive restart and export failure; reruns preserve and deduplicate earlier outcomes', t => {
  const { file, dir } = fixture(t); let store = new OpportunityStore(file);
  const batch = [record('1')]; store.ingest('x:buyers', batch); store.complete('x:buyers', batch, [verdict(0)]);
  const blocker = path.join(dir, 'blocked'); fs.writeFileSync(blocker, 'file');
  assert.throws(() => atomicWrite(path.join(blocker, 'queue.json'), '[]'));
  store.close(); store = new OpportunityStore(file); t.after(() => store.close());
  store.ingest('x:buyers', [record('1'), record('2')]);
  assert.deepEqual(store.pending('x:buyers').map(r => r.id), ['2']);
  store.complete('x:buyers', [record('2')], [verdict(0)]);
  const results = store.results('x:buyers', new Date().toISOString().slice(0, 10));
  assert.deepEqual(results.map(r => r.id), ['1', '2']);
  const out = path.join(dir, 'queue.json'); atomicWrite(out, JSON.stringify(results));
  assert.equal(JSON.parse(fs.readFileSync(out)).length, 2);
});
test('failed scoring is persisted and resumed without recapturing input', async t => {
  const { file } = fixture(t); let store = new OpportunityStore(file);
  store.ingest('x:buyers', [record('1')]);
  assert.equal(await qualifyPending(store, 'x:buyers', async () => []), 1);
  store.close(); store = new OpportunityStore(file); t.after(() => store.close());
  assert.equal(await qualifyPending(store, 'x:buyers', async () => [verdict(0)]), 0);
  assert.equal(store.pending('x:buyers').length, 0);
});
test('legacy seen migration preserves suppression and namespaces stay independent', t => {
  const { file, dir } = fixture(t); const store = new OpportunityStore(file); t.after(() => store.close());
  const old = path.join(dir, 'seen.json'); fs.writeFileSync(old, '["1"]');
  store.importLegacy('x:buyers', old); store.importLegacy('x:buyers', old);
  store.ingest('x:buyers', [record('1')]); store.ingest('x:jobs', [record('1')]);
  assert.equal(store.pending('x:buyers').length, 0); assert.equal(store.pending('x:jobs').length, 1);
});
test('model transport rejects empty and truncated responses', async () => {
  for (const body of [{ content: [] }, { stop_reason: 'max_tokens', content: [{ type: 'text', text: '[]' }] }]) {
    await assert.rejects(modelJSON('test', { fetcher: async () => ({ ok: true, json: async () => body }) }));
  }
  assert.throws(() => validateVerdicts([{ ...verdict(0), job: true, pain: '', aware: false }], 1, { facebook: true }));
});
test('integer options retain defaults when another flag is present', () => {
  assert.equal(integerOption('--top', 40, 1, ['--include-maybe']), 40);
  assert.throws(() => integerOption('--top', 40, 1, ['--top']));
  assert.throws(() => integerOption('--top', 40, 1, ['--top', 'abc']));
});
