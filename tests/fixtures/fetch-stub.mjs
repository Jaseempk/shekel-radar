/**
 * Preload for offline CLI tests: `node --import ./tests/fixtures/fetch-stub.mjs ...`.
 * Replaces fetch with canned responses from the JSON file named by FETCH_STUB.
 * Format: { "routes": { "<exact url>": { "status": 200, "json": {...} | "text": "..." | "error": "TimeoutError" } } }
 * Workable search URLs are matched by "search:<query>" (pageToken/limit ignored).
 * Every request is appended to FETCH_STUB + '.log' so tests can assert request counts.
 */
import fs from 'node:fs';

const file = process.env.FETCH_STUB;
const { routes } = JSON.parse(fs.readFileSync(file, 'utf8'));
globalThis.fetch = async (url) => {
  fs.appendFileSync(file + '.log', url + '\n');
  const u = new URL(url);
  const key = u.pathname === '/api/v1/jobs' && u.searchParams.has('query') ? `search:${u.searchParams.get('query')}` : url;
  const route = routes[key];
  if (!route) throw new Error(`fetch stub: no route for ${url}`);
  if (route.error) {
    const e = new Error(route.error === 'TimeoutError' ? 'The operation was aborted due to timeout' : route.error);
    e.name = route.error;
    throw e;
  }
  const body = route.json !== undefined ? JSON.stringify(route.json) : (route.text ?? '');
  return new Response(body, { status: route.status ?? 200, headers: { 'content-type': route.json !== undefined ? 'application/json' : 'text/html' } });
};
