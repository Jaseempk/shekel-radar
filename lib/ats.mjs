/**
 * Discovery, job search and buyer search use the same supported boards and parsers.
 * `postedAt` is the raw source posting date when the board exposes one (not an
 * update time); callers parse it with lib/signals.mjs and treat absence as unknown.
 */
export const BOARDS = {
  greenhouse: {
    url: s => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs`,
    rows: d => d.jobs,
    parse: j => ({ sourceId: j.id, title: j.title, location: j.location?.name ?? '', url: j.absolute_url, postedAt: j.first_published ?? null }),
  },
  ashby: {
    url: s => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
    rows: d => d.jobs,
    parse: j => ({ sourceId: j.id, title: j.title, location: j.location ?? '', url: j.jobUrl ?? j.applyUrl, remote: j.isRemote === true, postedAt: j.publishedAt ?? null }),
  },
  lever: {
    url: s => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
    rows: d => d,
    parse: j => ({ sourceId: j.id, title: j.text, location: j.categories?.location ?? '', url: j.hostedUrl, remote: j.workplaceType === 'remote', postedAt: j.createdAt ?? null }),
  },
  workable: {
    url: s => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(s)}?details=true`,
    rows: d => d.jobs,
    parse: j => ({ sourceId: j.shortcode ?? j.id, title: j.title, location: [j.city, j.country].filter(Boolean).join(', '), url: j.url, remote: j.telecommuting === true, postedAt: j.published_on ?? j.created_at ?? null }),
  },
  recruitee: {
    url: s => `https://${encodeURIComponent(s)}.recruitee.com/api/offers/`,
    rows: d => d.offers,
    parse: j => ({ sourceId: j.id, title: j.title, location: j.location ?? '', url: j.careers_url, remote: j.remote === true, postedAt: j.published_at ?? j.created_at ?? null }),
  },
};
export function normalizeBoard(ats, slug, payload) {
  const adapter = BOARDS[ats];
  if (!adapter) throw new Error(`Unsupported ATS: ${ats}`);
  const rows = adapter.rows(payload);
  if (!Array.isArray(rows)) throw new Error(`${ats}/${slug}: unexpected board response`);
  return rows.map(row => {
    const role = adapter.parse(row);
    if (!role.title || !role.url) throw new Error(`${ats}/${slug}: job missing title or URL`);
    return { ...role, id: `${ats}:${slug}:${role.sourceId ?? role.url}`, ats, slug };
  });
}
export async function fetchBoard(ats, slug, fetcher = fetch) {
  if (!BOARDS[ats]) throw new Error(`Unsupported ATS: ${ats}`);
  const response = await fetcher(BOARDS[ats].url(slug), { headers: { Accept: 'application/json', 'User-Agent': 'shekel-radar/1.0' }, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`${ats}/${slug}: HTTP ${response.status}`);
  return normalizeBoard(ats, slug, await response.json());
}
