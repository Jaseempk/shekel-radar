#!/usr/bin/env python3
"""Reproducible buyer workflow: prepare -> verify/import contacts -> review -> draft.

Nothing is ever sent. `draft` writes send-ready email drafts only for accepted prospects
with a conclusively verified inbox (send-queue.md); every other accepted prospect gets a
held draft without a recipient (held-queue.md). review-summary.md accounts for every prospect.
"""
import argparse
import csv
import io
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.runtime import ROOT, DATA_ROOT, SETTINGS, SettingsError, require_profile, write_json, atomic_write
from lib.outreach import (prepare_prospects, contact_readiness, draft_template, personalize, validate_decisions,
                          fingerprint, prospect_key, identity_fingerprint, role_for, prospect_contacts, LEGACY_WARNING)

STATUS_ORDER = ['accepted-ready', 'accepted-held', 'rejected', 'deferred', 'pending-review', 'unresolved-domain']


def read_json(file):
    return json.loads(Path(file).read_text())


def sha256_file(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def short(value):
    return (value or '')[:12]


def prepare(signals_file, domains_file, run):
    if (run / 'manifest.json').exists():
        raise ValueError('This run already exists; use its verify/review/draft stages or choose a new --run directory')
    signals = read_json(signals_file)
    domains = read_json(domains_file) if domains_file else {}
    prospects, unresolved = prepare_prospects(signals, domains)
    run.mkdir(parents=True, exist_ok=True)
    write_json(run / 'signals.json', signals)
    write_json(run / 'domains.json', domains)
    write_json(run / 'prospects.json', {'prospects': prospects})
    write_json(run / 'unresolved.json', unresolved)
    write_json(run / 'manifest.json', {'created': datetime.now(timezone.utc).isoformat(), 'signals_source': str(Path(signals_file).resolve()),
        'signals_sha256': sha256_file(signals_file), 'prospects': len(prospects), 'unresolved': len(unresolved)})
    print(f'{len(prospects)} source-backed companies; {len(unresolved)} need domain evidence -> {run}')


def finder_module():
    spec = importlib.util.spec_from_file_location('email_finder', ROOT / 'email-finder/find_emails.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def contacts_stage(run, contacts_file=None):
    if not (run / 'manifest.json').exists():
        raise ValueError('Run prepare before verify')
    if contacts_file:
        rows = list(csv.DictReader(io.StringIO(Path(contacts_file).read_text())))
        required = {'company', 'domain', 'email', 'source', 'smtp'}
        if not rows or not required.issubset(rows[0]):
            raise ValueError('Contacts CSV requires company, domain, email, source and smtp columns and at least one row')
        atomic_write(run / 'emails.csv', Path(contacts_file).read_text())
    else:
        finder_module().main(['--prospects', str(run / 'prospects.json'), '--out', str(run / 'emails.csv')])
    manifest = read_json(run / 'manifest.json')
    manifest['contacts_sha256'] = sha256_file(run / 'emails.csv')
    write_json(run / 'manifest.json', manifest)


# ---------------------------------------------------------------- run state

def load_run(run):
    if not (run / 'manifest.json').exists():
        raise ValueError(f'{run} is not a prepared run (no manifest.json); run prepare first')
    manifest = read_json(run / 'manifest.json')
    prospects = read_json(run / 'prospects.json')['prospects']
    unresolved = read_json(run / 'unresolved.json') if (run / 'unresolved.json').exists() else []
    return manifest, prospects, unresolved


def load_review(run, manifest):
    """The applied review stored in the run; its hash must match the manifest (no hand edits)."""
    path = run / 'review.json'
    if not path.exists():
        if manifest.get('review_sha256'):
            raise ValueError('review.json is missing but the manifest records an applied review; re-apply decisions with outreach review')
        return {'version': 1, 'decisions': {}}
    if manifest.get('review_sha256') != sha256_file(path):
        raise ValueError('review.json changed outside the review stage; edit your decisions file and re-run outreach review')
    return read_json(path)


def load_contacts(run, manifest, required):
    path = run / 'emails.csv'
    if not path.exists():
        if required:
            raise ValueError('Run verify first, or import a contacts CSV with --contacts')
        return None
    if manifest.get('contacts_sha256') != sha256_file(path):
        raise ValueError('Contacts changed after verification/import; run verify --contacts again')
    return list(csv.DictReader(io.StringIO(path.read_text())))


def review_state(prospect, entry):
    """Return (decision entry or None, note). A review is current only while the company identity
    and the selected source role are unchanged since it was applied."""
    if entry is None:
        return None, 'no review decision recorded'
    role = role_for(prospect, entry['role']['url'])
    if role is None:
        return None, 'stale review: the selected role is no longer in this prospect; review again'
    fps = entry['fingerprints']
    if fps['identity'] != identity_fingerprint(prospect) or fps['signal'] != fingerprint(role):
        return None, 'stale review: company or role evidence changed since review; review again'
    return entry, ''


def assess(prospects, unresolved, review, contacts, allow_legacy=False):
    """One row per prospect (and per unresolved company) with its review and contact status."""
    rows = []
    for p in prospects:
        key = prospect_key(p['company'], p['domain'])
        entry, note = review_state(p, review['decisions'].get(key))
        row = {'company': p['company'], 'domain': p['domain'], 'key': key, 'domain_source': p['domain_source'],
               'roles': [r.get('url') for r in p['roles']], 'prospect': p, 'review': entry}
        if entry is None:
            row.update(status='pending-review', note=note)
        elif entry['decision'] != 'accepted':
            row.update(status=entry['decision'], note=entry['reason'])
        elif contacts is None:
            row.update(status='accepted-held', note='contacts not verified or imported yet', readiness=None)
        else:
            ready = contact_readiness(p, contacts, allow_legacy)
            row.update(status='accepted-ready' if ready['status'] == 'ready' else 'accepted-held', readiness=ready,
                       note=ready['reason'] if ready['status'] == 'hold' else '')
            if ready['legacy']:
                row['note'] = LEGACY_WARNING
        rows.append(row)
    known = {p['company'].strip().casefold() for p in prospects}
    seen = set()
    for u in unresolved:
        name = str(u.get('company', '')).strip()
        if name.casefold() in known or name.casefold() in seen:
            continue
        seen.add(name.casefold())
        rows.append({'company': name, 'domain': None, 'key': None, 'status': 'unresolved-domain', 'note': u.get('reason', ''),
                     'roles': [x.get('url') for x in unresolved if str(x.get('company', '')).strip().casefold() == name.casefold()]})
    return rows


def write_summary(run, rows, drafts=None):
    """review-summary.json/.md: every prospect, its decision, contact readiness and evidence."""
    drafts = drafts or {}
    counts = {s: sum(r['status'] == s for r in rows) for s in STATUS_ORDER}
    items = []
    for r in sorted(rows, key=lambda r: (STATUS_ORDER.index(r['status']), r['company'].casefold())):
        item = {'company': r['company'], 'domain': r['domain'], 'status': r['status'], 'note': r.get('note', ''),
                'domain_source': r.get('domain_source'), 'roles': r.get('roles', [])}
        if r.get('review'):
            item['review'] = {k: v for k, v in r['review'].items() if k not in ('company', 'domain')}
        if r.get('readiness'):
            ready = r['readiness']
            item['contact'] = {'status': ready['status'], 'reason': ready['reason'], 'legacy': ready['legacy'],
                               'selected': (ready['contact'] or {}).get('email', '').strip().lower() or None, 'evidence': ready['evidence']}
        if r.get('key') in drafts:
            item['draft'] = drafts[r['key']]
        items.append(item)
    write_json(run / 'review-summary.json', {'counts': counts, 'total': len(rows), 'prospects': items})
    lines = ['# Review summary', '', 'Every prospect in this run, with its review decision and contact readiness. Nothing has been sent.', '',
             '| Status | Count |', '|---|---|', *[f'| {s} | {counts[s]} |' for s in STATUS_ORDER], f'| total | {len(rows)} |', '']
    for item in items:
        lines.append(f"## {item['company']} ({item['domain'] or 'no domain'}): {item['status']}")
        if item.get('review'):
            rv = item['review']
            lines.append(f"- Review: {rv['decision']} on {rv['reviewed_at']}: {rv['reason']}")
            lines.append(f"- Role: {rv['role'].get('title', '')} {rv['role']['url']}")
            if rv.get('offer'):
                lines.append(f"- Offer: {rv['offer']}")
            if rv.get('hypothesis'):
                lines.append(f"- Hypothesis: {rv['hypothesis']}")
            if rv.get('contact_route'):
                lines.append(f"- Reviewed route: {route_text(rv['contact_route'])}")
        if item['note']:
            lines.append(f"- Note: {item['note']}")
        if item.get('domain_source'):
            lines.append(f"- Company evidence: {item['domain_source']}")
        if item.get('contact'):
            lines.append(f"- Contact: {item['contact']['status']} ({item['contact']['reason']})")
            lines.extend(f"  - {e['email']} smtp={e['smtp'] or '-'} {e['smtp_reason']} {e['source_url']}".rstrip() for e in item['contact']['evidence'])
        if item.get('draft'):
            lines.append(f"- Draft: {item['draft']}")
        lines.append('')
    atomic_write(run / 'review-summary.md', '\n'.join(lines))
    return counts


def route_text(route):
    parts = [route['type']]
    if route.get('email'):
        parts.append(f"{route['email']} (unverified; not a recipient)")
    if route.get('url'):
        parts.append(route['url'])
    text = ' '.join(parts)
    return f"{text}: {route['note']}" if route.get('note') else text


# ---------------------------------------------------------------- review

def review_stage(run, decisions_file):
    manifest, prospects, unresolved = load_run(run)
    try:
        document = read_json(decisions_file)
    except ValueError as e:
        raise ValueError(f'Review file is not valid JSON: {e}') from None
    decisions = validate_decisions(document, prospects)
    current = load_review(run, manifest)
    contacts = load_contacts(run, manifest, required=False)  # integrity check before any write
    by_key = {prospect_key(p['company'], p['domain']): p for p in prospects}
    merged, changed, applied_at = dict(current['decisions']), 0, now_utc()
    for key, decision in decisions.items():
        p = by_key[key]
        fps = {'review': fingerprint(decision), 'identity': identity_fingerprint(p), 'signal': fingerprint(role_for(p, decision['role']['url']))}
        if key in merged and merged[key]['fingerprints'] == fps:
            continue
        merged[key] = {**decision, 'applied_at': applied_at, 'fingerprints': fps}
        changed += 1
    review = {'version': 1, 'decisions': dict(sorted(merged.items()))}
    write_json(run / 'review.json', review)
    manifest['review_sha256'] = sha256_file(run / 'review.json')
    manifest.setdefault('reviews_applied', []).append({'applied_at': applied_at, 'source': str(Path(decisions_file).resolve()),
        'source_sha256': sha256_file(decisions_file), 'decisions': len(decisions), 'changed': changed})
    write_json(run / 'manifest.json', manifest)
    counts = write_summary(run, assess(prospects, unresolved, review, contacts))
    print(f'{len(decisions)} decisions validated, {changed} new or changed; {len(merged)} of {len(prospects)} prospects reviewed. '
          + ', '.join(f'{k}: {v}' for k, v in counts.items() if v) + f' -> {run / "review-summary.md"}')


# ---------------------------------------------------------------- draft

def text_hash(draft):
    return fingerprint({'subject': draft.get('subject'), 'body': draft.get('body')})


def preserve(path, stamp):
    """Keep a copy of a file we are about to replace because it was edited or predates provenance."""
    copy = path.with_name(f'{path.stem}.preserved-{stamp}{path.suffix}')
    shutil.copy2(path, copy)
    return copy


def load_previous(path, stamp, notices):
    """Previously generated drafts keyed by prospect key. Files without provenance are legacy: preserved, not reused."""
    if not path.exists():
        return {}
    try:
        drafts = read_json(path)
    except ValueError:
        drafts = None
    if not isinstance(drafts, list) or not all(isinstance(d, dict) and d.get('key') and d.get('provenance') for d in drafts):
        notices.append(f'{path.name} predates review provenance; kept a copy at {preserve(path, stamp).name}')
        return {}
    return {d['key']: d for d in drafts}


def website_text(domain):
    import re
    html = finder_module().fetch('https://' + domain)
    text = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', html, flags=re.S | re.I)
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', text))[:3000]


def draft_stage(run, personal=False, allow_legacy=False, accept_edits=False):
    profile = require_profile()
    manifest, prospects, unresolved = load_run(run)
    contacts = load_contacts(run, manifest, required=True)
    review = load_review(run, manifest)
    rows = assess(prospects, unresolved, review, contacts, allow_legacy)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    notices = []
    previous = {**load_previous(run / 'held-drafts.json', stamp, notices), **load_previous(run / 'drafts.json', stamp, notices)}
    cache_path = run / 'draft-progress.json'
    cache = read_json(cache_path) if cache_path.exists() else {}
    conflicts_path = run / 'draft-conflicts.json'
    conflicts = read_json(conflicts_path) if conflicts_path.exists() else []
    conflict_ids = {(c['key'], c['edited_sha256'], c['reason']) for c in conflicts}
    ready, held, failures, outcome = [], [], [], {}
    profile_fp = fingerprint({'profile': profile, 'model': SETTINGS.get('draftModel') if personal else None})

    def add_conflict(prev, reason, regenerated=None):
        entry = {'key': prev['key'], 'company': prev['company'], 'edited_sha256': text_hash(prev), 'reason': reason,
                 'detected_at': now_utc(), 'edited': {k: prev.get(k) for k in ('queue', 'subject', 'body', 'provenance')}}
        if regenerated:
            entry['regenerated'] = {k: regenerated.get(k) for k in ('queue', 'subject', 'body', 'provenance')}
        ident = (entry['key'], entry['edited_sha256'], reason)
        if ident not in conflict_ids:  # report every run, record once
            conflicts.append(entry)
            conflict_ids.add(ident)
        notices.append(f"{prev['company']}: manually edited draft preserved ({reason}); see draft-conflicts.json")

    for row in rows:
        prev = previous.get(row.get('key'))
        edited = bool(prev) and text_hash(prev) != prev['provenance']['generated_sha256']
        if row['status'] not in ('accepted-ready', 'accepted-held'):
            if edited:
                add_conflict(prev, f"prospect is now {row['status']}; draft removed from queues")
            continue
        p, entry, readiness = row['prospect'], row['review'], row['readiness']
        role = role_for(p, entry['role']['url'])
        queue = 'send' if row['status'] == 'accepted-ready' else 'held'
        contact = readiness['contact'] if queue == 'send' else None
        to = contact['email'].strip().lower() if contact else None
        target = {**p, 'to': to, 'contact_source_url': (contact or {}).get('source_url', '')}
        fps = {'review': entry['fingerprints']['review'], 'prospect': fingerprint(p), 'signal': fingerprint(role),
               'contact': fingerprint(sorted((dict(c) for c in prospect_contacts(p, contacts)), key=lambda c: json.dumps(c, sort_keys=True))),
               'profile': profile_fp}
        cache_key = fingerprint({'fingerprints': fps, 'queue': queue, 'to': to, 'legacy': readiness['legacy'],
                                 'hold_reason': readiness['reason'] if queue == 'held' else None, 'personal': personal})
        try:
            if cache_key in cache:
                generated = cache[cache_key]
            else:
                text = website_text(p['domain']) if personal else None
                content = personalize(target, text, profile, role, entry['offer']) if personal else draft_template(target, profile, role, entry['offer'])
                generated = {k: content[k] for k in ('subject', 'body', 'offer', 'signal_url', 'domain_source')}
                generated['generated_at'] = now_utc()
                cache[cache_key] = generated
                write_json(cache_path, cache)  # checkpoint: successful drafts survive later failures
        except Exception as e:
            failures.append({'company': p['company'], 'domain': p['domain'], 'status': 'retry', 'error': str(e)[:300]})
            if edited:
                add_conflict(prev, 'regeneration failed; edited draft kept here until the retry succeeds')
            continue
        draft = {'key': row['key'], 'company': p['company'], 'domain': p['domain'], 'queue': queue,
                 'subject': generated['subject'], 'body': generated['body'], 'offer': generated['offer'],
                 'signal_url': generated['signal_url'], 'domain_source': generated['domain_source'],
                 'review': {k: entry[k] for k in ('decision', 'reason', 'reviewed_at', 'role') if k in entry},
                 'hypothesis': entry.get('hypothesis', ''), 'status': 'draft' if queue == 'send' else 'hold', 'sent': False}
        if queue == 'send':
            draft.update(to=to, contact_source=contact.get('source', ''), contact_source_url=contact.get('source_url', ''),
                         smtp=contact.get('smtp', ''), smtp_reason=contact.get('smtp_reason', ''))
            if readiness['legacy']:
                draft['warning'] = LEGACY_WARNING
        else:
            draft.update(hold_reason=readiness['reason'], contact_route=entry.get('contact_route'), contact_evidence=readiness['evidence'])
        draft['provenance'] = {**fps, 'cache_key': cache_key, 'generated_sha256': text_hash(generated),
                               'generated_at': generated['generated_at'], 'legacy_contact': readiness['legacy'], 'allow_legacy_contacts': allow_legacy}
        if edited:
            same = prev['provenance']['cache_key'] == cache_key and prev.get('queue') == queue
            if same or (accept_edits and prev.get('queue') == queue):
                draft.update(subject=prev['subject'], body=prev['body'], edited=True)
                if not same:
                    notices.append(f"{p['company']}: edited draft accepted against the current evidence (--accept-edits)")
            elif prev.get('queue') == queue:
                add_conflict(prev, 'upstream evidence changed since the draft was edited; the queue keeps your edit, '
                             'the regenerated text is in draft-conflicts.json (use --accept-edits to keep the edit)', draft)
                draft = {**draft, 'subject': prev['subject'], 'body': prev['body'], 'edited': True,
                         'edit_conflict': 'evidence changed since this draft was edited; check it against the provenance below',
                         'provenance': {**prev['provenance'], 'current': draft['provenance']}}
            else:
                add_conflict(prev, f"draft moved from the {prev.get('queue')} queue to the {queue} queue; edit not carried over", draft)
        elif prev and prev.get('to') and draft.get('to') != prev.get('to'):
            notices.append(f"{p['company']}: recipient now {draft.get('to') or 'held (none)'}; recipients come only from verified evidence")
        (ready if queue == 'send' else held).append(draft)
        outcome[row['key']] = f"{'send queue' if queue == 'send' else 'held queue'}{' (edited)' if draft.get('edited') else ''}"

    for f in failures:
        outcome[prospect_key(f['company'], f['domain'])] = f"retryable failure: {f['error']}"
    write_outputs(run, ready, held, failures, conflicts, stamp, notices)
    counts = write_summary(run, rows, outcome)
    for n in notices:
        print(f'note: {n}')
    if not review['decisions']:
        print(f'No review decisions recorded for this run: {len(prospects)} prospect(s) pending review. '
              f'Record them with: outreach review --run {run} --decisions FILE', file=sys.stderr)
    print(f"{len(ready)} send-ready drafts; {len(held)} held drafts (no recipient); "
          + ', '.join(f'{k}: {v}' for k, v in counts.items() if v)
          + f'; {len(failures)} retryable errors -> {run / "send-queue.md"}, {run / "held-queue.md"}')
    if failures:
        raise ValueError('Some drafts failed; rerun draft for this run')


def provenance_line(d):
    pv = d['provenance']
    return (f"Provenance: review {short(pv['review'])}, prospect {short(pv['prospect'])}, signal {short(pv['signal'])}, "
            f"contact {short(pv['contact'])}, profile {short(pv['profile'])}")


def common_lines(d):
    lines = [f"Subject: {d['subject']}", f"Signal: {d['signal_url']}", f"Company evidence: {d['domain_source']}",
             f"Review: {d['review']['decision']} on {d['review']['reviewed_at']}: {d['review']['reason']}"]
    if d.get('hypothesis'):
        lines.append(f"Hypothesis: {d['hypothesis']}")
    return lines


def render_send(drafts):
    lines = ['# Outreach drafts', '', 'Accepted prospects with a conclusively verified inbox. Review each draft and its evidence '
             'before sending manually; nothing has been sent.', '']
    for d in drafts:
        lines.extend([f"## {d['company']} ({d['domain']})"])
        if d.get('warning'):
            lines.extend([f"WARNING: {d['warning']}", ''])
        if d.get('edit_conflict'):
            lines.extend([f"WARNING: {d['edit_conflict']}", ''])
        lines.extend([f"To: {d['to']}", *common_lines(d),
                      f"Contact evidence: {d.get('contact_source_url') or 'No published URL recorded; review contact CSV'}",
                      f"SMTP evidence: smtp={d['smtp']} {d.get('smtp_reason') or '(no reason recorded: legacy evidence)'}",
                      provenance_line(d), '', d['body'], '', '---', ''])
    return '\n'.join(lines)


def render_held(drafts):
    lines = ['# Held drafts', '', 'Accepted prospects WITHOUT a send-ready recipient. These drafts have no recipient on purpose: '
             'resolve the hold (confirm a contact, re-run verify, or use the reviewed route manually) first. Nothing has been sent.', '']
    for d in drafts:
        lines.append(f"## {d['company']} ({d['domain']})")
        if d.get('edit_conflict'):
            lines.extend([f"WARNING: {d['edit_conflict']}", ''])
        lines.extend([f"Hold: {d['hold_reason']}",
                      f"Reviewed route: {route_text(d['contact_route']) if d.get('contact_route') else 'none recorded'}",
                      *common_lines(d), 'Contact evidence:'])
        lines.extend([f"- {e['email']} smtp={e['smtp'] or '-'} {e['smtp_reason']} {e['source_url']}".rstrip() for e in d['contact_evidence']]
                     or ['- none'])
        lines.extend([provenance_line(d), '', d['body'], '', '---', ''])
    return '\n'.join(lines)


def write_outputs(run, ready, held, failures, conflicts, stamp, notices):
    state_path = run / 'draft-state.json'
    state = read_json(state_path) if state_path.exists() else {}
    for name, text in (('send-queue.md', render_send(ready)), ('held-queue.md', render_held(held))):
        path = run / name
        if path.exists() and sha256_file(path) != state.get(name) and path.read_text() != text:
            # Markdown is rendered from the JSON drafts; keep hand edits (or legacy queues) instead of losing them.
            notices.append(f'{name} was edited or predates review provenance; kept a copy at {preserve(path, stamp).name} '
                           '(edit subject/body in drafts.json or held-drafts.json to keep changes across runs)')
        atomic_write(path, text)
        state[name] = sha256_file(path)
    write_json(run / 'drafts.json', ready)
    write_json(run / 'held-drafts.json', held)
    write_json(run / 'draft-errors.json', failures)
    write_json(run / 'draft-conflicts.json', conflicts)
    write_json(state_path, state)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('stage', choices=['prepare', 'verify', 'review', 'draft', 'run'])
    ap.add_argument('--signals', type=Path, help='Exact buyers/Workable JSON snapshot')
    ap.add_argument('--domains', type=Path, help='Reviewed company-to-domain mapping with source evidence')
    ap.add_argument('--run', type=Path, help='Run directory (required for verify/review/draft)')
    ap.add_argument('--contacts', type=Path, help='Import an existing email-verification CSV instead of network verification')
    ap.add_argument('--decisions', type=Path, help='Review decisions JSON (required for review; optional for run)')
    ap.add_argument('--allow-legacy-contacts', action='store_true',
                    help='Treat smtp=valid rows without smtp_reason (old verifier) as eligible, with a warning on each draft')
    ap.add_argument('--accept-edits', action='store_true', help='Keep manually edited drafts even though their evidence changed')
    ap.add_argument('--personalise', action='store_true', help='Fetch websites and use the configured model; default drafts are offline templates')
    args = ap.parse_args(argv)
    if args.stage in ('prepare', 'run') and not args.signals:
        ap.error('--signals is required for prepare/run')
    if args.stage in ('verify', 'review', 'draft') and not args.run:
        ap.error('--run is required for verify/review/draft')
    if args.stage == 'review' and not args.decisions:
        ap.error('--decisions is required for review')
    run = (args.run or DATA_ROOT / 'state/buyer-runs' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:8])).resolve()
    try:
        if args.stage == 'run':
            require_profile()  # fail before creating a run that cannot be drafted
        if args.stage in ('prepare', 'run'):
            prepare(args.signals, args.domains, run)
        if args.stage in ('verify', 'run'):
            contacts_stage(run, args.contacts)
        if args.stage == 'review' or (args.stage == 'run' and args.decisions):
            review_stage(run, args.decisions)
        if args.stage in ('draft', 'run'):
            draft_stage(run, args.personalise, args.allow_legacy_contacts, args.accept_edits)
    except SettingsError as e:
        print(f'error: {e}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError) as e:
        print(f'Workflow error: {e}', file=sys.stderr)
        raise SystemExit(1)
