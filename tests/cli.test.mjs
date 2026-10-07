import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/runtime.mjs';
import { OpportunityStore } from '../lib/opportunities.mjs';
import { JobStore } from '../lib/jobs.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'income-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (file, ...args) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, file), ...args], { cwd: dir, env: { ...process.env, INCOME_DATA_DIR: dir }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    return result;
  };
  return { dir, run };
}
test('social commands can rebuild matching JSON/Markdown twice without browser or model access', t => {
  const { dir, run } = fixture(t); const store = new OpportunityStore(path.join(dir,'state/opportunities.sqlite'));
  const rows = [{ id:'fixture-1',text:'Need help with a CRM',url:'https://example.com/1',screen_name:'owner',author:'Owner',bio:'',created:1700000000 }];
  const verdict = { i:0,score:85,buyer:true,offer:'B',reason:'Needs help',angle:'Ask about CRM',job:false,pain:'Repeated entry',aware:true };
  for (const [namespace, facebook] of [['x:buyers',false],['facebook:buyers',true]]) {
    store.ingest(namespace,rows); store.complete(namespace,rows,[verdict],{facebook});
  }
  store.close();
  const day = new Date().toISOString().slice(0,10);
  for (const [command, file] of [['x-radar/radar.mjs','x-radar/queue_'],['fb-radar/radar.mjs','fb-radar/queue_fb_']]) {
    run(command,'--export-only');
    const stem=path.join(dir,'exports',file+day); const before=fs.readFileSync(stem+'.md','utf8');
    run(command,'--export-only'); assert.equal(fs.readFileSync(stem+'.md','utf8'),before);
    const json=JSON.parse(fs.readFileSync(stem+'.json')); assert.equal((Array.isArray(json)?json:json.buyers).length,1);
    assert.ok(before.includes('https://example.com/1'));
  }
});
test('new-job exports do not replace full snapshots used by ranking; include-maybe defaults correctly', t => {
  const { dir, run }=fixture(t); const company={name:'Example',ats:'ashby',slug:'example'};
  const config=path.join(dir,'companies.json'); fs.writeFileSync(config,JSON.stringify({companies:[company]}));
  const store=new JobStore(path.join(dir,'state/opportunities.sqlite'));
  store.record(company,[{id:'ashby:example:1',title:'AI Engineer',url:'https://example.com/job',location:'Remote'}]); store.close();
  run('ats-radar/poll.mjs','--companies',config,'--export-only','--new');
  run('ats-radar/poll.mjs','--companies',config,'--export-only','--new');
  const result=run('ats-radar/rank.mjs','--include-maybe');
  assert.match(result.stdout,/1 viable/); assert.match(result.stdout,/top 40/);
  const snapshots=fs.readdirSync(path.join(dir,'exports/ats-radar')).filter(n=>/^roles_.*\.json$/.test(n)&&!n.includes('.status.'));
  assert.equal(snapshots.length,2);
  for (const file of snapshots) assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'exports/ats-radar',file))).length,1);
});
test('collector modules are safe to import without starting requests', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Import attempted a network request'); };
  try {
    for (const file of ['ats-radar/poll.mjs','ats-radar/rank.mjs','ats-radar/getro.mjs','ats-radar/find-slugs.mjs','buyer-signals/find-buyers.mjs','buyer-signals/workable.mjs','x-radar/radar.mjs','fb-radar/radar.mjs']) {
      await import(path.join(ROOT,file));
    }
  } finally { globalThis.fetch = old; }
});
