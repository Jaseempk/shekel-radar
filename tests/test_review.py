"""Review decisions, contact holds and draft provenance through the outreach CLI (offline, synthetic data)."""
import csv
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from lib.outreach import contact_readiness, validate_decisions, prepare_prospects, LEGACY_REASON

ROOT = Path(__file__).resolve().parents[1]
CLI = [sys.executable, str(ROOT / 'tools/run.py'), 'outreach']
PROFILE = {'name': 'Test Sender', 'website': 'example.test', 'proof': 'Shipped a synthetic project.',
           'claimsRule': 'Do not invent numbers.'}
FIELDS = ['company', 'domain', 'email', 'source', 'source_url', 'smtp', 'founder', 'smtp_reason', 'checked_at', 'mx_status', 'site_status', 'site_errors']
VALID = 'control-rejected+target-accepted: control 550 5.1.1; target 250'


def signal(company, domain, n=1, **extra):
    return {'company': company, 'title': f'Research Specialist {n}', 'url': f'https://jobs.example.test/{domain}/{n}',
            'website': f'https://{domain}/', 'score': 10, 'offer': 'B', **extra}


def contact(company, domain, email, smtp, reason='', **extra):
    return {'company': company, 'domain': domain, 'email': email, 'source': 'scraped', 'source_url': f'https://{domain}/contact',
            'smtp': smtp, 'smtp_reason': reason, 'checked_at': '2026-10-08T00:00:00+00:00', 'mx_status': 'ok', **extra}


def decision(company, domain, verdict='accepted', n=1, **extra):
    entry = {'company': company, 'domain': domain, 'decision': verdict, 'reason': f'{verdict} after reading the role',
             'reviewed_at': '2026-10-08T09:00:00Z', 'role': {'url': f'https://jobs.example.test/{domain}/{n}'}}
    if verdict == 'accepted':
        entry.update(offer='B', hypothesis='Repeated research might be assisted; budget unknown.')
    return {**entry, **extra}


class Workspace:
    """A temporary data area plus an unrelated working directory for subprocess calls."""

    def __init__(self, test, profile=PROFILE):
        self.test = test
        self._temp, self._cwd = tempfile.TemporaryDirectory(), tempfile.TemporaryDirectory()
        self.base, self.cwd = Path(self._temp.name), self._cwd.name
        self.run_dir = self.base / 'run'
        local = self.base / 'local.json'
        local.write_text(json.dumps({'profile': profile} if profile else {}))
        self.env = {**os.environ, 'INCOME_SETTINGS_LOCAL': str(local), 'INCOME_DATA_DIR': str(self.base)}
        self.env.pop('ANTHROPIC_API_KEY', None)
        test.addCleanup(self._temp.cleanup)
        test.addCleanup(self._cwd.cleanup)

    def write(self, name, value):
        path = self.base / name
        if name.endswith('.csv'):
            with path.open('w', newline='') as out:
                writer = csv.DictWriter(out, fieldnames=FIELDS if value and 'smtp_reason' in value[0] else list(value[0]))
                writer.writeheader()
                writer.writerows(value)
        else:
            path.write_text(value if isinstance(value, str) else json.dumps(value))
        return path

    def cli(self, *args, ok=True):
        result = subprocess.run(CLI + [str(a) for a in args], cwd=self.cwd, env=self.env, capture_output=True, text=True, timeout=60)
        if ok:
            self.test.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def prepare(self, signals, contacts=None):
        self.cli('prepare', '--signals', self.write('signals.json', signals), '--run', self.run_dir)
        if contacts is not None:
            self.contacts(contacts)

    def contacts(self, rows, name='contacts.csv'):
        return self.cli('verify', '--run', self.run_dir, '--contacts', self.write(name, rows))

    def review(self, decisions, name='review.json', ok=True):
        return self.cli('review', '--run', self.run_dir, '--decisions', self.write(name, decisions), ok=ok)

    def draft(self, *extra, ok=True):
        return self.cli('draft', '--run', self.run_dir, *extra, ok=ok)

    def json(self, name):
        return json.loads((self.run_dir / name).read_text())

    def text(self, name):
        return (self.run_dir / name).read_text()

    def snapshot(self):
        return {p.name: p.read_bytes() for p in sorted(self.run_dir.iterdir())}


