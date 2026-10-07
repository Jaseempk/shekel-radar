#!/usr/bin/env python3
"""Draft one email per Workable-funnel company, written from its own site."""
import json, os, re, sys, time, urllib.request
sys.path.insert(0, os.path.join('..','reddit-mining'))
from anthropic import Anthropic
from dotenv import load_dotenv
load_dotenv(os.path.join('..','reddit-mining','.env'))
UA={'User-Agent':'Mozilla/5.0'}

def site(d):
    for u in (f'https://{d}', f'https://www.{d}'):
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=15) as r:
                h=r.read(400_000).decode('utf-8','ignore')
            t=re.sub(r'<script.*?</script>|<style.*?</style>',' ',h,flags=re.S|re.I)
            return re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',t))[:3000]
        except Exception: continue
    return ''

client=Anthropic()
data=json.load(open('wk_draft_data.json'))
out=['# Workable funnel — send queue\n',
     'Operating companies paying salaries for repetitive data work. Each draft written from that company\'s own site.\n',
     '**Check the opener matches the real business before sending.** Several are non-UK/US; if a site is not in English the draft may be thin.\n',
     'Two or three a day. Follow up day 4, close out day 12.\n']
for i,d in enumerate(data,1):
    about=site(d['domain'])
    lang_note = '' if about else ' (site unreachable or non-English — draft is generic, verify before sending)'
    prompt=f"""Write a short cold email from Jaseem, a freelance engineer who builds AI automation for business teams.

TARGET: {d['company']} ({d['domain']})
WHAT THEIR SITE SAYS: {about[:2200] or '(site unreachable — do not invent anything about their business)'}
THEY ARE HIRING: {'; '.join(d['roles'])}
LOCATION: {d['location']}

Jaseem's offer: back-office automation (pull from source systems, validate, route into the system of record, surface only exceptions for a human) and lead pipelines (source, enrich, AI-score 0-100 with a written reason, route ranked into a CRM). Proof: he built and runs the AI operations platform at a mid-sized company where he ALSO ran operations before engineering them. He has NO precise before/after metrics, so never state hours saved or percentages.

Open by naming the role they posted and something specific and true about their business from the site, then connect why that repetitive work exists for them specifically.

Rules: 90-130 words, plain text, no em dashes, no bullets, no marketing adjectives, lowercase conversational engineer-to-person tone, invent nothing, write in English, end offering a 90 second screen recording free with no pitch. No greeting, no signature. Return ONLY the body."""
    try:
        body=client.messages.create(model="claude-opus-4-8",max_tokens=700,
              messages=[{"role":"user","content":prompt}]).content[0].text.strip()
    except Exception as e:
        body=f'(draft failed: {e})'
    print(f'  {i}/{len(data)}  {d["company"]}{lang_note}')
    out.append(f'## {i}. {d["company"]}  ·  {d["domain"]}')
    out.append(f'**To:** {d["to"]}{lang_note}')
    out.append(f'**Hiring:** {"; ".join(d["roles"])}\n  {d["url"]}\n')
    out.append(f'**Subject:** the {d["title"].lower()[:50]} role\n')
    out.append('> Hi,\n>\n> '+body.replace('\n','\n> ')+'\n>\n> Jaseem\n> jaseem.co\n\n---\n')
    time.sleep(0.4)
open('wk_send_queue.md','w').write('\n'.join(out))
print(f'\n{len(data)} drafts -> wk_send_queue.md')
