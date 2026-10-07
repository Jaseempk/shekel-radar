/**
 * Rank every role we've collected into one queue, scored for THIS candidate.
 *
 * Merges the three pipelines (company ATS boards, VC talent networks, founder
 * hiring posts on X), removes duplicates, drops roles that are not actually
 * reachable from UTC+5, and sorts by fit.
 *
 * Run:  node rank.mjs                # top 40
 *       node rank.mjs --top 100
 *       node rank.mjs --include-maybe # keep ambiguous-geography roles too
 *
 * Output: shortlist_YYYY-MM-DD.md
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
const argv = process.argv.slice(2);
const TOP = parseInt((argv[argv.indexOf('--top') + 1] ?? '40'), 10);
const INCLUDE_MAYBE = argv.includes('--include-maybe');

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const newest = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)).sort().pop() : null);

// ---------- load the three pipelines into one shape ----------
const roles = [];

const atsFile = newest(HERE, /^roles_\d{4}-\d{2}-\d{2}\.json$/);
for (const r of (atsFile ? readJson(path.join(HERE, atsFile)) : []) ?? []) {
  roles.push({ source: 'ATS', company: r.company, title: r.title, location: r.location || '', url: r.url, age: null });
}

const getroFile = newest(HERE, /^getro_\d{4}-\d{2}-\d{2}\.json$/);
for (const r of (getroFile ? readJson(path.join(HERE, getroFile)) : []) ?? []) {
  roles.push({
    source: `VC:${r.fund}`, company: r.company, title: r.title, location: r.locations || '',
    url: r.url, stage: r.stage, age: r.created ? Math.floor((Date.now() / 1000 - r.created) / 86400) : null,
  });
}

const xDir = path.join(ROOT, 'x-radar');
const xFile = newest(xDir, /^queue_jobs_\d{4}-\d{2}-\d{2}\.json$/);
for (const r of (xFile ? readJson(path.join(xDir, xFile)) : []) ?? []) {
  roles.push({
    source: 'X', company: `@${r.screen_name}`, title: (r.text || '').split('\n')[0].slice(0, 90),
    location: '', url: r.url, xScore: r.score, replies: r.replies,
    age: r.id ? Math.floor((Date.now() - (Number(BigInt(r.id) >> 22n) + 1288834974657)) / 86400000) : null,
  });
}

// ---------- geography: what can he actually take from UTC+5 ----------
const GOOD_GEO = /worldwide|anywhere|global|remote \(global\)|emea|europe|any ?time ?zone|async|international|apac|asia|middle east|dubai|uae|kazakh|singapore|india/i;
const HARD_NO = /united states only|us only|usa only|u\.s\. only|must reside in|authorized to work in the (us|united states)|citizen|clearance|onsite|on-site|hybrid/i;
// Country-locked remote: "Remote, India" style. Remote but not for him.
const COUNTRY_LOCK = /remote,? ?\((?!global|emea|europe|worldwide)/i;

function geo(loc, title) {
  const s = `${loc} ${title}`;
  if (HARD_NO.test(s)) return 'no';
  if (GOOD_GEO.test(s)) return 'yes';
  if (/^remote$/i.test(loc.trim()) || /remote/i.test(s)) return 'maybe';  // bare "Remote" — worth checking
  return 'maybe';
}

// ---------- fit scoring ----------
const ROLE_TIERS = [
  [/forward.?deployed|\bfde\b/i, 40, 'FDE'],
  [/founding engineer|founding .*engineer|first engineer/i, 35, 'founding'],
  [/customer engineer|solutions engineer|applied ai|ai engineer|llm engineer/i, 30, 'AI/customer'],
  [/agent|rag|\bllm\b|machine learning/i, 22, 'AI-adjacent'],
  [/full.?stack|product engineer|software engineer|backend|typescript|react/i, 14, 'full-stack'],
  [/integration|automation|data engineer|platform engineer/i, 12, 'adjacent'],
];
const NEGATIVE = /intern|internship|principal|staff engineer, |director|vp |head of|manager|designer|marketing|sales rep|recruiter|analyst|scientist/i;

function score(r) {
  let s = 0; const why = [];
  for (const [re, pts, label] of ROLE_TIERS) {
    if (re.test(r.title)) { s += pts; why.push(label); break; }
  }
  if (!why.length) return null;                       // not an engineering role we want
  if (NEGATIVE.test(r.title)) s -= 25;

  const g = geo(r.location, r.title);
  if (g === 'no') return null;
  if (g === 'yes') { s += 25; why.push('geo-ok'); }
  else { s += 5; why.push('geo-check'); }

  if (/pre.?seed|seed/i.test(r.stage ?? '')) { s += 12; why.push('early-stage'); }
  if (r.source.startsWith('VC')) { s += 8; why.push('own-careers-page'); }
  if (r.source === 'X') {
    s += 6; why.push('founder-post');
    if ((r.replies ?? 99) <= 5) { s += 8; why.push('uncontested'); }
  }
  if (r.age != null) {
    if (r.age <= 7) { s += 10; why.push('fresh'); }
    else if (r.age <= 21) s += 4;
    else if (r.age > 45) s -= 8;
  }
  return { ...r, score: s, why, geoFlag: g };
}

const scored = roles.map(score).filter(Boolean)
  .filter((r) => INCLUDE_MAYBE || r.geoFlag === 'yes' || r.source === 'X');

// dedupe: same company + near-same title
const seen = new Set();
const unique = scored.filter((r) => {
  const k = `${(r.company || '').toLowerCase()}::${r.title.toLowerCase().replace(/[^a-z]/g, '').slice(0, 30)}`;
  if (seen.has(k)) return false;
  seen.add(k); return true;
});
unique.sort((a, b) => b.score - a.score);

const day = new Date().toISOString().slice(0, 10);
const out = path.join(HERE, `shortlist_${day}.md`);
const lines = [
  `# Ranked shortlist — ${day}`,
  `${unique.length} roles scored from ${roles.length} collected. Showing top ${Math.min(TOP, unique.length)}.`,
  `Scored on role shape, whether it is genuinely reachable from UTC+5, freshness, stage, and how uncontested it is.`,
  `\`geo-check\` means the posting just says "Remote" — verify eligibility before investing time.\n`,
];
for (const [i, r] of unique.slice(0, TOP).entries()) {
  lines.push(`## ${i + 1}. ${r.title}  · ${r.score}pts`);
  lines.push(`**${r.company}**${r.stage ? ` · ${r.stage}` : ''} · ${r.source}${r.age != null ? ` · ${r.age}d old` : ''}${r.replies != null ? ` · ${r.replies} replies` : ''}`);
  if (r.location) lines.push(`📍 ${r.location.slice(0, 110)}`);
  lines.push(`${r.url}`);
  lines.push(`_${r.why.join(' · ')}_\n`);
}
fs.writeFileSync(out, lines.join('\n'));
console.log(`${roles.length} collected -> ${unique.length} viable -> ${path.basename(out)} (top ${TOP})`);
const byWhy = {};
unique.slice(0, TOP).forEach((r) => { const k = r.why[0]; byWhy[k] = (byWhy[k] ?? 0) + 1; });
console.log('shortlist by role type:', byWhy);
