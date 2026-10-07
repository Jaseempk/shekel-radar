#!/usr/bin/env python3
"""Rank uncontested AI-automation leads from Arctic Shift JSONL.

Reads <data>/<sub>_posts.jsonl (produced by niche-radar/sources/reddit.py) and,
if present, <data>/<sub>_comments.jsonl to detect posts a seller already replied
to. Outputs leads.csv / leads.json ranked best-first, deduped by author.

Stdlib only — no pip install. Run:
    python3 find_leads.py --data ./data --max-comments 5 --out leads.csv
"""
import argparse
import csv
from collections import Counter
import glob
import json
import os
import re
import time

# ---- Signal lexicons (edit freely) ------------------------------------------

PAIN = [
    "manual", "manually", "by hand", "copy paste", "copy and paste", "copy-paste",
    "spreadsheet", "google sheet", "hours every", "takes hours", "so much time",
    "time consuming", "time-consuming", "tedious", "repetitive", "mind-numbing",
    "drowning in", "buried in", "hire a va", "hiring a va", "virtual assistant",
    "data entry", "one by one", "one at a time", "falling through the cracks",
    "keep track of", "painstaking", "so tedious", "waste of time",
]
INTENT = [
    "how do i automate", "how to automate", "is there a tool", "is there a way to",
    "any tool that", "any software that", "looking for someone to build",
    "need a developer", "need someone to build", "can someone build",
    "can someone automate", "willing to pay", "hire someone to", "recommend a tool",
    "best tool for", "automate this", "automate my", "streamline", "set up automation",
    "build a system", "is there software",
]
OFFER_LEAD = [  # Offer B — lead pipeline
    "lead list", "prospect list", "list building", "build a list", "lead gen",
    "lead generation", "enrich", "enrichment", "scrape leads", "find leads",
    "qualify leads", "score leads", "cold email list", "prospecting",
    "find contacts", "contact info", "sales navigator", "apollo", "dedupe",
    "verify emails", "crm data",
]
OFFER_RAG = [  # Offer A — doc assistant
    "knowledge base", "our docs", "internal docs", "sops", "standard operating",
    "onboarding docs", "search our", "answer questions from", "find in our",
    "documentation", "wiki", "chatbot for our", "train on our", "faq bot",
    "ticket deflection", "support answers",
]
SELLER = [  # if a comment contains these, the post was already worked
    "dm me", "dm'd", "pm me", "i build", "we build", "i can build", "i'll build",
    "i offer", "we offer", "i do this", "i run an agency", "my agency",
    "we specialize", "i specialize", "check my profile", "reach out to me",
    "i've built", "link in bio", "hire me", "book a call", "my service",
]
NEGATIVE = ["looking for a job", "my resume", "meme", "giveaway", "upvote if"]

# --- Buyer vs. seller framing (checked against the TITLE) --------------------
# A lead is someone ASKING for help. Drop posts that are the author OFFERING a
# service, promoting their own tool, or sharing an expert "how I did it" flex —
# those are competitors/subcontractors, not buyers.
PROMO = [
    "[for hire]", "for hire", "i built", "i made", "i created", "i've built",
    "ive built", "just built", "built a ", "built an ", "made a ", "made an ",
    "how i ", "how we ", "guide", "playbook", "tips for", "tips to", "everything i",
    "what i learned", "lessons learned", "lessons from", "my journey", "case study",
    "want to try", "try it free", "try it out", "check out my", "check it out",
    "feedback on my", "roast my", "thoughts on my", "review my", "rate my",
    "would love feedback", "would love your thoughts", "heres everything",
    "here's everything", "my saas", "my tool", "my app", "my startup", "my product",
    "my agency", "we built", "we made", "we launched", "launched", "launching",
    "introducing", "split revenue", "you bring clients", "i turned", "i grew",
    "i scaled", "i went from", "went from 0", "ranked honestly",
]
# A buyer post is help-seeking — require a "?" in the title OR one of these.
BUYER = [
    "how do i", "how do you", "how can i", "how to", "is there", "are there",
    "any tool", "any software", "anyone know", "anyone using", "anyone have",
    "does anyone", "recommend", "recommendation", "suggestion", "suggest",
    "best tool", "best way", "best software", "which tool", "what tool",
    "what's the best", "whats the best", "looking for", "need help", "need a",
    "need to", "help with", "struggling", "advice", "worth it",
]

