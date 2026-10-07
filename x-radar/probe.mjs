/** Read-only profile check: visit each profile in the logged-in browser, capture UserByScreenName. */
const CDP = 'http://127.0.0.1:9222';
const names = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const want = new Set(); const users = {};
const send = (method, params = {}) => new Promise((res) => { const m = ++id; pending.set(m, res); ws.send(JSON.stringify({ id: m, method, params })); setTimeout(() => pending.delete(m) && res({}), 20000); });
ws.onmessage = async (e) => {
  const d = JSON.parse(e.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? {}); pending.delete(d.id); return; }
  if (d.method === 'Network.responseReceived' && /UserByScreenName/.test(d.params.response.url)) want.add(d.params.requestId);
  if (d.method === 'Network.loadingFinished' && want.has(d.params.requestId)) {
    want.delete(d.params.requestId);
    const r = await send('Network.getResponseBody', { requestId: d.params.requestId });
    try { const u = JSON.parse(r.body).data.user.result; users[u.core?.screen_name ?? u.legacy?.screen_name] = u; } catch {}
  }
};
await send('Network.enable');
for (const n of names) { await send('Page.navigate', { url: `https://x.com/${n}` }); await sleep(4500 + Math.random() * 3000); }
await sleep(1500);
const first = Object.values(users)[0];
if (first) console.log('KEYS', JSON.stringify(Object.keys(first)), 'LEGACY', JSON.stringify(Object.keys(first.legacy ?? {})).slice(0, 400));
for (const [n, u] of Object.entries(users)) {
  const L = u.legacy ?? {};
  console.log(JSON.stringify({ n, name: u.core?.name ?? L.name, bio: u.profile_bio?.description ?? L.description, followers: L.followers_count ?? u.relationship_counts?.followers, loc: u.location?.location ?? L.location, created: u.core?.created_at ?? L.created_at, verified: u.is_blue_verified, dm: u.dm_permissions ?? L.can_dm, url: L.url ?? u.website?.url }));
}
ws.close(); await fetch(`${CDP}/json/close/${target.id}`);
