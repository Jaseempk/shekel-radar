# Shekel Radar

A local toolkit for finding consulting clients and engineering roles, qualifying opportunities, and preparing outreach for manual review. The portfolio, demos, and promotional reel are separate deliverables.

The next four architecture improvements are scoped in [the execution plan](docs/ARCHITECTURE_EXECUTION_PLAN.md), including implementation order, regression cases and continuation context for another agent.

## Setup

- Node **22.22 or newer**. The collectors use built-in `fetch`, WebSocket and SQLite; Node 22 prints an experimental SQLite warning.
- Python **3.12 or newer**.
- Browser collection requires a logged-in Chrome/Brave session with a debugging port. Only run those commands when you want to collect live results.

A fresh clone runs help and the offline tests with no configuration, credentials, local assets or third-party packages:

```sh
python3 tools/run.py --help
npm test
```

For live features, install the locked Python dependencies and add local configuration:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.lock.txt
cp .env.example .env                                              # ANTHROPIC_API_KEY, optional INCOME_* settings
cp config/settings.local.example.json config/settings.local.json  # sender facts, location
```

`requirements.txt` specifies the supported direct dependency range; `requirements.lock.txt` pins the dependency closure (verified on macOS with Python 3.12; CI installs it on Linux). Only model calls need it: `anthropic` is imported lazily. The root Node package has no third-party dependencies. The Remotion reel has its own package and lockfile.

## Configuration

Settings resolve in this order, later layers winning. `lib/runtime.py` and `lib/runtime.mjs` implement the same merge, validation and error messages, and tests check that they agree.

1. `config/settings.json`: committed, generic defaults (model names, the buyer score threshold, retention limits, a neutral `candidateLocation` and a default `claimsRule`). It contains no personal facts.
2. `config/settings.local.json`: your ignored override. Objects merge key by key (so a partial `profile` keeps the default `claimsRule`); other values replace. Set `INCOME_SETTINGS_LOCAL=/path/file.json` to use another file, which must then exist.
3. Environment variables `INCOME_SOCIAL_MODEL` and `INCOME_DRAFT_MODEL`, when non-empty, override the models.

The actual environment overrides root `.env`. The old `reddit-mining/.env` remains a fallback for the model key. Other supported variables are `INCOME_DATA_DIR` (relocate runtime data; by default this project), `INCOME_CDP_URL` (browser debugging endpoint), `NICHE_RADAR` (Reddit scraper checkout), and `INCOME_SMTP_MAIL_FROM` / `INCOME_SMTP_HELO`, your own envelope sender and HELO name for `outreach verify` SMTP probes.

General settings are type-checked on load; an invalid override fails with the setting name. Sender facts (`profile.name`, `profile.website`, `profile.proof` and `profile.claimsRule`) are checked only by commands that draft, through `require_profile()` / `requireProfile()`, which stop with a message naming each missing fact instead of inventing one. Help, collection, export-only rebuilds and tests run without them. `candidateLocation` is interpolated into job-scoring prompts, so set your real location locally. Model availability depends on your provider account and is only exercised by live model features.

All commands work from another directory when invoked by absolute path. User-supplied input paths are relative to the calling directory.

## Where things live

| Location | Purpose |
|---|---|
| `lib/` | Shared qualification state, model validation, browser transport, ATS adapters, buyer rules, contact matching and drafting |
| `config/` and source-specific search JSON files | Committed default settings, the local override example, and search definitions |
| `state/opportunities.sqlite` | Durable social/Reddit outcomes, retryable work, current ATS observations and notification history |
| `state/buyer-runs/` | Buyer workflow inputs, company evidence, contact verification and resumable drafts |
| `state/facebook-groups.json` | Discovered group registry |
| `data/raw/` | Disposable scraped captures |
| `exports/` | Rebuildable queues and collection snapshots |
| `tests/` | Offline failure, recovery, adapter, workflow and command tests |
| `site/`, `resume/` | Local portfolio website and resume (ignored by Git) |
| `.github/workflows/ci.yml` | Offline CI: help and `npm test` on push and pull request |
| `reel/`, `demos/` | Promotional reel and demonstration assets |

Credentials, databases, caches, generated data, dependencies and downloaded ATS directories are excluded from Git. Reusable source lists remain in their current folders. Existing `seen*.json` files are imported on first use and retained locally. Those historical IDs suppress rediscovery; deleting old queues does not recreate their deleted content.

## Social opportunities

```sh
python3 tools/run.py x
python3 tools/run.py x --searches searches-jobs.json
python3 tools/run.py facebook
python3 tools/run.py facebook --searches searches-pain-groups.json
```

These commands collect live data and score it using the configured model. They never post, join groups, react, send messages or send email. Search-pack paths are resolved relative to the source folder, or can be absolute.

Scoring requires exactly one well-typed verdict per input. Raw candidates are persisted before scoring, and validated results and completion state are saved together. Missing verdicts, invalid responses and request failures remain retryable. Search packs have independent qualification histories; their names identify the namespace.

```sh
# Retry saved pending work without opening the browser.
python3 tools/run.py x --resume
python3 tools/run.py facebook --searches searches-pain-groups.json --resume