class ReviewWorkflowTests(unittest.TestCase):
    def test_only_accepted_verified_prospects_enter_email_queue_and_summary_counts_everyone(self):
        ws = Workspace(self)
        companies = [('Accepted Co', 'accepted.test'), ('Rejected Co', 'rejected.test'), ('Deferred Co', 'deferred.test'), ('Pending Co', 'pending.test')]
        signals = [signal(c, d) for c, d in companies] + [{'company': 'Nodomain Co', 'title': 'Research', 'url': 'https://jobs.example.test/x', 'offer': 'B'}]
        ws.prepare(signals, [contact(c, d, f'hello@{d}', 'valid', VALID) for c, d in companies])
        ws.review([decision('Accepted Co', 'accepted.test'), decision('Rejected Co', 'rejected.test', 'rejected'),
                   decision('Deferred Co', 'deferred.test', 'deferred')])
        ws.draft()
        drafts = ws.json('drafts.json')
        self.assertEqual([(d['company'], d['to']) for d in drafts], [('Accepted Co', 'hello@accepted.test')])
        self.assertEqual(ws.json('held-drafts.json'), [])
        summary = ws.json('review-summary.json')
        self.assertEqual(summary['total'], 5)
        self.assertEqual({k: v for k, v in summary['counts'].items() if v},
                         {'accepted-ready': 1, 'rejected': 1, 'deferred': 1, 'pending-review': 1, 'unresolved-domain': 1})
        by_company = {p['company']: p for p in summary['prospects']}
        self.assertEqual(by_company['Pending Co']['note'], 'no review decision recorded')
        self.assertEqual(by_company['Accepted Co']['contact']['evidence'][0]['smtp_reason'], VALID)
        queue = ws.text('send-queue.md')
        self.assertIn('Review: accepted on 2026-10-08T09:00:00Z', queue)
        self.assertIn('Hypothesis: Repeated research might be assisted', queue)
        self.assertIn('Provenance: review ', queue)
        for name in ('Rejected Co', 'Deferred Co', 'Pending Co'):
            self.assertNotIn(name, queue)
        self.assertIn('## Pending Co (pending.test): pending-review', ws.text('review-summary.md'))

    def test_accepted_prospects_without_verified_inbox_are_held_with_reason_and_evidence(self):
        ws = Workspace(self)
        cos = {'Catchall Co': 'catchall.test', 'Unknown Co': 'unknown.test', 'Empty Co': 'empty.test', 'Offsite Co': 'offsite.test'}
        ws.prepare([signal(c, d) for c, d in cos.items()], [
            contact('Catchall Co', 'catchall.test', 'hello@catchall.test', 'catchall', 'control-accepted: random address accepted (250)'),
            contact('Unknown Co', 'unknown.test', 'info@unknown.test', 'unknown', 'circuit-open: 3 transport failures'),
            contact('Offsite Co', 'offsite.test', 'team@other.test', '', source='scraped-offsite'),
            contact('Offsite Co', 'offsite.test', 'support@offsite.test', 'valid', VALID)])
        route = {'type': 'contact-form', 'url': 'https://catchall.test/contact', 'note': 'Official form'}
        ws.review([decision('Catchall Co', 'catchall.test', contact_route=route), decision('Unknown Co', 'unknown.test'),
                   decision('Empty Co', 'empty.test'), decision('Offsite Co', 'offsite.test',
                   contact_route={'type': 'unverified-email', 'email': 'partners@offsite.test'})])
        ws.draft()
        self.assertEqual(ws.json('drafts.json'), [])
        held = {d['company']: d for d in ws.json('held-drafts.json')}
        self.assertEqual(set(held), set(cos))
        self.assertTrue(all('to' not in d and d['status'] == 'hold' for d in held.values()))
        self.assertIn('control-accepted', held['Catchall Co']['hold_reason'])
        self.assertIn('smtp=catchall', held['Catchall Co']['hold_reason'])
        self.assertIn('circuit-open', held['Unknown Co']['hold_reason'])
        self.assertEqual(held['Empty Co']['hold_reason'], 'no contact found')
        self.assertEqual(held['Offsite Co']['hold_reason'], 'only off-domain or disallowed inboxes')
        self.assertEqual(held['Catchall Co']['contact_route'], route)
        self.assertEqual(held['Catchall Co']['contact_evidence'][0]['email'], 'hello@catchall.test')
        markdown = ws.text('held-queue.md')
        self.assertNotIn('To:', markdown)
        self.assertIn('Reviewed route: contact-form https://catchall.test/contact: Official form', markdown)
        self.assertIn('partners@offsite.test (unverified; not a recipient)', markdown)
        self.assertNotIn('Catchall Co', ws.text('send-queue.md'))
        self.assertEqual(ws.json('review-summary.json')['counts']['accepted-held'], 4)

    def test_same_name_companies_on_different_domains_never_share_reviews_or_contacts(self):
        ws = Workspace(self)
        ws.prepare([signal('Acme', 'acme.test'), signal('Acme', 'acme-labs.test')],
                   [contact('Acme', 'acme-labs.test', 'hello@acme-labs.test', 'valid', VALID),
                    contact('Acme', 'acme.test', 'hello@acme-labs.test', 'valid', VALID)])
        ws.review([decision('Acme', 'acme.test')])
        ws.draft()
        self.assertEqual(ws.json('drafts.json'), [])  # acme.test only has an off-domain address
        held = ws.json('held-drafts.json')
        self.assertEqual([(d['domain'], d['hold_reason']) for d in held], [('acme.test', 'only off-domain or disallowed inboxes')])
        statuses = {p['domain']: p['status'] for p in ws.json('review-summary.json')['prospects']}
        self.assertEqual(statuses, {'acme.test': 'accepted-held', 'acme-labs.test': 'pending-review'})
        # A decision cannot target a domain that is not evidenced for that company in this run.
        result = ws.review([decision('Acme', 'acme.example')], name='bad.json', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no prospect Acme / acme.example', result.stderr)

    def test_changed_contact_review_or_role_evidence_invalidates_cached_draft_and_approval(self):
        ws = Workspace(self)
        ws.prepare([signal('Shift Co', 'shift.test')], [contact('Shift Co', 'shift.test', 'hello@shift.test', 'valid', VALID)])
        ws.review([decision('Shift Co', 'shift.test')])
        ws.draft()
        first = ws.json('drafts.json')[0]['provenance']
        # Contact evidence changes: the domain is now known to be catch-all, so the email approval is gone.
        ws.contacts([contact('Shift Co', 'shift.test', 'hello@shift.test', 'catchall', 'control-accepted: 250')], name='c2.csv')
        ws.draft()
        self.assertEqual(ws.json('drafts.json'), [])
        held = ws.json('held-drafts.json')[0]
        self.assertNotEqual(held['provenance']['contact'], first['contact'])
        self.assertNotEqual(held['provenance']['cache_key'], first['cache_key'])
        # Restored contacts return to the queue; the cached draft for that evidence is reused.
        ws.contacts([contact('Shift Co', 'shift.test', 'hello@shift.test', 'valid', VALID)], name='c3.csv')
        ws.draft()
        self.assertEqual(ws.json('drafts.json')[0]['provenance']['cache_key'], first['cache_key'])
        # A changed review decision regenerates the draft under a new review fingerprint.
        ws.review([decision('Shift Co', 'shift.test', offer='ops', hypothesis='Validation might be assisted.')], name='r2.json')
        ws.draft()
        draft = ws.json('drafts.json')[0]
        self.assertNotEqual(draft['provenance']['review'], first['review'])
        self.assertEqual(draft['offer'], 'ops')
        self.assertIn('move data between your systems', draft['body'])
        # Changed role evidence makes the approval stale: back to pending review, nothing drafted.
        prospects = ws.json('prospects.json')
        prospects['prospects'][0]['roles'][0]['title'] = 'Changed Title'
        (ws.run_dir / 'prospects.json').write_text(json.dumps(prospects))
        ws.draft()
        self.assertEqual((ws.json('drafts.json'), ws.json('held-drafts.json')), ([], []))
        summary = ws.json('review-summary.json')['prospects'][0]
        self.assertEqual(summary['status'], 'pending-review')
        self.assertIn('stale review', summary['note'])

    def test_repeated_execution_preserves_decisions_results_and_manual_edits(self):
        ws = Workspace(self)
        ws.prepare([signal('Keep Co', 'keep.test'), signal('Later Co', 'later.test')],
                   [contact('Keep Co', 'keep.test', 'hello@keep.test', 'valid', VALID),
                    contact('Later Co', 'later.test', 'hello@later.test', 'catchall', 'control-accepted: 250')])
        ws.review([decision('Keep Co', 'keep.test')])
        applied = ws.json('review.json')['decisions']['keep co|keep.test']['applied_at']
        ws.review([decision('Keep Co', 'keep.test')], name='same.json')  # idempotent re-application
        ws.review([decision('Later Co', 'later.test')], name='later.json')  # adds; does not drop Keep Co
        decisions = ws.json('review.json')['decisions']
        self.assertEqual(set(decisions), {'keep co|keep.test', 'later co|later.test'})
        self.assertEqual(decisions['keep co|keep.test']['applied_at'], applied)
        ws.draft()
        queue, held_queue = ws.text('send-queue.md'), ws.text('held-queue.md')
        ws.draft()
        self.assertEqual((ws.text('send-queue.md'), ws.text('held-queue.md')), (queue, held_queue))
        # Manual edit of a generated draft survives later runs.
        drafts = ws.json('drafts.json')
        drafts[0]['body'] = 'Hand-written body.'
        drafts[0]['to'] = 'someone@elsewhere.test'  # recipients are never taken from edits
        (ws.run_dir / 'drafts.json').write_text(json.dumps(drafts))
        held = ws.json('held-drafts.json')
        held[0]['subject'] = 'Edited held subject'
        (ws.run_dir / 'held-drafts.json').write_text(json.dumps(held))
        ws.draft()
        draft = ws.json('drafts.json')[0]
        self.assertEqual((draft['body'], draft['to'], draft['edited']), ('Hand-written body.', 'hello@keep.test', True))
        self.assertEqual(ws.json('held-drafts.json')[0]['subject'], 'Edited held subject')
        self.assertIn('Hand-written body.', ws.text('send-queue.md'))
        # Hand edits to the rendered Markdown are kept as a copy, not silently lost.
        (ws.run_dir / 'send-queue.md').write_text(ws.text('send-queue.md') + '\nmy note\n')
        result = ws.draft()
        copies = list(ws.run_dir.glob('send-queue.preserved-*.md'))
        self.assertEqual(len(copies), 1)
        self.assertIn('my note', copies[0].read_text())
        self.assertIn('send-queue.md was edited', result.stdout)
        # Upstream evidence changes after an edit: the edit stays, the conflict is reported.
        ws.review([decision('Keep Co', 'keep.test', reason='Re-reviewed with more context')], name='r3.json')
        result = ws.draft()
        self.assertIn('manually edited draft preserved', result.stdout)
        draft = ws.json('drafts.json')[0]
        self.assertEqual(draft['body'], 'Hand-written body.')
        self.assertIn('edit_conflict', draft)
        self.assertIn('WARNING: evidence changed', ws.text('send-queue.md'))
        conflicts = ws.json('draft-conflicts.json')
        self.assertEqual(conflicts[0]['edited']['body'], 'Hand-written body.')
        self.assertIn('I saw your Research Specialist 1 opening', conflicts[0]['regenerated']['body'])
        ws.draft()
        self.assertEqual(len(ws.json('draft-conflicts.json')), 1)  # reported again, not duplicated
        ws.draft('--accept-edits')
        draft = ws.json('drafts.json')[0]
        self.assertNotIn('edit_conflict', draft)
        self.assertEqual(draft['body'], 'Hand-written body.')
        self.assertEqual(draft['review']['reason'], 'Re-reviewed with more context')
        ws.draft()
        self.assertNotIn('edit_conflict', ws.json('drafts.json')[0])
        # An edited draft whose prospect is rejected leaves the queue but is kept in the conflicts file.
        ws.review([decision('Keep Co', 'keep.test', 'rejected')], name='r4.json')
        ws.draft()
        self.assertEqual(ws.json('drafts.json'), [])
        self.assertTrue(any('now rejected' in c['reason'] for c in ws.json('draft-conflicts.json')))

    def test_legacy_runs_are_not_silently_approved_and_migrate_explicitly(self):
        ws = Workspace(self)
        ws.prepare([signal('Old Co', 'old.test'), signal('Older Co', 'older.test')])
        # An old-style contact import: no diagnostic columns, smtp=valid from the old verifier.
        ws.contacts([{'company': 'Old Co', 'domain': 'old.test', 'email': 'info@old.test', 'source': 'scraped', 'source_url': '', 'smtp': 'valid'},
                     {'company': 'Older Co', 'domain': 'older.test', 'email': 'hello@older.test', 'source': 'generic', 'source_url': '', 'smtp': 'catchall'}])
        (ws.run_dir / 'drafts.json').write_text(json.dumps([{'company': 'Old Co', 'to': 'info@old.test', 'body': 'old'}]))
        (ws.run_dir / 'send-queue.md').write_text('# Outreach drafts\n\n## Old Co\nTo: info@old.test\n')
        result = ws.draft()
        self.assertIn('No review decisions recorded for this run: 2 prospect(s) pending review', result.stderr)
        self.assertEqual((ws.json('drafts.json'), ws.json('held-drafts.json')), ([], []))
        self.assertEqual(ws.json('review-summary.json')['counts']['pending-review'], 2)
        self.assertEqual(json.loads(next(ws.run_dir.glob('drafts.preserved-*.json')).read_text())[0]['body'], 'old')
        self.assertIn('To: info@old.test', next(ws.run_dir.glob('send-queue.preserved-*.md')).read_text())
        ws.review([decision('Old Co', 'old.test'), decision('Older Co', 'older.test')])
        ws.draft()
        held = {d['company']: d for d in ws.json('held-drafts.json')}
        self.assertEqual(held['Old Co']['hold_reason'], LEGACY_REASON)
        self.assertEqual(held['Older Co']['hold_reason'], 'smtp=catchall (hello@older.test): no reason recorded')
        self.assertEqual(ws.json('drafts.json'), [])
        ws.draft('--allow-legacy-contacts')
        drafts = ws.json('drafts.json')
        self.assertEqual([(d['company'], d['to']) for d in drafts], [('Old Co', 'info@old.test')])
        self.assertTrue(drafts[0]['provenance']['legacy_contact'])
        self.assertIn('WARNING: LEGACY CONTACT EVIDENCE', ws.text('send-queue.md'))
        self.assertEqual([d['company'] for d in ws.json('held-drafts.json')], ['Older Co'])

    def test_invalid_review_input_fails_before_mutating_the_run(self):
        ws = Workspace(self)
        ws.prepare([signal('Valid Co', 'valid.test')], [contact('Valid Co', 'valid.test', 'hello@valid.test', 'valid', VALID)])
        ws.review([decision('Valid Co', 'valid.test', 'deferred')])
        before = ws.snapshot()
        good = decision('Valid Co', 'valid.test')
        bad_inputs = [
            '{not json', [], {'decisions': [good], 'extra': 1}, [{**good, 'decision': 'approve'}], [{**good, 'reason': '  '}],
            [{**good, 'reviewed_at': 'yesterday'}], [{**good, 'role': {'url': 'https://jobs.example.test/other'}}],
            [{**good, 'role': {'url': good['role']['url'], 'title': 'Wrong'}}], [{**good, 'offer': 'Z'}],
            [{k: v for k, v in good.items() if k != 'hypothesis'}], [good, good], [{**good, 'unexpected': True}],
            [{**good, 'contact_route': {'type': 'contact-form'}}], [{**good, 'contact_route': {'type': 'fax', 'url': 'https://x.test'}}],
            [decision('Valid Co', 'valid.test', 'rejected', contact_route={'type': 'linkedin', 'url': 'https://linkedin.test/x'})],
            [good, decision('Missing Co', 'missing.test')],
        ]
        for i, bad in enumerate(bad_inputs):
            result = ws.review(bad, name=f'bad{i}.json', ok=False)
            self.assertEqual(result.returncode, 1, (bad, result.stderr))
            self.assertIn('error', result.stderr.lower())
            self.assertEqual(ws.snapshot(), before, bad)
        # A hand-edited stored review is detected rather than trusted.
        stored = ws.json('review.json')
        stored['decisions']['valid co|valid.test']['decision'] = 'accepted'
        (ws.run_dir / 'review.json').write_text(json.dumps(stored))
        result = ws.draft(ok=False)
        self.assertIn('review.json changed outside the review stage', result.stderr)

    def test_drafting_without_profile_exits_2_while_other_stages_work(self):
        ws = Workspace(self, profile=None)
        ws.prepare([signal('Valid Co', 'valid.test')], [contact('Valid Co', 'valid.test', 'hello@valid.test', 'valid', VALID)])
        ws.review([decision('Valid Co', 'valid.test')])
        result = ws.draft(ok=False)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('Missing required settings: profile.name, profile.website, profile.proof', result.stderr)
        self.assertFalse((ws.run_dir / 'drafts.json').exists())


class ReviewUnitTests(unittest.TestCase):
    def test_review_never_manufactures_a_recipient(self):
        prospects, _ = prepare_prospects([signal('Route Co', 'route.test')], {})
        decisions = validate_decisions({'version': 1, 'decisions': [decision('Route Co', 'route.test',
            contact_route={'type': 'unverified-email', 'email': 'Ops@Route.test'})]}, prospects)
        self.assertEqual(decisions['route co|route.test']['contact_route']['email'], 'ops@route.test')
        ready = contact_readiness(prospects[0], [contact('Route Co', 'route.test', 'ops@route.test', 'catchall', 'control-accepted: 250')])
        self.assertEqual(ready['status'], 'hold')
        ready = contact_readiness(prospects[0], [contact('Route Co', 'route.test', 'ops@route.test', 'valid', 'target-policy: odd')])
        self.assertEqual(ready['status'], 'hold')
        self.assertIn('inconsistent evidence', ready['reason'])

    def test_review_records_collected_role_identity(self):
        prospects, _ = prepare_prospects([signal('Id Co', 'id.test', jobId='workable:abc', qualification={'status': 'qualified'})], {})
        role = validate_decisions([decision('Id Co', 'id.test')], prospects)['id co|id.test']['role']
        self.assertEqual(role, {'url': 'https://jobs.example.test/id.test/1', 'title': 'Research Specialist 1',
                                'jobId': 'workable:abc', 'qualification_status': 'qualified'})


if __name__ == '__main__':
    unittest.main()
