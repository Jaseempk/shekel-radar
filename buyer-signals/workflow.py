#!/usr/bin/env python3
"""Reproducible buyer workflow: prepare → verify/import contacts → draft."""
import argparse
import csv
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.runtime import ROOT, DATA_ROOT, SETTINGS, write_json, atomic_write
from lib.outreach import prepare_prospects, select_contacts, draft_template, personalize


def read_json(file):
    return json.loads(Path(file).read_text())


def prepare(signals_file, domains_file, run):
    if (run / 'manifest.json').exists():
        raise ValueError('This run already exists; use its verify/draft stages or choose a new --run directory')
    signals = read_json(signals_file)
    domains = read_json(domains_file) if domains_file else {}
    prospects, unresolved = prepare_prospects(signals, domains)
    run.mkdir(parents=True, exist_ok=True)
    write_json(run / 'signals.json', signals)
    write_json(run / 'domains.json', domains)
    write_json(run / 'prospects.json', {'prospects': prospects})
    write_json(run / 'unresolved.json', unresolved)
    write_json(run / 'manifest.json', {'created': datetime.now(timezone.utc).isoformat(), 'signals_source': str(Path(signals_file).resolve()),
        'signals_sha256': hashlib.sha256(Path(signals_file).read_bytes()).hexdigest(), 'prospects': len(prospects), 'unresolved': len(unresolved)})
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
        rows = list(csv.DictReader(Path(contacts_file).open()))
        required = {'company', 'domain', 'email', 'source', 'smtp'}
        if not rows or not required.issubset(rows[0]):
            raise ValueError('Contacts CSV requires company, domain, email, source and smtp columns and at least one row')
        atomic_write(run / 'emails.csv', Path(contacts_file).read_text())
    else:
        finder_module().main(['--prospects', str(run / 'prospects.json'), '--out', str(run / 'emails.csv')])
    manifest = read_json(run / 'manifest.json')
    manifest['contacts_sha256'] = hashlib.sha256((run / 'emails.csv').read_bytes()).hexdigest()
    write_json(run / 'manifest.json', manifest)


def draft_stage(run, personal=False):
    prospects = read_json(run / 'prospects.json')['prospects']
    manifest = read_json(run / 'manifest.json')
    if not (run / 'emails.csv').exists():
        raise ValueError('Run verify first, or import a contacts CSV with --contacts')
    if manifest.get('contacts_sha256') != hashlib.sha256((run / 'emails.csv').read_bytes()).hexdigest():
        raise ValueError('Contacts changed after verification/import; run verify --contacts again')
    contacts = list(csv.DictReader((run / 'emails.csv').open()))
    targets = select_contacts(prospects, contacts)
    drafts, failures = [], []
    cache_path = run / 'draft-progress.json'
    cache = read_json(cache_path) if cache_path.exists() else {}
    for target in targets:
        cache_key = hashlib.sha256(json.dumps({'target': target, 'personal': personal, 'settings': SETTINGS}, sort_keys=True).encode()).hexdigest()
        try:
            if cache_key in cache:
                drafts.append(cache[cache_key])
                continue
            if personal:
                # Reuse the same bounded website fetcher as email discovery.
                import re
                html = finder_module().fetch('https://' + target['domain'])
                text = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', html, flags=re.S | re.I)
                text = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', text))[:3000]
                drafts.append(personalize(target, text))
            else:
                drafts.append(draft_template(target))
            cache[cache_key] = drafts[-1]
            write_json(cache_path, cache)
        except Exception as e:
            failures.append({'company': target['company'], 'status': 'retry', 'error': str(e)[:300]})
    write_json(run / 'drafts.json', drafts)
    write_json(run / 'draft-errors.json', failures)
    lines = ['# Outreach drafts', '', 'Review each draft and its evidence before sending manually.', '']
    for d in drafts:
        lines.extend([f"## {d['company']}", f"To: {d['to']}", f"Subject: {d['subject']}", f"Signal: {d['signal_url']}",
                      f"Company evidence: {d['domain_source']}", '', d['body'], '', '---', ''])
    atomic_write(run / 'send-queue.md', '\n'.join(lines))
    print(f'{len(drafts)} drafts; {len(prospects)-len(targets)} companies without eligible contacts; {len(failures)} retryable errors -> {run / "send-queue.md"}')
    if failures:
        raise ValueError('Some drafts failed; rerun draft for this run')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('stage', choices=['prepare', 'verify', 'draft', 'run'])
    ap.add_argument('--signals', type=Path, help='Exact buyers/Workable JSON snapshot')
    ap.add_argument('--domains', type=Path, help='Reviewed company-to-domain mapping with source evidence')
    ap.add_argument('--run', type=Path, help='Run directory (required for verify/draft)')
    ap.add_argument('--contacts', type=Path, help='Import an existing email-verification CSV instead of network verification')
    ap.add_argument('--personalise', action='store_true', help='Fetch websites and use the configured model; default drafts are offline templates')
    args = ap.parse_args(argv)
    if args.stage in ('prepare', 'run') and not args.signals:
        ap.error('--signals is required for prepare/run')
    if args.stage in ('verify', 'draft') and not args.run:
        ap.error('--run is required for verify/draft')
    run = (args.run or DATA_ROOT / 'state/buyer-runs' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:8])).resolve()
    if args.stage in ('prepare', 'run'):
        prepare(args.signals, args.domains, run)
    if args.stage in ('verify', 'run'):
        contacts_stage(run, args.contacts)
    if args.stage in ('draft', 'run'):
        draft_stage(run, args.personalise)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError) as e:
        print(f'Workflow error: {e}', file=sys.stderr)
        raise SystemExit(1)
