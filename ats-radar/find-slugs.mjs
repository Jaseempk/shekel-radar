/**
 * ATS slug prober — turn a list of company NAMES into verified ATS board slugs.
 *
 * The poller needs {name, ats, slug}. Getting slugs is the only hard part, and
 * guessing is cheap: most companies use a normalised form of their own name, and
 * a wrong guess is a 404 that costs nothing. This tries several name variants
 * against every ATS we support and keeps only boards that actually answer with
 * at least one job.
 *
 * Run:  node find-slugs.mjs names.txt            # one company name per line
 *       node find-slugs.mjs names.txt --merge    # append hits into companies.json
 *
 * Output: found-slugs.json (and optionally merged into companies.json)
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const namesFile = argv.find((a) => !a.startsWith('--'));
if (!namesFile) { console.error('usage: node find-slugs.mjs <names.txt> [--merge]'); process.exit(1); }

// Ordered deliberately: research on early-stage AI startups found ~90% of boards
// on Ashby, so probing it first cuts the request count dramatically.
// SmartRecruiters is omitted on purpose: its robots.txt disallows automated collection.
const ENDPOINTS = {
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
  lever: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
  rippling: (s) => `https://api.rippling.com/platform/api/ats/v1/board/${s}/jobs`,
  teamtailor: (s) => `https://${s}.teamtailor.com/jobs.json`,
  breezy: (s) => `https://${s}.breezy.hr/json`,
  recruitee: (s) => `https://${s}.recruitee.com/api/offers/`,
};

const countJobs = {
  ashby: (d) => (d.jobs ?? []).length,
  greenhouse: (d) => (d.jobs ?? []).length,
  lever: (d) => (Array.isArray(d) ? d.length : 0),
  rippling: (d) => (Array.isArray(d) ? d.length : 0),
  teamtailor: (d) => (d.items ?? []).length,
  breezy: (d) => (Array.isArray(d) ? d.length : 0),
  recruitee: (d) => (d.offers ?? []).length,
};

/** Name variants companies actually use for their board slug. */
function variants(name) {
  const base = name.trim();
  const lower = base.toLowerCase();
  const alnum = lower.replace(/[^a-z0-9]+/g, '');
  const dashed = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const noSuffix = dashed.replace(/-(ai|inc|labs|hq|io|com|technologies|technology)$/, '');
  return [...new Set([alnum, dashed, noSuffix, base.replace(/\s+/g, ''), base])].filter(Boolean);
}

async function probe(ats, slug) {
  try {
    const r = await fetch(ENDPOINTS[ats](slug), {
      headers: { 'User-Agent': 'job-search/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return 0;
    return countJobs[ats](await r.json());
  } catch { return 0; }
}

const names = fs.readFileSync(namesFile, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
console.log(`Probing ${names.length} companies across ${Object.keys(ENDPOINTS).length} ATS platforms...\n`);

const found = [];
for (const [i, name] of names.entries()) {
  let hit = null;
  outer:
  for (const slug of variants(name)) {
    for (const ats of Object.keys(ENDPOINTS)) {
      const n = await probe(ats, slug);
      if (n > 0) { hit = { name, ats, slug, openRoles: n }; break outer; }
    }
  }
  if (hit) { found.push(hit); console.log(`  ✓ ${name} -> ${hit.ats}/${hit.slug} (${hit.openRoles} roles)`); }
  else console.log(`  · ${name} — no public board found`);
  await new Promise((r) => setTimeout(r, 250)); // ~1 company/sec, well under any limit
}

fs.writeFileSync(path.join(HERE, 'found-slugs.json'), JSON.stringify(found, null, 2));
console.log(`\n${found.length}/${names.length} boards found -> found-slugs.json`);

if (argv.includes('--merge')) {
  const p = path.join(HERE, 'companies.json');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const have = new Set(doc.companies.map((c) => `${c.ats}:${c.slug}`));
  const added = found.filter((f) => !have.has(`${f.ats}:${f.slug}`))
                     .map(({ name, ats, slug }) => ({ name, ats, slug }));
  doc.companies.push(...added);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  console.log(`merged ${added.length} new companies into companies.json (now ${doc.companies.length})`);
}
