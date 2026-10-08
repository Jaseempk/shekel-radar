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
        def fetch(url, timeout):
            if url.endswith('/contact'):
                return finder.Page(url, 'ok', 'sales@company.test partner@external.test')
            return finder.Page(url, 'ok', '<p>No email here</p>')
        with patch.object(finder, 'PAGES', ['', 'contact']):
            own, other, report = finder.scrape_site('company.test', fetcher=fetch, sleep=lambda s: None)
        self.assertEqual(own, {'sales@company.test': 'https://company.test/contact'})
        self.assertEqual(other, {'partner@external.test': 'https://company.test/contact'})
        self.assertEqual((report.status, report.fetched, report.failures), ('ok', 2, ()))

    def test_unreachable_site_is_reported_not_treated_as_no_email(self):
        calls = []

        def fetch(url, timeout):
            calls.append(url)
            return finder.Page(url, 'error', reason='URLError: [Errno 8] nodename nor servname provided')
        with patch.object(finder, 'PAGES', ['', 'contact', 'about', 'team', 'privacy']):
            own, other, report = finder.scrape_site('company.test', fetcher=fetch, sleep=lambda s: None)
        self.assertEqual((own, other), ({}, {}))
        self.assertEqual(report.status, 'unavailable')
        self.assertLessEqual(len(calls), 4)  # each host variant is abandoned after two network failures
        self.assertIn('nodename', report.summary())
        self.assertTrue(any('skipped: site unreachable' in reason for _, reason in report.failures))

    def test_partial_failures_and_missing_pages_are_distinguished(self):
        def fetch(url, timeout):
            if url.endswith('/contact'):
                return finder.Page(url, 'ok', 'hello@company.test')
            if url.endswith('/team'):
                return finder.Page(url, 'http-error', reason='HTTP 503')
            return finder.Page(url, 'missing', reason='HTTP 404')
        with patch.object(finder, 'PAGES', ['contact', 'team', 'about']):
            own, _, report = finder.scrape_site('company.test', fetcher=fetch, sleep=lambda s: None)
        self.assertEqual(own, {'hello@company.test': 'https://company.test/contact'})
        self.assertEqual(report.status, 'partial')
        self.assertEqual([url for url, _ in report.failures], ['https://company.test/team', 'https://www.company.test/team'])
        with patch.object(finder, 'PAGES', ['about']):
            _, _, report = finder.scrape_site('company.test', fetcher=fetch, sleep=lambda s: None)
        self.assertEqual((report.status, report.failures), ('not-found', ()))

    def test_discovery_shares_one_monotonic_budget(self):
        clock = [0.0]

        def fetch(url, timeout):
            clock[0] += timeout  # a hanging server consumes its whole timeout
            return finder.Page(url, 'http-error', reason='HTTP 504')
        with patch.object(finder, 'PAGES', ['', 'contact', 'about', 'team', 'privacy', 'terms']):
            _, _, report = finder.scrape_site('company.test', fetcher=fetch, sleep=lambda s: None,
                                              clock=lambda: clock[0], budget=30.0, timeout=12)
        self.assertLessEqual(clock[0], 30.0)
        self.assertEqual(report.status, 'unavailable')
        self.assertTrue(any('discovery budget exhausted' in reason for _, reason in report.failures))

    def test_fetch_page_keeps_failure_reasons(self):
        import urllib.error

        class Response:
            def __init__(self, ctype, body=b''):
                self.headers, self.body = {'Content-Type': ctype}, body

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self, limit):
                return self.body[:limit]

        def opener(result):
            def open_(req, timeout):
                if isinstance(result, Exception):
                    raise result
                return result
            return open_
        url = 'https://company.test/contact'
        self.assertEqual(finder.fetch_page(url, opener=opener(Response('text/html', b'hi@company.test'))).text, 'hi@company.test')
        self.assertEqual(finder.fetch_page(url, opener=opener(Response('application/pdf'))).status, 'not-text')
        missing = urllib.error.HTTPError(url, 404, 'Not Found', {}, None)
        self.assertEqual(finder.fetch_page(url, opener=opener(missing)).status, 'missing')
        blocked = urllib.error.HTTPError(url, 403, 'Forbidden', {}, None)
        self.assertEqual(finder.fetch_page(url, opener=opener(blocked)).reason, 'HTTP 403')
        down = finder.fetch_page(url, opener=opener(urllib.error.URLError('timed out')))
        self.assertEqual((down.status, down.reason), ('error', 'URLError: timed out'))
        self.assertEqual(finder.fetch_page(url, opener=opener(TimeoutError('read timed out'))).status, 'error')
