"""Source models for the synthetic fixture. No sockets, OpenSSL or privilege."""
from __future__ import annotations

import pathlib
import unittest
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock, Mock, call, patch

path = pathlib.Path(__file__).with_name('native-workload-browser-capability-fixture.py')
F = ModuleType('native_browser_capability_fixture_model')
F.__file__ = str(path)
exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), F.__dict__)
NONCE = b'0' * 32


class FixtureModels(unittest.TestCase):
    def test_fixed_navigation_and_private_probe_are_distinct(self):
        request = F._REQUEST + b'User-Agent: Fictional Chrome\r\n\r\n'
        self.assertEqual(F._request_kind(request, NONCE), 'browser')
        self.assertEqual(F._request_kind(F._REQUEST + b'x-aihr-fixture-probe: ' + NONCE + b'\r\n\r\n', NONCE), 'probe')
        with self.assertRaisesRegex(F.FixtureRefusal, '^fixture-probe-identity$'):
            F._request_kind(F._REQUEST + b'x-aihr-fixture-probe: fictional-private\r\n\r\n', NONCE)

    def test_other_paths_authority_credentials_and_payload_refuse(self):
        request = F._REQUEST + b'\r\n'
        inputs = [
            request.replace(b'/__aihr_browser_capability_v1', b'/foreign'),
            request.replace(b'GET ', b'POST '),
            request.replace(b'127.0.0.1:3443', b'localhost:3443'),
            request + b'fictional-payload\r\n\r\n',
            request.rstrip(b'\n'),
            F._REQUEST + b'X-Fill: ' + b'a' * F._HEADER_BYTES + b'\r\n\r\n',
        ]
        for header in (b'host: 127.0.0.1:3443', b'Authorization: Fictional', b'Cookie: Fictional',
                       b'Content-Length: 0', b'Transfer-Encoding: chunked', b'Upgrade: websocket'):
            inputs.append(F._REQUEST + header + b'\r\n\r\n')
        for number, data in enumerate(inputs):
            with self.subTest(number=number), self.assertRaisesRegex(F.FixtureRefusal, '^fixture-http-'):
                F._request_kind(data, NONCE)

    def test_browser_admission_requires_the_single_validated_independent_probe(self):
        fixture = F.CapabilityFixture(None, F.time.monotonic())
        with patch.object(fixture, 'require_ready') as ready:
            with self.assertRaisesRegex(F.FixtureRefusal, 'fixture-browser-admission'):
                fixture.allow_browser_request()
            fixture._served = 1
            with self.assertRaisesRegex(F.FixtureRefusal, 'fixture-browser-admission'):
                fixture.allow_browser_request()
            fixture._verified_probe = True
            with self.assertRaisesRegex(F.FixtureRefusal, 'fixture-browser-admission'):
                fixture.allow_browser_request()
            fixture._tcp_probe_confirmed = True
            fixture.allow_browser_request()
            with self.assertRaisesRegex(F.FixtureRefusal, 'fixture-browser-admission'):
                fixture.allow_browser_request()
            self.assertEqual(ready.call_count, 5)

    def test_only_one_armed_bare_tcp_eof_settles_inside_same_counter_clock(self):
        class Clock:
            def __init__(self):
                self.start = F.time.monotonic()
                self.remaining = Mock(return_value=42)

        for mode in ('empty', 'unarmed', 'data', 'repeat'):
            with self.subTest(mode=mode):
                clock = Clock()
                fixture = F.CapabilityFixture(SimpleNamespace(Deadline=Clock), F.time.monotonic())
                fixture._served = 1
                fixture._verified_probe = True
                fixture._tls = Mock()
                ingress, tripwire, peer = Mock(), Mock(), MagicMock()
                fixture._listeners = {F.INGRESS:(ingress, 11), F.TRIPWIRE:(tripwire, 12)}
                ingress.accept.return_value = (peer, (F.LOOPBACK, 32123))
                peer.recv.return_value = b'X' if mode == 'data' else b''

                def close_peer(*_):
                    self.assertEqual(fixture._tcp_probe_observed, mode == 'repeat')
                    fixture._stop.set()

                peer.__exit__.side_effect = close_peer
                events = [([ingress], [], []), ([peer], [], [])]
                with patch.object(fixture, 'require_ready'), patch.object(fixture, '_serve_tls', wraps=fixture._serve_tls) as tls, \
                     patch.object(F.select, 'select', side_effect=events):
                    if mode != 'unarmed':
                        fixture.allow_browser_tcp_probe(clock)
                    if mode == 'repeat':
                        fixture._tcp_probe_observed = True
                    fixture._serve()
                    self.assertEqual(fixture._served, 1)
                    fixture._tls.wrap_socket.assert_not_called()
                    if mode == 'empty':
                        self.assertFalse(fixture._failed)
                        self.assertTrue(fixture._tcp_probe_observed)
                        with self.assertRaisesRegex(F.FixtureRefusal, 'fixture-tcp-probe-order'):
                            fixture.require_browser_tcp_probe(Clock())
                        fixture.require_browser_tcp_probe(clock)
                        with self.assertRaisesRegex(F.FixtureRefusal, 'fixture-tcp-probe-order'):
                            fixture.require_browser_tcp_probe(clock)
                        self.assertEqual(clock.remaining.call_args_list, [call(42), call(42)])
                    else:
                        self.assertTrue(fixture._failed)
                    if mode in ('unarmed', 'repeat'):
                        peer.recv.assert_not_called()
                    else:
                        peer.recv.assert_called_once_with(1)
                    if mode == 'repeat':
                        tls.assert_called_once()
                    else:
                        tls.assert_not_called()

    def test_queued_split_tls_record_and_premature_eof_refuse_before_response(self):
        for ready, result, allowed in (
            ([], F.ssl.SSLWantReadError(), True),
            ([True], F.ssl.SSLWantReadError(), False),
            ([True], b'X', False),
            ([], b'X', False),
            ([True], b'', False),
        ):
            with self.subTest(ready=bool(ready), result=type(result).__name__):
                tls = Mock()
                tls.pending.return_value = 0
                tls.recv.side_effect = [result]
                deadline = F.time.monotonic() + 3
                with patch.object(F.select, 'select', return_value=(ready, [], [])):
                    if allowed:
                        F._require_no_queued_request_data(tls, deadline)
                    else:
                        with self.assertRaisesRegex(F.FixtureRefusal, 'fixture-http-framing'):
                            F._require_no_queued_request_data(tls, deadline)
                tls.recv.assert_called_once_with(1)

    def test_controlled_tls_shutdown_keeps_want_read_and_ragged_eof_distinct(self):
        tls, transport = Mock(), MagicMock()
        deadline = F.time.monotonic() + 3
        tls.unwrap.side_effect = [F.ssl.SSLWantReadError(), transport, F.ssl.SSLEOFError()]
        with patch.object(F.select, 'select', return_value=([tls], [], [])) as select:
            F._finish_probe_tls(tls, deadline)
            with self.assertRaises(F.ssl.SSLEOFError):
                F._finish_probe_tls(tls, deadline)
        select.assert_called_once()
        transport.__enter__.assert_called_once_with()
        transport.__exit__.assert_called_once_with(None, None, None)

    def test_crypto_retains_leader_until_group_signal_and_observed_group_absence(self):
        native = Mock()
        native.children.return_value = b''
        fixture = F.CapabilityFixture(SimpleNamespace(_bounded_file=native.children), F.time.monotonic())
        child = fixture._crypto_child = Mock(pid=41, returncode=None, wait=native.wait)
        native.getpgid.return_value = native.getsid.return_value = 41
        native.killpg.side_effect = [None, ProcessLookupError()]
        native.wait.return_value = 0
        with patch.object(F.os, 'getpgid', native.getpgid, create=True), \
             patch.object(F.os, 'getsid', native.getsid, create=True), \
             patch.object(F.os, 'killpg', native.killpg, create=True):
            self.assertEqual(fixture._settle_crypto(F.time.monotonic() + 3), 0)
        self.assertEqual([row[0] for row in native.mock_calls], ['getpgid','getsid','killpg','wait','killpg','children'])
        self.assertEqual(native.killpg.call_args_list, [call(41, F.signal.SIGKILL), call(41, 0)])
        self.assertGreater(child.wait.call_args.kwargs['timeout'], 0)
        self.assertLessEqual(child.wait.call_args.kwargs['timeout'], 1)
        self.assertFalse(fixture._crypto_unsettled())

    def test_crypto_unknown_settlement_refuses_fixture_release_and_keeps_private_writers(self):
        fixture = F.CapabilityFixture(None, F.time.monotonic())
        fixture._started = True
        child = fixture._crypto_child = Mock(pid=41, returncode=None)
        child.wait.side_effect = F.subprocess.TimeoutExpired('fixed', 1)
        with patch.object(F.os, 'getpgid', return_value=41, create=True), \
             patch.object(F.os, 'getsid', return_value=41, create=True), \
             patch.object(F.os, 'killpg', create=True) as killpg, \
             self.assertRaisesRegex(F.FixtureRefusal, 'fixture-crypto-settlement'):
            fixture._settle_crypto(F.time.monotonic() + 3)
        killpg.assert_called_once_with(41, F.signal.SIGKILL)
        files = fixture._crypto_files = Mock()
        with patch.object(fixture, '_absent') as absent, \
             self.assertRaisesRegex(F.FixtureRefusal, 'fixture-crypto-settlement'):
            fixture.close()
        self.assertIs(fixture._crypto_child, child)
        self.assertIs(fixture._crypto_files, files)
        absent.assert_not_called()
        files.close.assert_not_called()

    def test_failed_crypto_launch_retains_exact_held_writers_without_releasing_fixture(self):
        fixture = F.CapabilityFixture(None, F.time.monotonic())
        fds = [41, 42, 43, 44]

        def refuse(*_):
            fixture._crypto_launch_uncertain = True
            raise F.FixtureRefusal('fixture-tls-material')

        with patch.object(F.os, 'memfd_create', side_effect=fds), patch.object(F.os, 'fchmod') as chmod, \
             patch.object(F.os, 'close') as close, patch.object(fixture, '_run_crypto', side_effect=refuse):
            with self.assertRaisesRegex(F.FixtureRefusal, 'fixture-tls-material'):
                F._tls_context(fixture, F.time.monotonic() + 3)
            self.assertTrue(fixture._crypto_unsettled())
            self.assertEqual(chmod.call_args_list, [call(fd, 0o600) for fd in fds])
            close.assert_not_called()
            # Dispose only these mocked model handles, outside the modeled owner.
            fixture._crypto_files.close()
            self.assertEqual(close.call_args_list, [call(fd) for fd in reversed(fds)])

    def test_late_queued_traffic_keeps_failure_even_after_positive_listener_cleanup(self):
        fixture = F.CapabilityFixture(None, F.time.monotonic())
        fixture._started = True
        ingress, tripwire = (Mock(fileno=Mock(return_value=-1)) for _ in range(2))
        fixture._listeners = {F.INGRESS:(ingress, 11), F.TRIPWIRE:(tripwire, 12)}
        with patch.object(fixture, '_held') as held, patch.object(fixture, '_absent') as absent, \
             patch.object(F.select, 'select', side_effect=[([ingress], [], []), ([], [], [])]):
            self.assertEqual(fixture.close(), {'listenersAbsent':True, 'serverHealthy':False})
        self.assertEqual(held.call_count, 2)
        ingress.close.assert_called_once_with()
        tripwire.close.assert_called_once_with()
        absent.assert_called_once_with()

    def test_tripwire_accepts_no_protocol_and_fails_the_course(self):
        fixture = F.CapabilityFixture(None, F.time.monotonic())
        ingress, tripwire, peer = Mock(), Mock(), Mock()
        tripwire.accept.return_value = (peer, (F.LOOPBACK, 32123))
        fixture._listeners = {F.INGRESS:(ingress, 11), F.TRIPWIRE:(tripwire, 12)}
        with patch.object(F.select, 'select', return_value=([ingress, tripwire], [], [])):
            fixture._serve()
        self.assertTrue(fixture._failed)
        self.assertEqual(fixture._served, 0)
        peer.close.assert_called_once_with()
        peer.recv.assert_not_called()
        peer.send.assert_not_called()
        ingress.accept.assert_not_called()

    def test_unsettled_thread_does_not_authorize_closing_either_held_listener(self):
        fixture = F.CapabilityFixture(None, F.time.monotonic())
        fixture._started = True
        fixture._thread = SimpleNamespace(ident=17, join=Mock(), is_alive=Mock(return_value=True))
        ingress, tripwire = Mock(), Mock()
        fixture._listeners = {F.INGRESS:(ingress, 11), F.TRIPWIRE:(tripwire, 12)}
        with patch.object(fixture, '_absent') as absent, \
             self.assertRaisesRegex(F.FixtureRefusal, 'fixture-server-settlement'):
            fixture.close()
        self.assertTrue(fixture._stop.is_set())
        fixture._thread.join.assert_called_once_with(1)
        ingress.close.assert_not_called()
        tripwire.close.assert_not_called()
        absent.assert_not_called()


if __name__ == '__main__':
    unittest.main()
