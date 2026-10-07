#!/usr/bin/env bash
# Scrape the subreddit set with your existing niche-radar Arctic Shift scraper,
# then you run find_leads.py on the output.
#
# Requires niche-radar's Python env (it needs httpx). Easiest:
#   cd /Users/jasim/SOLIDITY/Personal/SaasBaaba/niche-radar && source .venv/bin/activate  (if it has one)
# or install httpx into your current env:  pip install httpx
#
# Override any of these via env vars, e.g.:  AFTER=2025-01-01 bash scrape.sh
set -euo pipefail

NR="${NICHE_RADAR:-/Users/jasim/SOLIDITY/Personal/SaasBaaba/niche-radar}"
AFTER="${AFTER:-$(date -v-4m +%F)}"      # last 4 months only — older posts = stale leads
BEFORE="${BEFORE:-$(date -v+1d +%F)}"    # through now (tomorrow's date = include everything up to this moment)
OUT="${OUT:-$PWD/data}"                   # absolute so it survives the cd below

mkdir -p "$OUT"
SUBS=$(python3 -c "import json;print(','.join(s for t in json.load(open('subreddits.json'))['tiers'] for s in t['subreddits']))")
N=$(echo "$SUBS" | tr ',' '\n' | wc -l | tr -d ' ')

echo "Scraping $N subreddits  $AFTER .. $BEFORE  ->  $OUT"
echo "(trim subreddits.json to fewer tiers if this is too much volume)"

( cd "$NR" && python3 sources/reddit.py \
    --subreddits "$SUBS" \
    --after "$AFTER" \
    --before "$BEFORE" \
    --kind "${KIND:-posts}" \
    --output-dir "$OUT" )

echo ""
echo "Scrape done. Rank leads with:"
echo "  python3 find_leads.py --data \"$OUT\" --max-comments 5 --out leads.csv"
