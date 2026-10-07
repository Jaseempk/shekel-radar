# Reddit opportunity mining

The pipeline collects archived posts, ranks buying signals, checks competing replies, then qualifies authors and drafts responses. Sending remains manual.

Run from the project root (or use absolute paths):

```sh
bash reddit-mining/scrape.sh
python3 tools/run.py reddit-rank --max-comments 5 --max-age-days 30
python3 tools/run.py reddit-sellers
python3 tools/run.py reddit-draft --limit 150
```

The scraper depends on the separate `niche-radar` checkout. Set `NICHE_RADAR` to its path and install that project's dependencies. Defaults: posts only, last 30 days, output in `data/raw/reddit/`. Override `AFTER`, `BEFORE`, `KIND` or `OUT` explicitly when needed. Ranking uses `subreddits.json` for weights; `expansion.json` remains available for niche-radar.

Generated queues live under `exports/reddit-mining/`. Qualification results and pending retries are durable in `state/opportunities.sqlite`. An existing local `leads_drafted.jsonl` checkpoint is imported once; entries containing errors remain retryable. New runs do not append to the legacy checkpoint.

```sh
# Retry qualification failures without collecting again.
python3 tools/run.py reddit-draft --resume

# Rebuild CSV, JSON and Markdown without model calls.
python3 tools/run.py reddit-draft --export-only

# Retry unavailable seller lookups separately.
python3 tools/run.py reddit-sellers \
  --leads exports/reddit-mining/leads.retry.json \
  --out exports/reddit-mining/retried-leads.csv
```

Unavailable seller checks produce `*.retry.json` and a nonzero exit. They are never marked clean. `--max-comments` defaults to 5; `--keep-contested` retains marked contested posts. Very fresh archive counts may lag; the targeted seller pass checks actual retrieved comments (up to 100 per post).

Review the age and context of saved drafts before replying. The root [README](../README.md) covers credentials, data retention, storage and the common test command.
