/**
 * Getro radar — pull roles from VC and accelerator talent networks.
 *
 * Most `jobs.<fund>.com` boards run on Getro, whose search API is public and
 * unauthenticated. Each hit carries the COMPANY'S OWN careers URL, so this
 * surfaces pre-seed and seed roles at their source, before aggregators index
 * them.
 *
 * Run:  node getro.mjs                       # remote engineering roles, last 21 days
 *       node getro.mjs --days 7
 *       node getro.mjs --query "founding"    # extra title keyword
 *       node getro.mjs --all-stages          # don't restrict to early stage
 *
 * Output: getro_YYYY-MM-DD.md
 *
 * Notes learned the hard way:
 *  - The API 406s without an explicit Accept header.
 *  - hitsPerPage is capped at 20; paginate with `page`.
 *  - Only `query` and `filters.searchable_locations` are honoured server-side;
 *    everything else (stage, seniority) is silently ignored, so filter locally.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exportPath, atomicWrite, runStamp, integerOption } from '../lib/runtime.mjs';
import { fileURLToPath } from 'node:url';

export async function main() {
  if (process.argv.includes('--help')) { console.log('VC jobs: --days N --query TEXT --all-stages. Results: exports/ats-radar.'); return; }

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };

  const DAYS = integerOption('--days', 21, 1);
  const EXTRA = val('--query', '');

  // Networks verified live, weighted toward EU/EMEA funds (best timezone fit) and
  // early-stage specialists. name -> Getro collection id.
  const NETWORKS = {
    'Entrepreneur First': 228, Seedcamp: 4186, Speedinvest: 947, 'Cherry Ventures': 44081,
    'Dawn Capital': 3063, 'Point Nine': 1680, Earlybird: 617, byFounders: 248,
    Antler: 7715, MMC: 2303, Kindred: 221, Techstars: 89, SignalFire: 135,
    'Long Journey': 8279, Freestyle: 108, Bonfire: 790, 'Basis Set': 619,
    'Craft Ventures': 340, Uncork: 247, Khosla: 257, Madrona: 151, Menlo: 767,
    NFX: 307, 'Pear VC': 138, Redpoint: 189, Upfront: 184, Eniac: 117,
    'Lerer Hippeau': 120, Foundry: 25, Firstminute: 178, Blackbird: 219,
    DCVC: 514, Lux: 103, Accel: 8672, '8VC': 1005,
  };

  const EARLY = /pre.?seed|seed|series_a/i;
  const TITLE_RE = /engineer|developer|founding|forward deployed|fde/i;
  const AI_RE = /\bai\b|llm|ml\b|machine learning|agent|rag|applied/i;

  async function search(id, page) {
    const r = await fetch(`https://api.getro.com/api/v2/collections/${id}/search/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',            // without this the API 406s
        'User-Agent': 'job-search/1.0',
      },
      body: JSON.stringify({
        hitsPerPage: 20,
        page,
        query: EXTRA || 'engineer',
        filters: { searchable_locations: ['Remote'] },
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return (d.results ?? d).jobs ?? [];
  }

  const cutoff = Date.now() / 1000 - DAYS * 86400;
  const rows = [];
  const failures = [];

  for (const [fund, id] of Object.entries(NETWORKS)) {
    let got = 0;
    try {
      for (let page = 0; page < 3; page++) {          // 60 newest per network is plenty
        const jobs = await search(id, page);
        if (!jobs.length) break;
        for (const j of jobs) {
          if ((j.created_at ?? 0) < cutoff) continue;
          const title = j.title ?? '';
          if (!TITLE_RE.test(title)) continue;
          const org = j.organization ?? {};
          if (!flag('--all-stages') && org.stage && !EARLY.test(org.stage)) continue;
          rows.push({
            fund, company: org.name ?? '?', stage: org.stage ?? '?',
            observedAt: new Date().toISOString(), title, url: j.url ?? '', created: j.created_at,
            locations: (j.searchable_locations ?? []).join(', '),
            ai: AI_RE.test(title),
          });
          got++;
        }
        await new Promise((r) => setTimeout(r, 350));  // ~1 req/sec across the sweep
      }
      process.stdout.write(`  ${fund}: ${got}\n`);
    } catch (e) {
      failures.push(`${fund}: ${e.message}`);
    }
  }

  // Same role often appears in several funds' networks; keep one.
  const seen = new Set();
  const unique = rows.filter((r) => {
    const k = `${r.company}::${r.title}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  unique.sort((a, b) => (b.ai - a.ai) || (b.created - a.created));

  const day = runStamp();
  const out = exportPath('ats-radar', `getro_${day}.md`);
  const lines = [`# Early-stage roles via VC talent networks — ${day}`,
    `${unique.length} roles, last ${DAYS} days, remote, from ${Object.keys(NETWORKS).length} networks.`,
    `Links go to the company's own careers page. Apply there, and consider messaging the founder directly.\n`];
  for (const r of unique) {
    const when = new Date(r.created * 1000).toISOString().slice(0, 10);
    lines.push(`## ${r.title}${r.ai ? ' 🎯' : ''}`);
    lines.push(`**${r.company}** · ${r.stage} · via ${r.fund} · posted ${when} · ${r.locations || 'remote'}`);
    lines.push(`${r.url}\n`);
  }
  atomicWrite(out, lines.join('\n'));
  atomicWrite(out.replace(/\.md$/, '.json'), JSON.stringify(unique, null, 2));
  console.log(`\n${unique.length} unique roles -> ${path.basename(out)}`);
  if (failures.length) console.log(`${failures.length} network(s) failed: ${failures.slice(0, 4).join(' | ')}`);

  atomicWrite(out.replace(/\.md$/, '.status.json'), JSON.stringify({ errors: failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
