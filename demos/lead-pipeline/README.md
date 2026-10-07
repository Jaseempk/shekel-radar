# Demo — Lead-enrichment + AI-scoring pipeline (Offer B)

A minimal, working version of your flagship offer. It reads a list of leads, uses Claude to **score each 0–100 against an ideal-customer profile with a one-line reason**, and writes them back **ranked best-first**. This is the thing you screen-record for the 90-second Loom.

## Run it (2 minutes)

```bash
cd demos/lead-pipeline
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env         # then put your Anthropic API key in .env
python score_leads.py
```

Output: a ranked table in your terminal + `ranked_leads.csv`.

## Use it in a sales conversation (the close)

1. Edit `icp.md` to describe **the prospect's** ideal customer (30 seconds — do this live on the call or before the Loom).
2. Drop ~15 leads from **their niche** into `sample_leads.csv` (grab them from any directory).
3. Run it. Screen-record the ranked output landing.
4. Narration: *"This is your list, sourced and scored against your ideal customer, ranked so your team works the best ones first — automatically."*

That's the demo that closes. Reskinning = editing two files.

## What you'd build for a paying client (the real pilot)
- Swap the CSV input for a live source (their CRM export, Apollo/LinkedIn export, or a scraper).
- Add real enrichment (company size, tech stack, signals) before scoring.
- Push the ranked output straight into their CRM (HubSpot/Pipedrive/ClickUp API).
- Schedule it (cron / a small worker) so it runs unattended.

The scoring core in `score_leads.py` stays the same — that's the reusable engine you productize.

## Cost
Uses `claude-opus-4-8` by default. For bulk scoring of large lists, switch `MODEL` in `score_leads.py` to `claude-haiku-4-5` to cut cost ~5× — plenty smart for lead scoring.
