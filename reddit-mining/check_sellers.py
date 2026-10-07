#!/usr/bin/env python3
"""Second pass: for each surviving lead, fetch ONLY that post's comments and drop
leads a seller already replied to. Cheap — hundreds of targeted lookups, not the
millions of comments a full --kind both scrape pulls.

Usage:
    python3 find_leads.py --data ./data --out leads.csv      # posts-only, fast
    python3 check_sellers.py --leads leads.json --out leads.csv
"""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.runtime import ROOT, DATA_ROOT, atomic_write, write_json

import argparse
import csv
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from find_leads import SELLER  # reuse the same seller-signal lexicon

BASE = "https://arctic-shift.photon-reddit.com/api/comments/search"


def post_id_from_url(url):
    m = re.search(r"/comments/([a-z0-9]+)", url or "", re.I)
    return m.group(1) if m else None


def fetch_comments(pid):
    q = urllib.parse.urlencode({"link_id": pid, "limit": 100, "fields": "body"})
    req = urllib.request.Request(BASE + "?" + q, headers={"User-Agent": "lead-miner/0.1"})
    for _ in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                remaining = r.headers.get("X-RateLimit-Remaining")
                data = json.loads(r.read()).get("data", [])
                try:
                    if remaining is not None and float(remaining) < 5:
                        time.sleep(2.0)
                except ValueError:
                    pass
                return data
        except urllib.error.HTTPError as e:
            time.sleep(30 if e.code == 429 else 5)
        except Exception:
            time.sleep(5)
    raise RuntimeError("Seller lookup unavailable after retries")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--leads", default=str(DATA_ROOT / "exports/reddit-mining/leads.json"))
    ap.add_argument("--out", default=str(DATA_ROOT / "exports/reddit-mining/leads.csv"))
    ap.add_argument("--max-comments", type=int, default=5)
    ap.add_argument("--keep-contested", action="store_true", help="flag instead of drop")
    args = ap.parse_args()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)

    leads = json.loads(Path(args.leads).read_text())
    kept = []
    failures = []
    for i, ld in enumerate(leads, 1):
        pid = post_id_from_url(ld.get("url", ""))
        seller = False
        if not pid:
            failures.append({**ld, 'seller_check': 'unknown', 'error': 'No valid Reddit post ID'})
            continue
        if pid:
            try:
                comments = fetch_comments(pid)
            except Exception as e:
                failures.append({**ld, 'seller_check': 'unknown', 'error': str(e)})
                print(f"  seller check unavailable: {pid}")
                continue
            ld["num_comments"] = len(comments)
            seller = any(any(s in (c.get("body") or "").lower() for s in SELLER) for c in comments)
            time.sleep(0.5)  # ~2 req/s
        contested = seller or ld.get("num_comments", 0) > args.max_comments
        ld["contested"] = "yes" if contested else "no"
        ld["seller_check"] = "complete"
        print(f"  {i}/{len(leads)}  {ld.get('subreddit',''):<18} "
              f"{'SELLER — drop' if seller else 'clean'}  ({ld.get('num_comments',0)} cmts)")
        if contested and not args.keep_contested:
            continue
        kept.append(ld)

    kept.sort(key=lambda x: x.get("score", 0), reverse=True)
    fields = ["score", "subreddit", "offer", "num_comments", "contested",
              "age_days", "author", "title", "url", "matched", "angle"]
    with io.StringIO(newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(kept)
        atomic_write(args.out, f.getvalue())
    write_json(Path(args.out).with_suffix(".json"), kept)
    print(f"\n{len(kept)}/{len(leads)} leads survived the seller check -> {args.out}")
    write_json(Path(args.out).with_suffix('.retry.json'), failures)
    if failures:
        print(f"{len(failures)} unchecked leads saved for retry (not labelled clean)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
