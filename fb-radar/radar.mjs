/**
 * Facebook lead radar. Runs post searches (Recent filter) in YOUR logged-in browser,
 * reads the search results the page itself loads, dedupes against earlier runs,
 * LLM-scores buyer intent, and writes a queue you review by hand.
 *
 * READ-ONLY: never joins, posts, reacts, comments or messages.
 *
 * Prereqs: browser running with --remote-debugging-port=9222 and logged in to facebook.com.
 * Run:   node radar.mjs            (1x per day is plenty)
 *        node radar.mjs --max-age-days 30
 * Output: queue_fb_YYYY-MM-DD.md/.json, groups_fb_YYYY-MM-DD.md, seen.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { apiKey, settings, statePath, exportPath, atomicWrite, option, integerOption } from '../lib/runtime.mjs';
import { OpportunityStore, qualifyPending } from '../lib/opportunities.mjs';
import { modelJSON } from '../lib/qualification.mjs';
import { openTab, captureGraphql, sleep } from './cdp.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PACK_FILE = option('--searches', 'searches.json');
const PACK = path.basename(PACK_FILE, '.json').replace(/^searches-?/, '');
const TAG = PACK ? `_${PACK}` : '';
const SEEN_PATH = path.join(HERE, 'seen.json');
const MODEL = process.env.INCOME_SOCIAL_MODEL || settings.socialModel;
const MIN_SCORE = settings.minimumBuyerScore;
const argVal = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const MAX_AGE_DAYS = parseInt(argVal('--max-age-days', '45'), 10);
const SCROLLS = 3;
const PAUSE = () => 9000 + Math.random() * 12000;

// Facebook's "Recent posts" filter, as the search page encodes it.
const RECENT = Buffer.from(JSON.stringify({ 'recent_posts:0': JSON.stringify({ name: 'recent_posts', args: '' }) })).toString('base64');

const cut = (s, n) => Array.from(s ?? '').slice(0, n).join('').toWellFormed();


/** Walk any JSON blob and pull out search-result posts. */
function extractPosts(node, sink) {
  if (Array.isArray(node)) return node.forEach((n) => extractPosts(n, sink));
  if (!node || typeof node !== 'object') return;
  const vm = node.rendering_strategy?.view_model;
  if (vm?.__typename === 'SearchPostViewModel') {
    const story = vm.click_model?.story ?? {};
    const content = story.comet_sections?.content?.story ?? {};
    const actor = content.actors?.[0] ?? {};
    const text = content.comet_sections?.message?.story?.message?.text ?? content.message?.text ?? '';
    const url = content.comet_sections?.message?.story?.permalink_url ?? content.wwwURL ?? '';
    const id = story.post_id ?? content.post_id;
    if (id && text) {
      const group = (url.match(/facebook\.com\/groups\/([^/]+)/) || [])[1] ?? '';
      sink.set(id, {
        id, url, text: cut(text, 900),
        author: actor.name ?? '', author_url: actor.url ?? '', author_type: actor.__typename ?? '',
        group, created: story.creation_time ?? 0,
      });
    }
    return;
  }
  for (const v of Object.values(node)) extractPosts(v, sink);
}

function parseBodies(bodies, sink) {
  for (const b of bodies)
    for (const line of b.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try { extractPosts(JSON.parse(line), sink); } catch { /* partial chunk */ }
    }
}

