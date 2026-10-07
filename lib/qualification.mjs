/** Treat external model output as untrusted data. A batch succeeds only in full. */
export function validateVerdicts(verdicts, count, { facebook = false, jobs = false } = {}) {
  if (!Array.isArray(verdicts) || verdicts.length !== count) throw new Error(`Expected ${count} verdicts; received ${verdicts?.length ?? 'non-array'}`);
  const seen = new Set();
  return verdicts.map(v => {
    if (!v || !Number.isInteger(v.i) || v.i < 0 || v.i >= count || seen.has(v.i)) throw new Error('Invalid or duplicate verdict index');
    seen.add(v.i);
    if (typeof v.buyer !== 'boolean' || !Number.isInteger(v.score) || v.score < 0 || v.score > 100) throw new Error('Invalid buyer/score verdict');
    for (const key of ['offer', 'reason', 'angle']) if (typeof v[key] !== 'string' || !v[key].trim()) throw new Error(`Missing verdict ${key}`);
    if (!jobs && !['A', 'B', 'ops'].includes(v.offer)) throw new Error('Unknown offer');
    if (facebook && (typeof v.job !== 'boolean' || typeof v.aware !== 'boolean' || typeof v.pain !== 'string')) throw new Error('Invalid Facebook verdict');
    if (facebook && v.buyer && v.job) throw new Error('A verdict cannot be both buyer and job');
    return { i: v.i, score: v.score, buyer: v.buyer, offer: v.offer, reason: v.reason, angle: v.angle,
      ...(facebook ? { job: v.job, aware: v.aware, pain: v.pain } : {}),
      kind: (jobs ? v.buyer : v.job) ? 'job' : v.buyer ? 'consulting' : 'rejected' };
  });
}
export async function modelJSON(prompt, { key, model, fetcher = fetch, maxTokens = 4000 } = {}) {
  const response = await fetcher('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!response.ok) throw new Error(`Model request failed: HTTP ${response.status}`);
  const data = await response.json();
  if (data.stop_reason === 'max_tokens') throw new Error('Model response was truncated');
  const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!text) throw new Error('Model returned no text');
  return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}
