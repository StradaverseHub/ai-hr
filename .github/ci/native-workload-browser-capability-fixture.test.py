"""Source models for the synthetic fixture. No sockets, OpenSSL or privilege."""
from __future__ import annotations

import pathlib
import unittest
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

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
            fixture.allow_browser_request()
            with self.assertRaisesRegex(F.FixtureRefusal, 'fixture-browser-admission'):
                fixture.allow_browser_request()
            self.assertEqual(ready.call_count, 4)

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
