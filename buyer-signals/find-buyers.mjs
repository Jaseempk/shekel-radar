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
 * Run:  node find-buyers.mjs [--max-age-days N]
 *       node find-buyers.mjs --ats --limit 400
 *
 * Qualification here is title-only (lib/buyers.mjs classify). Unlike the Workable
 * collector these rows carry no company website and no description evidence, so
 * outreach treats them as unresolved until a reviewed domain mapping is supplied.
 * Jobs are deduplicated by source identity and filtered by posting age where the
 * source reports a posting date; rows without one are kept but flagged unknown.
 *
 * Output: buyers_YYYY-MM-DD.md + .json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchBoard } from '../lib/ats.mjs';
import { classify } from '../lib/buyers.mjs';
import { exportPath, atomicWrite, integerOption, runStamp } from '../lib/runtime.mjs';
import { DEFAULT_MAX_AGE_DAYS, parsePostedAt, freshness, dedupeByIdentity } from '../lib/signals.mjs';
import { fileURLToPath } from 'node:url';

export async function main() {
  if (process.argv.includes('--help')) { console.log(`Buyer signals: --feeds (default) | --ats --limit N; --max-age-days N (default ${DEFAULT_MAX_AGE_DAYS}, by posting date). Title-only qualification. Results: exports/buyer-signals.`); return; }

  const HERE = path.dirname(fileURLToPath(import.meta.url));
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
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return await r.json();
    } catch (e) { errors.push(e.message); return null; }
  }

  const maxAgeDays = integerOption('--max-age-days', DEFAULT_MAX_AGE_DAYS, 0);
  const now = new Date();
  const fetchedAt = now.toISOString();
  const errors = [];
  const rows = [];
  const push = (company, title, url, source, location = '', { sourceId = null, posted = null } = {}) => {
    const c = classify(title || '');
    if (!c) return;
    const identity = sourceId ?? url ?? `${company}::${title}`;
    rows.push({ company: company || '?', title, url, source, location, sourceId: sourceId == null ? null : String(sourceId),
      jobId: `${source}:${identity}`, postedAt: parsePostedAt(posted, now), fetchedAt, queries: [source], qualification: { status: 'title-only' }, ...c });
  };

  // ---------- free aggregator feeds ----------
  async function feeds() {
    const rok = await getJson('https://remoteok.com/api');
    for (const j of (rok ?? []).filter((x) => x && x.position))
      push(j.company, j.position, j.url || j.apply_url, 'RemoteOK', j.location, { sourceId: j.id, posted: j.date ?? j.epoch });

    const arb = await getJson('https://www.arbeitnow.com/api/job-board-api');
    for (const j of (arb?.data ?? []))
      push(j.company_name, j.title, j.url, 'Arbeitnow', (j.location || ''), { sourceId: j.slug, posted: j.created_at });

    const rmv = await getJson('https://remotive.com/api/remote-jobs');
    for (const j of (rmv?.jobs ?? []))
      push(j.company_name, j.title, j.url, 'Remotive', j.candidate_required_location, { sourceId: j.id, posted: j.publication_date });

    const him = await getJson('https://himalayas.app/jobs/api');
    for (const j of (him?.jobs ?? []))
      push(j.companyName, j.title, j.applicationLink || j.guid, 'Himalayas', (j.locationRestrictions || []).join(', '), { sourceId: j.guid, posted: j.pubDate });
  }

  // ---------- company ATS boards ----------
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
        try {
          for (const j of await fetchBoard(ats_, slug)) push(slug, j.title, j.url, `ATS:${ats_}`, j.location, { sourceId: j.sourceId, posted: j.postedAt });
        } catch (e) { errors.push(e.message); }
      }));
      done += CONC;
      if (done % 300 < CONC) process.stdout.write(`  ${Math.min(done, take.length)}/${take.length}\n`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (flag('--ats')) await ats(); else await feeds();

  // Dedupe by source identity (distinct same-title jobs stay distinct), then filter by posting age.
  const excluded = [];
  const uniq = [];
  for (const r of dedupeByIdentity(rows)) {
    const f = freshness(r.postedAt, now, maxAgeDays);
    const row = { ...r, freshness: f.freshness, ageDays: f.ageDays, ...(f.reason ? { freshnessReason: f.reason } : {}) };
    if (f.freshness === 'stale') excluded.push({ ...row, excludedReason: f.reason }); else uniq.push(row);
  }
  const FRESH = { fresh: 0, unknown: 1 };
  uniq.sort((a, b) => b.score - a.score || FRESH[a.freshness] - FRESH[b.freshness] || String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? '')));

  const day = runStamp();
  const out = exportPath('buyer-signals', `buyers_${day}.md`);
  const lines = [`# Buyer signals — ${day} — ${uniq.length} postings with automatable-sounding titles\n`,
    `Title-only matches: duties, buying intent and budget are unverified. Posting-age cutoff ${maxAgeDays} days; ${excluded.length} older postings excluded (see .evidence.json).\n`];
  const byWhy = {};
  for (const r of uniq) (byWhy[r.why] ??= []).push(r);
  for (const [why, list] of Object.entries(byWhy)) {
    lines.push(`## ${why} (${list.length})`);
    for (const r of list) lines.push(`- **${r.company}** — ${r.title}${r.location ? ` · ${r.location.slice(0,40)}` : ''} · ${r.freshness === 'fresh' ? `posted ${r.ageDays}d ago` : 'posting date unknown'}\n  ${r.url}`);
    lines.push('');
  }
  atomicWrite(out, lines.join('\n'));
  atomicWrite(out.replace(/\.md$/, '.json'), JSON.stringify(uniq, null, 2));
  atomicWrite(out.replace(/\.md$/, '.evidence.json'), JSON.stringify({ maxAgeDays, collectedAt: fetchedAt, excluded }, null, 2));
  console.log(`\n${uniq.length} buyer signals (${excluded.length} older than ${maxAgeDays}d excluded) -> ${out.replace(/\.md$/, '.json')}`);
  console.log(Object.fromEntries(Object.entries(byWhy).map(([k, v]) => [k, v.length])));

  atomicWrite(out.replace(/\.md$/, '.status.json'), JSON.stringify({ errors, count: uniq.length, excludedStale: excluded.length, unknownDates: uniq.filter(r => r.freshness === 'unknown').length, maxAgeDays, qualification: 'title-only' }, null, 2));
  if (errors.length) { console.error(`${errors.length} sources failed; see status snapshot`); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
