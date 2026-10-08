"""Offline SMTP verification protocol tests: fake servers, fake clock, no network."""
import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import smtplib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('email_finder_smtp', ROOT / 'email-finder/find_emails.py')
finder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(finder)

IDENTITY = finder.ProbeIdentity('probe@sender.test', 'mail.sender.test')
NONEXISTENT = (550, b'5.1.1 <x@company.test>: Recipient address rejected: User unknown')
ACCEPTED = (250, b'2.1.5 OK')


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Server:
    """Scripted behaviour for one SMTP session. `rcpt` maps an address to a
    reply tuple or an exception; `control` answers the random probe."""

    def __init__(self, control=NONEXISTENT, targets=None, default=NONEXISTENT, banner=220, mail=250,
                 connect_error=None, ehlo_error=None, connect_cost=0.0):
        self.control, self.targets, self.default = control, targets or {}, default
        self.banner, self.mail_code, self.connect_error, self.ehlo_error = banner, mail, connect_error, ehlo_error
        self.connect_cost = connect_cost


class FakeSMTP:
    def __init__(self, network, helo, timeout):
        self.network, self.helo, self.timeout = network, helo, timeout
        self.server, self.closed, self.quit_called, self.log = None, False, False, []

    def connect(self, host, port):
        self.server = self.network.next_session(host)
        # Real sockets honour the per-operation timeout the verifier passes in.
        cost = self.server.connect_cost or (self.timeout if self.server.connect_error else 0)
        self.network.clock.t += min(cost, self.timeout)
        if self.server.connect_error:
            raise self.server.connect_error
        return self.server.banner, b'ready'

    def ehlo_or_helo_if_needed(self):
        if self.server.ehlo_error:
            raise self.server.ehlo_error

    def mail(self, sender):
        assert sender == IDENTITY.mail_from
        return self.server.mail_code, b'sender'

    def rcpt(self, address):
        self.log.append(address)
        self.network.rcpts.append(address)
        local = address.split('@')[0]
        reply = self.server.targets.get(address) if address in self.server.targets else (
            self.server.control if local.startswith('ctl') else self.server.default)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def quit(self):
        self.quit_called = True
        if self.server is None or self.server.connect_error:
            raise smtplib.SMTPServerDisconnected('not connected')
        return 221, b'bye'

    def close(self):
        self.closed = True


class Network:
    """Hands out scripted sessions in order (the last one repeats)."""

    def __init__(self, *sessions, clock=None):
        self.sessions, self.clock = list(sessions), clock or Clock()
        self.clients, self.rcpts, self.hosts = [], [], []

    def next_session(self, host):
        self.hosts.append(host)
        return self.sessions.pop(0) if len(self.sessions) > 1 else self.sessions[0]

    def factory(self, helo, timeout):
        assert helo == IDENTITY.helo
        client = FakeSMTP(self, helo, timeout)
        self.clients.append(client)
        return client


class ControlRng:
    """Random control addresses are recognisable to the fake server."""

    def __init__(self):
        self.n = 0

    def choice(self, alphabet):
        self.n += 1
        return 'ctl'[self.n % 16 - 1] if 0 < self.n % 16 <= 3 else 'q'


def verifier(network, mx=('mx1.company.test', 'mx2.company.test'), **kw):
    return finder.DomainVerifier('company.test', IDENTITY, mx=finder.MXResult(tuple(mx), 'ok', 'test'),
                                 smtp_factory=network.factory, clock=network.clock, rng=ControlRng(),
                                 now=lambda: '2026-10-08T00:00:00+00:00', **kw)


