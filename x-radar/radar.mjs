/**
 * X lead radar — runs the saved live searches in YOUR logged-in browser session,
 * captures the SearchTimeline GraphQL responses the page itself loads, dedupes
 * against everything already seen, LLM-scores buyer intent, and appends a daily
 * queue markdown you review by hand.
 *
 * READ-ONLY by design: it never posts, likes, follows, or DMs. Posting stays manual.
 *
 * Prereqs:
 *   1. Quit Brave, relaunch with the debug port:
 *        open -a "Brave Browser" --args --remote-debugging-port=9222
 *      (Chrome works too: open -a "Google Chrome" --args --remote-debugging-port=9222)
 *   2. Be logged in to x.com in that browser.
 *   3. ANTHROPIC_API_KEY in ../reddit-mining/.env (already there).
 *
 * Run (1-2x per day, no more):  node radar.mjs
 * Output: queue_YYYY-MM-DD.md (best first) + seen.json (dedupe state)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey, settings, statePath, exportPath, atomicWrite, option, integerOption } from '../lib/runtime.mjs';
import { OpportunityStore, qualifyPending } from '../lib/opportunities.mjs';
import { modelJSON } from '../lib/qualification.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { openTab, sleep } from '../lib/cdp.mjs';
const SEARCH_FILE = option('--searches', 'searches.json');
const __pack = path.basename(SEARCH_FILE, '.json').replace(/^searches-?/, '');
const SEEN_PATH = path.join(HERE, __pack ? `seen_${__pack}.json` : 'seen.json');
const MODEL = process.env.INCOME_SOCIAL_MODEL || settings.socialModel;
const MIN_SCORE = settings.minimumBuyerScore;
const MAX_AGE_DAYS = integerOption('--max-age-days', 45, 1);
const MAX_REPLIES = integerOption('--max-replies', Number.MAX_SAFE_INTEGER);
const SCROLLS_PER_SEARCH = 2;          // stay light: first page + two scrolls
const PAUSE_BETWEEN_SEARCHES = () => 8000 + Math.random() * 12000;


const cut = (s, n) => Array.from(s ?? '').slice(0, n).join('').toWellFormed();

function extractTweets(json, sink) {
  const timeline = json?.data?.search_by_raw_query?.search_timeline?.timeline;
  const instructions = timeline?.instructions ?? [];
  for (const inst of instructions) {
    const entries = inst.type === 'TimelineAddEntries' ? inst.entries ?? [] : [];
    for (const entry of entries) {
      if (!entry.entryId?.startsWith('tweet-')) continue;
      let result = entry.content?.itemContent?.tweet_results?.result;
      if (result?.__typename === 'TweetWithVisibilityResults') result = result.tweet;
      if (!result?.legacy) continue;
      const legacy = result.legacy;
      const user = result.core?.user_results?.result;
      const screen = user?.core?.screen_name ?? user?.legacy?.screen_name ?? '';
      const followers = user?.relationship_counts?.followers ?? user?.legacy?.followers_count ?? 0;
      const bio = user?.profile_bio?.description ?? user?.legacy?.description ?? '';
      const location = user?.location?.location ?? user?.legacy?.location ?? '';
      const text = result.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text ?? '';
      sink.set(result.rest_id, {
        id: result.rest_id,
        url: `https://x.com/${screen || 'i'}/status/${result.rest_id}`,
        screen_name: screen,
        bio: cut(bio, 200),
        followers,
        location,
        created_at: legacy.created_at,
        text: cut(text, 600),
        replies: legacy.reply_count ?? 0,
      });
    }
  }
}

function dayStamp(offset) {
  const d = new Date(Date.now() - offset * 86400000);
  return d.toISOString().slice(0, 10);
}


async function runSearches() {
  // --searches <file>: alternate search pack (e.g. searches-jobs.json). Default: searches.json
  const sIdx = process.argv.indexOf('--searches');
  const searchFile = SEARCH_FILE;
  const pack = JSON.parse(fs.readFileSync(path.join(HERE, searchFile), 'utf8'));
  const baseQueries = pack.queries;
  globalThis.__rubric = pack.rubric?.replaceAll('{{candidateLocation}}', settings.candidateLocation) || null;

  // --backfill N: walk each query back N day-windows (one-time harvest).
  // Normal runs use the plain live search (the newest slice).
  const bfArg = process.argv.find((a) => a.startsWith('--backfill'));
  const backfillDays = bfArg ? parseInt(bfArg.split('=')[1] ?? process.argv[process.argv.indexOf(bfArg) + 1] ?? '7', 10) : 0;
  let queries;
  if (backfillDays > 0) {
    queries = [];
    for (let d = backfillDays; d >= 1; d--)
      for (const q of baseQueries)
        queries.push(`${q} since:${dayStamp(d)} until:${dayStamp(d - 1)}`);
    console.log(`Backfill mode: ${baseQueries.length} queries x ${backfillDays} day-windows = ${queries.length} searches. This will take a while; leave it running.`);
  } else {
    queries = baseQueries;
  }

  const { send, on, close, drain } = await openTab();
  try {
  await send('Network.enable');
  await send('Page.enable');
  const found = new Map();

  // Capture the app's own SearchTimeline GraphQL responses.
  const wanted = new Set();
  on(async (msg) => {
    if (msg.method === 'Network.responseReceived' &&
        (msg.params.response.url || '').includes('SearchTimeline')) {
      wanted.add(msg.params.requestId);
    }
    if (msg.method === 'Network.loadingFinished' && wanted.has(msg.params.requestId)) {
      wanted.delete(msg.params.requestId);
      const r = await send('Network.getResponseBody', { requestId: msg.params.requestId });
      if (r && r.body) { try { extractTweets(JSON.parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body), found); } catch { /* not JSON */ } }
    }
  });

  for (const [i, q] of queries.entries()) {
    const url = 'https://x.com/search?q=' + encodeURIComponent(q) + '&f=live';
    process.stdout.write(`[${i + 1}/${queries.length}] ${q.slice(0, 58)} ... `);
    const before = found.size;
    await send('Page.navigate', { url });
    await sleep(5000);
    for (let sc = 0; sc < SCROLLS_PER_SEARCH; sc++) {
      await send('Runtime.evaluate', { expression: 'window.scrollBy(0, 2500)' });
      await sleep(2500 + Math.random() * 1500);
    }
    await sleep(1200); // let the last response body land
    console.log(`+${found.size - before} tweets`);
    if (i < queries.length - 1) await sleep(PAUSE_BETWEEN_SEARCHES());
  }
  await drain();
  return [...found.values()];
  } finally { await close(); }
}

