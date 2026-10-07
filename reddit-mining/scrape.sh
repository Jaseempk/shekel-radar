#!/usr/bin/env bash
# Collect disposable Reddit captures. Requires the separate niche-radar checkout.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(dirname "$HERE")"
NR="${NICHE_RADAR:-$(dirname "$PROJECT")/Personal/SaasBaaba/niche-radar}"
AFTER="${AFTER:-$(python3 -c 'from datetime import datetime,timedelta,timezone; print((datetime.now(timezone.utc)-timedelta(days=30)).date())')}"
BEFORE="${BEFORE:-$(python3 -c 'from datetime import datetime,timedelta,timezone; print((datetime.now(timezone.utc)+timedelta(days=1)).date())')}"
OUT="${OUT:-${INCOME_DATA_DIR:-$PROJECT}/data/raw/reddit}"
if [ ! -f "$NR/sources/reddit.py" ]; then
  echo 'Set NICHE_RADAR to a checkout containing sources/reddit.py.' >&2
  exit 1
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
SUBS=$(python3 -c "import json,sys;print(','.join(s for t in json.load(open(sys.argv[1]))['tiers'] for s in t['subreddits']))" "$HERE/subreddits.json")
echo "Scraping $AFTER .. $BEFORE -> $OUT"
(cd "$NR" && python3 sources/reddit.py --subreddits "$SUBS" --after "$AFTER" --before "$BEFORE" --kind "${KIND:-posts}" --output-dir "$OUT")
echo "Next: python3 $HERE/find_leads.py --data $OUT"
