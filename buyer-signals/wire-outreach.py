#!/usr/bin/env python3
"""Turn buyer signals into contactable prospects with drafted outreach.

Three phases:
  1. resolve each ATS slug to the company's real domain
  2. find + SMTP-verify an address there (reuses ../email-finder/find_emails.py)
  3. draft an email whose opening line names THEIR OWN job posting

The trigger is the whole point: most cold email guesses at pain. Here the
company published a job ad proving it, with a salary attached.

Run: python3 wire-outreach.py
Out: outreach_YYYY-MM-DD.md  (+ prospects.json for the verifier)
"""
import json, re, sys, os, datetime, urllib.request, urllib.error, socket
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'email-finder'))

ATS_HOSTS = re.compile(r'greenhouse\.io|ashbyhq\.com|lever\.co|rippling|teamtailor|breezy\.hr|recruitee', re.I)
UA = {'User-Agent': 'Mozilla/5.0 (prospect-research)'}

def head_ok(url, timeout=8):
    try:
        req = urllib.request.Request(url, headers=UA, method='HEAD')
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 400
    except Exception:
        return False

def resolve_domain(slug, job_urls):
    """Prefer a custom careers host; otherwise probe the obvious domains."""
    for u in job_urls:
        try:
            host = urllib.parse.urlparse(u).netloc.lower().replace('www.', '')
        except Exception:
            continue
        if host and not ATS_HOSTS.search(host):
            return host
    base = re.sub(r'[^a-z0-9]', '', slug.lower())
    base = re.sub(r'\d+$', '', base)           # affinipay1 -> affinipay
    for tld in ('.com', '.io', '.ai', '.co'):
        if head_ok(f'https://{base}{tld}'):
            return base + tld
    return None

import urllib.parse
day = datetime.date.today().isoformat()
signals = json.load(open(os.path.join(HERE, f'buyers_{day}.json')))

by_company = defaultdict(list)
for s in signals:
    by_company[s['company']].append(s)
print(f'{len(signals)} signals across {len(by_company)} companies\n')

# ---------- phase 1: domains ----------
prospects, skipped = [], []
for slug, rows in by_company.items():
    dom = resolve_domain(slug, [r['url'] for r in rows])
    if dom:
        prospects.append({'company': slug, 'domain': dom, 'founder': None})
        print(f'  ✓ {slug:<24} -> {dom}')
    else:
        skipped.append(slug)
        print(f'  · {slug:<24} -- no domain found')

json.dump({'prospects': prospects}, open(os.path.join(HERE, 'prospects.json'), 'w'), indent=2)
print(f'\n{len(prospects)} domains resolved, {len(skipped)} skipped -> prospects.json')
print('next: python3 ../email-finder/find_emails.py --prospects prospects.json --out emails.csv')

# ---------- phase 3: draft outreach (run after find_emails.py) ----------
def draft():
    import csv
    from collections import defaultdict
    BAD = re.compile(r'^(legal|privacy|security|abuse|dmca|compliance|websites?|platform|noreply|no-reply|postmaster|webmaster|legalnotices|copyright|trademark|gdpr|dpo|support|care|arbitration)@', re.I)
    PREF = ['hello@', 'contact@', 'team@', 'info@', 'sales@', 'partnerships@', 'growth@', 'marketing@']

    rows = [r for r in csv.DictReader(open(os.path.join(HERE, 'emails.csv'))) if r['smtp'] == 'valid']
    by_co = defaultdict(list)
    for r in rows:
        if not BAD.match(r['email']):
            by_co[r['company']].append(r['email'])
    def best(emails):
        for p in PREF:
            for e in emails:
                if e.lower().startswith(p): return e
        return emails[0]

    sigs = json.load(open(os.path.join(HERE, f'buyers_{day}.json')))
    roles = defaultdict(list)
    for s in sigs: roles[s['company']].append(s)

    out, n = [], 0
    out.append(f'# Buyer-signal outreach — {day}\n')
    out.append('Each company below published a job ad for work you automate. The opening line names their own posting, so the trigger is a fact, not a guess.\n')
    out.append('Send 2-3 a day from your own address. Follow up day 4, close out day 12.\n')

    for co, emails in sorted(by_co.items()):
        rs = roles.get(co, [])
        if not rs: continue
        n += 1
        email = best(emails)
        titles = [r['title'] for r in rs]
        kind = rs[0]['why']
        cnt = len(rs)

        if 'prospecting' in kind:
            plural = f'{cnt} SDRs' if cnt > 1 else titles[0]
            body = (f"saw you're hiring {plural}. New reps usually lose most of month one to building and cleaning lists "
                    f"instead of selling.\n\nI build the layer under that: source, enrich, score each lead 0-100 with a reason, "
                    f"drop them ranked into your CRM. Reps start the week with a worked list instead of a blank sheet. "
                    f"I ran operations before automating them.\n\n"
                    f"Want a 90 second screen recording of how I'd wire it to your stack? No pitch, just the build.")
        elif 'back-office' in kind or 'processing' in kind:
            body = (f"saw the {titles[0]} opening. That role is usually 80% moving data between systems by hand.\n\n"
                    f"I automate exactly that: pull from the source, validate, route into the system of record, flag only the "
                    f"exceptions for a human. Built one for a mid-sized company that took a manual weekly process down to "
                    f"under an hour.\n\nHappy to record a 90 second walkthrough of how I'd approach yours. Free, no catch.")
        else:
            body = (f"saw the {titles[0]} opening. If the goal is people finding answers in your own docs faster, that's "
                    f"buildable without adding headcount.\n\nI build assistants over internal docs: every answer cites its "
                    f"source and respects who's allowed to see what. Did this over a 6,300 file drive and shipped it only "
                    f"after it passed a retrieval accuracy benchmark.\n\nWant a 90 second walkthrough? No pitch.")

        out.append(f'## {n}. {co}  ·  {cnt} matching role{"s" if cnt>1 else ""}')
        out.append(f'**To:** {email}' + (f'  ·  alts: {", ".join(e for e in emails if e != email)}' if len(emails) > 1 else ''))
        for r in rs[:4]:
            out.append(f'- {r["title"]}  \n  {r["url"]}')
        out.append(f'\n**Subject:** {"your SDR hires" if "prospecting" in kind else "the " + titles[0].lower() + " role"}\n')
        out.append(f'> Hi,\n>\n> ' + body.replace('\n', '\n> ') + '\n')
        out.append('---\n')

    p = os.path.join(HERE, f'outreach_{day}.md')
    open(p, 'w').write('\n'.join(out))
    print(f'{n} companies with drafted outreach -> {os.path.basename(p)}')

if '--draft' in sys.argv:
    draft()
