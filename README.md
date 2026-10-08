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
python3 tools/run.py buyers --pages 4 --max-age-days 30 --descriptions 25
python3 tools/run.py buyer-feeds
python3 tools/run.py buyer-feeds --ats --limit 300
```

The ATS sweep uses the existing downloaded `ats-radar/ds_*.json` directories, which are retained locally but not committed. Feed and Workable modes do not require them.

Both collectors deduplicate repeated query hits by the source's job ID (distinct jobs with identical titles stay distinct) and exclude postings older than `--max-age-days` (default 30), measured from the source's posting date, not the collection date. A missing or malformed posting date is flagged `unknown` and needs review; no date is invented. Excluded jobs and their reasons are kept in the run's `.evidence.json`.

Only the Workable collector (`buyers`) qualifies jobs by their description. After the cheap title and age filters it fetches descriptions for a bounded shortlist (`--descriptions N`, default 25 jobs; at most two requests per job, a 15-second timeout and a 1.5 MB body cap per request; `--no-descriptions` skips fetching). It tries Workable's job API first and falls back to the job page's schema.org `JobPosting` data. Deterministic duty rules in `lib/buyers.mjs` (no model calls) assign each job one status: `qualified` (at least two concrete repeated research/data duties, no blockers, fresh known posting date), `rejected` (in-person retail/event work or mainly customer support), `review` (outsourced/BPO, regulated, strategic or quota-carrying, non-English, weak or unclear duties, or unknown date), `insufficient` (removed, closed, missing, malformed or oversized description), `retry` (timeout, network error, HTTP 429/5xx) or `not-fetched` (outside the shortlist or request budget). Each job's `qualification` field records the status, reasons, quoted duty evidence, the offer (`A`, `B` or `ops`) and the description's fetch status, source URL and timestamp. Descriptions are cached in `state/buyer-signals/workable-descriptions.json` for seven days; retryable failures are fetched again on the next run. Regional copies of one opening (same company and title once location words are removed, unless their descriptions differ) count once toward company priority.

The Workable `workable_RUN.json` snapshot contains only qualified companies and roles. `workable_RUN.review.json` has the same shape and holds everything that needs a person; use it with `outreach prepare` only after reviewing those roles. Search failures or retryable description failures make the run exit nonzero; see `.status.json`. Qualification is a guess about whether the workflow fits. A job opening does not show buying intent or budget, or that the company wants to replace staff.

`buyer-feeds` (aggregator feeds and the ATS sweep) qualifies by title only: its rows are marked `qualification.status: "title-only"` and carry no company website, so `outreach prepare` lists them as unresolved until you supply a reviewed domain mapping.

Use the exact JSON snapshot printed by collection. The workflow has explicit stages and does not require hand-built `draft_data.json` files:

```sh
python3 tools/run.py outreach prepare \
  --signals /absolute/path/to/workable_RUN.json \
  --run state/buyer-runs/my-run

# Scrape candidate emails and perform DNS/SMTP verification (no email sent).
# Requires INCOME_SMTP_MAIL_FROM and INCOME_SMTP_HELO in .env (see below).
python3 tools/run.py outreach verify --run state/buyer-runs/my-run

# Record your review decisions (validated; see "Review decisions" below).
python3 tools/run.py outreach review --run state/buyer-runs/my-run --decisions /path/review.json

# Generate offline template drafts: send-ready for verified inboxes, held otherwise.
python3 tools/run.py outreach draft --run state/buyer-runs/my-run
```

`outreach run --signals FILE` executes prepare, verify, review (when `--decisions FILE` is given) and draft, and prints its generated run directory. To run entirely offline with existing verification results:

```sh
python3 tools/run.py outreach run \
  --signals /path/signals.json --contacts /path/emails.csv \
  --decisions /path/review.json --run state/buyer-runs/my-run
