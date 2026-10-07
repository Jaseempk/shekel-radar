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

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CDP_URL = 'http://127.0.0.1:9222';
const __sIdx = process.argv.indexOf('--searches');
const __pack = __sIdx > -1 ? path.basename(process.argv[__sIdx + 1], '.json').replace('searches-', '') : '';
const SEEN_PATH = path.join(HERE, __pack ? `seen_${__pack}.json` : 'seen.json');
const ENV_PATH = path.join(HERE, '..', 'reddit-mining', '.env');
const MODEL = 'claude-haiku-4-5';
const MIN_SCORE = 55;
const __mrIdx = process.argv.indexOf('--max-replies');
const MAX_REPLIES = __mrIdx > -1 ? parseInt(process.argv[__mrIdx + 1], 10) : Infinity;
const SCROLLS_PER_SEARCH = 2;          // stay light: first page + two scrolls
const PAUSE_BETWEEN_SEARCHES = () => 8000 + Math.random() * 12000;

function apiKey() {
  const env = fs.readFileSync(ENV_PATH, 'utf8');
  const m = env.match(/ANTHROPIC_API_KEY\s*=\s*(\S+)/);
  if (!m) throw new Error('ANTHROPIC_API_KEY not found in ' + ENV_PATH);
  return m[1];
}

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
      const followers = user?.legacy?.followers_count ?? 0;
      const bio = user?.legacy?.description ?? '';
      const text = result.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text ?? '';
      sink.set(result.rest_id, {
        id: result.rest_id,
        url: `https://x.com/${screen || 'i'}/status/${result.rest_id}`,
        screen_name: screen,
        bio: bio.slice(0, 200),
        followers,
        created_at: legacy.created_at,
        text: text.slice(0, 600),
        replies: legacy.reply_count ?? 0,
      });
    }
  }
}

function dayStamp(offset) {
  const d = new Date(Date.now() - offset * 86400000);
  return d.toISOString().slice(0, 10);
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal CDP client over a fresh tab. Playwright's connectOverCDP attaches to
 * every target in the browser (service workers, extensions, iframes) and hangs
 * when any of them fails to handshake; this only ever touches its own tab.
 */
async function openTab() {
  const target = await (await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? {}); pending.delete(d.id); }
    else if (d.method) listeners.forEach((fn) => fn(d));
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.delete(mid)) res({}); }, 30000);
  });
  const close = async () => {
    try { ws.close(); } catch {}
    try { await fetch(`${CDP_URL}/json/close/${target.id}`); } catch {}
  };
  return { send, on: (fn) => listeners.push(fn), close };
}

async function runSearches() {
  // --searches <file>: alternate search pack (e.g. searches-jobs.json). Default: searches.json
  const sIdx = process.argv.indexOf('--searches');
  const searchFile = sIdx > -1 ? process.argv[sIdx + 1] : 'searches.json';
  const pack = JSON.parse(fs.readFileSync(path.join(HERE, searchFile), 'utf8'));
  const baseQueries = pack.queries;
  globalThis.__rubric = pack.rubric || null;

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

  const { send, on, close } = await openTab();
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
      if (r && r.body) { try { extractTweets(JSON.parse(r.body), found); } catch { /* not JSON */ } }
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
  await close();
  return [...found.values()];
}