# Rebuild a day's queues without browser access or model calls.
python3 tools/run.py x --export-only --day 2026-10-07
python3 tools/run.py facebook --export-only --day 2026-10-07
```

Use the same `--searches` value when resuming or exporting an alternate pack. Dates are UTC completion dates. Same-day queues contain all results completed that day, not just the latest run. JSON and Markdown are separate atomic exports: if one fails, rerun `--export-only` to rebuild both from SQLite. `--input /path/posts.json` can ingest previously captured source-shaped records; it still performs model scoring unless `--export-only` is set. Run one collector per search pack at a time to avoid duplicate paid calls.

## Engineering jobs

```sh
python3 tools/run.py jobs --remote-only
python3 tools/run.py jobs --new
python3 tools/run.py vc-jobs --days 21
python3 tools/run.py rank-jobs --include-maybe --top 40
```

ATS discovery, polling and buyer scanning use the same adapters: Ashby, Greenhouse, Lever, Workable and Recruitee. `companies.json` is the configured company list. Discovery no longer advertises unsupported boards.

Full observations are always retained. `--new` produces a separate notification view and cannot erase the observations used by ranking. Stable source job IDs distinguish new postings with identical titles. A failed refresh preserves the previous board snapshot with an explicit stale status; ranking excludes it. `jobs --export-only` reconstructs exports from saved observations without polling.

Ranking uses the latest snapshot for each source, rejects old source files (30 days by default), and reports missing sources. Broad regional matches remain `geo-check`: a compatible location alone is not proof of work authorization. Getro and buyer collection write unique run snapshots and companion `.status.json` files; partial collections exit nonzero so they are distinguishable from successful empty results.

## Consulting prospects and outreach

```sh
# Collect companies hiring for potentially automatable work.
python3 tools/run.py buyers --pages 4
python3 tools/run.py buyer-feeds
python3 tools/run.py buyer-feeds --ats --limit 300
```

The ATS sweep uses the existing downloaded `ats-radar/ds_*.json` directories, which are retained locally but not committed. Feed and Workable modes do not require them.

Use the exact JSON snapshot printed by collection. The workflow has explicit stages and does not require hand-built `draft_data.json` files:

```sh
python3 tools/run.py outreach prepare \
  --signals /absolute/path/to/workable_RUN.json \
  --run state/buyer-runs/my-run

# Scrape candidate emails and perform DNS/SMTP verification (no email sent).
# Requires INCOME_SMTP_MAIL_FROM and INCOME_SMTP_HELO in .env (see below).
python3 tools/run.py outreach verify --run state/buyer-runs/my-run

# Generate offline template drafts using verified contacts.
python3 tools/run.py outreach draft --run state/buyer-runs/my-run
```

`outreach run --signals FILE` executes all three stages and prints its generated run directory. To run entirely offline with existing verification results:

```sh
python3 tools/run.py outreach run \
  --signals /path/signals.json --contacts /path/emails.csv \
  --run state/buyer-runs/my-run
