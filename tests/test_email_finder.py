import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('email_finder', Path(__file__).resolve().parents[1] / 'email-finder/find_emails.py')
finder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(finder)


class EmailFinderTests(unittest.TestCase):
    def test_public_encoded_addresses_and_malformed_data(self):
        key = 0x73
        encoded = bytes([key] + [ord(c) ^ key for c in 'api@company.test']).hex()
        page = f'<a data-cfemail="{encoded}">[email protected]</a>'
        page += '<a href="mailto:Info&#64;company.test">Email</a>'
        page += '<a data-cfemail="f">broken</a> invalid@example.com'
        page += r'\u003esales@company.test\u003c'
        self.assertEqual(finder.published_emails(page), {'api@company.test', 'info@company.test', 'sales@company.test'})

    def test_discovery_preserves_source_and_separates_other_domains(self):
        def fetch(url):
            if url.endswith('/contact'):
                return 'sales@company.test partner@external.test'
            return '<p>No email here</p>'
        with patch.object(finder, 'PAGES', ['', 'contact']), patch.object(finder, 'fetch', side_effect=fetch), patch.object(finder.time, 'sleep'):
            own, other = finder.scrape_site('company.test')
        self.assertEqual(own, {'sales@company.test': 'https://company.test/contact'})
        self.assertEqual(other, {'partner@external.test': 'https://company.test/contact'})
