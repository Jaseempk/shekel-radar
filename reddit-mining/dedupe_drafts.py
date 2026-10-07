#!/usr/bin/env python3
"""Clean an already-drafted queue: drop reposted / duplicate-title posts (a spam
signal, and it stops you posting near-identical replies), then regenerate
leads_drafts.md / leads_drafted.csv / leads_drafted.json. No re-drafting — runs
in seconds on what you already have.

Usage: python3 dedupe_drafts.py
"""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.runtime import ROOT, DATA_ROOT

import argparse
import json
from collections import Counter

from find_leads import title_signature  # single source of truth for the signature
from draft_leads import write_outputs    # reuse the same output builder


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default=str(DATA_ROOT / "exports/reddit-mining/leads_drafted.json"))
    ap.add_argument("--out", default=str(DATA_ROOT / "exports/reddit-mining/leads_drafted.csv"))
    args = ap.parse_args()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)

    recs = json.load(open(args.inp, encoding="utf-8"))
    counts = Counter(title_signature(r.get("title", "")) for r in recs)

    kept, dropped = [], []
    for r in recs:
        sig = title_signature(r.get("title", ""))
        (dropped if sig and counts[sig] > 1 else kept).append(r)

    n, _, md = write_outputs(kept, args.out, 0)
    print(f"Removed {len(dropped)} reposted/duplicate drafts -> {n} unique buyers in {md}\n")
    if dropped:
        print("Dropped (reposted across posts):")
        for r in dropped:
            print(f"  r/{r.get('subreddit',''):<20} {r.get('title','')[:60]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
