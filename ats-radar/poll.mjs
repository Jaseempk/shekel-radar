/**
 * ATS radar — pull open roles straight from companies' applicant tracking systems.
 *
 * Job boards aggregate with a lag and miss small companies entirely. Every ATS
 * below exposes an unauthenticated JSON endpoint per company board, so once you
 * know a company's slug you see its roles the moment they are posted.
 *
 * Run:  node poll.mjs                    # all companies in companies.json
 *       node poll.mjs --remote-only      # drop roles with no remote signal
 *       node poll.mjs --match "engineer" # title filter
 *       node poll.mjs --new              # only roles unseen since last run
 *
 * Output: roles_YYYY-MM-DD.md + seen.json
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SEEN = path.join(HERE, 'seen.json');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };

const ENDPOINTS = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
  lever: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
  workable: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
  recruitee: (s) => `https://${s}.recruitee.com/api/offers/`,
};

// Each ATS shapes its payload differently; normalise to {title, location, url, remote}.
const PARSE = {
  greenhouse: (d) => (d.jobs ?? []).map((j) => ({
    title: j.title, location: j.location?.name ?? '', url: j.absolute_url,
  })),
  ashby: (d) => (d.jobs ?? []).map((j) => ({
    title: j.title, location: j.location ?? '', url: j.jobUrl ?? j.applyUrl ?? '',
  })),
  lever: (d) => (Array.isArray(d) ? d : []).map((j) => ({
    title: j.text, location: j.categories?.location ?? '', url: j.hostedUrl,
  })),
  workable: (d) => (d.jobs ?? []).map((j) => ({
    title: j.title, location: [j.city, j.country].filter(Boolean).join(', '), url: j.url,
  })),
  recruitee: (d) => (d.offers ?? []).map((j) => ({
    title: j.title, location: j.location ?? '', url: j.careers_url,
  })),
};

const REMOTE_RE = /remote|anywhere|worldwide|global|distributed|emea|apac|any timezone/i;
// Locations that rule this candidate out regardless of the word "remote".
const EXCLUDE_RE = /united states only|us only|usa only|onsite|on-site|hybrid/i;

async function fetchBoard(c) {
  const url = ENDPOINTS[c.ats]?.(c.slug);
  if (!url) return { ...c, error: `unknown ats: ${c.ats}` };
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'job-search/1.0' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ...c, error: `HTTP ${r.status}` };
    return { ...c, roles: PARSE[c.ats](await r.json()) };
  } catch (e) {
    return { ...c, error: e.message.slice(0, 60) };
  }
}

const { companies } = JSON.parse(fs.readFileSync(path.join(HERE, 'companies.json'), 'utf8'));
const seen = fs.existsSync(SEEN) ? new Set(JSON.parse(fs.readFileSync(SEEN, 'utf8'))) : new Set();

// Modest concurrency: these are other people's servers.
const results = [];
for (let i = 0; i < companies.length; i += 5) {
  results.push(...await Promise.all(companies.slice(i, i + 5).map(fetchBoard)));
  await new Promise((r) => setTimeout(r, 400));
}

const match = val('--match', '').toLowerCase();
let rows = [];
let errors = [];
for (const r of results) {
  if (r.error) { errors.push(`${r.name}: ${r.error}`); continue; }
  for (const role of r.roles) {
    const loc = role.location || '';
    const remote = REMOTE_RE.test(loc) || REMOTE_RE.test(role.title);
    if (flag('--remote-only') && (!remote || EXCLUDE_RE.test(loc))) continue;
    if (match && !role.title.toLowerCase().includes(match)) continue;
    const id = `${r.name}::${role.title}::${loc}`;
    if (flag('--new') && seen.has(id)) continue;
    rows.push({ company: r.name, ...role, remote, id });
  }
}

rows.forEach((r) => seen.add(r.id));
fs.writeFileSync(SEEN, JSON.stringify([...seen]));

const day = new Date().toISOString().slice(0, 10);
const out = path.join(HERE, `roles_${day}.md`);
const byCompany = {};
for (const r of rows) (byCompany[r.company] ??= []).push(r);
const lines = [`# ATS roles — ${day} — ${rows.length} roles across ${Object.keys(byCompany).length} companies\n`];
for (const [company, list] of Object.entries(byCompany)) {
  lines.push(`## ${company}`);
  for (const r of list) lines.push(`- **${r.title}** · ${r.location || 'no location'}${r.remote ? ' · REMOTE' : ''}\n  ${r.url}`);
  lines.push('');
}
fs.writeFileSync(out, lines.join('\n'));
fs.writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(rows, null, 2));

console.log(`${rows.length} roles across ${Object.keys(byCompany).length} companies -> ${path.basename(out)}`);
if (errors.length) console.log(`\n${errors.length} board(s) failed (wrong slug or private):\n  ` + errors.join('\n  '));
