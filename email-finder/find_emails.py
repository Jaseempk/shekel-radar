#!/usr/bin/env python3
"""DIY email finder + verifier for the agency prospect list. Stdlib only.

Per prospect:
  1. SCRAPE  - fetch a handful of likely pages on their site, regex out
               published addresses (mailto: and plain text).
  2. PATTERN - when we know the founder's name, generate the usual corporate
               patterns (first@, first.last@, flast@, ...). Always try the
               generic inboxes (hello@, info@, ...) as a fallback.
  3. VERIFY  - MX lookup, then an SMTP RCPT TO handshake (no mail is sent).
               Every SMTP session first offers a random control address. A
               target is `valid` only when that same session explicitly
               rejected the control as nonexistent and accepted the target;
               an accepted control means `catchall`; anything inconclusive is
               `unknown` with a recorded reason.

The SMTP probe identity comes from INCOME_SMTP_MAIL_FROM and INCOME_SMTP_HELO
(root .env or environment). Nothing is probed until both are configured.

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
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
import random
import re
import smtplib
import string
import subprocess
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
SMTP_ENV = ("INCOME_SMTP_MAIL_FROM", "INCOME_SMTP_HELO")
HOSTNAME_RE = re.compile(r"(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+")
CSV_FIELDS = ["company", "domain", "email", "source", "source_url", "smtp", "founder",
              "smtp_reason", "checked_at", "mx_status", "site_status", "site_errors"]


class ConfigError(ValueError):
    """Required local configuration is missing; raised before any network use."""


@dataclass(frozen=True)
class ProbeIdentity:
    mail_from: str
    helo: str


def probe_identity(env=None):
    """SMTP envelope sender and HELO name from the local environment (.env).

    There is deliberately no default: probing with someone else's identity
    misattributes the traffic and can damage that sender's reputation."""
    env = os.environ if env is None else env
    mail_from = (env.get("INCOME_SMTP_MAIL_FROM") or "").strip()
    helo = (env.get("INCOME_SMTP_HELO") or "").strip()
    missing = [name for name, value in zip(SMTP_ENV, (mail_from, helo)) if not value]
    if missing:
        raise ConfigError(f"SMTP probe identity is not configured: set {' and '.join(missing)} in .env "
                          "(see .env.example) to an address and hostname you control. No network checks were made.")
    local, _, host = mail_from.partition("@")
    if not local or "@" in host or not HOSTNAME_RE.fullmatch(host):
        raise ConfigError("INCOME_SMTP_MAIL_FROM must be a plain email address such as probe@your-domain.example")
    if not HOSTNAME_RE.fullmatch(helo):
        raise ConfigError("INCOME_SMTP_HELO must be a hostname such as mail.your-domain.example")
    return ProbeIdentity(mail_from, helo)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True)
class Page:
    """status: ok | not-text (fetched, no readable text) | missing (404/410)
    | http-error (other HTTP failure) | error (network/TLS/timeout)
    | skipped (not attempted: discovery budget exhausted)."""
    url: str
    status: str
    text: str = ""
    reason: str = ""


