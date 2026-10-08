#!/usr/bin/env python3
"""DIY email finder + verifier for the agency prospect list. Stdlib only.

Per prospect:
  1. SCRAPE  - fetch a handful of likely pages on their site, regex out
               published addresses (mailto: and plain text).
  2. PATTERN - when we know the founder's name, generate the usual corporate
               patterns (first@, first.last@, flast@, ...). Always try the
               generic inboxes (hello@, info@, ...) as a fallback.
  3. VERIFY  - MX lookup, then an SMTP RCPT TO handshake (no mail is sent).
               A random probe address first detects catch-all domains, where
               every address "exists" and verification proves nothing.

Output: found_emails.csv, one row per candidate, best evidence first.
Run:  python3 find_emails.py            (all prospects)
      python3 find_emails.py --only salesbread.com
"""
from pathlib import Path
import io
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.runtime import DATA_ROOT, atomic_write

import argparse
import csv
import json
import os
import random
import re
import smtplib
import socket
import string
import subprocess
import sys
import time
import urllib.request
import urllib.error
from html import unescape

HERE = os.path.dirname(os.path.abspath(__file__))
PAGES = ["", "contact", "contact-us", "about", "about-us", "team", "privacy-policy", "privacy", "terms"]
GENERIC = ["hello", "info", "contact", "sales", "team", "founders"]
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
JUNK = ("example.", "sentry", "wixpress", "your@", "email@", "name@", "@2x", ".png", ".jpg", ".webp", ".svg", "@sentry")
MAIL_FROM = "jaseem.co"  # plausible envelope sender for the probe
HELO = "gmail.com"


def fetch(url, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if "text" not in (r.headers.get("Content-Type") or "text"):
                return ""
            return r.read(800_000).decode("utf-8", "ignore")
    except Exception:
        return ""


def published_emails(html):
    """Read plain text, mailto and Cloudflare's public email display encoding."""
    # Embedded JSON can encode markup delimiters; otherwise "\\u003esales@"
    # incorrectly becomes the candidate "u003esales@".
    text = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m[1], 16)), html)
    text = unescape(text)
    for encoded in re.findall(r'data-cfemail=[\"\']([a-fA-F0-9]+)[\"\']', text):
        try:
            raw = bytes.fromhex(encoded)
            text += ' ' + bytes(c ^ raw[0] for c in raw[1:]).decode('utf-8')
        except (ValueError, UnicodeDecodeError):
            continue
    return {email.lower().rstrip('.') for email in EMAIL_RE.findall(text)
            if not any(j in email.lower() for j in JUNK)}


def scrape_site(domain):
    found = {}
    for path in PAGES:
        for scheme_host in (f"https://{domain}", f"https://www.{domain}"):
            source_url = f"{scheme_host}/{path}"
            html = fetch(source_url)
            if not html:
                continue
            for email in published_emails(html):
                found.setdefault(email, source_url)
            break  # first host variant that answered is enough for this path
        time.sleep(0.3)
    on_domain = {e: source for e, source in found.items() if e.split("@")[1].removeprefix("www.") == domain}
    return on_domain, {e: source for e, source in found.items() if e not in on_domain}


def pattern_candidates(founder, domain):
    if not founder:
        return []
    f, l = founder
    return [c + "@" + domain for c in
            (f, f"{f}.{l}", f"{f}{l}", f"{f[0]}{l}", f"{f}_{l}", f"{f}{l[0]}", l)]


