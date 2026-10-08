"""Reddit drafting uses configured sender facts and fails clearly without them."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUN = [sys.executable, str(ROOT / 'tools/run.py'), 'reddit-draft']


def load_drafter():
    spec = importlib.util.spec_from_file_location('draft_leads_under_test', ROOT / 'reddit-mining/draft_leads.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RedditDraftConfigTests(unittest.TestCase):
    def run_cli(self, temp, local, *args):
        file = Path(temp) / 'local.json'
        file.write_text(json.dumps(local))
        env = {**os.environ, 'INCOME_DATA_DIR': temp, 'INCOME_SETTINGS_LOCAL': str(file)}
        env.pop('ANTHROPIC_API_KEY', None)
        return subprocess.run(RUN + list(args), cwd=temp, env=env, capture_output=True, text=True, timeout=30)

    def test_prompt_uses_profile_facts_and_threshold(self):
        drafter = load_drafter()
        profile = {'name': 'Test Sender', 'website': 'example.test', 'proof': 'Shipped a synthetic project.',
                   'claimsRule': 'Never state numbers.'}
        prompt = drafter.build_prompt({'subreddit': 'smallbusiness', 'title': 'Invoices'}, '', 'r/x (1)', '  -', '  -',
                                      profile, min_score=70)
        self.assertIn('drafting as Test Sender', prompt)
        self.assertIn('Shipped a synthetic project.', prompt)
        self.assertIn('Never state numbers.', prompt)
        self.assertIn('score >= 70', prompt)
        self.assertNotIn('50-person', prompt)

    def test_threshold_comes_from_settings(self):
        from lib.runtime import SETTINGS
        self.assertEqual(load_drafter().MIN_BUYER_SCORE, SETTINGS['minimumBuyerScore'])

    def test_drafting_without_profile_fails_before_any_work(self):
        with tempfile.TemporaryDirectory() as temp:
            leads = Path(temp) / 'leads.json'
            leads.write_text(json.dumps([{'url': 'https://reddit.com/r/t/comments/abc', 'title': 'x'}]))
            result = self.run_cli(temp, {}, '--leads', str(leads))
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn('Missing required settings: profile.name, profile.website, profile.proof.', result.stderr)
            self.assertNotIn('Traceback', result.stderr)
            self.assertFalse((Path(temp) / 'state/opportunities.sqlite').exists())

    def test_help_and_export_only_work_without_profile(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(self.run_cli(temp, {}, '--help').returncode, 0)
            result = self.run_cli(temp, {}, '--export-only', '--out', str(Path(temp) / 'out.csv'))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('0 qualified buyers', result.stdout)


if __name__ == '__main__':
    unittest.main()