```

Contact CSV required columns: `company,domain,email,source,smtp`. Discovery also records `source_url` for published addresses (including Cloudflare's public email display encoding), and carries it into drafts for review. Only `smtp=valid` records matching both the company name and the evidenced company domain enter the draft queue. SMTP acceptance is evidence from the probe, not a guarantee of deliverability or mailbox ownership.

Network verification needs a probe identity you control. It refuses to start, before any network request, until both are set in the root `.env` or the environment:

```sh
INCOME_SMTP_MAIL_FROM=probe@your-domain.example   # SMTP envelope sender (MAIL FROM)
INCOME_SMTP_HELO=mail.your-domain.example         # EHLO/HELO hostname
```

Verification is conservative. Every SMTP session first offers a random address on the domain:

| `smtp` | Meaning |
|---|---|
| `valid` | The same session explicitly rejected the random address as a nonexistent recipient (e.g. `550 5.1.1`) and accepted the candidate. |
| `invalid` | The candidate was explicitly rejected as a nonexistent recipient. |
| `catchall` | The random address was accepted, so acceptance proves nothing. |
| `unknown` | Evidence was inconclusive: no/failed MX lookup, connection failure, policy block, temporary (4xx) or ambiguous 5xx replies, a random-address probe that was not explicitly rejected, or the domain's time budget/circuit breaker ran out. |
| empty | Off-domain address found on the site (`source=scraped-offsite`); not probed. |

Generated CSVs append diagnostic columns after the original ones: `smtp_reason` (`token: detail`, e.g. `control-inconclusive: …`, `target-policy: 550 5.7.1 …`, `circuit-open: …`), `checked_at` (UTC), `mx_status` (`ok`, `none`, `error`), `site_status` (`ok`, `partial`, `unavailable`, `not-found`) and `site_errors` (failed page URLs with reasons). A reconnect re-runs the random-address probe before trusting any reply, every SMTP connection is closed, and each domain is limited to a 45-second monotonic budget, four connection attempts and three transport failures, after which remaining candidates are `unknown` with the reason. Website discovery separately records unreachable pages instead of treating them as pages without email, and stops trying a host variant after repeated network failures. Imported contact CSVs only need the required columns.

Company domains come from the source-provided website or a reviewed `--domains FILE` mapping. A domain responding to a guessed name is never sufficient. Missing domains are recorded in `unresolved.json`. Mapping format:

```json
{
  "Example Company": {
    "domain": "example.com",
    "source": "https://example.com/about — reviewed company identity"
  }
}
```

Inspect `send-queue.md`, `drafts.json` and the source evidence inside the run directory. Optional `--personalise` on `draft` or `run` fetches company websites and calls the model. Successful drafts are checkpointed; errors go to `draft-errors.json` and remain retryable. Templates and model prompts share the same approved profile facts. All sending remains manual.

The old `wire-outreach.py`, `personalise.py` and `wk_personalise.py` commands are compatibility entry points for the explicit prepare/draft stages; pass `--help` for the required inputs. They no longer discover today's inputs implicitly.

## Reddit

The raw scraper lives in the separate `niche-radar` checkout, which is not part of this repository and is needed only for `scrape.sh`. Set `NICHE_RADAR` to a checkout containing `sources/reddit.py` (the built-in fallback is the owner's local layout). Its own Python dependencies must be installed. Ranking, seller checks and drafting work on any previously captured data. The wrapper defaults to 30 days of posts and uses portable date calculations.

```sh
bash reddit-mining/scrape.sh
python3 tools/run.py reddit-rank --max-comments 5 --max-age-days 30
python3 tools/run.py reddit-sellers
python3 tools/run.py reddit-draft --limit 150
python3 tools/run.py reddit-draft --resume
python3 tools/run.py reddit-draft --export-only
```

`reddit-draft` requires the sender profile described in Configuration. Its prompt uses the same `profile.proof` and `profile.claimsRule` as the outreach drafts, and its queue threshold defaults to `minimumBuyerScore` (`--min-score` overrides). `--export-only` needs neither the profile nor a key.

Seller-check failures are saved in `leads.retry.json` and exit nonzero; they are never labelled clean. Retry that file with `reddit-sellers --leads FILE --out NEW_OUTPUT.csv`. Qualification errors stay pending in SQLite and can be retried without rebuilding the lead list. Exports include completed qualified records; review their age before replying. Model rules can evolve independently of already-saved decisions.

## Retention and recovery

```sh
# Dry run: raw captures older than 30 days, exports older than 90 days,
# plus oldest raw captures above the configured 1 GiB raw-data budget.
python3 tools/run.py prune
python3 tools/run.py prune --delete
```

Pruning operates only under `data/raw/` and `exports/`. It does not touch source, credentials, SQLite history or buyer-run evidence, and it ignores symlinks. Retention runs only when invoked; no scheduler has been installed. Back up `state/` while collectors are stopped, including any SQLite WAL files, or use SQLite's online backup facility.

## Verification and assets

`npm test` runs Node's built-in test runner and Python's unittest suite. Tests use temporary stores, synthetic records, explicit empty settings overrides and local process execution; they do not require credentials, a local profile, a browser, external network access or paid model calls. GitHub Actions (`.github/workflows/ci.yml`) runs `python3 tools/run.py --help` and `npm test` on Node 22 and Python 3.12 for every push and pull request, and separately checks that `requirements.lock.txt` installs on Linux. CI never uses keys, browsers, SMTP or scheduled scraping.

Manual, read-only diagnostic: `node fb-radar/peek.mjs URL...` prints the visible text of Facebook posts or profiles in the logged-in browser, to check who an author is and how contested a post is. It uses the shared browser transport (`fb-radar/cdp.mjs` re-exports `lib/cdp.mjs`).

The portfolio (`site/`) is local-only. `wrangler.toml` is kept as an optional example of the owner's Cloudflare Pages deployment and does nothing without `site/`. The reel uses its own commands in `reel/package.json`. Case studies and outreach copy still need human factual review before publication; this refactor did not verify the claims in those documents.
