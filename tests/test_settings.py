"""Settings precedence and validation, including Python/Node parity."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from lib.runtime import ROOT, SettingsError, load_settings, require_profile, require_settings

NODE_PROBE = """
import { loadSettings, requireProfile } from %s;
const [defaults, mode] = process.argv.slice(1);
const env = JSON.parse(process.env.PROBE_ENV);
try {
  const s = loadSettings(env, defaults);
  console.log(JSON.stringify(mode === 'profile' ? requireProfile(s) : s));
} catch (e) { console.log(JSON.stringify({ error: e.name, message: e.message })); }
""" % json.dumps((ROOT / 'lib/runtime.mjs').as_uri())

DEFAULTS = {
    'socialModel': 'social-default', 'draftModel': 'draft-default', 'minimumBuyerScore': 55,
    'rawRetentionDays': 30, 'exportRetentionDays': 90, 'maxRawMB': 1024, 'candidateLocation': 'Remote',
    'profile': {'name': '', 'website': '', 'proof': '', 'claimsRule': 'Do not invent metrics.'},
}
PROFILE = {'name': 'Test Sender', 'website': 'example.test', 'proof': 'Shipped a synthetic project.'}


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.defaults = self.dir / 'settings.json'
        self.defaults.write_text(json.dumps(DEFAULTS))

    def tearDown(self):
        self.temp.cleanup()

    def local(self, value):
        file = self.dir / 'local.json'
        file.write_text(value if isinstance(value, str) else json.dumps(value))
        return str(file)

    def python(self, env, mode='settings'):
        try:
            s = load_settings(env, self.defaults)
            return require_profile(s) if mode == 'profile' else s
        except SettingsError as e:
            return {'error': 'SettingsError', 'message': str(e)}

    def node(self, env, mode='settings'):
        result = subprocess.run(['node', '--input-type=module', '-e', NODE_PROBE, str(self.defaults), mode],
                                capture_output=True, text=True, timeout=20,
                                env={**os.environ, 'PROBE_ENV': json.dumps(env)})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def both(self, env, mode='settings'):
        py, js = self.python(env, mode), self.node(env, mode)
        if 'error' in py:
            # JSON parser details differ by runtime; everything before them must match.
            self.assertEqual(py['message'].split(' (')[0], js['message'].split(' (')[0])
        else:
            self.assertEqual(py, js)
        return py

    def test_defaults_then_local_then_environment(self):
        env = {'INCOME_SETTINGS_LOCAL': self.local({'draftModel': 'local-draft', 'socialModel': 'local-social',
                                                     'minimumBuyerScore': 70, 'profile': PROFILE}),
               'INCOME_SOCIAL_MODEL': 'env-social'}
        s = self.both(env)
        self.assertEqual(s['socialModel'], 'env-social')
        self.assertEqual(s['draftModel'], 'local-draft')
        self.assertEqual(s['minimumBuyerScore'], 70)
        self.assertEqual(s['maxRawMB'], 1024)
        # Profile objects merge key by key, keeping the default claims rule.
        self.assertEqual(s['profile'], {**PROFILE, 'claimsRule': 'Do not invent metrics.'})
        self.assertEqual(self.both({**env, 'INCOME_DRAFT_MODEL': 'env-draft'})['draftModel'], 'env-draft')

    def test_collection_settings_load_without_override_or_profile(self):
        s = self.both({'INCOME_SETTINGS_LOCAL': self.local({})})
        self.assertEqual(s['candidateLocation'], 'Remote')
        self.assertEqual(s['profile']['name'], '')

    def test_missing_profile_fails_clearly_and_never_falls_back(self):
        result = self.both({'INCOME_SETTINGS_LOCAL': self.local({})}, 'profile')
        self.assertEqual(result['error'], 'SettingsError')
        self.assertIn('Missing required settings: profile.name, profile.website, profile.proof.', result['message'])
        self.assertIn('settings.local.example.json', result['message'])
        partial = self.both({'INCOME_SETTINGS_LOCAL': self.local({'profile': {'name': 'Only Name'}})}, 'profile')
        self.assertIn('profile.website, profile.proof.', partial['message'])
        self.assertNotIn('profile.name', partial['message'])

    def test_complete_profile_is_returned(self):
        env = {'INCOME_SETTINGS_LOCAL': self.local({'profile': PROFILE})}
        self.assertEqual(self.both(env, 'profile'), {**PROFILE, 'claimsRule': 'Do not invent metrics.'})

    def test_invalid_values_fail_identically(self):
        cases = [
            ({'minimumBuyerScore': 101}, 'Invalid setting minimumBuyerScore: must be an integer from 0 to 100'),
            ({'minimumBuyerScore': True}, 'Invalid setting minimumBuyerScore: must be an integer from 0 to 100'),
            ({'rawRetentionDays': -1}, 'Invalid setting rawRetentionDays: must be a non-negative integer'),
            ({'draftModel': ' '}, 'Invalid setting draftModel: must be a non-empty string'),
            ({'candidateLocation': None}, 'Invalid setting candidateLocation: must be a string'),
            ({'profile': 'Jane'}, 'Invalid setting profile: must be an object'),
        ]
        for override, message in cases:
            with self.subTest(override=override):
                self.assertEqual(self.both({'INCOME_SETTINGS_LOCAL': self.local(override)})['message'], message)
        bad_field = self.both({'INCOME_SETTINGS_LOCAL': self.local({'profile': {**PROFILE, 'proof': 7}})}, 'profile')
        self.assertEqual(bad_field['message'], 'Invalid setting profile.proof: must be a string')

    def test_broken_or_missing_override_files(self):
        self.assertIn('Settings file is not valid JSON', self.both({'INCOME_SETTINGS_LOCAL': self.local('{')})['message'])
        self.assertIn('must contain a JSON object', self.both({'INCOME_SETTINGS_LOCAL': self.local('[]')})['message'])
        missing = self.both({'INCOME_SETTINGS_LOCAL': str(self.dir / 'absent.json')})
        self.assertIn('Settings file not found', missing['message'])

    def test_require_settings_accepts_dotted_keys(self):
        s = load_settings({'INCOME_SETTINGS_LOCAL': self.local({'profile': PROFILE})}, self.defaults)
        self.assertIs(require_settings(['draftModel', 'profile.website'], s), s)
        with self.assertRaises(SettingsError):
            require_settings(['profile.missing'], s)

    def test_committed_defaults_hold_no_sender_facts(self):
        committed = json.loads((ROOT / 'config/settings.json').read_text())
        self.assertEqual({k: committed['profile'][k] for k in ('name', 'website', 'proof')},
                         {'name': '', 'website': '', 'proof': ''})
        example = json.loads((ROOT / 'config/settings.local.example.json').read_text())
        require_profile(load_settings({'INCOME_SETTINGS_LOCAL': str(ROOT / 'config/settings.local.example.json')}))
        self.assertEqual(example['profile']['website'], 'example.com')


if __name__ == '__main__':
    unittest.main()
