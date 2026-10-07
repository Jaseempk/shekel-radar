# Buying Signals + Daily Signal Loop

Two engines: **outbound** (companies broadcasting an automatable process via job posts) and **inbound** (where buyers ask "how do I automate X"). Bookmark the URLs; run them each morning.

---

## ENGINE 1 — Buying-signal job posts (outbound)

**The signal:** a company hiring a human for repetitive research/entry = a process a pipeline can absorb.
- "lead research / list building / SDR / VA lead-gen" → **Offer B** (lead-enrichment + scoring).
- "data entry / operations coordinator / research assistant" → **Offer A** (RAG assistant / ingestion automation).

Freshest = a post from the **last 24 hours** (they feel the pain now, haven't hired yet). URLs are tuned to newest-first.

### LinkedIn Jobs (best titles + firmographics)
`f_TPR=r86400` = last 24h · `sortBy=DD` = newest · append `&f_WT=3` remote-only · `f_TPR=r3600` = last hour.

| Role | URL |
|---|---|
| Lead research | https://www.linkedin.com/jobs/search/?keywords=lead%20research&f_TPR=r86400&sortBy=DD |
| List building | https://www.linkedin.com/jobs/search/?keywords=list%20building&f_TPR=r86400&sortBy=DD |
| Lead-gen VA | https://www.linkedin.com/jobs/search/?keywords=lead%20generation%20virtual%20assistant&f_TPR=r86400&sortBy=DD |
| SDR | https://www.linkedin.com/jobs/search/?keywords=sales%20development%20representative&f_TPR=r86400&sortBy=DD |
| Data entry | https://www.linkedin.com/jobs/search/?keywords=data%20entry&f_TPR=r86400&sortBy=DD |
| Research assistant | https://www.linkedin.com/jobs/search/?keywords=research%20assistant&f_TPR=r86400&sortBy=DD |
| Operations coordinator | https://www.linkedin.com/jobs/search/?keywords=operations%20coordinator&f_TPR=r86400&sortBy=DD |

### Indeed (deepest SMB coverage)
`fromage=1` = last day · `sort=date`.

| Target | URL |
|---|---|
| "lead research" | https://www.indeed.com/jobs?q=%22lead+research%22&l=Remote&fromage=1&sort=date |
| "list building" | https://www.indeed.com/jobs?q=%22list+building%22&l=Remote&fromage=1&sort=date |
| "lead generation specialist" | https://www.indeed.com/jobs?q=%22lead+generation+specialist%22&fromage=1&sort=date |
| "data entry" | https://www.indeed.com/jobs?q=%22data+entry%22&l=Remote&fromage=1&sort=date |
| "prospect list" | https://www.indeed.com/jobs?q=%22prospect+list%22&fromage=3&sort=date |

### Upwork (clients literally describing the task they'll pay to remove — your #1 board)
`sort=recency`. Every post is a buyer with budget.

| Target | URL |
|---|---|
| Lead generation | https://www.upwork.com/nx/search/jobs/?q=lead%20generation&sort=recency |
| List building | https://www.upwork.com/nx/search/jobs/?q=list%20building&sort=recency |
| Lead research / enrichment | https://www.upwork.com/nx/search/jobs/?q=lead%20research&sort=recency |
| Data entry + CRM | https://www.upwork.com/nx/search/jobs/?q=data%20entry%20crm&sort=recency |
| Prospect list | https://www.upwork.com/nx/search/jobs/?q=prospect%20list&sort=recency |

### Wellfound / RemoteOK / WWR
- Wellfound: https://wellfound.com/role/r/sales-development · https://wellfound.com/role/r/operations
- RemoteOK: https://remoteok.com/remote-data-entry-jobs · https://remoteok.com/remote-virtual-assistant-jobs · JSON feed for your own scraper: `https://remoteok.com/api?tags=lead-generation`
- We Work Remotely: https://weworkremotely.com/remote-jobs/search?term=lead+generation

> The RemoteOK JSON feed is the hook for the optional daily auto-scraper (see README → "automate on a schedule").

---

## ENGINE 2 — Where buyers ask "how do I automate X" (inbound loop)

**Critical filter:** Skool/Discord "AI automation agency" rooms are mostly **peers/competitors**, not buyers — use for intel/tooling, not leads. Real buyers live in **operator subreddits, LinkedIn, and X**.

### Reddit (highest-intent buyer channel)
Per-sub: `https://www.reddit.com/r/SUB/search/?q=QUERY&restrict_sr=1&sort=new&t=week` · Site-wide: `https://www.reddit.com/search/?q=QUERY&sort=new&t=day`

| Subreddit | Why high-intent |
|---|---|
| r/msp | MSP owners: constant "how do I automate onboarding/reporting/lead intake" — buyers with budget |
| r/coldemail | Outbound operators — **prime** enrichment/scoring buyers |
| r/agency | Agency owners scaling ops |
| r/smallbusiness | SMB owners drowning in manual admin (RAG + entry buyers) |
| r/sales, r/salestechniques | SDR/AE pain = enrichment + scoring |
| r/digital_marketing | Agency-side lead-gen automation asks |
| r/Entrepreneur | Broad; filter with strings below |
| r/automation, r/n8n, r/Zapier, r/nocode | DIY buyers who often give up and outsource |
| r/RAG, r/LocalLLaMA | Doc-assistant build-vs-buy |

**Daily search strings** (`sort=new`):
- "how do I automate": https://www.reddit.com/search/?q=%22how%20do%20i%20automate%22&sort=new&t=day
- "automate lead": https://www.reddit.com/search/?q=%22automate%20lead%22&sort=new&t=day
- "lead enrichment": https://www.reddit.com/search/?q=%22lead%20enrichment%22&sort=new&t=week
- "manual data entry": https://www.reddit.com/search/?q=%22manual%20data%20entry%22&sort=new&t=week
- Per-sub: https://www.reddit.com/r/msp/search/?q=automate&restrict_sr=1&sort=new&t=week (repeat for r/agency, r/coldemail, r/smallbusiness)

### X / Twitter (`f=live` = newest)
- "how do I automate" + lead/outreach: https://x.com/search?q=%22how%20do%20i%20automate%22%20(lead%20OR%20outreach%20OR%20%22data%20entry%22)&f=live
- "automate my" + crm/leadgen: https://x.com/search?q=%22automate%20my%22%20(outreach%20OR%20%22lead%20gen%22%20OR%20crm)&f=live
- Pain venting: https://x.com/search?q=(%22so%20much%20manual%22%20OR%20%22hours%20every%20day%22)%20(leads%20OR%20%22data%20entry%22)&f=live
- Hashtags to monitor: #n8n #makecom #nocode #leadgen #salesautomation #RevOps

### LinkedIn
Follow hashtag feeds (`https://www.linkedin.com/feed/hashtag/?keywords=HASHTAG`): #nocode #n8n #salesautomation #leadgeneration #RevOps #marketingautomation. Groups: "No Code Founders", "Sales Automation Professionals", "RevOps Co-op". Search posts for `"how do we automate"` and comment.

### Skool / Discord (intel + occasional buyer — not primary)
- Skool: AI Automation Society https://www.skool.com/ai-automation-society · AI Automation Agency Hub https://www.skool.com/ai-automation-agency-hub
- Discord: n8n official (#help = live "how do I build X") https://discord.com/invite/n8n · find more: https://disboard.org/servers/tag/n8n

---

## How to run it daily (~45 min)
- **Morning (outbound):** LinkedIn + Indeed + Upwork last-24h searches → pull 10–20 buying-signal companies → personalized touch each (`outreach-scripts.md`).
- **Throughout (inbound):** Reddit + X live searches → answer 3–5 questions genuinely → let the DMs come.
- Skool/Discord = tooling intel, not your primary well.