```

`draft` (and therefore `run`) needs the sender profile described in Configuration and exits with status 2, naming the missing facts, without it. `prepare`, `verify` and `review` do not need it.

Contact CSV required columns: `company,domain,email,source,smtp`. Discovery also records `source_url` for published addresses (including Cloudflare's public email display encoding), and carries it into drafts for review. Only `smtp=valid` records with conclusive evidence (see below) matching both the company name and the evidenced company domain can enter the email queue, and only for accepted prospects. SMTP acceptance is evidence from the probe, not a guarantee of deliverability or mailbox ownership.

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

### Review decisions

Nothing is drafted for a prospect until a person has reviewed it. A review file is a JSON list of decisions (or `{"version": 1, "decisions": [...]}`):

```json
[
  {
    "company": "Example Company",
    "domain": "example.com",
    "decision": "accepted",
    "reason": "Role describes repeated account research and CRM de-duplication.",
    "reviewed_at": "2026-10-08",
    "role": {"url": "https://jobs.example.test/123", "title": "Sales Research Specialist"},
    "offer": "B",
    "hypothesis": "Research and CRM validation could be assisted; budget and intent are unknown.",
    "contact_route": {"type": "contact-form", "url": "https://example.com/contact", "note": "Official form; domain is catch-all"}
  }
]
```

- `company` + `domain` must match a prospect in the run exactly (the domain is normalized, e.g. `www.` dropped). Same-name companies on different domains are separate prospects with separate reviews and contacts.
- `decision` is `accepted`, `rejected` or `deferred`; `reason` and an ISO 8601 `reviewed_at` are always required; `role` is the selected source role URL (or `{url, title}`) and must be one of that prospect's roles.
- `accepted` also needs `offer` (`A`, `B` or `ops`) and `hypothesis`. Optional `contact_route` (accepted only) records a reviewed alternative: `contact-form`, `linkedin` or `other` with a `url`, or `unverified-email` with the proposed `email`. A route only shapes the held draft; it never becomes a recipient. Unknown fields are rejected.

The whole file is validated before anything in the run changes. Applied decisions are merged into the run's `review.json` (re-applying an identical decision is a no-op; a later file adds or replaces decisions for its prospects and keeps the rest), with a fingerprint of each decision and of the company identity and selected role it was made against. `manifest.json` records the hash of `review.json` and each application; hand edits to `review.json` are refused, so change your decisions file and re-run `review`. If the company identity or the selected role's evidence changes, the decision becomes stale and the prospect returns to pending review.

### Draft outputs

| File | Contents |
|---|---|
| `send-queue.md`, `drafts.json` | Accepted prospects with a permitted on-domain inbox whose `smtp=valid` row carries the conclusive `control-rejected+target-accepted` reason. Each draft has a `To:` recipient, its review, hypothesis, contact/SMTP evidence and provenance. |
| `held-queue.md`, `held-drafts.json` | Accepted prospects without a send-ready inbox. No recipient, a hold reason from the best contact row (e.g. `smtp=catchall (hello@…): control-accepted: …`), or `no contact found` / `only off-domain or disallowed inboxes`, the reviewed route, and every contact row as evidence. |
| `review-summary.md`, `review-summary.json` | Every prospect: `accepted-ready`, `accepted-held`, `rejected`, `deferred`, `pending-review` (including stale reviews) and `unresolved-domain`, with decisions, notes, contact evidence and draft outcome. `review` writes it too. |
| `draft-errors.json` | Retryable generation failures (the command exits nonzero). |
| `draft-conflicts.json` | Manually edited drafts whose evidence changed or whose prospect left the queue, with the edited and regenerated text. |
| `draft-progress.json` | Checkpointed generated text, keyed by the review, prospect, signal, contact and profile fingerprints, so changed evidence never reuses a stale draft and a rerun resumes after failures. |

Each draft's `provenance` holds those fingerprints, its cache key and the hash of the generated subject/body. To revise a draft, edit `subject`/`body` in `drafts.json` or `held-drafts.json`: later runs keep the edit. If its evidence changes, the edit stays in its queue with a visible warning and the regenerated text goes to `draft-conflicts.json`; pass `draft --accept-edits` to keep the edit against the new evidence, or delete the entry to take the regenerated text. If the prospect leaves the queue (rejected, held, stale), the edited text is kept only in `draft-conflicts.json`. Recipients are always re-derived from contact evidence, never from edits. The Markdown queues are rendered from the JSON; a hand-edited Markdown queue is copied to `send-queue.preserved-TIMESTAMP.md` (or `held-queue.…`) before it is rewritten.

Optional `--personalise` on `draft` or `run` fetches company websites and calls the model. Templates and model prompts share the same approved profile facts. Nothing is sent by any command; all sending remains manual.

### Older runs

Runs created before the review stage have no `review.json`, so `draft` treats every prospect as pending review (it says so) and writes no drafts. Their earlier `drafts.json` and `send-queue.md` are copied to `*.preserved-TIMESTAMP.*` before the first new draft run; other files (including manual notes such as `reviewed-drafts.json`) are untouched. To migrate, write a review file and run `outreach review` on the run.

Contact rows with `smtp=valid` but no `smtp_reason` were produced by the old verifier, which could mistake catch-all or inconclusive replies for success. By default they are held with the reason `legacy-smtp-evidence: re-run verify`; re-run `outreach verify --run RUN` to replace them. `draft --allow-legacy-contacts` keeps them eligible instead, and every such draft carries a `LEGACY CONTACT EVIDENCE` warning in `send-queue.md` and `legacy_contact: true` in its provenance.

The old `wire-outreach.py` and `personalise.py` (draft) and `wk_personalise.py` (prepare, or draft with `--draft`) commands are compatibility entry points for these stages and accept the same options; pass `--help` for the required inputs. They no longer discover today's inputs implicitly, and drafting through them also requires recorded review decisions.

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