async function runSearches(queries) {
  const tab = await openTab();
  await tab.send('Network.enable');
  const found = new Map();
  for (const [i, q] of queries.entries()) {
    const bodies = [];
    const stop = captureInto(tab, bodies);
    const url = `https://www.facebook.com/search/posts/?q=${encodeURIComponent(q)}&filters=${encodeURIComponent(RECENT)}`;
    process.stdout.write(`[${i + 1}/${queries.length}] ${q.slice(0, 50)} ... `);
    const before = found.size;
    await tab.send('Page.navigate', { url });
    await sleep(7000);
    for (let s = 0; s < SCROLLS; s++) {
      await tab.send('Runtime.evaluate', { expression: 'window.scrollBy(0, 3000)' });
      await sleep(3500 + Math.random() * 2000);
    }
    await sleep(1500);
    // First page is server-rendered into the HTML, not fetched: read it from the page's JSON scripts.
    const ssr = await tab.send('Runtime.evaluate', {
      expression: '[...document.querySelectorAll(\'script[type="application/json"]\')].map(s => s.textContent).filter(t => t.includes("SearchPostViewModel")).join("\\n")',
      returnByValue: true,
    });
    stop();
    parseBodies([...bodies, ssr.result?.value ?? ''], found);
    console.log(`+${found.size - before} posts`);
    if (i < queries.length - 1) await sleep(PAUSE());
  }
  await tab.close();
  return [...found.values()];
}

/** Parse group search results: id, name, url, public/private, members, posts per day. */
function extractGroups(node, sink) {
  if (Array.isArray(node)) return node.forEach((n) => extractGroups(n, sink));
  if (!node || typeof node !== 'object') return;
  if (node.logging_model?.module_role === 'ENTITY_GROUPS' && node.primary_snippet_text_with_entities?.text) {
    const t = node.primary_snippet_text_with_entities.text;
    const num = (m) => (m ? parseFloat(m[1]) * ({ K: 1e3, M: 1e6 }[m[2]] ?? 1) : 0);
    const id = node.logging_model.tapped_result_id;
    sink.set(id, {
      id, name: node.profile_name_with_possible_nickname ?? '', url: `https://www.facebook.com/groups/${id}/`,
      public: /^Public/.test(t), members: num(t.match(/([\d.]+)([KM]?) members/)),
      perDay: num(t.match(/([\d.]+)\+? posts? a day/)), snippet: t,
    });
    return;
  }
  for (const v of Object.values(node)) extractGroups(v, sink);
}

async function loadPage(tab, url, scrolls) {
  const bodies = [];
  const stop = captureInto(tab, bodies);
  await tab.send('Page.navigate', { url });
  await sleep(6500);
  for (let s = 0; s < scrolls; s++) {
    await tab.send('Runtime.evaluate', { expression: 'window.scrollBy(0, 3000)' });
    await sleep(3000 + Math.random() * 2000);
  }
  await sleep(1200);
  const ssr = await tab.send('Runtime.evaluate', {
    expression: '[...document.querySelectorAll(\'script[type="application/json"]\')].map(s => s.textContent).filter(t => t.includes("serpResponse") || t.includes("SearchPostViewModel")).join("\\n")',
    returnByValue: true,
  });
  stop();
  return [...bodies, ssr.result?.value ?? ''];
}

const REGISTRY = path.join(HERE, 'groups_registry.json');

async function discoverGroups(tab, pack) {
  const reg = fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) : {};
  for (const niche of pack.niches) {
    if (reg[niche] && !process.argv.includes('--rediscover')) continue;
    const sink = new Map();
    for (const b of await loadPage(tab, 'https://www.facebook.com/search/groups/?q=' + encodeURIComponent(niche), 1))
      for (const line of b.split('\n')) if (line.trim().startsWith('{')) { try { extractGroups(JSON.parse(line), sink); } catch {} }
    reg[niche] = [...sink.values()].filter((g) => g.public && g.members >= (pack.minMembers ?? 5000))
      .sort((a, b) => (b.perDay - a.perDay) || (b.members - a.members)).slice(0, pack.groupsPerNiche ?? 2);
    console.log(`groups for "${niche}": ${reg[niche].map((g) => `${g.name} (${g.snippet})`).join(' ; ') || 'none public'}`);
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
    await sleep(PAUSE());
  }
  const all = new Map();
  for (const [niche, list] of Object.entries(reg)) if (pack.niches.includes(niche)) for (const g of list) all.set(g.id, { ...g, niche });
  return [...all.values()];
}

