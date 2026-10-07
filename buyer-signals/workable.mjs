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

const HERE = path.dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const PAGES = parseInt((argv[argv.indexOf('--pages') + 1] ?? '6'), 10);

const QUERIES = [
  'data entry', 'lead generation', 'list building', 'prospect research',
  'back office', 'data processing', 'order processing', 'invoice processing',
  'billing specialist', 'claims processing', 'sales development representative',
  'appointment setter', 'data annotation', 'document processing',
];

const SIGNALS = [
  [/lead gen(eration)?\b|list build|prospect(ing| research)|sales research|data enrich|contact discovery/i, 10, 'Offer B — lead pipeline'],
  [/data entry|data processing|data annotation|data clean|order (entry|processing)|back.?office|document processing|transcription/i, 10, 'back-office data work'],
  [/invoice processing|accounts payable|billing (specialist|clerk)|claims processing|payroll (clerk|administrator)|reconciliation/i, 9, 'processing busywork'],
  [/\bsdr\b|\bbdr\b|sales development rep|appointment setter|cold call/i, 8, 'manual prospecting'],
];
const NEGATIVE = new RegExp([
  'engineer','developer','scientist','architect','devops','\\bqa\\b',
  'nurse','clinical','medical','phlebotom','patient','physician','therapist','pharmac','caregiver',
  'babysit','nanny','childcare','teacher','tutor','instructor',
  'driver','warehouse','technician','mechanic','electric','plumb','construction worker','janitor',
  'attorney','counsel','paralegal','chef','cook','barista','cashier',
  'intern\\b','internship','volunteer','director','\\bvp\\b','head of','chief ',
].join('|'), 'i');
const DOER = /associate|assistant|coordinator|representative|\bagent\b|junior|\bjr\b|specialist|clerk|administrator|officer/i;
const LEADER = /manager|director|\bhead\b|principal|senior|\bsr\.?\b|chief|vp\b|strategist|lead\b/i;

function classify(title) {
  if (NEGATIVE.test(title)) return null;
  for (const [re, base, why] of SIGNALS) {
    if (!re.test(title)) continue;
    let s = base + (DOER.test(title) ? 3 : 0) - (LEADER.test(title) ? 5 : 0);
    return s >= 8 ? { score: s, why } : null;
  }
  return null;
}

const rows = [];
for (const q of QUERIES) {
  let token = null, got = 0;
  for (let p = 0; p < PAGES; p++) {
    const url = `https://jobs.workable.com/api/v1/jobs?query=${encodeURIComponent(q)}&limit=20`
              + (token ? `&pageToken=${encodeURIComponent(token)}` : '');
    let d;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
      if (!r.ok) break;
      d = await r.json();
    } catch { break; }
    const jobs = d.jobs ?? [];
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
  else { prev.roles.push(r); if (r.score > prev.score) Object.assign(prev, r, { roles: prev.roles }); }
}
const uniq = [...byCo.values()].filter((r) => r.website).sort((a, b) => b.score - a.score || b.roles.length - a.roles.length);

const day = new Date().toISOString().slice(0, 10);
const out = path.join(HERE, `workable_${day}.md`);
const lines = [`# Workable buyer signals — ${day}`,
  `${uniq.length} companies with a website attached, from ${rows.length} matching postings.`,
  `Company websites come straight from the API, so no domain guessing.\n`];
for (const r of uniq) {
  lines.push(`## ${r.company}  ·  ${r.score}pts  ·  ${r.why}`);
  lines.push(`**${r.website}**${r.location ? ` · ${r.location}` : ''} · ${r.roles.length} matching role${r.roles.length > 1 ? 's' : ''}`);
  for (const j of r.roles.slice(0, 3)) lines.push(`- ${j.title}\n  ${j.url}`);
  lines.push('');
}
fs.writeFileSync(out, lines.join('\n'));
fs.writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(uniq, null, 2));
console.log(`\n${rows.length} postings -> ${uniq.length} companies -> ${path.basename(out)}`);