def fetch_page(url, timeout=12, opener=None, limit=800_000):
    """Fetch one page, keeping failure evidence instead of collapsing it to ''."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with (opener or urllib.request.urlopen)(req, timeout=timeout) as r:
            content_type = r.headers.get("Content-Type") or "text"
            if "text" not in content_type:
                return Page(url, "not-text", reason=content_type[:80])
            return Page(url, "ok", r.read(limit).decode("utf-8", "ignore"))
    except urllib.error.HTTPError as e:
        return Page(url, "missing" if e.code in (404, 410) else "http-error", reason=f"HTTP {e.code}")
    except Exception as e:
        detail = getattr(e, "reason", None) or e
        return Page(url, "error", reason=f"{type(e).__name__}: {detail}"[:160])


def fetch(url, timeout=12):
    """Compatibility helper: page text, or '' when unavailable or not text."""
    page = fetch_page(url, timeout)
    return page.text if page.status == "ok" else ""


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


@dataclass(frozen=True)
class SiteReport:
    """status: ok | partial | unavailable | not-found; failures: [(url, reason)]."""
    status: str
    fetched: int
    failures: tuple

    def summary(self, limit=5):
        parts = [f"{url} {reason}" for url, reason in self.failures[:limit]]
        if len(self.failures) > limit:
            parts.append(f"(+{len(self.failures) - limit} more)")
        return "; ".join(parts)[:600]


def scrape_site(domain, fetcher=None, sleep=time.sleep, clock=time.monotonic, budget=90.0, timeout=12,
                max_host_failures=2):
    """Published addresses on the company's own pages.

    -> (on_domain {email: source_url}, off_domain {email: source_url}, SiteReport).
    A host variant that keeps failing at the network level is skipped, and the
    whole discovery shares one monotonic budget. Missing pages (404) are not
    failures; unreachable or erroring pages are recorded as diagnostics."""
    fetcher = fetcher or fetch_page
    started = clock()
    variants = (f"https://{domain}", f"https://www.{domain}")
    host_failures = dict.fromkeys(variants, 0)
    found, failures, fetched = {}, [], 0
    for path in PAGES:
        remaining = budget - (clock() - started)
        live = [h for h in variants if host_failures[h] < max_host_failures]
        if remaining <= 0 or not live:
            why = "discovery budget exhausted" if remaining <= 0 else "site unreachable (host variants failing)"
            failures.append((f"https://{domain}/{path}", f"skipped: {why}"))
            continue
        attempts = []
        for scheme_host in live:
            source_url = f"{scheme_host}/{path}"
            remaining = budget - (clock() - started)
            if remaining <= 0:
                attempts.append(Page(source_url, "skipped", reason="discovery budget exhausted"))
                break
            page = fetcher(source_url, timeout=min(timeout, remaining))
            if page.status in ("ok", "not-text"):
                host_failures[scheme_host] = 0
                fetched += 1
                for email in published_emails(page.text):
                    found.setdefault(email, source_url)
                attempts = []
                break  # first host variant that answered is enough for this path
            host_failures[scheme_host] = host_failures[scheme_host] + 1 if page.status == "error" else 0
            attempts.append(page)
        failures.extend((page.url, f"{page.status}: {page.reason}") for page in attempts if page.status != "missing")
        sleep(0.3)
    if failures and not fetched:
        status = "unavailable"
    elif failures:
        status = "partial"
    else:
        status = "ok" if fetched else "not-found"
    on_domain = {e: source for e, source in found.items() if e.split("@")[1].removeprefix("www.") == domain}
    report = SiteReport(status, fetched, tuple(failures))
    return on_domain, {e: source for e, source in found.items() if e not in on_domain}, report


def pattern_candidates(founder, domain):
    if not founder:
        return []
    f, l = founder
    return [c + "@" + domain for c in
            (f, f"{f}.{l}", f"{f}{l}", f"{f[0]}{l}", f"{f}_{l}", f"{f}{l[0]}", l)]


# -- DNS ----------------------------------------------------------------------

@dataclass(frozen=True)
class MXResult:
    """status: ok (hosts found) | none (domain has no usable MX) | error (lookup failed)."""
    hosts: tuple
    status: str
    reason: str


def parse_dig(output):
    """Parse `dig +noall +comments +answer MX` output into an MXResult."""
    header = re.search(r"status:\s*([A-Z]+)", output)
    if not header:
        tail = " ".join(output.split())[-160:]
        return MXResult((), "error", f"no DNS answer header ({tail or 'empty output'})")
    status = header[1]
    if status == "NXDOMAIN":
        return MXResult((), "none", "domain does not exist (NXDOMAIN)")
    if status != "NOERROR":
        return MXResult((), "error", f"DNS lookup failed ({status})")
    records = []
    for line in output.splitlines():
        parts = line.split()
        if line.startswith(";") or len(parts) < 6 or parts[3].upper() != "MX" or not parts[4].isdigit():
            continue
        records.append((int(parts[4]), parts[5].rstrip(".")))
    hosts = tuple(h for _, h in sorted(records) if h)
    if records and not hosts:
        return MXResult((), "none", "null MX: domain accepts no mail")
    if not hosts:
        return MXResult((), "none", "no MX records")
    return MXResult(hosts, "ok", f"{len(hosts)} MX host(s)")


def mx_lookup(domain, run=subprocess.run, timeout=15):
    """MX hosts with an explicit distinction between 'no MX' and 'lookup failed'."""
    try:
        done = run(["dig", "+noall", "+comments", "+answer", "+time=5", "+tries=2", "MX", domain],
                   capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return MXResult((), "error", "dig is not installed")
    except subprocess.TimeoutExpired:
        return MXResult((), "error", f"DNS lookup timed out after {timeout}s")
    except Exception as e:
        return MXResult((), "error", f"DNS lookup failed: {type(e).__name__}: {e}"[:200])
    if done.returncode != 0:
        detail = " ".join((done.stdout + " " + done.stderr).split())[-160:]
        return MXResult((), "error", f"dig exited {done.returncode}: {detail}")
    return parse_dig(done.stdout)


def mx_hosts(domain):
    """Compatibility helper: MX hosts by preference, empty on no MX or failure."""
    return list(mx_lookup(domain).hosts)


# -- SMTP ---------------------------------------------------------------------

@dataclass(frozen=True)
class Verdict:
    """smtp: valid | invalid | catchall | unknown. reason: '<token>: detail'."""
    smtp: str
    reason: str
    checked_at: str


ENHANCED_RE = re.compile(r"\b([245])\.(\d{1,3})\.(\d{1,3})\b")
NONEXISTENT_TEXT = re.compile(r"user unknown|unknown user|no such (user|mailbox|recipient)|does ?n[o']t exist|not exist|"
                              r"unknown (recipient|mailbox|address)|recipient (unknown|not found)|invalid (recipient|mailbox)|"
                              r"mailbox (not found|does not exist)|no mailbox|address not found", re.I)
POLICY_TEXT = re.compile(r"block|blacklist|denylist|spam|policy|denied|reputation|\brbl\b|dnsbl|not permitted|"
                         r"relay|authenticat|prohibited|refused|abuse", re.I)


def classify_rcpt(code, message=""):
    """Categorise one RCPT TO reply without overstating what it proves.

    -> accepted | nonexistent | policy | malformed | temporary | ambiguous | transport.
    Only an explicit unknown-recipient reply (5.1.1, or equivalent wording)
    proves a mailbox does not exist; RFC 5321 also uses 550 for policy refusals.
    """
    text = message.decode("utf-8", "replace") if isinstance(message, bytes) else str(message or "")
    if code is None or code < 0 or code == 421:
        return "transport"
    if code in (250, 251):
        return "accepted"
    if 400 <= code < 500:
        return "temporary"
    if not 500 <= code < 600:
        return "ambiguous"
    enhanced = ENHANCED_RE.search(text)
    if enhanced and enhanced[1] == "5":
        sub = (enhanced[2], enhanced[3])
        if sub in (("1", "1"), ("1", "10")):
            return "nonexistent"
        if sub[0] == "7":
            return "policy"
        if sub[0] == "5" or sub == ("1", "3"):
            return "malformed"
        return "ambiguous"
    if POLICY_TEXT.search(text):
        return "policy"
    if code in (500, 501, 502, 503, 504, 555):
        return "malformed"
    if code in (550, 551, 553) and NONEXISTENT_TEXT.search(text):
        return "nonexistent"
    return "ambiguous"


def _reply(code, message):
    text = message.decode("utf-8", "replace") if isinstance(message, bytes) else str(message or "")
    return f"{code} {' '.join(text.split())}"[:160].strip()


def default_smtp_factory(helo, timeout):
    """Unconnected client, so a failed connect/EHLO can still be closed."""
    return smtplib.SMTP(local_hostname=helo, timeout=timeout)


def close_quietly(client):
    if client is None:
        return
    try:
        client.quit()
    except Exception:
        pass
    finally:
        try:
            client.close()
        except Exception:
            pass


class DomainVerifier:
    """Conservative RCPT-TO verification for one domain. No mail is sent.

    Each SMTP session first offers a random control address. A target is only
    `valid` when that same session explicitly rejected the control as a
    nonexistent recipient and then accepted the target. An accepted control
    means `catchall`; anything inconclusive yields `unknown` with a reason.
    The domain has one monotonic time budget, a connection cap and a circuit
    breaker for repeated transport failures, so unreachable domains stay cheap.
    """

    def __init__(self, domain, identity, *, mx=None, resolver=None, smtp_factory=default_smtp_factory,
                 clock=time.monotonic, now=utc_now, rng=None, budget=45.0, timeout=10.0,
                 max_connects=4, max_transport_failures=3, port=25):
        if not isinstance(identity, ProbeIdentity):
            raise ConfigError("DomainVerifier requires a configured ProbeIdentity")
        self.domain, self.identity = domain, identity
        self.smtp_factory, self.clock, self.now = smtp_factory, clock, now
        self.rng = rng or random.SystemRandom()
        self.budget, self.timeout, self.port = budget, timeout, port
        self.max_connects, self.max_transport_failures = max_connects, max_transport_failures
        self.started = clock()
        self.mx = mx if mx is not None else (resolver or mx_lookup)(domain)
        self.session = None
        self.control = None        # per session: ('proven' | 'inconclusive', reply)
        self.catch_all = None      # domain-level once a random address is accepted
        self.blocked = None        # domain-level policy refusal of the probe identity
        self.connects = 0
        self.transport_failures = 0
        self.network_calls = 0
        self.last_error = ""

    def remaining(self):
        return self.budget - (self.clock() - self.started)

    def _gate(self):
        if self.remaining() <= 0:
            return f"budget-exhausted: {self.budget:g}s domain budget used"
        if self.transport_failures >= self.max_transport_failures:
            return f"circuit-open: {self.transport_failures} transport failures (last: {self.last_error})"
        if self.connects >= self.max_connects:
            return f"connect-limit: {self.connects} connection attempts used"
        return None

    def _op_timeout(self):
        return max(0.1, min(self.timeout, self.remaining()))

    def _apply_timeout(self, client):
        sock = getattr(client, "sock", None)
        if sock is not None:
            sock.settimeout(self._op_timeout())

    def _drop(self):
        close_quietly(self.session)
        self.session, self.control = None, None

    def _transport_failure(self, detail):
        self.transport_failures += 1
        self.last_error = detail

    def _rcpt(self, address):
        self.network_calls += 1
        try:
            self._apply_timeout(self.session)
            return self.session.rcpt(address)
        except Exception as e:
            return -1, f"{type(e).__name__}: {e}"

    def _open_session(self):
        """Connect, EHLO, MAIL FROM, then run the control probe. True when usable."""
        errors = []
        for host in self.mx.hosts[:2]:
            gate = self._gate()
            if gate:
                errors.append(gate)
                break
            self.connects += 1
            self.network_calls += 1
            client = None
            try:
                client = self.smtp_factory(self.identity.helo, self._op_timeout())
                code, msg = client.connect(host, self.port)
                if code != 220:
                    raise smtplib.SMTPConnectError(code, msg)
                self._apply_timeout(client)
                client.ehlo_or_helo_if_needed()
                code, msg = client.mail(self.identity.mail_from)
                if 500 <= code < 600:
                    close_quietly(client)
                    self.blocked = f"mail-from-rejected: {host} {_reply(code, msg)}"
                    return False
                if code != 250:
                    raise smtplib.SMTPResponseException(code, msg)
            except Exception as e:
                close_quietly(client)
                self._transport_failure(f"{host} {type(e).__name__}: {e}"[:200])
                errors.append(self.last_error)
                continue
            self.session = client
            probe = "".join(self.rng.choice(string.ascii_lowercase) for _ in range(16)) + "@" + self.domain
            code, msg = self._rcpt(probe)
            kind = classify_rcpt(code, msg)
            if kind == "transport":
                self._drop()
                self._transport_failure(f"{host} control probe: {msg}"[:200])
                errors.append(self.last_error)
                continue
            if kind == "accepted":
                self.catch_all = f"control-accepted: random address accepted ({_reply(code, msg)})"
            elif kind == "nonexistent":
                self.control = ("proven", _reply(code, msg))
            elif kind == "policy":
                self._drop()
                self.blocked = f"policy-blocked: control probe refused ({_reply(code, msg)})"
                return False
            else:
                self.control = ("inconclusive", f"{kind} {_reply(code, msg)}")
            return True
        self.last_error = "; ".join(errors) or "no MX hosts"
        return False

    def check(self, email):
        """-> Verdict(smtp='valid'|'invalid'|'catchall'|'unknown', reason, checked_at)"""
        stamp = self.now()

        def out(smtp, reason):
            return Verdict(smtp, reason, stamp)

        if self.mx.status != "ok":
            return out("unknown", f"mx-{self.mx.status}: {self.mx.reason}")
        for _ in range(2):  # the current session plus at most one reconnect per candidate
            if self.catch_all:
                return out("catchall", self.catch_all)
            if self.blocked:
                return out("unknown", self.blocked)
            if self.session is None:
                gate = self._gate()
                if gate:
                    return out("unknown", gate)
                if not self._open_session():
                    return out("unknown", self.blocked or f"connect-failed: {self.last_error}")
                if self.catch_all:
                    return out("catchall", self.catch_all)
            if self.remaining() <= 0:
                self._drop()
                return out("unknown", f"budget-exhausted: {self.budget:g}s domain budget used")
            code, msg = self._rcpt(email)
            kind = classify_rcpt(code, msg)
            if kind == "transport":
                # The replacement session must re-run its own control probe;
                # the old session's control result is never reused.
                self._drop()
                self._transport_failure(f"target probe: {msg}"[:200])
                continue
            reply = _reply(code, msg)
            if kind == "nonexistent":
                return out("invalid", f"target-nonexistent: {reply}")
            if kind == "accepted":
                state, control = self.control
                if state == "proven":
                    return out("valid", f"control-rejected+target-accepted: control {control}; target {reply}")
                return out("unknown", f"control-inconclusive: target accepted but control was {control}")
            return out("unknown", f"target-{kind}: {reply}")
        return out("unknown", f"transport-failed: {self.last_error}")

    def close(self):
        self._drop()


def main(argv=None, *, env=None, verifier_factory=None, sleep=time.sleep):
    ap = argparse.ArgumentParser(description="Discover and conservatively SMTP-verify prospect inboxes (no mail is sent).")
    ap.add_argument("--prospects", default=os.path.join(HERE, "prospects.json"))
    ap.add_argument("--out", default=str(DATA_ROOT / "exports/email-finder/found_emails.csv"))
    ap.add_argument("--only", help="comma-separated domains to limit to")
    args = ap.parse_args(argv)

    identity = probe_identity(env)  # fail before any network access
    verifier_factory = verifier_factory or (lambda domain: DomainVerifier(domain, identity))
    prospects = json.loads(Path(args.prospects).read_text())["prospects"]
    if args.only:
        keep = {d.strip() for d in args.only.split(",")}
        prospects = [p for p in prospects if p["domain"] in keep]

    rows = []
    for i, p in enumerate(prospects, 1):
        dom, company, founder = p["domain"], p["company"], p.get("founder")
        print(f"[{i}/{len(prospects)}] {company} ({dom})", flush=True)

        scraped_own, scraped_other, site = scrape_site(dom, sleep=sleep)
        if site.status not in ("ok", "not-found"):
            print(f"    website evidence {site.status}: {site.summary(2)}", flush=True)
        site_columns = {"site_status": site.status, "site_errors": site.summary()}
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

        ver = verifier_factory(dom)
        try:
            found_valid = 0
            for email, source in candidates:
                if found_valid >= 2 and source != "scraped":
                    break  # two verified non-scraped hits per company is plenty
                calls = ver.network_calls
                verdict = ver.check(email)
                rows.append({"company": company, "domain": dom, "email": email,
                             "source": source, "source_url": scraped_own.get(email, ''), "smtp": verdict.smtp,
                             "founder": " ".join(founder) if founder else "", "smtp_reason": verdict.reason,
                             "checked_at": verdict.checked_at, "mx_status": ver.mx.status, **site_columns})
                if verdict.smtp == "valid":
                    found_valid += 1
                print(f"    {email:<45} {source:<8} {verdict.smtp:<8} {verdict.reason[:70]}", flush=True)
                if ver.network_calls != calls:
                    sleep(0.8)  # pace only real probes
        finally:
            ver.close()
        for e in sorted(scraped_other):
            rows.append({"company": company, "domain": dom, "email": e, "source": "scraped-offsite",
                         "source_url": scraped_other[e], "smtp": "", "founder": "", "smtp_reason": "",
                         "checked_at": "", "mx_status": "", **site_columns})
        sleep(1.0)

    order = {"valid": 0, "catchall": 1, "unknown": 2, "": 3, "invalid": 4}
    rows.sort(key=lambda r: (r["company"], order.get(r["smtp"], 5)))
    with io.StringIO(newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        w.writerows(rows)
        atomic_write(args.out, f.getvalue())
    n_valid = sum(1 for r in rows if r["smtp"] == "valid")
    n_catch = len({r["domain"] for r in rows if r["smtp"] == "catchall"})
    n_unknown = sum(1 for r in rows if r["smtp"] == "unknown")
    print(f"\n{len(rows)} candidates -> {args.out}")
    print(f"{n_valid} SMTP-verified addresses; {n_catch} domains are catch-all; {n_unknown} candidates unknown "
          "(see smtp_reason). Only smtp=valid enters the draft queue.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ConfigError as e:
        print(f"Configuration error: {e}", file=sys.stderr)
        sys.exit(2)