async function runGroupSearches(pack) {
  const tab = await openTab();
  await tab.send('Network.enable');
  const groups = await discoverGroups(tab, pack);
  const found = new Map();
  const total = groups.length * pack.keywords.length;
  let n = 0;
  for (const g of groups) {
    for (const kw of pack.keywords) {
      n++;
      process.stdout.write(`[${n}/${total}] ${g.name.slice(0, 40)} :: ${kw} ... `);
      const sink = new Map();
      parseBodies(await loadPage(tab, `https://www.facebook.com/groups/${g.id}/search/?q=${encodeURIComponent(kw)}`, 1), sink);
      let added = 0;
      for (const p of sink.values()) if (!found.has(p.id)) { found.set(p.id, { ...p, group: p.group || g.id, group_name: g.name, niche: g.niche }); added++; }
      console.log(`+${added} posts`);
      await sleep(5000 + Math.random() * 6000);
    }
  }
  await tab.close();
  return [...found.values()];
}

// captureGraphql never unsubscribes, so gate it per search.
function captureInto(tab, bodies) {
  let on = true;
  const sink = { push: (x) => on && bodies.push(x.body) };
  if (!tab.__hooked) { tab.__sinks = []; captureGraphql(tab, { push: (x) => tab.__sinks.forEach((s) => s.push(x)) }); tab.__hooked = true; }
  tab.__sinks.push(sink);
  return () => { on = false; };
}

const DEFAULT_RUBRIC = `You qualify sales leads for a freelance AI-automation consultant (Jaseem). His offers: lead research/enrichment/scoring pipelines into a CRM, internal document assistants (RAG), and workflow automation (Zapier, Make, n8n, CRM setup, integrations, AI agents) for business teams.

These are Facebook posts, mostly from groups. For each, judge whether the AUTHOR is a genuine potential BUYER: a business owner or operator who needs automation, integration, CRM, chatbot or AI-agent work done for their own business, or is asking to hire/recommend someone for it.

Mark buyer=false for:
- brand or page-style accounts publishing marketing copy: pain-point essays that end in a CTA ("send us", "link in bio", "we can help", "book a call", a website), polls that pitch a service, "Read this" posts. A real buyer asks for help and sells nothing.
- sellers and freelancers offering services ("I build automations", "DM me for", "we help businesses", portfolios, agency ads), even when written as a pain story
- job seekers and VAs looking for work, students, course/tool promotion, affiliate posts, giveaways, engagement bait
- posts asking for a human VA to do manual tasks where automation is not plausible
- crypto, MLM, adult, or obviously scammy posts

Separately, set "job": true when the post is a company or founder hiring an AI/automation/integration/full-stack engineer (employee or contractor) and the role is plausibly open to someone remote in Kazakhstan (UTC+5); country-locked roles (e.g. "Philippines only") are job=false. Job posts are buyer=false.

Score (0-100) = how likely a short, helpful message leads to a paid project: explicit hiring intent and concrete scope score highest; vague curiosity lowest.`;

