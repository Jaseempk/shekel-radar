#!/usr/bin/env python3
"""Lead scoring demo — ranks leads 0-100 against an ICP using Claude.

Reads sample_leads.csv, scores each lead with a one-line reason, writes
ranked_leads.csv (best first) and prints a table. This is the reusable core
you productize per client.
"""
import csv
import json
import os
import sys

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

# Default to the flagship model. For bulk lists, switch to "claude-haiku-4-5"
# to cut cost ~5x — plenty capable for lead scoring.
MODEL = "claude-opus-4-8"

LEADS_FILE = "sample_leads.csv"
ICP_FILE = "icp.md"
OUT_FILE = "ranked_leads.csv"

SCORE_SCHEMA = {
    "type": "object",
    "properties": {
        "score": {"type": "integer"},
        "reason": {"type": "string"},
    },
    "required": ["score", "reason"],
    "additionalProperties": False,
}


def score_lead(client: Anthropic, icp: str, lead: dict) -> dict:
    lead_desc = "\n".join(f"- {k}: {v}" for k, v in lead.items())
    prompt = (
        "You are scoring a sales lead against an ideal-customer profile (ICP).\n\n"
        f"# ICP\n{icp}\n\n"
        f"# Lead\n{lead_desc}\n\n"
        "Give an integer score from 0 (terrible fit / disqualified) to 100 "
        "(perfect fit), and a single short sentence explaining why. Be decisive: "
        "reserve 80+ for strong fits and push clear disqualifiers below 20."
    )
    resp = client.messages.create(
        model=MODEL,
        max_tokens=300,
        output_config={"format": {"type": "json_schema", "schema": SCORE_SCHEMA}},
        messages=[{"role": "user", "content": prompt}],
    )
    text = next(b.text for b in resp.content if b.type == "text")
    return json.loads(text)


def main() -> int:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Set ANTHROPIC_API_KEY (copy .env.example to .env and fill it in).")
        return 1

    with open(ICP_FILE) as f:
        icp = f.read()
    with open(LEADS_FILE, newline="") as f:
        leads = list(csv.DictReader(f))

    client = Anthropic()
    scored = []
    for i, lead in enumerate(leads, 1):
        result = score_lead(client, icp, lead)
        lead["score"] = result["score"]
        lead["reason"] = result["reason"]
        scored.append(lead)
        print(f"  scored {i}/{len(leads)}: {lead.get('company','?')} -> {result['score']}")

    scored.sort(key=lambda x: x["score"], reverse=True)

    fields = list(leads[0].keys())
    with open(OUT_FILE, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(scored)

    print(f"\nRanked {len(scored)} leads (best first) -> {OUT_FILE}\n")
    print(f"{'SCORE':>5}  {'COMPANY':<24} REASON")
    print("-" * 78)
    for lead in scored:
        print(f"{lead['score']:>5}  {lead.get('company',''):<24} {lead['reason']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
