#!/usr/bin/env python3
"""Steps 4 + 5: qualify each lead's author, then draft a reply for real buyers.

For each of the top-N leads (from leads.json), this:
  1. Pulls the author's recent Reddit posts + comments from Arctic Shift.
  2. Asks Claude — in ONE structured call — whether the author is a genuine
     potential BUYER (business/operator with the manual-work pain), NOT a
     builder validating their own tool, a competing freelancer, or a hobbyist.
  3. If a buyer, drafts a helpful, non-salesy Reddit reply ending in a soft offer.

Outputs (buyers only, best first):
  leads_drafted.csv   – spreadsheet
  leads_drafts.md     – human-readable, copy-paste queue (your daily driver)
  leads_drafted.jsonl – every processed lead (also the resume checkpoint)

Run:
  python3 draft_leads.py --leads leads.json --limit 150
Resumable: re-run the same command; already-processed posts are skipped.

Needs ANTHROPIC_API_KEY (env or .env). Arctic Shift needs no key.
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
from collections import Counter

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

MODEL = "claude-opus-4-8"  # swap to "claude-haiku-4-5" to cut cost on large batches
ARCTIC = "https://arctic-shift.photon-reddit.com/api"
MIN_BUYER_SCORE = 55  # include in the final queue only at/above this

PROMPT = """You help a freelance engineer decide whether a Reddit poster is a genuine potential CLIENT for AI-automation services, and if so, draft a reply.

THE ENGINEER (you are drafting as him):
- Builds AI automations for businesses. Two offers:
  - Offer B: lead-enrichment + AI-scoring pipelines (source -> enrich -> score 0-100 -> into their CRM).
  - Offer A: RAG assistants trained on a company's internal docs/SOPs (instant sourced answers).
- Proof: automated a mid-sized company's operations end to end.

THE POST (a potential lead):
- Subreddit: r/{sub}
- Title: {title}
- Body: {body}
- Keyword signals that matched: {matched}
- Best-fit offer: {offer}

THE AUTHOR'S RECENT REDDIT ACTIVITY:
- Most active in: {top_subs}
- Recent post titles:
{post_titles}
- Recent comment snippets:
{comment_snips}

TASK:
1) Decide if the AUTHOR is a genuine potential BUYER: a business owner, operator, agency, or working professional with real, ongoing manual/repetitive work that these automations would remove, who could plausibly pay.
   NOT a buyer: someone building or validating their OWN competing tool/SaaS; a freelancer or agency selling the same automation service; a hobbyist or student; someone just chatting; or a post where the keywords matched only loosely/off-topic.
2) buyer_score: 0-100 confidence they are a real, payable buyer with this pain.
3) If is_buyer is true (score >= 55), write draft_reply — a Reddit comment that:
   - HELPS FIRST: one or two concrete, specific things you'd actually do about THEIR exact problem. Real substance, no fluff, don't restate their question.
   - Sounds like a real person firing off a quick helpful reply — casual, plain, contractions, a bit offhand. NOT polished, NOT essay-like. Vary sentence length; slightly imperfect is good.
   - AVOID these AI tells: no "it's not X, it's Y" constructions, no "the trick is", no "that way you're not...", no neat wrap-up summary sentence, no corporate tone, no emojis, no links, no "I'd love to"/"feel free to".
   - Reference their actual words/situation.
   - Format as TWO short paragraphs with a blank line between them. Keep the WHOLE reply under ~100 words.
   - End with ONE soft, natural offer to show them — and VARY the wording every time (e.g. "can screen-record how I'd set it up if that's useful", "happy to show you the flow I use", "can throw together a quick clip if you wanna see it"). Never "DM me", never a hard pitch.
   If not a buyer, draft_reply must be "".

Return ONLY a JSON object and nothing else (no markdown, no text before or after), with exactly these keys:
{{"is_buyer": true or false, "buyer_score": <integer 0-100>, "reason": "<one line>", "draft_reply": "<the reply, or empty string>"}}"""


def arctic(kind, params):
    """GET /api/{kind}/search with rate-limit backoff. Returns data list."""
    url = f"{ARCTIC}/{kind}/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "lead-miner/0.1"})
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


def post_id_from_url(url):
    m = re.search(r"/comments/([a-z0-9]+)", url or "", re.I)
    return m.group(1) if m else None


def fetch_body(pid):
    if not pid:
        return ""
    url = f"{ARCTIC}/posts/ids?" + urllib.parse.urlencode(
        {"ids": pid, "fields": "selftext"})
    req = urllib.request.Request(url, headers={"User-Agent": "lead-miner/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read()).get("data", [])
            return (data[0].get("selftext") or "") if data else ""
    except Exception:
        return ""


def author_profile(author):
    """Compact summary of an author's recent activity for the LLM."""
    posts = arctic("posts", {"author": author, "limit": 40, "sort": "desc",
                             "fields": "subreddit,title"})
    time.sleep(0.3)
    comments = arctic("comments", {"author": author, "limit": 40, "sort": "desc",
                                   "fields": "subreddit,body"})
    subs = Counter()
    for x in posts + comments:
        if x.get("subreddit"):
            subs[x["subreddit"]] += 1
    top_subs = ", ".join(f"r/{s} ({n})" for s, n in subs.most_common(10)) or "unknown"
    titles = "\n".join(f"  - {(p.get('title') or '').strip()[:120]}" for p in posts[:15]) or "  (none)"
    snips = "\n".join(f"  - {(c.get('body') or '').strip()[:120]}" for c in comments[:10]) or "  (none)"
    return top_subs, titles, snips