async function scoreBatch(batch, key) {
  const listing = batch.map((t, i) =>
    `[${i}] @${t.screen_name} (bio: ${t.bio || 'none'})\n${t.text}`).join('\n---\n');
  const rubricHead = globalThis.__rubric ?? `You qualify sales leads for a freelance AI-automation consultant. His offers: (B) lead-enrichment/AI-scoring pipelines, (A) internal doc/RAG assistants, plus general workflow automation for business teams.

For each numbered tweet below, judge whether the AUTHOR is a genuine potential BUYER: a real business operator/owner describing manual, repetitive work in their own business that they would plausibly pay to remove. NOT a buyer: developers, automation/marketing sellers, builders showcasing tools, job seekers, students, engagement-bait, memes.

CRITICAL X-specific trap: sellers write pain-story content that MIMICS buyer posts to farm engagement. Mark buyer=false when the post: pivots from pain to a solution reveal ("here's what it looks like with the right system", "then I gave AI access and...", thread arrows like "👇"), promotes a named product or the author's own service, ends in any CTA ("DM me", "free consult", "test it now", link to their tool), is a how-I-did-it success story or guru framework ("here's the framework that got me out"), or the author's bio/handle markets automation, AI, marketing, or coaching services. A real buyer is mid-problem with no solution to sell and nothing to promote.

HIGHEST-value buyers: operators explicitly looking to hire or pay someone (freelancer, consultant, agency) to build an automation, AI assistant, integration or lead pipeline. Score these 80+ when the author is the business itself. A post asking for a recommendation counts. A post offering such services does not.`;

  const prompt = `${rubricHead}

Return ONLY a JSON array, one object per tweet: {"i": <index>, "score": 0-100, "buyer": true/false, "offer": ${__pack === 'jobs' ? '"fde"|"founding"|"ai-eng"|"fullstack"|"automation"|"referral-ask"' : '"A"|"B"|"ops"'}, "reason": "<one line>", "angle": "<one line: what a genuinely helpful reply would address>"}.

Tweets:\n${listing}`;
  return modelJSON(prompt, { key, model: MODEL });
}

