/**
 * Funnel 2 — Workable global job search.
 *
 * Unlike the ATS sweep this needs no slug enumeration: Workable exposes a
 * cross-company keyword search, and every hit carries the company's own website,
 * which removes the domain-guessing step that sent one draft to the wrong Kojo.
 *
 * Population skews SMB and Europe, so it surfaces the businesses that actually
 * employ people to do data entry, rather than venture-backed tech.
 *
 * Run:  node workable.mjs
 *       node workable.mjs --pages 4
 * Out:  workable_YYYY-MM-DD.md + .json
 */
import fs from 'node:fs';
import path from 'node:path';
import { classify } from '../lib/buyers.mjs';
import { exportPath, atomicWrite, integerOption, runStamp } from '../lib/runtime.mjs';
import { fileURLToPath } from 'node:url';

export async function main() {
  if (process.argv.includes('--help')) { console.log('Workable buyer signals: --pages N. Results: exports/buyer-signals.'); return; }

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const argv = process.argv.slice(2);
  const PAGES = integerOption('--pages', 6, 1);

  const QUERIES = [
    'data entry', 'lead generation', 'list building', 'prospect research',
    'back office', 'data processing', 'order processing', 'invoice processing',
    'billing specialist', 'claims processing', 'sales development representative',
    'appointment setter', 'data annotation', 'document processing',
  ];


  const errors = [];
  const rows = [];
  for (const q of QUERIES) {
    let token = null, got = 0;
    for (let p = 0; p < PAGES; p++) {
      const url = `https://jobs.workable.com/api/v1/jobs?query=${encodeURIComponent(q)}&limit=20`
                + (token ? `&pageToken=${encodeURIComponent(token)}` : '');
      let d;
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        d = await r.json();
        if (!Array.isArray(d.jobs)) throw new Error('Unexpected Workable response');
      } catch (e) { errors.push({ query: q, page: p, error: e.message }); break; }
      const jobs = d.jobs;
      if (!jobs.length) break;
      for (const j of jobs) {
        const c = classify(j.title ?? '');
        if (!c) continue;
        const loc = j.location ?? {};
        rows.push({
          company: j.company?.title ?? '?',
          website: (j.company?.website ?? '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''),
          title: j.title,
          url: j.url,
          location: [loc.city, loc.countryName].filter(Boolean).join(', '),
          created: j.created ?? '',
          ...c,
        });
        got++;
      }
      token = d.nextPageToken;
      if (!token) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    console.log(`  ${q.padEnd(34)} +${got}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  // one row per company, keep its strongest signal
  const byCo = new Map();
  for (const r of rows) {
    const k = (r.company || '').toLowerCase();
    const prev = byCo.get(k);
    if (!prev) byCo.set(k, { ...r, roles: [r] });
    else { if (!prev.roles.some(role => role.url === r.url)) prev.roles.push(r); if (r.score > prev.score) Object.assign(prev, r, { roles: prev.roles }); }
  }
  const uniq = [...byCo.values()].filter((r) => r.website).sort((a, b) => b.score - a.score || b.roles.length - a.roles.length);

  const day = runStamp();
  const out = exportPath('buyer-signals', `workable_${day}.md`);
  const lines = [`# Workable buyer signals — ${day}`,
    `${uniq.length} companies with a website attached, from ${rows.length} matching postings.`,
    `Company websites come straight from the API, so no domain guessing.\n`];
  for (const r of uniq) {
    lines.push(`## ${r.company}  ·  ${r.score}pts  ·  ${r.why}`);
    lines.push(`**${r.website}**${r.location ? ` · ${r.location}` : ''} · ${r.roles.length} matching role${r.roles.length > 1 ? 's' : ''}`);
    for (const j of r.roles.slice(0, 3)) lines.push(`- ${j.title}\n  ${j.url}`);
    lines.push('');
  }
  atomicWrite(out, lines.join('\n'));
  atomicWrite(out.replace(/\.md$/, '.json'), JSON.stringify(uniq, null, 2));
  console.log(`\n${rows.length} postings -> ${uniq.length} companies -> ${path.basename(out)}`);

  atomicWrite(out.replace(/\.md$/, '.status.json'), JSON.stringify({ errors }, null, 2));
  if (errors.length) { console.error(`${errors.length} searches failed; see status snapshot`); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
