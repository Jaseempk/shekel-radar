/** Poll supported company boards. Always retain full observations; --new changes only the notification view. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBoard } from '../lib/ats.mjs';
import { JobStore } from '../lib/jobs.mjs';
import { statePath, exportPath, atomicWrite, option, runStamp } from '../lib/runtime.mjs';

export async function main() {
const HERE = path.dirname(fileURLToPath(import.meta.url));
const flag = f => process.argv.includes(f);
if (flag('--help')) {
  console.log('ATS poll: --companies FILE --remote-only --match TEXT --new --export-only');
} else {
  const { companies } = JSON.parse(fs.readFileSync(option('--companies', path.join(HERE, 'companies.json')), 'utf8'));
  const store = new JobStore(statePath('opportunities.sqlite'));
  try {
    if (!flag('--export-only')) {
      for (let i = 0; i < companies.length; i += 5) {
        await Promise.all(companies.slice(i, i + 5).map(async c => {
          try { store.record(c, await fetchBoard(c.ats, c.slug)); }
          catch (e) { store.record(c, null, e.message); }
        }));
        await new Promise(r => setTimeout(r, 400));
      }
    }
    const { rows, errors } = store.snapshot(companies);
    const stamp = runStamp();
    // Full snapshots are always available to rank.mjs, including during --new runs.
    atomicWrite(exportPath('ats-radar', `roles_${stamp}.json`), JSON.stringify(rows, null, 2));
    atomicWrite(exportPath('ats-radar', `roles_${stamp}.status.json`), JSON.stringify({ errors, collected: new Date().toISOString() }, null, 2));
    const legacyFile = path.join(HERE, 'seen.json');
    const legacy = new Set(fs.existsSync(legacyFile) ? JSON.parse(fs.readFileSync(legacyFile, 'utf8')) : []);
    store.importLegacy(rows, legacy);
    const remote = r => r.remote || /remote|anywhere|worldwide|global|distributed/i.test(`${r.location} ${r.title}`);
    let selected = rows.filter(r => r.collectionStatus === 'ok');
    if (flag('--remote-only')) selected = selected.filter(remote);
    const match = option('--match', '').toLowerCase();
    if (match) selected = selected.filter(r => r.title.toLowerCase().includes(match));
    if (flag('--new')) selected = store.unseen(selected);
    const stem = `${flag('--new') ? 'new_roles' : 'roles'}_${stamp}`;
    if (flag('--new')) atomicWrite(exportPath('ats-radar', stem + '.json'), JSON.stringify(selected, null, 2));
    const lines = [`# ATS roles — ${selected.length} selected`, '', ...selected.map(r => `- **${r.company}: ${r.title}** · ${r.location || 'unknown'}\n  ${r.url}`)];
    const out = exportPath('ats-radar', stem + '.md');
    atomicWrite(out, lines.join('\n') + '\n');
    // Only acknowledge notifications after their view was successfully written.
    store.notified(selected);
    console.log(`${selected.length} selected; ${rows.length} retained -> ${out}`);
    if (errors.length) { console.error(`${errors.length} boards failed; retained observations are marked stale`); process.exitCode = 1; }
  } finally { store.close(); }
}

}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
