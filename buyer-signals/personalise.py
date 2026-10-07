#!/usr/bin/env python3
"""Draft one genuinely specific email per company.

The template version produced near-clones because eight of ten targets posted the
same role. This reads each company's own site first, then writes an email that
could only have been sent to them.

Run: python3 personalise.py
"""
import json, os, re, sys, time, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'reddit-mining'))
from anthropic import Anthropic
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'reddit-mining', '.env'))

MODEL = "claude-opus-4-8"
UA = {'User-Agent': 'Mozilla/5.0'}

def site_text(domain):
    for url in (f'https://{domain}', f'https://www.{domain}'):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=15) as r:
                html = r.read(400_000).decode('utf-8', 'ignore')
            text = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', html, flags=re.S | re.I)
            text = re.sub(r'<[^>]+>', ' ', text)
            text = re.sub(r'\s+', ' ', text)
            return text[:4000]
        except Exception:
            continue
    return ''

client = Anthropic()
data = json.load(open('draft_data.json'))
prospects = json.load(open('prospects.json'))['prospects']
dom = {p['company']: p['domain'] for p in prospects}

out = ['# Send queue (personalised) — one email per company, written from their own site\n',
       'Each draft references what this specific company does. Review, tweak a word, send.\n',
       'Two or three a day. Follow up day 4, close out day 12.\n']

for i, d in enumerate(data, 1):
    domain = dom.get(d['company'], '')
    about = site_text(domain)
    roles = '; '.join(d['titles'])
    prompt = f"""Write a short cold email from Jaseem, a freelance engineer who builds AI automation for business teams.

TARGET COMPANY: {d['company']} ({domain})
WHAT THEIR SITE SAYS: {about[:2500] or '(site unreachable — do not invent facts about them)'}
THEY ARE CURRENTLY HIRING: {roles}

Jaseem's offer: he builds lead pipelines (source, enrich, AI-score each lead 0-100 with a written reason, route ranked into a CRM), back-office data automation, and assistants over internal documents. His proof: he built and runs the AI operations platform at a mid-sized company where he ALSO ran operations before engineering them. He does NOT have precise before/after metrics, so never state hours saved or percentages.

Write the email so it could only have been sent to THIS company. Open by naming the role they posted AND something specific and true about what they actually do, drawn from their site. Connect their business to why that manual work exists for them specifically.

Rules:
- 90-130 words, plain text
- no em dashes, no bullet points, no marketing adjectives
- lowercase conversational tone, like an engineer writing to another person
- do not invent metrics, headcount, customers or funding
- if the site text is empty, write from the role alone and stay vague about their business rather than guessing
- end by offering a 90 second screen recording, free, no pitch
- do NOT include a greeting line or signature, just the body

Return ONLY the email body."""

    try:
        msg = client.messages.create(model=MODEL, max_tokens=700,
                                     messages=[{"role": "user", "content": prompt}])
        body = msg.content[0].text.strip()
    except Exception as e:
        body = f'(draft failed: {e})'
    print(f'  {i}/{len(data)}  {d["company"]}')
    out.append(f'## {i}. {d["company"]}')
    out.append(f'**To:** {d["to"]}  ·  hiring: {roles}\n')
    out.append(f'**Subject:** {d["title"].strip().lower()}\n')
    out.append('> Hi,\n>\n> ' + body.replace('\n', '\n> ') + '\n>\n> Jaseem\n> jaseem.co\n\n---\n')
    time.sleep(0.5)

open('send_queue_personalised.md', 'w').write('\n'.join(out))
print(f'\n{len(data)} personalised drafts -> send_queue_personalised.md')
