/** Minimal CDP client over one fresh tab (same approach as x-radar: never attaches to other targets). */
export const CDP_URL = 'http://127.0.0.1:9222';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openTab() {
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

/** Collect every /api/graphql/ response body the page loads, tagged with its friendly name. */
export function captureGraphql({ send, on }, sink) {
  const names = new Map();
  on(async (msg) => {
    if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.includes('/api/graphql')) {
      const h = msg.params.request.headers || {};
      const post = msg.params.request.postData || '';
      const name = h['x-fb-friendly-name'] || h['X-FB-Friendly-Name'] || (post.match(/fb_api_req_friendly_name=([^&]+)/) || [])[1] || '?';
      names.set(msg.params.requestId, name);
    }
    if (msg.method === 'Network.loadingFinished' && names.has(msg.params.requestId)) {
      const name = names.get(msg.params.requestId);
      names.delete(msg.params.requestId);
      const r = await send('Network.getResponseBody', { requestId: msg.params.requestId });
      if (r?.body) sink.push({ name, body: r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body });
    }
  });
}
