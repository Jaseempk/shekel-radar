# X + Facebook Signal Mining — the non-technical-operator channel

Thesis: technical founders DIY with n8n and ChatGPT; non-technical operators (trades, clinics, realtors, recruiters, boomer-run SMBs) describe the pain in plain language and need someone to just build it. X finds them venting publicly; Facebook groups are where they actually live.

Rules first:
- **X:** manual monitoring below, 10 min/day. Automated capture is possible (see bottom) but is a ToS risk you must consciously accept.
- **Facebook:** NEVER automate. Account bans are fast and can take down Business Manager with them. Manual only.
- Replies follow `outreach-scripts.md` §4: answer fully and genuinely first, credential line at the end, let them come to you. No links in first replies on either platform.

---

## X live searches (bookmark all; check once daily, newest first)

Pain venting, plain language:
- https://x.com/search?q=%22spend%20hours%22%20(%22every%20week%22%20OR%20%22every%20day%22)%20(spreadsheet%20OR%20%22data%20entry%22%20OR%20invoices)&f=live
- https://x.com/search?q=%22there%20has%20to%20be%20a%20better%20way%22%20(leads%20OR%20clients%20OR%20invoices%20OR%20scheduling)&f=live
- https://x.com/search?q=%22copy%20and%20paste%22%20(crm%20OR%20spreadsheet%20OR%20%22every%20lead%22)&f=live
- https://x.com/search?q=%22drowning%20in%22%20(admin%20OR%20paperwork%20OR%20emails%20OR%20spreadsheets)&f=live

Help-seeking, non-technical phrasing (they ask for "someone", not "a tool"):
- https://x.com/search?q=%22is%20there%20someone%20who%22%20(automate%20OR%20%22set%20up%22)%20-crypto&f=live
- https://x.com/search?q=%22who%20do%20I%20hire%22%20(automate%20OR%20%22ai%20for%20my%22)&f=live
- https://x.com/search?q=%22not%20technical%22%20(automate%20OR%20ai%20OR%20workflow)&f=live
- https://x.com/search?q=%22how%20do%20i%20automate%22%20-code%20-n8n%20-developer&f=live

Vertical-specific (rotate through, one per day):
- https://x.com/search?q=(realtor%20OR%20%22real%20estate%20agent%22)%20(%22follow%20up%22%20OR%20leads)%20(manual%20OR%20%22by%20hand%22%20OR%20forgetting)&f=live
- https://x.com/search?q=(recruiter%20OR%20recruiting)%20(sourcing%20OR%20%22candidate%20research%22)%20(hours%20OR%20manual%20OR%20tedious)&f=live
- https://x.com/search?q=(%22my%20clinic%22%20OR%20%22my%20practice%22%20OR%20%22front%20desk%22)%20(scheduling%20OR%20%22no%20shows%22%20OR%20reminders)%20(manual%20OR%20nightmare)&f=live
- https://x.com/search?q=(contractor%20OR%20hvac%20OR%20plumbing%20OR%20roofing)%20(quotes%20OR%20invoices%20OR%20leads)%20(paperwork%20OR%20%22falling%20behind%22)&f=live

Qualify before replying (30 seconds): real person, not a builder/marketer themselves; describes THEIR business; account active. Skip anyone selling anything.

---

## Facebook groups (manual playbook)

Find via group search — join 5-8 total, no more:
- Search: "real estate agents", "realtor mastermind", "HVAC business owners", "contractor business", "dental practice owners", "recruiting and staffing professionals", "small business owners [your target country/city]", "bookkeepers community"
- Prefer groups 5k-50k members with daily posts and admin moderation (spam-free groups have buyers; spammy groups have sellers).

The loop (15 min/day):
1. Sort by New. Scan for pain posts: "how do you all handle...", "is there an easier way...", "what do you use for...", anyone describing manual routine work.
2. Use Facebook's in-group keyword search weekly: "automate", "spreadsheet", "VA", "hours every".
3. Answer 1-2 per day maximum, genuinely and completely, zero links, zero pitch. Credential line only: "I build these systems for businesses like yours, happy to answer follow-ups."
4. Let DMs come to you. In DM, offer the 90-sec Loom, then Calendly.

What makes this channel work: in boomer-operator groups a complete, patient, jargon-free answer is rare enough to be remarkable. You are not competing with other sellers there; you are competing with silence and bad advice.

Timing note: group admins often ban visible sellers. The credential line is the maximum. If a group has a weekly promo thread, use that and only that for anything promotional.

---

## Optional: automating the X side

`~/SOLIDITY/twitter-bookmarks-export` already contains the technique: attach to the logged-in browser over CDP and capture the GraphQL responses the page loads itself. Repurposed, it would: open each saved search above, capture results, dedupe against seen posts, LLM-score buyer-intent (same rubric as `reddit-mining/draft_leads.py`), and append to a daily queue.

Decision required before building: read-only automation of your own session is the mildest ToS breach and rarely enforced at low volume, but it is a breach. After the Reddit ban, only proceed if losing this X account would be acceptable. If yes, keep it to 1-2 runs/day, randomized timing, reading only — posting stays 100% manual forever.
