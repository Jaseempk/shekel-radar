import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOARDS, normalizeBoard, fetchBoard } from '../lib/ats.mjs';
import { JobStore } from '../lib/jobs.mjs';
import { protocolClient } from '../lib/cdp.mjs';

const samples = {
  greenhouse: { jobs: [{ id: 1, title: 'Engineer', location: { name: 'Remote' }, absolute_url: 'https://example.com/1' }] },
  ashby: { jobs: [{ id: '1', title: 'Engineer', location: 'Remote', applyUrl: 'https://example.com/1' }] },
  lever: [{ id: '1', text: 'Engineer', categories: { location: 'Remote' }, hostedUrl: 'https://example.com/1' }],
  workable: { jobs: [{ shortcode: '1', title: 'Engineer', country: 'Remote', url: 'https://example.com/1' }] },
  recruitee: { offers: [{ id: 1, title: 'Engineer', location: 'Remote', careers_url: 'https://example.com/1' }] },
};
test('every discoverable board produces pollable canonical jobs with stable source IDs', async () => {
  assert.deepEqual(Object.keys(BOARDS).sort(), Object.keys(samples).sort());
  for (const [ats, payload] of Object.entries(samples)) {
    const rows = await fetchBoard(ats, 'studio', async () => ({ ok: true, json: async () => payload }));
    assert.equal(rows[0].id, `${ats}:studio:1`);
    assert.equal(rows[0].url, 'https://example.com/1');
  }
  assert.throws(() => normalizeBoard('ashby', 'studio', {}));
  await assert.rejects(fetchBoard('ashby', 'studio', async () => ({ ok: false, status: 503 })));
  assert.deepEqual(normalizeBoard('ashby', 'studio', { jobs: [] }), []);
});
test('notifications do not erase full job observations; failures retain marked stale results', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'income-jobs-'));
  const store = new JobStore(path.join(dir, 'state.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const company = { name: 'Studio', ats: 'ashby', slug: 'studio' };
  const first = normalizeBoard('ashby','studio',samples.ashby);
  store.record(company, first);
  let snapshot = store.snapshot([company]); store.notified(snapshot.rows);
  assert.equal(store.unseen(snapshot.rows).length, 0);
  assert.equal(store.snapshot([company]).rows.length, 1);
  // A new posting with the same name is a different opportunity.
  store.record(company, [{ ...first[0], id: 'ashby:studio:2' }]);
  assert.equal(store.unseen(store.snapshot([company]).rows).length, 1);
  store.record(company, null, 'HTTP 503');
  snapshot = store.snapshot([company]);
  assert.equal(snapshot.rows.length, 1); assert.equal(snapshot.rows[0].collectionStatus, 'stale');
  assert.equal(snapshot.errors.length, 1);
  store.record(company, []);
  assert.equal(store.snapshot([company]).rows.length, 0);
});
test('browser protocol errors and timeouts reject; listeners unsubscribe and close rejects pending work', async () => {
  const sent = []; const ws = { send: text => sent.push(JSON.parse(text)), close() {} };
  const client = protocolClient(ws, 10);
  const call = client.send('Page.navigate');
  ws.onmessage({ data: JSON.stringify({ id: sent[0].id, error: { message: 'No target' } }) });
  await assert.rejects(call, /No target/);
  await assert.rejects(client.send('Network.enable'), /timeout/);
  let calls = 0; const stop = client.on(() => calls++); stop();
  ws.onmessage({ data: JSON.stringify({ method: 'Network.event' }) }); await client.drain(); assert.equal(calls,0);
  const pending = client.send('Page.enable'); client.dispose(); await assert.rejects(pending, /closed/);
});

test('legacy title-based notifications migrate once and do not suppress later postings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'income-legacy-jobs-'));
  const store = new JobStore(path.join(dir, 'state.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const legacy = new Set(['Example::Engineer::Remote']);
  const first = { id: 'ashby:example:1', company: 'Example', title: 'Engineer', location: 'Remote' };
  store.importLegacy([first], legacy);
  assert.equal(store.unseen([first]).length, 0);
  const reopened = { ...first, id: 'ashby:example:2' };
  store.importLegacy([reopened], legacy);
  assert.equal(store.unseen([reopened]).length, 1);
});