def mx_hosts(domain):
    try:
        out = subprocess.run(["dig", "+short", "MX", domain], capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return []
    hosts = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit():
            hosts.append((int(parts[0]), parts[1].rstrip(".")))
    return [h for _, h in sorted(hosts)]


class DomainVerifier:
    """One SMTP session per domain; detects catch-all with a random probe."""

    def __init__(self, domain):
        self.domain = domain
        self.mx = mx_hosts(domain)
        self.server = None
        self.catch_all = None

    def _connect(self):
        for host in self.mx[:2]:
            try:
                s = smtplib.SMTP(host, 25, local_hostname=HELO, timeout=20)
                s.ehlo_or_helo_if_needed()
                s.mail(MAIL_FROM)
                return s
            except Exception:
                continue
        return None

    def check(self, email):
        """-> 'valid' | 'invalid' | 'catchall' | 'unknown'"""
        if not self.mx:
            return "unknown"
        if self.server is None:
            self.server = self._connect()
            if self.server is None:
                return "unknown"
            probe = "".join(random.choices(string.ascii_lowercase, k=14)) + "@" + self.domain
            self.catch_all = self._rcpt(probe) == 250
        if self.catch_all:
            return "catchall"
        code = self._rcpt(email)
        if code == 250:
            return "valid"
        if code in (550, 551, 553):
            return "invalid"
        return "unknown"

    def _rcpt(self, email):
        try:
            code, _ = self.server.rcpt(email)
            return code
        except Exception:
            try:
                self.server.quit()
            except Exception:
                pass
            self.server = self._connect()
            if self.server is None:
                return -1
            try:
                code, _ = self.server.rcpt(email)
                return code
            except Exception:
                return -1

    def close(self):
        if self.server is not None:
            try:
                self.server.quit()
            except Exception:
                pass


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--prospects", default=os.path.join(HERE, "prospects.json"))
    ap.add_argument("--out", default=str(DATA_ROOT / "exports/email-finder/found_emails.csv"))
    ap.add_argument("--only", help="comma-separated domains to limit to")
    args = ap.parse_args(argv)

    prospects = json.loads(Path(args.prospects).read_text())["prospects"]
    if args.only:
        keep = {d.strip() for d in args.only.split(",")}
        prospects = [p for p in prospects if p["domain"] in keep]

    rows = []
    for i, p in enumerate(prospects, 1):
        dom, company, founder = p["domain"], p["company"], p.get("founder")
        print(f"[{i}/{len(prospects)}] {company} ({dom})", flush=True)

        scraped_own, scraped_other = scrape_site(dom)
        candidates = []  # (email, source) in priority order
        for e in sorted(scraped_own):
            candidates.append((e, "scraped"))
        for e in pattern_candidates(founder, dom):
            if all(e != c for c, _ in candidates):
                candidates.append((e, "pattern"))
        for g in GENERIC:
            e = f"{g}@{dom}"
            if all(e != c for c, _ in candidates):
                candidates.append((e, "generic"))

        ver = DomainVerifier(dom)
        found_valid = 0
        for email, source in candidates:
            if found_valid >= 2 and source != "scraped":
                break  # two verified non-scraped hits per company is plenty
            status = ver.check(email)
            rows.append({"company": company, "domain": dom, "email": email,
                         "source": source, "source_url": scraped_own.get(email, ''), "smtp": status,
                         "founder": " ".join(founder) if founder else ""})
            if status == "valid":
                found_valid += 1
            print(f"    {email:<45} {source:<8} {status}", flush=True)
            time.sleep(0.8)
        for e in sorted(scraped_other):
            rows.append({"company": company, "domain": dom, "email": e,
                         "source": "scraped-offsite", "source_url": scraped_other[e], "smtp": "", "founder": ""})
        ver.close()
        time.sleep(1.0)

    order = {"valid": 0, "catchall": 1, "unknown": 2, "": 3, "invalid": 4}
    rows.sort(key=lambda r: (r["company"], order.get(r["smtp"], 5)))
    with io.StringIO(newline="") as f:
        w = csv.DictWriter(f, fieldnames=["company", "domain", "email", "source", "source_url", "smtp", "founder"])
        w.writeheader()
        w.writerows(rows)
        atomic_write(args.out, f.getvalue())
    n_valid = sum(1 for r in rows if r["smtp"] == "valid")
    n_catch = len({r["domain"] for r in rows if r["smtp"] == "catchall"})
    print(f"\n{len(rows)} candidates -> {args.out}")
    print(f"{n_valid} SMTP-verified addresses; {n_catch} domains are catch-all (send via contact form/LinkedIn instead).")


if __name__ == "__main__":
    sys.exit(main())
