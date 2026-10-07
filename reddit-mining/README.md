# Reddit Lead Mining (Arctic Shift → ranked, uncontested leads)

Turns your existing `niche-radar` Arctic Shift scraper into a **ranked queue of un-pitched, qualified leads** — people describing a manual/repetitive workflow that your Offer B (lead pipeline) or Offer A (doc assistant) removes, in threads where no seller has replied yet.

## Why this beats live scraping / obvious subreddits

- **Historical + client-side comment filter = uncontested leads.** Arctic Shift is an archive, so instead of racing 30 other commenters on today's r/automation post, we pull *old* posts with pain/intent signals and **≤ N comments / no seller replies** — nobody worked them. That's the "stand out rather than be one among others" edge.
- **We fish where buyers are, not where sellers are.** The subreddit set is weighted toward Tier 2 (occupation/vertical subs — realtors, recruiters, trades, agencies-by-vertical) and Tier 5 (SE-Asia regional, your timezone edge), where your ideal customer vents but automation sellers don't lurk.

## How it fits your existing code (nothing rewritten)

The scraper is your `niche-radar/sources/reddit.py` (Arctic Shift: `GET /api/posts|comments/search`, no auth, `subreddit`+time-window+`limit`+`sort`, returns `num_comments`/`score`). This module adds two things on top:
1. `subreddits.json` — the tiered subreddit set (also usable as niche-radar `expansion.json`).
2. `find_leads.py` — a **stdlib-only** client-side filter/ranker that reads the scraped `<sub>_posts.jsonl` (+ `<sub>_comments.jsonl` if present) and outputs `leads.csv` / `leads.json`.

## Run it

```bash
cd income-system/reddit-mining

# 1. Scrape POSTS only (fast). Comments are NOT bulk-downloaded — that's the
#    time sink (a big sub has 100k+ comments). scrape.sh defaults to --kind posts.
bash scrape.sh

# 2. Rank the leads (uses the post's num_comments field for the uncontested filter)
python3 find_leads.py --data ./data --max-comments 5 --out leads.csv

# 3. Seller check: for the survivors only, fetch each post's comments and drop
#    ones a seller already replied to. Hundreds of lookups, not millions.
python3 check_sellers.py --leads leads.json --out leads.csv
```

Output: `leads.csv` (+ `leads.json`) ranked best-first, one row per lead, deduped by author, each with the post URL, matched signals, which offer fits (A/B), and a suggested reply angle.

> Why posts-only: Arctic Shift has no server-side keyword filter, so `--kind both` pulls *every* comment in the window per sub (tens of thousands each) — days of runtime. Step 3 gets the same seller-detection quality by fetching comments only for the few hundred posts that survive Step 2. (You can still bulk-scrape comments with `KIND=both bash scrape.sh` if you ever want them.)

## The two Arctic Shift gotchas, handled
- **No server-side `num_comments`/`score` filter** — those fields come back per post, so `find_leads.py` filters them locally.
- **Posts < ~36h old report `num_comments` as 0/1** in Arctic Shift (not yet backfilled). We scrape **through now** (freshest leads matter most), and because `scrape.sh` pulls comments too (`--kind both`), `find_leads.py` counts the *actual* scraped comments per post instead of trusting that field — so even a post from an hour ago is judged correctly. (Only if you scrape posts-only do very fresh posts fall back to the stale field.)

## Files
- `subreddits.json` — 5 tiers with per-tier weights + rationale. Trim to the tiers you want before scraping (all of it is a lot of volume).
- `expansion.json` — niche-radar drop-in (`subreddits` / `keywords` / `negative_keywords`) if you'd rather run `collect_reddit.py`.
- `find_leads.py` — the ranker. Keyword lists (pain / intent / offer / seller-signal) live at the top — edit freely.
- `scrape.sh` — wrapper that calls your niche-radar scraper across the subreddit set.

## Tuning
- Start with **Tier 2 + Tier 5** (highest ROI, least contested). Add Tier 1 last.
- `--max-comments` 5 is the "uncontested" threshold; lower = stricter (fewer, cleaner leads).
- If you scrape `--kind both`, `find_leads.py` auto-uses the comments to mark posts where a seller already replied as *contested* and down-ranks them (higher-fidelity than comment-count alone).
