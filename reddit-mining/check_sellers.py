#!/usr/bin/env python3
"""Second pass: for each surviving lead, fetch ONLY that post's comments and drop
leads a seller already replied to. Cheap — hundreds of targeted lookups, not the
millions of comments a full --kind both scrape pulls.

Usage:
    python3 find_leads.py --data ./data --out leads.csv      # posts-only, fast
    python3 check_sellers.py --leads leads.json --out leads.csv
"""
import argparse
import csv
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
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--leads", default="leads.json")
    ap.add_argument("--out", default="leads.csv")
    ap.add_argument("--keep-contested", action="store_true", help="flag instead of drop")
    args = ap.parse_args()

    leads = json.load(open(args.leads))
    kept = []
    for i, ld in enumerate(leads, 1):
        pid = post_id_from_url(ld.get("url", ""))
        seller = False
        if pid:
            comments = fetch_comments(pid)
            ld["num_comments"] = len(comments)
            seller = any(any(s in (c.get("body") or "").lower() for s in SELLER) for c in comments)
            time.sleep(0.5)  # ~2 req/s
        ld["contested"] = "yes" if seller else ld.get("contested", "no")
        print(f"  {i}/{len(leads)}  {ld.get('subreddit',''):<18} "
              f"{'SELLER — drop' if seller else 'clean'}  ({ld.get('num_comments',0)} cmts)")
        if seller and not args.keep_contested:
            continue
        kept.append(ld)

    kept.sort(key=lambda x: x.get("score", 0), reverse=True)
    fields = ["score", "subreddit", "offer", "num_comments", "contested",
              "age_days", "author", "title", "url", "matched", "angle"]
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(kept)
    json.dump(kept, open(os.path.splitext(args.out)[0] + ".json", "w"), indent=2)
    print(f"\n{len(kept)}/{len(leads)} leads survived the seller check -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