class SmtpVerificationTests(unittest.TestCase):
    def test_classification_distinguishes_nonexistent_from_policy_and_malformed(self):
        cases = {
            (250, b'OK'): 'accepted', (251, b'forward'): 'accepted',
            (550, b'5.1.1 user unknown'): 'nonexistent', (550, b'No such user here'): 'nonexistent',
            (550, b'5.7.1 Service unavailable; client host blocked using Spamhaus'): 'policy',
            (550, b'Relay access denied'): 'policy', (554, b'rejected by policy'): 'policy',
            (550, b'Requested action not taken'): 'ambiguous', (553, b'5.1.3 bad address syntax'): 'malformed',
            (501, b'Syntax error'): 'malformed', (450, b'4.2.1 try later (greylisted)'): 'temporary',
            (421, b'closing'): 'transport', (-1, 'SMTPServerDisconnected'): 'transport',
        }
        for (code, msg), expected in cases.items():
            self.assertEqual(finder.classify_rcpt(code, msg), expected, (code, msg))

    def test_accepted_control_is_catchall(self):
        net = Network(Server(control=ACCEPTED, default=ACCEPTED))
        ver = verifier(net)
        first, second = ver.check('hello@company.test'), ver.check('info@company.test')
        self.assertEqual((first.smtp, second.smtp), ('catchall', 'catchall'))
        self.assertTrue(first.reason.startswith('control-accepted:'))
        self.assertEqual(first.checked_at, '2026-10-08T00:00:00+00:00')
        self.assertNotIn('hello@company.test', net.rcpts)

    def test_inconclusive_control_never_promotes_accepted_target(self):
        for control in [(450, b'4.7.1 greylisted, try later'), (550, b'Requested action not taken'), (501, b'syntax')]:
            net = Network(Server(control=control, targets={'hello@company.test': ACCEPTED}))
            verdict = verifier(net).check('hello@company.test')
            self.assertEqual(verdict.smtp, 'unknown', control)
            self.assertTrue(verdict.reason.startswith('control-inconclusive:'), verdict.reason)

    def test_conclusive_control_allows_valid_and_explicit_rejection_is_invalid(self):
        net = Network(Server(targets={'hello@company.test': ACCEPTED}))
        ver = verifier(net)
        valid, invalid = ver.check('hello@company.test'), ver.check('nobody@company.test')
        self.assertEqual(valid.smtp, 'valid')
        self.assertTrue(valid.reason.startswith('control-rejected+target-accepted:'))
        self.assertEqual(invalid.smtp, 'invalid')
        self.assertTrue(invalid.reason.startswith('target-nonexistent:'))
        self.assertEqual(len(net.clients), 1)  # one session, one control probe
        self.assertTrue(net.rcpts[0].startswith('ctl'))

    def test_policy_and_ambiguous_target_rejections_are_unknown(self):
        net = Network(Server(targets={'a@company.test': (550, b'5.7.1 blocked by policy'),
                                      'b@company.test': (550, b'mailbox unavailable')}))
        ver = verifier(net)
        self.assertEqual(ver.check('a@company.test').reason.split(':')[0], 'target-policy')
        self.assertEqual(ver.check('b@company.test').reason.split(':')[0], 'target-ambiguous')

    def test_policy_refusal_of_probe_identity_stops_probing(self):
        net = Network(Server(mail=554))
        ver = verifier(net)
        verdicts = [ver.check(f'{n}@company.test') for n in ('a', 'b', 'c')]
        self.assertEqual({v.smtp for v in verdicts}, {'unknown'})
        self.assertTrue(all(v.reason.startswith('mail-from-rejected:') for v in verdicts))
        self.assertEqual(len(net.clients), 1)
        self.assertTrue(net.clients[0].closed)
        net = Network(Server(control=(554, b'5.7.1 client blocked')))
        ver = verifier(net)
        self.assertTrue(ver.check('a@company.test').reason.startswith('policy-blocked:'))
        self.assertEqual(ver.check('b@company.test').smtp, 'unknown')
        self.assertEqual(len(net.clients), 1)

    def test_reconnect_re_runs_control_and_cannot_reuse_old_result(self):
        disconnect = smtplib.SMTPServerDisconnected('connection dropped')
        # Session 1 proves the control, then drops on the target. Session 2's
        # control is only greylisted, so the accepted target must stay unknown.
        net = Network(Server(targets={'hello@company.test': disconnect}),
                      Server(control=(451, b'4.7.1 try again later'), targets={'hello@company.test': ACCEPTED}))
        ver = verifier(net)
        verdict = ver.check('hello@company.test')
        self.assertEqual(verdict.smtp, 'unknown')
        self.assertTrue(verdict.reason.startswith('control-inconclusive:'), verdict.reason)
        self.assertEqual(len(net.clients), 2)
        second_session = net.clients[1].log
        self.assertTrue(second_session[0].startswith('ctl'), second_session)
        self.assertEqual(second_session[1], 'hello@company.test')
        self.assertTrue(net.clients[0].closed)

    def test_reconnect_with_failed_control_is_not_valid(self):
        disconnect = smtplib.SMTPServerDisconnected('connection dropped')
        net = Network(Server(targets={'hello@company.test': disconnect}),
                      Server(control=disconnect, targets={'hello@company.test': ACCEPTED}),
                      Server(control=disconnect, targets={'hello@company.test': ACCEPTED}))
        ver = verifier(net)
        verdict = ver.check('hello@company.test')
        self.assertEqual(verdict.smtp, 'unknown')
        self.assertNotIn(verdict.smtp, ('valid',))
        self.assertTrue(all(c.closed for c in net.clients))

    def test_reconnect_with_proven_control_can_still_verify(self):
        disconnect = smtplib.SMTPServerDisconnected('connection dropped')
        net = Network(Server(targets={'hello@company.test': disconnect}), Server(targets={'hello@company.test': ACCEPTED}))
        verdict = verifier(net).check('hello@company.test')
        self.assertEqual(verdict.smtp, 'valid')
        self.assertTrue(net.clients[1].log[0].startswith('ctl'))

    def test_unreachable_domain_is_bounded_by_breaker_and_budget(self):
        clock = Clock()
        net = Network(Server(connect_error=TimeoutError('timed out')), clock=clock)
        ver = verifier(net, budget=45.0, timeout=10.0, max_connects=4, max_transport_failures=3)
        start = clock.t
        verdicts = [ver.check(f'user{n}@company.test') for n in range(12)]
        self.assertEqual({v.smtp for v in verdicts}, {'unknown'})
        self.assertLessEqual(len(net.clients), 3)
        self.assertLessEqual(clock.t - start, 45.0)
        self.assertTrue(verdicts[0].reason.startswith('connect-failed:'))
        self.assertTrue(verdicts[-1].reason.startswith('circuit-open:'), verdicts[-1].reason)
        self.assertTrue(all(c.closed for c in net.clients))
        # A slow host without a tripped breaker is still capped by the total budget.
        clock = Clock()
        net = Network(Server(connect_error=TimeoutError('timed out'), connect_cost=20.0), clock=clock)
        ver = verifier(net, budget=45.0, timeout=20.0, max_connects=100, max_transport_failures=100)
        verdicts = [ver.check(f'user{n}@company.test') for n in range(12)]
        self.assertLessEqual(len(net.clients), 3)
        self.assertLessEqual(clock.t - 1000.0, 45.0)
        self.assertTrue(verdicts[-1].reason.startswith('budget-exhausted:'), verdicts[-1].reason)

    def test_sessions_close_on_success_and_setup_failures(self):
        net = Network(Server(targets={'hello@company.test': ACCEPTED}))
        ver = verifier(net)
        ver.check('hello@company.test')
        ver.close()
        self.assertTrue(net.clients[0].quit_called and net.clients[0].closed)
        for failing in (Server(ehlo_error=smtplib.SMTPHeloError(501, b'bad helo')), Server(banner=554),
                        Server(mail=451), Server(connect_error=ConnectionRefusedError('refused'))):
            net = Network(failing)
            ver = verifier(net, mx=('mx1.company.test',))
            self.assertEqual(ver.check('hello@company.test').smtp, 'unknown')
            ver.close()
            self.assertTrue(net.clients and all(c.closed for c in net.clients))

    def test_mx_failures_keep_diagnostic_reason(self):
        net = Network(Server())
        for result, token in [(finder.MXResult((), 'error', 'DNS lookup timed out after 15s'), 'mx-error'),
                              (finder.MXResult((), 'none', 'no MX records'), 'mx-none')]:
            ver = finder.DomainVerifier('company.test', IDENTITY, mx=result, smtp_factory=net.factory)
            verdict = ver.check('hello@company.test')
            self.assertEqual(verdict.smtp, 'unknown')
            self.assertTrue(verdict.reason.startswith(token + ':'))
            self.assertIn(result.reason, verdict.reason)
        self.assertFalse(net.clients)

    def test_dig_output_parsing_separates_none_from_failure(self):
        ok = (';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1\n;; ANSWER SECTION:\n'
              'company.test.\t300\tIN\tMX\t20 mx2.company.test.\ncompany.test.\t300\tIN\tMX\t10 mx1.company.test.\n')
        self.assertEqual(finder.parse_dig(ok), finder.MXResult(('mx1.company.test', 'mx2.company.test'), 'ok', '2 MX host(s)'))
        self.assertEqual(finder.parse_dig(';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1\n').status, 'none')
        self.assertEqual(finder.parse_dig(';; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 1\n').status, 'none')
        self.assertEqual(finder.parse_dig(';; ->>HEADER<<- opcode: QUERY, status: NOERROR\ncompany.test. 1 IN MX 0 .\n').reason,
                         'null MX: domain accepts no mail')
        self.assertEqual(finder.parse_dig(';; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 1\n').status, 'error')

        def runner(result=None, error=None):
            def run(*args, **kwargs):
                if error:
                    raise error
                return result
            return run
        failed = subprocess.CompletedProcess([], 9, ';; connection timed out; no servers could be reached\n', '')
        self.assertEqual(finder.mx_lookup('company.test', run=runner(failed)).status, 'error')
        self.assertIn('no servers', finder.mx_lookup('company.test', run=runner(failed)).reason)
        self.assertEqual(finder.mx_lookup('company.test', run=runner(error=FileNotFoundError())).reason, 'dig is not installed')
        timeout = subprocess.TimeoutExpired(['dig'], 15)
        self.assertEqual(finder.mx_lookup('company.test', run=runner(error=timeout)).status, 'error')

    def test_probe_identity_is_required_and_validated(self):
        with self.assertRaises(finder.ConfigError) as caught:
            finder.probe_identity({})
        self.assertIn('INCOME_SMTP_MAIL_FROM', str(caught.exception))
        self.assertIn('INCOME_SMTP_HELO', str(caught.exception))
        with self.assertRaises(finder.ConfigError) as caught:
            finder.probe_identity({'INCOME_SMTP_MAIL_FROM': 'probe@sender.test', 'INCOME_SMTP_HELO': ' '})
        self.assertIn('INCOME_SMTP_HELO', str(caught.exception))
        self.assertNotIn('INCOME_SMTP_MAIL_FROM and', str(caught.exception))
        for bad in [{'INCOME_SMTP_MAIL_FROM': 'not-an-address', 'INCOME_SMTP_HELO': 'mail.sender.test'},
                    {'INCOME_SMTP_MAIL_FROM': 'probe@sender.test', 'INCOME_SMTP_HELO': 'bad host'}]:
            with self.assertRaises(finder.ConfigError):
                finder.probe_identity(bad)
        self.assertEqual(finder.probe_identity({'INCOME_SMTP_MAIL_FROM': 'probe@sender.test', 'INCOME_SMTP_HELO': 'mail.sender.test'}),
                         IDENTITY)
        with self.assertRaises(finder.ConfigError):
            finder.DomainVerifier('company.test', None, mx=finder.MXResult((), 'none', 'x'))
        self.assertNotIn('gmail', Path(finder.__file__).read_text().lower())