export async function main() {
  if (process.argv.includes('--help')) {
    console.log('X radar: --searches FILE --max-age-days N --max-replies N --input JSON --resume --export-only --day YYYY-MM-DD'); return;
  }
  const namespace = `x:${__pack || 'buyers'}`;
  const store = new OpportunityStore(statePath('opportunities.sqlite'));
  try {
    store.importLegacy(namespace, SEEN_PATH);
    const pack = JSON.parse(fs.readFileSync(path.resolve(HERE, SEARCH_FILE), 'utf8'));
    globalThis.__rubric = pack.rubric?.replaceAll('{{candidateLocation}}', settings.candidateLocation) || null;
    let failures = 0;
    if (!process.argv.includes('--export-only')) {
      const tweets = process.argv.includes('--resume') ? [] : option('--input')
        ? JSON.parse(fs.readFileSync(path.resolve(option('--input')), 'utf8')) : await runSearches();
      store.ingest(namespace, tweets, t => Date.now() - Date.parse(t.created_at) > MAX_AGE_DAYS * 86400000 || (t.replies ?? 0) > MAX_REPLIES);
      if (store.pending(namespace).length) {
        const key = apiKey();
        failures = await qualifyPending(store, namespace, batch => scoreBatch(batch, key), { jobs: __pack === 'jobs' });
      }
    }
    const day = option('--day', new Date().toISOString().slice(0, 10));
    const scored = store.results(namespace, day);
  const buyers = scored.filter((s) => s.buyer && s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  const out = exportPath('x-radar', `queue${__pack ? '_' + __pack : ''}_${day}.md`);
  const lines = [`# X lead queue — ${day} — ${buyers.length} qualified (of ${scored.length} scored)\n`,
    `Reply manually, from your account, genuinely helpful first (see outreach-scripts.md §4). 1-3 replies/day max.\n`];
  for (const [n, b] of buyers.entries()) {
    lines.push(`## ${n + 1}. @${b.screen_name} · ${b.score}/100 · ${b.offer} · ${b.replies ?? '?'} replies`);
    lines.push(`${b.url}`);
    lines.push(`*Author:* ${(b.bio || 'no bio').replace(/\n/g, ' ')} · ${b.followers} followers${b.location ? ' · ' + b.location : ''} · posted ${b.created_at?.slice(4, 10)}`);
    lines.push(`> ${b.text.replace(/\n/g, ' ')}\n`);
    lines.push(`*Why:* ${b.reason}`);
    lines.push(`*Angle:* ${b.angle}\n`);
  }
  atomicWrite(out, lines.join('\n') + '\n');
  atomicWrite(out.replace(/\.md$/, '.json'), JSON.stringify(buyers, null, 2));
  console.log(`${buyers.length} qualified opportunities -> ${out}`);
  if (failures) throw new Error(`${failures} records need retry; run with --resume`);
  } finally { store.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