async function scoreBatch(batch, key) {
  const listing = batch.map((t, i) =>
    `[${i}] @${t.screen_name} (bio: ${t.bio || 'none'})\n${t.text}`).join('\n---\n');
  const rubricHead = globalThis.__rubric ?? `You qualify sales leads for a freelance AI-automation consultant. His offers: (B) lead-enrichment/AI-scoring pipelines, (A) internal doc/RAG assistants, plus general workflow automation for business teams.

For each numbered tweet below, judge whether the AUTHOR is a genuine potential BUYER: a real business operator/owner describing manual, repetitive work in their own business that they would plausibly pay to remove. NOT a buyer: developers, automation/marketing sellers, builders showcasing tools, job seekers, students, engagement-bait, memes.

CRITICAL X-specific trap: sellers write pain-story content that MIMICS buyer posts to farm engagement. Mark buyer=false when the post: pivots from pain to a solution reveal ("here's what it looks like with the right system", "then I gave AI access and...", thread arrows like "👇"), promotes a named product or the author's own service, ends in any CTA ("DM me", "free consult", "test it now", link to their tool), is a how-I-did-it success story or guru framework ("here's the framework that got me out"), or the author's bio/handle markets automation, AI, marketing, or coaching services. A real buyer is mid-problem with no solution to sell and nothing to promote.

HIGHEST-value buyers: operators explicitly looking to hire or pay someone (freelancer, consultant, agency) to build an automation, AI assistant, integration or lead pipeline. Score these 80+ when the author is the business itself. A post asking for a recommendation counts. A post offering such services does not.`;

  const prompt = `${rubricHead}

Return ONLY a JSON array, one object per tweet: {"i": <index>, "score": 0-100, "buyer": true/false, "offer": "A"|"B"|"ops", "reason": "<one line>", "angle": "<one line: what a genuinely helpful reply would address>"}.

Tweets:\n${listing}`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error('Anthropic API ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
  const data = await resp.json();
  const text = data.content?.[0]?.text ?? '[]';
  const jsonStr = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  return JSON.parse(jsonStr);
}

async function main() {
  const key = apiKey();
  const seen = fs.existsSync(SEEN_PATH) ? new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'))) : new Set();

  const tweets = await runSearches();
  let fresh = tweets.filter((t) => !seen.has(t.id));
  const beforeReplies = fresh.length;
  if (MAX_REPLIES !== Infinity) fresh = fresh.filter((t) => (t.replies ?? 0) <= MAX_REPLIES);
  console.log(`\n${tweets.length} captured, ${beforeReplies} new since last run.`);
  if (MAX_REPLIES !== Infinity)
    console.log(`${beforeReplies - fresh.length} dropped as contested (>${MAX_REPLIES} replies), ${fresh.length} left.`);
  if (!fresh.length) return;

  const scored = [];
  for (let i = 0; i < fresh.length; i += 20) {
    const batch = fresh.slice(i, i + 20);
    try {
      const verdicts = await scoreBatch(batch, key);
      for (const v of verdicts) if (batch[v.i]) scored.push({ ...batch[v.i], ...v });
    } catch (e) {
      console.error('scoring batch failed:', e.message);
    }
  }

  fresh.forEach((t) => seen.add(t.id));
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen]));

  const buyers = scored.filter((s) => s.buyer && s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  const day = new Date().toISOString().slice(0, 10);
  const sIdx2 = process.argv.indexOf('--searches');
  const packTag = sIdx2 > -1 ? '_' + path.basename(process.argv[sIdx2 + 1], '.json').replace('searches-', '') : '';
  const out = path.join(HERE, `queue${packTag}_${day}.md`);
  const lines = [`# X lead queue — ${day} — ${buyers.length} qualified (of ${fresh.length} new)\n`,
    `Reply manually, from your account, genuinely helpful first (see outreach-scripts.md §4). 1-3 replies/day max.\n`];
  for (const [n, b] of buyers.entries()) {
    lines.push(`## ${n + 1}. @${b.screen_name} · ${b.score}/100 · ${b.offer} · ${b.replies ?? '?'} replies`);
    lines.push(`${b.url}`);
    lines.push(`> ${b.text.replace(/\n/g, ' ')}\n`);
    lines.push(`*Why:* ${b.reason}`);
    lines.push(`*Angle:* ${b.angle}\n`);
  }
  fs.appendFileSync(out, lines.join('\n') + '\n');
  fs.writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(buyers, null, 2));
  console.log(`${buyers.length} qualified buyers -> ${out}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
