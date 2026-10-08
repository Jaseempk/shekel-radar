import csv
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from lib.outreach import prepare_prospects, select_contacts, draft_template, domain_name

ROOT = Path(__file__).resolve().parents[1]


class OutreachTests(unittest.TestCase):
    def signal(self, **changes):
        return {'company': 'Example Studio', 'title': 'Lead Generation Specialist', 'url': 'https://jobs.example.test/1',
                'website': 'https://example.com/about/', 'score': 13, 'why': 'Offer B — lead pipeline', **changes}

    def test_identity_requires_evidence_not_guessing(self):
        prospects, unresolved = prepare_prospects([self.signal(website='')], {})
        self.assertFalse(prospects)
        self.assertEqual(len(unresolved), 1)
        prospects, _ = prepare_prospects([self.signal(website='')], {'Example Studio': {'domain': 'example.com', 'source': 'Reviewed company site'}})
        self.assertEqual(prospects[0]['domain'], 'example.com')
        with self.assertRaises(ValueError):
            prepare_prospects([self.signal()], {'Example Studio': {'domain': 'other.com'}})
        self.assertEqual(domain_name('https://www.example.com/contact'), 'example.com')

    def test_contacts_cannot_join_same_name_wrong_domain(self):
        prospects, _ = prepare_prospects([self.signal()], {})
        bad = {'company': 'Example Studio', 'domain': 'different.com', 'email': 'hello@different.com', 'smtp': 'valid'}
        self.assertFalse(select_contacts(prospects, [bad]))
        bad.update(domain='example.com')
        self.assertFalse(select_contacts(prospects, [bad]))
        bad.update(email='hello@example.com', smtp='catchall')
        self.assertFalse(select_contacts(prospects, [bad]))

    def test_only_conclusive_valid_contacts_are_eligible(self):
        prospects, _ = prepare_prospects([self.signal()], {})
        base = {'company': 'Example Studio', 'domain': 'example.com', 'email': 'hello@example.com', 'source': 'generic',
                'mx_status': 'ok', 'checked_at': '2026-10-08T00:00:00+00:00'}
        for smtp, reason in [('catchall', 'control-accepted: random address accepted (250 OK)'),
                             ('unknown', 'control-inconclusive: target accepted but control was temporary 451'),
                             ('unknown', 'circuit-open: 3 transport failures'), ('', ''), ('invalid', 'target-nonexistent: 550 5.1.1')]:
            self.assertFalse(select_contacts(prospects, [{**base, 'smtp': smtp, 'smtp_reason': reason}]), smtp)
        chosen = select_contacts(prospects, [{**base, 'smtp': 'valid', 'smtp_reason': 'control-rejected+target-accepted: ...'}])
        self.assertEqual(chosen[0]['to'], 'hello@example.com')

    def test_offer_b_routes_to_lead_pipeline_without_invented_metrics(self):
        prospects, _ = prepare_prospects([self.signal()], {})
        draft = draft_template({**prospects[0], 'to': 'hello@example.com'})
        self.assertEqual(draft['offer'], 'B')
        self.assertIn('rank prospect lists', draft['body'])
        self.assertNotIn('15 hours', draft['body'])
        self.assertNotIn('assistant over internal', draft['body'])

    def test_full_offline_workflow_from_unrelated_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); signals = base/'signals.json'; contacts = base/'contacts.csv'; run = base/'run'
            signals.write_text(json.dumps([self.signal()]))
            with contacts.open('w', newline='') as out:
                writer = csv.DictWriter(out, fieldnames=['company','domain','email','source','source_url','smtp'])
                writer.writeheader(); writer.writerow({'company':'Example Studio','domain':'example.com','email':'hello@example.com','source':'scraped','source_url':'https://example.com/contact','smtp':'valid'})
            command = [sys.executable, str(ROOT/'buyer-signals/workflow.py')]
            result = subprocess.run(command+['run','--signals',str(signals),'--contacts',str(contacts),'--run',str(run)],cwd=temp,capture_output=True,text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((run/'drafts.json').read_text())[0]['offer'], 'B')
            old = (run/'send-queue.md').read_text()
            self.assertIn('Contact evidence: https://example.com/contact', old)
            result = subprocess.run(command+['draft','--run',str(run)],cwd=temp,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual((run/'send-queue.md').read_text(),old)
            contacts_copy=run/'emails.csv'; contacts_copy.write_text(contacts_copy.read_text()+'\n')
            result=subprocess.run(command+['draft','--run',str(run)],cwd=temp,capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('Contacts changed',result.stderr)


if __name__ == '__main__':
    unittest.main()