class FinderCommandTests(unittest.TestCase):
    def write_prospects(self, base):
        prospects = base / 'prospects.json'
        prospects.write_text(json.dumps({'prospects': [{'company': 'Company', 'domain': 'company.test', 'founder': None}]}))
        return prospects

    def test_missing_identity_fails_before_any_network_use(self):
        def forbidden(*args, **kwargs):
            raise AssertionError('network used before identity check')
        with tempfile.TemporaryDirectory() as temp:
            prospects = self.write_prospects(Path(temp))
            with patch.object(finder, 'scrape_site', forbidden), patch.object(finder, 'mx_lookup', forbidden), \
                    patch.object(finder, 'fetch', forbidden):
                with self.assertRaises(finder.ConfigError) as caught:
                    finder.main(['--prospects', str(prospects), '--out', str(Path(temp) / 'out.csv')], env={},
                                verifier_factory=forbidden, sleep=forbidden)
            self.assertIn('INCOME_SMTP_MAIL_FROM', str(caught.exception))
            self.assertFalse((Path(temp) / 'out.csv').exists())

    def test_command_writes_compatible_smtp_column_with_diagnostics(self):
        env = {'INCOME_SMTP_MAIL_FROM': 'probe@sender.test', 'INCOME_SMTP_HELO': 'mail.sender.test'}
        net = Network(Server(control=ACCEPTED, default=ACCEPTED))
        with tempfile.TemporaryDirectory() as temp:
            prospects, out = self.write_prospects(Path(temp)), Path(temp) / 'out.csv'
            scraped = ({'sales@company.test': 'https://company.test/contact'}, {'partner@external.test': 'https://company.test/contact'})
            with patch.object(finder, 'scrape_site', return_value=scraped), patch('builtins.print'):
                finder.main(['--prospects', str(prospects), '--out', str(out)], env=env,
                            verifier_factory=lambda d: verifier(net), sleep=lambda s: None)
            rows = list(csv.DictReader(io.StringIO(out.read_text())))
        self.assertEqual(list(rows[0])[:7], ['company', 'domain', 'email', 'source', 'source_url', 'smtp', 'founder'])
        for column in ('smtp_reason', 'checked_at', 'mx_status'):
            self.assertIn(column, rows[0])
        own = [r for r in rows if r['source'] != 'scraped-offsite']
        self.assertEqual({r['smtp'] for r in own}, {'catchall'})
        self.assertTrue(all(r['smtp_reason'].startswith('control-accepted:') and r['checked_at'] for r in own))
        self.assertEqual(own[0]['source_url'], 'https://company.test/contact')
        offsite = [r for r in rows if r['source'] == 'scraped-offsite']
        self.assertEqual([(r['email'], r['smtp']) for r in offsite], [('partner@external.test', '')])

    def test_outreach_verify_stage_reports_missing_identity(self):
        signal = {'company': 'Example Studio', 'title': 'Lead Generation Specialist', 'url': 'https://jobs.example.test/1',
                  'website': 'https://example.com/', 'score': 13, 'offer': 'B'}
        with tempfile.TemporaryDirectory() as temp:
            signals = Path(temp) / 'signals.json'
            signals.write_text(json.dumps([signal]))
            # Empty values also stop any local .env from supplying an identity.
            env = {**os.environ, 'INCOME_SMTP_MAIL_FROM': '', 'INCOME_SMTP_HELO': '', 'INCOME_DATA_DIR': temp}
            command = [sys.executable, str(ROOT / 'buyer-signals/workflow.py')]
            result = subprocess.run(command + ['prepare', '--signals', str(signals), '--run', str(Path(temp) / 'run')],
                                    cwd=temp, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run(command + ['verify', '--run', str(Path(temp) / 'run')], cwd=temp, env=env,
                                    capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('INCOME_SMTP_MAIL_FROM and INCOME_SMTP_HELO', result.stderr)
            self.assertFalse((Path(temp) / 'run/emails.csv').exists())


if __name__ == '__main__':
    unittest.main()
