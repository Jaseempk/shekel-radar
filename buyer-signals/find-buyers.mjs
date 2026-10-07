/**
 * Buyer-signal radar — find companies that are HIRING A HUMAN to do the work
 * you automate. An open "Data Entry Specialist" or "Lead Generation Associate"
 * req means the pain is felt now, the budget is already approved, and no vendor
 * has been chosen. That is a warmer signal than any "how do I automate X" post.
 *
 * Sources:
 *   --feeds  (default) free aggregator APIs: RemoteOK, Arbeitnow, Remotive, Himalayas
 *   --ats    company ATS boards from the slug datasets in ../ats-radar/ds_*.json
 *            (15k+ boards; use --limit to sample, it polls ~1/sec by design)
 *
 * Run:  node find-buyers.mjs
 *       node find-buyers.mjs --ats --limit 400
 *
 * Output: buyers_YYYY-MM-DD.md + .json
 */
import fs from 'node:fs';
import path from 'node:path';
import { classify } from '../lib/buyers.mjs';
import { exportPath, atomicWrite, integerOption, runStamp } from '../lib/runtime.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };

// Titles that mean "a human is doing something a pipeline could do".
// Weighted: the first group is the offer almost verbatim.

async function getJson(url, opts = {}) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (buyer-signal-research)', Accept: 'application/json', ...opts.headers },
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const rows = [];
const push = (company, title, url, source, location = '') => {
  const c = classify(title || '');
  if (!c) return;
  rows.push({ company: company || '?', title, url, source, location, ...c });
};

// ---------- free aggregator feeds ----------
async function feeds() {
  const rok = await getJson('https://remoteok.com/api');
  for (const j of (rok ?? []).filter((x) => x && x.position))
    push(j.company, j.position, j.url || j.apply_url, 'RemoteOK', j.location);

  const arb = await getJson('https://www.arbeitnow.com/api/job-board-api');
  for (const j of (arb?.data ?? []))
    push(j.company_name, j.title, j.url, 'Arbeitnow', (j.location || ''));

  const rmv = await getJson('https://remotive.com/api/remote-jobs');
  for (const j of (rmv?.jobs ?? []))
    push(j.company_name, j.title, j.url, 'Remotive', j.candidate_required_location);

  const him = await getJson('https://himalayas.app/jobs/api');
  for (const j of (him?.jobs ?? []))
    push(j.companyName, j.title, j.applicationLink || j.guid, 'Himalayas', (j.locationRestrictions || []).join(', '));
}

// ---------- company ATS boards ----------
const ATS = {
  ashby: { url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
           jobs: (d) => (d.jobs ?? []).map((j) => ({ t: j.title, u: j.jobUrl, l: j.location })) },
  greenhouse: { url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
           jobs: (d) => (d.jobs ?? []).map((j) => ({ t: j.title, u: j.absolute_url, l: j.location?.name })) },
  lever: { url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
           jobs: (d) => (Array.isArray(d) ? d : []).map((j) => ({ t: j.text, u: j.hostedUrl, l: j.categories?.location })) },
};

async function ats() {
  const limit = integerOption('--limit', 300, 1);
  const pool = [];
  for (const [name, file] of [['ashby','ds_ashby.json'], ['greenhouse','ds_greenhouse.json'], ['lever','ds_lever.json']]) {
    const p = path.join(HERE, '..', 'ats-radar', file);
    if (!fs.existsSync(p)) continue;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const slugs = Array.isArray(d) ? d : (d.companies ?? Object.values(d)[0] ?? []);
    for (const s of slugs) pool.push([name, s]);
  }
  // shuffle so repeat runs sample different companies
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const take = pool.slice(0, limit);
  console.log(`probing ${take.length} of ${pool.length} company boards...`);

  let done = 0;
  const CONC = 3;                       // 3 in flight across 3 different hosts
  for (let i = 0; i < take.length; i += CONC) {
    await Promise.all(take.slice(i, i + CONC).map(async ([ats_, slug]) => {
      const d = await getJson(ATS[ats_].url(slug));
      if (d) for (const j of ATS[ats_].jobs(d)) push(slug, j.t, j.u, `ATS:${ats_}`, j.l ?? '');
    }));
    done += CONC;
    if (done % 300 < CONC) process.stdout.write(`  ${Math.min(done, take.length)}/${take.length}\n`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

if (flag('--ats')) await ats(); else await feeds();

// dedupe + rank
const seen = new Set();
const uniq = rows.filter((r) => {
  const k = `${(r.company || '').toLowerCase()}::${(r.title || '').toLowerCase()}`;
  if (seen.has(k)) return false; seen.add(k); return true;
});
uniq.sort((a, b) => b.score - a.score);

const day = runStamp();
const out = exportPath('buyer-signals', `buyers_${day}.md`);
const lines = [`# Buyer signals — ${day} — ${uniq.length} companies hiring for automatable work\n`,
  `Each row is a company paying a salary for work your pipeline removes. Budget exists, pain is current, no vendor chosen.\n`];
const byWhy = {};
for (const r of uniq) (byWhy[r.why] ??= []).push(r);
for (const [why, list] of Object.entries(byWhy)) {
  lines.push(`## ${why} (${list.length})`);
  for (const r of list) lines.push(`- **${r.company}** — ${r.title}${r.location ? ` · ${r.location.slice(0,40)}` : ''}\n  ${r.url}`);
  lines.push('');
}
atomicWrite(out, lines.join('\n'));
atomicWrite(out.replace(/\.md$/, '.json'), JSON.stringify(uniq, null, 2));
console.log(`\n${uniq.length} buyer signals -> ${path.basename(out)}`);
console.log(Object.fromEntries(Object.entries(byWhy).map(([k, v]) => [k, v.length])));
