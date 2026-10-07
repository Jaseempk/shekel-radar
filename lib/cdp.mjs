/** One owned tab; protocol errors reject, listeners unsubscribe, close always cleans up. */
export const CDP_URL = process.env.INCOME_CDP_URL || 'http://127.0.0.1:9222';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function protocolClient(ws, timeout = 30000) {
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  const tasks = new Set();
  const errors = [];
  const rejectAll = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  ws.onclose = () => rejectAll(new Error('Browser connection closed'));
  ws.onerror = () => rejectAll(new Error('Browser connection failed'));
  ws.onmessage = message => {
    let d;
    try { d = JSON.parse(message.data); } catch (e) { errors.push(e); return; }
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id); pending.delete(d.id); clearTimeout(p.timer);
      if (d.error) p.reject(new Error(d.error.message || 'CDP request failed'));
      else if (d.result?.exceptionDetails || d.result?.errorText) p.reject(new Error(d.result.errorText || 'Browser evaluation failed'));
      else p.resolve(d.result ?? {});
    } else if (d.method) {
      for (const listener of listeners) {
        const task = Promise.resolve().then(() => listener(d)).catch(e => errors.push(e)).finally(() => tasks.delete(task));
        tasks.add(task);
      }
    }
  };
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        const timer = setTimeout(() => { pending.delete(mid); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
        pending.set(mid, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ id: mid, method, params })); }
        catch (e) { pending.delete(mid); clearTimeout(timer); reject(e); }
      });
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async drain() { while (tasks.size) await Promise.all([...tasks]); if (errors.length) throw errors.shift(); },
    dispose() { listeners.clear(); rejectAll(new Error('Browser tab closed')); ws.close(); },
  };
}
export async function openTab() {
  const response = await fetch(`${CDP_URL}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Cannot open browser tab: HTTP ${response.status}`);
  const target = await response.json();
  const closeTarget = async () => { await fetch(`${CDP_URL}/json/close/${target.id}`, { signal: AbortSignal.timeout(10000) }); };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser handshake timed out')), 10000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Browser handshake failed')); };
    });
  } catch (e) { ws.close(); await closeTarget().catch(() => {}); throw e; }
  const client = protocolClient(ws);
  return { ...client, async close() { client.dispose(); await closeTarget(); } };
}
export function captureGraphql({ send, on }, sink) {
  const names = new Map();
  return on(async msg => {
    if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.includes('/api/graphql')) {
      const request = msg.params.request;
      const h = request.headers || {};
      names.set(msg.params.requestId, h['x-fb-friendly-name'] || h['X-FB-Friendly-Name'] || (request.postData || '').match(/fb_api_req_friendly_name=([^&]+)/)?.[1] || '?');
    }
    if (msg.method === 'Network.loadingFailed') names.delete(msg.params.requestId);
    if (msg.method === 'Network.loadingFinished' && names.has(msg.params.requestId)) {
      const name = names.get(msg.params.requestId); names.delete(msg.params.requestId);
      const r = await send('Network.getResponseBody', { requestId: msg.params.requestId });
      if (r?.body) sink.push({ name, body: r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body });
    }
  });
}