# Titles that repeat across posts are a repost/spam signal (and would cause you
# to post near-identical replies). We collapse them by a signature of the
# significant words in the title, ignoring filler/question words.
TITLE_STOP = {
    "what", "whats", "best", "this", "that", "with", "your", "have", "does",
    "need", "tool", "tools", "from", "into", "when", "where", "which", "would",
    "could", "should", "about", "there", "here", "using", "help", "looking",
    "someone", "anyone", "recommend", "recommendation", "recommendations", "want",
}


def title_signature(title):
    words = re.findall(r"[a-z0-9]+", (title or "").lower())
    return frozenset(w for w in words if len(w) >= 4 and w not in TITLE_STOP)

# ---- Helpers ----------------------------------------------------------------


def count_hits(text, lexicon):
    return [kw for kw in lexicon if kw in text]


def load_weights(path):
    weights = {}
    try:
        data = json.load(open(path))
        for tier in data.get("tiers", []):
            w = float(tier.get("weight", 1.0))
            for sub in tier.get("subreddits", []):
                weights[sub.lower()] = w
    except (OSError, ValueError):
        pass
    return weights


def iter_jsonl(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


def load_comments(data_dir):
    """Scan scraped comments once. Returns:
      flagged  - post ids that already have a seller-signal reply (already worked)
      counts   - ACTUAL scraped comment count per post id. Reliable even for very
                 fresh posts, where Arctic Shift's num_comments field is still 0/1.
      subs_ok  - lowercased subreddits we actually have comments for
    """
    flagged, counts, subs_ok = set(), {}, set()
    suffix = "_comments.jsonl"
    for path in glob.glob(os.path.join(data_dir, "*" + suffix)):
        subs_ok.add(os.path.basename(path)[: -len(suffix)].lower())
        for c in iter_jsonl(path):
            link = (c.get("link_id") or "").replace("t3_", "")
            if not link:
                continue
            counts[link] = counts.get(link, 0) + 1
            body = (c.get("body") or "").lower()
            if any(s in body for s in SELLER):
                flagged.add(link)
    return flagged, counts, subs_ok


# ---- Main -------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="./data", help="dir of *_posts.jsonl files")
    ap.add_argument("--subreddits-file", default="subreddits.json")
    ap.add_argument("--max-comments", type=int, default=5, help="uncontested threshold")
    ap.add_argument("--min-age-hours", type=float, default=0.0, help="skip posts newer than N hours (0 = include all; actual comment counts keep fresh posts safe)")
    ap.add_argument("--max-age-days", type=float, default=0.0, help="skip posts older than N days (0 = include all)")
    ap.add_argument("--include-contested", action="store_true", help="keep worked posts too")
    ap.add_argument("--out", default="leads.csv")
    ap.add_argument("--top", type=int, default=25)
    args = ap.parse_args()

    weights = load_weights(args.subreddits_file)
    worked, actual_counts, subs_with_comments = load_comments(args.data)
    now = time.time()

    by_author = {}  # author -> best lead dict
    post_files = glob.glob(os.path.join(args.data, "*_posts.jsonl"))
    if not post_files:
        print(f"No *_posts.jsonl found in {args.data}. Run scrape.sh first.")
        return 1

    scanned = 0
    for path in post_files:
        for p in iter_jsonl(path):
            scanned += 1
            author = p.get("author") or ""
            if not author or author in ("[deleted]", "AutoModerator"):
                continue

            created = p.get("created_utc")
            try:
                created = float(created)
            except (TypeError, ValueError):
                continue
            age_h = (now - created) / 3600.0
            if age_h < args.min_age_hours:
                continue  # counts unreliable for <~36h-old posts
            if args.max_age_days and age_h / 24.0 > args.max_age_days:
                continue

            title = p.get("title") or ""
            body = p.get("selftext") or ""
            text = f"{title}\n{body}".lower()

            if any(n in text for n in NEGATIVE):
                continue

            # Buyer-intent gate: drop self-promo / for-hire / competitor posts,
            # and require the title to read as a question / help-seeking.
            title_l = title.lower()
            if any(pat in title_l for pat in PROMO):
                continue
            if "?" not in title and not any(sig in title_l for sig in BUYER):
                continue

            pain = count_hits(text, PAIN)
            intent = count_hits(text, INTENT)
            lead = count_hits(text, OFFER_LEAD)
            rag = count_hits(text, OFFER_RAG)
            offer = len(lead) + len(rag)

            # a real lead: explicit intent, or pain + a concrete offer signal
            if not (intent or (pain and offer)):
                continue

            pid = p.get("id") or ""
            sub = (p.get("subreddit") or "").lower()
            # Prefer the ACTUAL scraped comment count — reliable even for very
            # fresh posts, where Arctic Shift's num_comments field is still 0/1.
            if sub in subs_with_comments:
                num_comments = actual_counts.get(pid, 0)
            else:
                num_comments = p.get("num_comments") or 0
            contested = (num_comments > args.max_comments) or (pid in worked)
            if contested and not args.include_contested:
                continue

            tier_w = weights.get(sub, 1.0)
            recency = max(0.0, 2.0 - (age_h / 24.0) / 90.0)  # up to +2 within ~90 days
            uncontested_bonus = 0.0 if contested else 2.0
            score = (3 * len(intent) + 2 * offer + len(pain)
                     + tier_w + uncontested_bonus + recency)

            offer_type = "A — doc assistant" if len(rag) > len(lead) else "B — lead pipeline"
            matched = (intent + lead + rag + pain)[:5]
            angle = (f"Reply with a full teardown of how you'd automate '{(matched[0] if matched else 'this')}', "
                     f"then offer to send a 90-sec Loom. Fits Offer {offer_type[0]}.")

            permalink = p.get("permalink") or ""
            url = f"https://reddit.com{permalink}" if permalink.startswith("/") else permalink

            lead_row = {
                "score": round(score, 1),
                "subreddit": p.get("subreddit") or "",
                "offer": offer_type,
                "num_comments": int(num_comments),
                "contested": "yes" if contested else "no",
                "age_days": round(age_h / 24.0, 1),
                "author": author,
                "title": title.replace("\n", " ")[:140],
                "url": url,
                "matched": ", ".join(matched),
                "angle": angle,
            }
            prev = by_author.get(author)
            if prev is None or lead_row["score"] > prev["score"]:
                by_author[author] = lead_row

    leads = sorted(by_author.values(), key=lambda x: x["score"], reverse=True)

    # Drop reposted / duplicate titles (spam signal; prevents duplicate replies).
    sigs = {id(l): title_signature(l["title"]) for l in leads}
    sig_counts = Counter(s for s in sigs.values() if s)
    before_dedup = len(leads)
    leads = [l for l in leads if not sigs[id(l)] or sig_counts[sigs[id(l)]] == 1]
    deduped = before_dedup - len(leads)

    fields = ["score", "subreddit", "offer", "num_comments", "contested",
              "age_days", "author", "title", "url", "matched", "angle"]
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(leads)
    json_out = os.path.splitext(args.out)[0] + ".json"
    json.dump(leads, open(json_out, "w", encoding="utf-8"), indent=2)

    print(f"Scanned {scanned} posts across {len(post_files)} subreddits.")
    print(f"Dropped {deduped} reposted/duplicate-title posts (spam).")
    print(f"Found {len(leads)} unique-author leads -> {args.out} / {json_out}\n")
    print(f"{'SCORE':>5}  {'SUB':<20} {'CMTS':>4}  {'OFFER':<18} TITLE")
    print("-" * 100)
    for r in leads[:args.top]:
        print(f"{r['score']:>5}  {r['subreddit']:<20} {r['num_comments']:>4}  "
              f"{r['offer']:<18} {r['title'][:44]}")
        print(f"        {r['url']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