async function scoreBatch(batch, key, rubric) {
  const listing = batch.map((p, i) => `[${i}] ${p.author} (${p.author_type}) in ${p.group_name || p.group || 'personal/page feed'}${p.niche ? ` (${p.niche})` : ''}\n${p.text}`).join('\n---\n');
  const prompt = `${rubric}\n\nReturn ONLY a JSON array, one object per post: {"i": <index>, "score": 0-100, "buyer": true/false, "job": true/false, "offer": "B"|"A"|"ops", "reason": "<one line>", "pain": "<one line, or empty>", "aware": true/false, "angle": "<one line: what a genuinely helpful reply would address>"}.\n\nPosts:\n${listing}`;
  return modelJSON(prompt, { key, model: MODEL });
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Facebook radar: --searches FILE --max-age-days N --limit N --dry --input JSON --resume --export-only --day YYYY-MM-DD'); return;
  }
  const pack = JSON.parse(fs.readFileSync(path.resolve(HERE, PACK_FILE), 'utf8'));
  const { queries = [], rubric = DEFAULT_RUBRIC } = pack;
  const maxAge = integerOption('--max-age-days', pack.maxAgeDays ?? 45, 1);
  const namespace = `facebook:${PACK || 'buyers'}`;
  const store = new OpportunityStore(statePath('opportunities.sqlite'));
  try {
    store.importLegacy(namespace, SEEN_PATH);
    let failures = 0;
    if (!process.argv.includes('--export-only')) {
      const limit = integerOption('--limit', 0);
      const posts = process.argv.includes('--resume') ? [] : option('--input')
        ? JSON.parse(fs.readFileSync(path.resolve(option('--input')), 'utf8'))
        : pack.mode === 'groups'
          ? await runGroupSearches(limit ? { ...pack, niches: pack.niches.slice(0, limit) } : pack)
          : await runSearches(limit ? queries.slice(0, limit) : queries);
      if (process.argv.includes('--dry')) { console.log(JSON.stringify(posts, null, 2)); return; }
      store.ingest(namespace, posts, p => p.created && p.created < Date.now() / 1000 - maxAge * 86400);
      if (store.pending(namespace).length) {
        const key = apiKey();
        failures = await qualifyPending(store, namespace, batch => scoreBatch(batch, key, rubric), { facebook: true });
      }
    }
    const day = option('--day', new Date().toISOString().slice(0, 10));
    const scored = store.results(namespace, day);
  const buyers = scored.filter((s) => s.buyer && s.score >= MIN_SCORE).sort((a, b) => b.score - a.score);
  const jobs = scored.filter((s) => s.job).sort((a, b) => b.created - a.created);
  const when = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : '?');
  const lines = [`# Facebook lead queue, ${day}: ${buyers.length} qualified (of ${scored.length} scored)\n`];
  for (const [n, b] of buyers.entries()) {
    lines.push(`## ${n + 1}. ${b.author} · ${b.score}/100 · ${b.offer} · ${b.group_name || b.group || 'feed'} · ${when(b.created)}`);
    lines.push(`${b.url}`);
    lines.push(`Author: ${b.author_url}`);
    lines.push(`> ${b.text.replace(/\n/g, ' ')}\n`);
    if (b.pain) lines.push(`*Pain (${b.aware ? 'aware' : 'unaware'}):* ${b.pain}`);
    lines.push(`*Why:* ${b.reason}`);
    lines.push(`*Angle:* ${b.angle}\n`);
  }
  if (jobs.length) lines.push(`\n# Remote-plausible automation/engineering roles (${jobs.length})\n`);
  for (const j of jobs) lines.push(`- ${when(j.created)} · ${j.author} · ${j.text.slice(0, 140).replace(/\n/g, ' ')}\n  ${j.url}`);
  atomicWrite(exportPath('fb-radar', `queue_fb${TAG}_${day}.md`), lines.join('\n') + '\n');
  atomicWrite(exportPath('fb-radar', `queue_fb${TAG}_${day}.json`), JSON.stringify({ buyers, jobs }, null, 2));

  // Which groups do buyers actually post in? Worth joining (by hand) for member-only posts.
  const groups = {};
  for (const s of scored) if (s.group) {
    groups[s.group] ??= { posts: 0, buyers: 0 };
    groups[s.group].posts++;
    if (s.buyer) groups[s.group].buyers++;
  }
  const ranked = Object.entries(groups).filter(([, g]) => g.buyers).sort((a, b) => b[1].buyers - a[1].buyers);
  atomicWrite(exportPath('fb-radar', `groups_fb${TAG}_${day}.md`),
    [`# Groups where buyers posted, ${day}\n`, ...ranked.map(([g, c]) => `- https://www.facebook.com/groups/${g} · ${c.buyers} buyer post(s) of ${c.posts}`)].join('\n') + '\n');
  console.log(`${buyers.length} qualified -> ${exportPath('fb-radar', `queue_fb${TAG}_${day}.md`)}`);
  if (failures) throw new Error(`${failures} records need retry; run with --resume`);
  } finally { store.close(); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