def _parse_json(text):
    """Parse the model's JSON, tolerating stray text around the object."""
    try:
        return json.loads(text)
    except ValueError:
        s, e = text.find("{"), text.rfind("}")
        if s != -1 and e > s:
            return json.loads(text[s:e + 1])
        raise


def qualify_and_draft(client, lead):
    pid = post_id_from_url(lead.get("url", ""))
    body = fetch_body(pid)
    time.sleep(0.3)
    top_subs, post_titles, comment_snips = author_profile(lead.get("author", ""))
    prompt = PROMPT.format(
        sub=lead.get("subreddit", ""),
        title=lead.get("title", ""),
        body=(body or "(no body text)")[:600],
        matched=lead.get("matched", ""),
        offer=lead.get("offer", ""),
        top_subs=top_subs,
        post_titles=post_titles,
        comment_snips=comment_snips,
    )
    resp = client.messages.create(
        model=MODEL,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "".join(b.text for b in resp.content if b.type == "text")
    data = _parse_json(text)
    return {
        **lead,
        "is_buyer": bool(data.get("is_buyer")),
        "buyer_score": int(data.get("buyer_score") or 0),
        "buyer_reason": data.get("reason", ""),
        "draft": data.get("draft_reply", ""),
    }


# ---- output builders (offline-testable) -------------------------------------

CSV_FIELDS = ["buyer_score", "is_buyer", "subreddit", "offer", "num_comments",
              "age_days", "author", "title", "url", "buyer_reason", "draft"]


def write_outputs(records, out_csv, min_score):
    buyers = [r for r in records if r.get("is_buyer") and r.get("buyer_score", 0) >= min_score]
    buyers.sort(key=lambda x: x.get("buyer_score", 0), reverse=True)

    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(buyers)
    json.dump(buyers, open(os.path.splitext(out_csv)[0] + ".json", "w"), indent=2)

    md_path = "leads_drafts.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# Ready-to-post replies — {len(buyers)} qualified buyers\n\n")
        f.write("Review each draft, tweak the voice to sound like you, then post from your account. Highest-confidence first.\n\n---\n\n")
        for i, r in enumerate(buyers, 1):
            f.write(f"## {i}. r/{r.get('subreddit','')} · buyer {r.get('buyer_score')}/100 · {r.get('offer','')}\n\n")
            f.write(f"**{r.get('title','')}**\n\n")
            f.write(f"{r.get('url','')}\n\n")
            f.write(f"*Why a buyer:* {r.get('buyer_reason','')}\n\n")
            f.write("**Draft reply:**\n\n")
            draft = (r.get("draft") or "").strip()
            f.write("> " + draft.replace("\n", "\n> ") + "\n\n---\n\n")
    return len(buyers), buyers, md_path


def main():
    global MODEL
    ap = argparse.ArgumentParser()
    ap.add_argument("--leads", default="leads.json")
    ap.add_argument("--limit", type=int, default=150, help="process the top N ranked leads")
    ap.add_argument("--out", default="leads_drafted.csv")
    ap.add_argument("--min-score", type=int, default=MIN_BUYER_SCORE)
    ap.add_argument("--model", default=MODEL)
    args = ap.parse_args()

    MODEL = args.model

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Set ANTHROPIC_API_KEY (export it or put it in .env).")
        return 1

    leads = json.load(open(args.leads))[: args.limit]
    ckpt = os.path.splitext(args.out)[0] + ".jsonl"

    # resume: load already-processed records, skip their post ids
    done = {}
    if os.path.exists(ckpt):
        for line in open(ckpt, encoding="utf-8"):
            line = line.strip()
            if line:
                try:
                    rec = json.loads(line)
                    done[rec.get("url", "")] = rec
                except ValueError:
                    pass

    client = Anthropic()
    records = list(done.values())
    ckpt_fh = open(ckpt, "a", encoding="utf-8")
    todo = [ld for ld in leads if ld.get("url", "") not in done]
    print(f"{len(done)} already done · {len(todo)} to process (top {args.limit})\n")

    for i, lead in enumerate(todo, 1):
        try:
            rec = qualify_and_draft(client, lead)
        except Exception as e:
            rec = {**lead, "is_buyer": False, "buyer_score": 0,
                   "buyer_reason": f"error: {e}", "draft": ""}
        records.append(rec)
        ckpt_fh.write(json.dumps(rec) + "\n")
        ckpt_fh.flush()
        tag = f"BUYER {rec['buyer_score']:>3}" if rec.get("is_buyer") else "  skip   "
        print(f"  {i}/{len(todo)}  {tag}  r/{rec.get('subreddit',''):<18} {rec.get('title','')[:46]}")
        time.sleep(0.2)

    ckpt_fh.close()
    n, _, md_path = write_outputs(records, args.out, args.min_score)
    print(f"\n{n} qualified buyers -> {args.out} / {md_path}")
    print(f"Open {md_path} for the copy-paste queue.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
