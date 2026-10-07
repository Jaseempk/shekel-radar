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
import { exportPath, atomicWrite, integerOption, settings } from '../lib/runtime.mjs';
import { fileURLToPath } from 'node:url';

export async function main() {
  if (process.argv.includes('--help')) { console.log('Rank jobs: --top N --include-maybe --max-source-age-days N. Reads exports/ats-radar and exports/x-radar.'); return; }

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.join(HERE, '..');
  const argv = process.argv.slice(2);
  const TOP = integerOption('--top', 40, 1);
  const MAX_SOURCE_AGE = integerOption('--max-source-age-days', 30, 1);
  const INCLUDE_MAYBE = argv.includes('--include-maybe');

  const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  const newest = (dir, re) => {
    const file = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => re.test(f)).sort().pop() : null;
    if (!file) { console.error(`No snapshots in ${dir}`); return null; }
    if (Date.now() - Date.parse(file.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '1970-01-01') > MAX_SOURCE_AGE * 86400000) {
      console.error(`Ignoring stale snapshot: ${file}`); return null;
    }
    return file;
  };
  const ATS_DIR = exportPath('ats-radar');

  // ---------- load the three pipelines into one shape ----------
  const roles = [];

  const atsFile = newest(ATS_DIR, /^roles_[0-9T:.Z-]+(?:-[a-f0-9]{8})?\.json$/);
  for (const r of (atsFile ? readJson(path.join(ATS_DIR, atsFile)) : []) ?? []) {
    if (r.collectionStatus === 'stale' || (r.observedAt && Date.now() - Date.parse(r.observedAt) > MAX_SOURCE_AGE * 86400000)) continue;
    roles.push({ source: 'ATS', company: r.company, title: r.title, location: r.location || '', url: r.url, age: null });
  }

  const getroFile = newest(ATS_DIR, /^getro_[0-9T:.Z-]+(?:-[a-f0-9]{8})?\.json$/);
  for (const r of (getroFile ? readJson(path.join(ATS_DIR, getroFile)) : []) ?? []) {
    roles.push({
      source: `VC:${r.fund}`, company: r.company, title: r.title, location: r.locations || '',
      url: r.url, stage: r.stage, age: r.created ? Math.floor((Date.now() / 1000 - r.created) / 86400) : null,
    });
  }

  const xDir = exportPath('x-radar');
  const xFile = newest(xDir, /^queue_jobs_\d{4}-\d{2}-\d{2}\.json$/);
  for (const r of (xFile ? readJson(path.join(xDir, xFile)) : []) ?? []) {
    roles.push({
      source: 'X', company: `@${r.screen_name}`, title: (r.text || '').split('\n')[0].slice(0, 90),
      location: '', url: r.url, xScore: r.score, replies: r.replies,
      age: r.id ? Math.floor((Date.now() - (Number(BigInt(r.id) >> 22n) + 1288834974657)) / 86400000) : null,
    });
  }

  // ---------- geography: what can he actually take from UTC+5 ----------
  // Location compatibility alone does not establish work authorization.
  const HARD_NO = /united states only|us only|usa only|u\.s\. only|must reside in|authorized to work in|citizen|clearance|onsite|on-site|hybrid/i;
  function geo(loc, title) {
    const s = `${loc} ${title}`;
    if (HARD_NO.test(s)) return 'no';
    if (/worldwide|anywhere|global|any ?time ?zone/i.test(s)) return 'yes';
    // Country and broad region matches stay tentative until eligibility is verified.
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
  const out = exportPath('ats-radar', `shortlist_${day}.md`);
  const lines = [
    `# Ranked shortlist — ${day}`,
    `${unique.length} roles scored from ${roles.length} collected. Showing top ${Math.min(TOP, unique.length)}.`,
    `Scored on role shape, whether it is ${settings.candidateLocation} eligibility, freshness, stage, and how uncontested it is.`,
    `\`geo-check\` means the posting just says "Remote" — verify eligibility before investing time.\n`,
  ];
  for (const [i, r] of unique.slice(0, TOP).entries()) {
    lines.push(`## ${i + 1}. ${r.title}  · ${r.score}pts`);
    lines.push(`**${r.company}**${r.stage ? ` · ${r.stage}` : ''} · ${r.source}${r.age != null ? ` · ${r.age}d old` : ''}${r.replies != null ? ` · ${r.replies} replies` : ''}`);
    if (r.location) lines.push(`📍 ${r.location.slice(0, 110)}`);
    lines.push(`${r.url}`);
    lines.push(`_${r.why.join(' · ')}_\n`);
  }
  atomicWrite(out, lines.join('\n'));
  console.log(`${roles.length} collected -> ${unique.length} viable -> ${path.basename(out)} (top ${TOP})`);
  const byWhy = {};
  unique.slice(0, TOP).forEach((r) => { const k = r.why[0]; byWhy[k] = (byWhy[k] ?? 0) + 1; });
  console.log('shortlist by role type:', byWhy);

  if (!roles.length) { console.error('No usable observations. Collect jobs or regenerate social exports first.'); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
