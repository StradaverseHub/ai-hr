"""Source-owned models. No real file descriptors, native services, TLS or DB."""
import json
import pathlib
import unittest
from collections import deque
from types import ModuleType
from unittest.mock import Mock, patch


def load(name, basename):
    source = pathlib.Path(__file__).with_name(basename)
    module = ModuleType(name)
    module.__file__ = str(source)
    exec(compile(source.read_bytes(), str(source), 'exec', dont_inherit=True), module.__dict__)
    return module


I = load('issuer_model', 'native-workload-browser-issuer.py')
K = load('kernel_model', 'native-workload-browser-host.py')


def wire(op, **fields):
    return (json.dumps({'op': op, **fields}, separators=(',', ':')) + '\n').encode('ascii')


class PipeModel:
    def __init__(self, index, packets):
        self.read_birth, self.write_birth = (1, index), (1, index + 1)
        self.packets = deque(packets)
        self.sent = []
        self.input_closed = False
        self.closed = False

    def frame(self, clock, frontier):
        clock.remaining(frontier)
        return self.packets.popleft()

    def send(self, frame, clock, frontier):
        clock.remaining(frontier)
        self.sent.append(frame)

    def close_input(self):
        self.input_closed = True

    def require_eof(self, clock, frontier):
        clock.remaining(frontier)
        if not self.input_closed or self.packets:
            raise I._Refused('model-eof-unproved')

    def close(self):
        self.closed = True

    def bind(self):
        pipe = I._RolePipes.__new__(I._RolePipes)
        pipe.read_birth, pipe.write_birth = self.read_birth, self.write_birth
        pipe.frame, pipe.send = self.frame, self.send
        pipe.close_input, pipe.require_eof, pipe.close = self.close_input, self.require_eof, self.close
        return pipe


class TranscriptModel(unittest.TestCase):
    def setUp(self):
        self.clock = K.Deadline()
        self.firewall = K.Firewall('123', '0123456789abcdef')
        self.firewall.attempted, self.firewall.handles = True, (('table', 1),)
        self.roles = {
            'driver': PipeModel(1, [wire('observer-ready', pid=77, tag='aihrbc_0123456789abcdef'),
                                   wire('websocket-ready'), wire('ingress-complete', status=200),
                                   wire('driver-closed')]),
            'browser': PipeModel(3, [wire('listener-ready', pid=78), wire('probe-ready', pid=79),
                                    wire('negatives-complete', checks=K.PROBE_CHECKS), wire('browser-closed')]),
            'third': PipeModel(5, [wire('probe-ready', pid=80), wire('control-denied')]),
        }
        self.pipes = {role: model.bind() for role, model in self.roles.items()}
        self.transcript = I._Transcript(K, self.clock, self.firewall, self.pipes['driver'], self.pipes['browser'])
        self.driver = I._HeldDriver.__new__(I._HeldDriver)

    def counters(self):
        base = {label: 0 for rows in K.firewall_rules().values() for label, *_ in rows}
        out = []
        for _, increments in I._WINDOWS:
            out.append(base)
            base = {key: val + (key in increments) for key, val in base.items()}
            out.append(base)
        return out

    def exchange(self, count=17):
        with patch.object(self.driver, 'current_pid', return_value=61), \
             patch.object(self.firewall, 'observe', side_effect=self.counters()) as observer:
            for role, direction, operation in K.FRAME_ORDER[:count]:
                if role == 'third' and operation == 'probe-ready':
                    self.transcript.attach_third(self.pipes['third'])
                if operation == 'connect':
                    self.transcript.finish_third_transport()
                if direction == 'root':
                    options = {'held_driver': self.driver} if operation == 'deny-prepare' else {}
                    self.transcript.send(role, operation, **options)
                else:
                    self.transcript.receive(role, operation)
        return observer

    def test_exact_frames_use_distinct_role_pipes_and_bound_the_counter_windows(self):
        observer = self.exchange()
        self.assertEqual([call.args[1] for call in observer.call_args_list], [42, 42, 42, 42, 56, 56, 56, 56])
        self.assertEqual(self.roles['driver'].sent, [wire('connect'), wire('request'), wire('stop')])
        self.assertEqual(self.roles['browser'].sent, [wire('deny-prepare', pid=61), wire('deny-go'), wire('stop')])
        self.assertEqual(self.roles['third'].sent, [wire('probe')])
        self.transcript.finish_frames()
        self.assertTrue(self.transcript.frames_finished)
        self.assertTrue(all(pipe.input_closed for pipe in self.roles.values()))
        with self.assertRaisesRegex(I._Refused, 'transcript-incomplete'):
            self.transcript.finish_frames()
        self.transcript.close_pipes()
        self.assertTrue(all(pipe.closed for pipe in self.roles.values()))
        self.assertFalse(self.firewall.removal_attempted)

    def test_initial_unowned_fence_and_aliased_role_channels_refuse(self):
        with self.assertRaisesRegex(I._Refused, 'pipes-alias'):
            I._Transcript(K, self.clock, self.firewall, self.pipes['driver'], self.pipes['driver'])
        self.firewall.handles = None
        with self.assertRaisesRegex(I._Refused, 'fence-required'):
            I._Transcript(K, self.clock, self.firewall, self.pipes['driver'], self.pipes['browser'])

    def test_out_of_order_root_and_child_frames_poison_without_writes(self):
        with self.assertRaisesRegex(I._Refused, 'out-of-order'):
            self.transcript.send('browser', 'deny-go')
        with self.assertRaisesRegex(I._Refused, 'closed-capability-transcript'):
            self.transcript.receive('driver', 'observer-ready')
        self.assertTrue(all(not pipe.sent for pipe in self.roles.values()))

    def test_an_unexpected_packet_cannot_be_replaced_by_a_correct_one(self):
        self.roles['driver'].packets.appendleft(wire('observer-ready', pid=77, tag='unexpected'))
        with self.assertRaisesRegex(K.Refused, 'invalid-observer-tag'):
            self.transcript.receive('driver', 'observer-ready')
        with self.assertRaisesRegex(I._Refused, 'closed-capability-transcript'):
            self.transcript.receive('driver', 'observer-ready')

    def test_wrong_counter_window_poison_preserves_fence(self):
        self.exchange(4)
        before, after = self.counters()[:2]
        after = {**after, 'driver-postgres': 1}
        with patch.object(self.firewall, 'observe', side_effect=[before, after]):
            self.transcript.send('browser', 'deny-go')
            with self.assertRaisesRegex(K.Refused, 'counter-window-differs'):
                self.transcript.receive('browser', 'negatives-complete')
        self.assertTrue(self.transcript.poisoned)
        self.assertFalse(self.firewall.removal_attempted)

    def test_timeout_rejects_before_consuming_first_frame(self):
        with patch.object(K.time, 'monotonic', return_value=self.clock.start + 32):
            with self.assertRaisesRegex(K.Refused, 'capability-deadline'):
                self.transcript.receive('driver', 'observer-ready')
        self.assertEqual(len(self.roles['driver'].packets), 4)

    def test_missing_eof_preserves_primary_and_closes_other_pipes(self):
        self.exchange()
        self.roles['browser'].packets.append(wire('browser-closed'))
        with self.assertRaisesRegex(I._Refused, 'model-eof-unproved') as failure:
            self.transcript.finish_frames()
        self.assertFalse(self.transcript.frames_finished)
        self.pipes['driver'].close = Mock(side_effect=OSError('simulated close failure'))
        with self.assertRaises(I._Refused) as settled:
            self.transcript.close_pipes(failure.exception)
        self.assertIs(settled.exception, failure.exception)
        self.assertEqual(settled.exception.__notes__, ['held-role-pipe-settlement-unproved'])
        self.assertTrue(self.roles['browser'].closed and self.roles['third'].closed)
        self.assertFalse(self.firewall.removal_attempted)

    def test_driver_connection_cannot_start_before_third_transport_eof(self):
        self.exchange(9)
        with self.assertRaisesRegex(I._Refused, 'held-third-transport-unproved'):
            self.transcript.send('driver', 'connect')
        self.assertEqual(self.roles['driver'].sent, [])

    def test_actual_role_pipe_refuses_child_output_observed_before_root_turn(self):
        listener = wire('listener-ready', pid=78)
        for case in ('coalesced', 'queued', 'quiet'):
            with self.subTest(case=case):
                first = listener + wire('probe-ready', pid=79) if case == 'coalesced' else listener

                def ready(readers, writers, _errors, _timeout):
                    self.assertEqual(readers, [5])
                    if not writers:
                        return [5], [], []
                    self.assertEqual(writers, [6])
                    return ([5] if case == 'queued' else []), [6], []

                with patch.object(I, '_pipe_birth', side_effect=lambda fd: (2, fd)), \
                     patch.object(I.os, 'fpathconf', return_value=512), \
                     patch.object(I.select, 'select', side_effect=ready) as selected, \
                     patch.object(I.os, 'read', return_value=first) as read, \
                     patch.object(I.os, 'write', side_effect=lambda _, data: len(data)) as write, \
                     patch.object(self.driver, 'current_pid', return_value=61):
                    pipe = I._RolePipes(5, 6, 512)
                    driver = PipeModel(1, [wire('observer-ready', pid=77, tag='aihrbc_0123456789abcdef')])
                    transcript = I._Transcript(K, self.clock, self.firewall, driver.bind(), pipe)
                    transcript.receive('driver', 'observer-ready')
                    self.assertEqual(transcript.receive('browser', 'listener-ready')['pid'], 78)
                    if case == 'quiet':
                        transcript.send('browser', 'deny-prepare', held_driver=self.driver)
                        write.assert_called_once_with(6, wire('deny-prepare', pid=61))
                    else:
                        with self.assertRaisesRegex(I._Refused, 'held-role-output-before-command'):
                            transcript.send('browser', 'deny-prepare', held_driver=self.driver)
                        with self.assertRaisesRegex(I._Refused, 'closed-capability-transcript'):
                            transcript.receive('browser', 'probe-ready')
                        write.assert_not_called()
                    read.assert_called_once_with(5, 513)
                    self.assertEqual(selected.call_count, 1 if case == 'coalesced' else 2)

    def test_partial_transcript_is_terminal_before_any_descriptor_close(self):
        for case in ('clean', 'close-error', 'foreign-input'):
            with self.subTest(case=case):
                browser = PipeModel(13, [])
                primary = RuntimeError('independent primary failure')

                def close(fd):
                    self.assertTrue(transcript.pipes_closed)
                    if fd == 6 and case == 'close-error':
                        raise OSError('simulated descriptor close failure')

                with patch.object(I, '_pipe_birth', side_effect=lambda fd: (2, fd)) as birth, \
                     patch.object(I.os, 'fpathconf', return_value=512), \
                     patch.object(I.os, 'close', side_effect=close) as closed:
                    driver = I._RolePipes(5, 6, 512)
                    transcript = I._Transcript(K, self.clock, self.firewall, driver, browser.bind())
                    driver.pending.extend(wire('observer-ready', pid=77, tag='aihrbc_0123456789abcdef'))
                    if case == 'foreign-input':
                        birth.side_effect = lambda fd: (3 if fd == 6 else 2, fd)
                    if case == 'clean':
                        transcript.close_pipes()
                    else:
                        with self.assertRaises(RuntimeError) as caught:
                            transcript.close_pipes(primary)
                        self.assertIs(caught.exception, primary)
                        self.assertEqual(primary.__notes__, ['held-role-pipe-settlement-unproved'])
                    self.assertTrue(browser.closed)
                    with self.assertRaisesRegex(I._Refused, 'closed-capability-transcript'):
                        transcript.receive('driver', 'observer-ready')
                    with self.assertRaisesRegex(I._Refused, 'held-role-output-changed'):
                        driver.frame(self.clock, 32)
                    with self.assertRaisesRegex(I._Refused, 'settlement-already-attempted'):
                        transcript.close_pipes()
                    self.assertEqual([call.args[0] for call in closed.call_args_list],
                                     [5] if case == 'foreign-input' else [6, 5])


class SyntheticTranscriptModel(unittest.TestCase):
    def fixture(self):
        model = TranscriptModel('test_exact_frames_use_distinct_role_pipes_and_bound_the_counter_windows')
        model.setUp()
        model.roles['driver'].packets[0] = wire('driver-ready')
        transcript = I._SyntheticTranscript(K, model.clock, model.firewall, model.pipes['driver'], model.pipes['browser'])
        return model, transcript

    def test_synthetic_readiness_runs_the_exact_remaining_role_and_counter_sequence(self):
        model, transcript = self.fixture()
        self.assertEqual(transcript.receive('driver', 'driver-ready'), {'op': 'driver-ready'})
        self.assertEqual(transcript.frames.position, 1)
        with patch.object(model.driver, 'current_pid', return_value=61), \
             patch.object(model.firewall, 'observe', side_effect=model.counters()) as observer:
            for role, direction, operation in K.FRAME_ORDER[1:]:
                if role == 'third' and operation == 'probe-ready':
                    transcript.attach_third(model.pipes['third'])
                if operation == 'connect':
                    transcript.finish_third_transport()
                if direction == 'root':
                    options = {'held_driver': model.driver} if operation == 'deny-prepare' else {}
                    transcript.send(role, operation, **options)
                else:
                    transcript.receive(role, operation)
        self.assertEqual([call.args[1] for call in observer.call_args_list], [42, 42, 42, 42, 56, 56, 56, 56])
        self.assertEqual(model.roles['driver'].sent, [wire('connect'), wire('request'), wire('stop')])
        self.assertEqual(model.roles['browser'].sent, [wire('deny-prepare', pid=61), wire('deny-go'), wire('stop')])
        self.assertEqual(model.roles['third'].sent, [wire('probe')])
        transcript.finish_frames()
        self.assertTrue(transcript.frames_finished)
        self.assertTrue(all(pipe.input_closed for pipe in model.roles.values()))
        transcript.close_pipes()
        self.assertTrue(all(pipe.closed for pipe in model.roles.values()))
        self.assertFalse(model.firewall.removal_attempted)

    def test_synthetic_readiness_refuses_observer_data_or_extra_fields_permanently(self):
        for packet in (wire('observer-ready', pid=77, tag='aihrbc_0123456789abcdef'),
                       wire('driver-ready', pid=77), wire('driver-ready', tag='aihrbc_0123456789abcdef'),
                       wire('driver-ready', extra=True), wire('driver-ready')[:-1]):
            with self.subTest(packet=packet):
                model, transcript = self.fixture()
                model.roles['driver'].packets.appendleft(packet)
                with self.assertRaisesRegex(K.Refused, 'invalid-capability-frame'):
                    transcript.receive('driver', 'driver-ready')
                self.assertEqual(transcript.frames.position, 0)
                with self.assertRaisesRegex(I._Refused, 'closed-capability-transcript'):
                    transcript.receive('driver', 'driver-ready')
                self.assertTrue(all(not pipe.sent for pipe in model.roles.values()))
                self.assertFalse(model.firewall.removal_attempted)

    def test_observer_transcript_does_not_accept_synthetic_readiness(self):
        model, _ = self.fixture()
        with self.assertRaisesRegex(K.Refused, 'invalid-capability-frame'):
            model.transcript.receive('driver', 'observer-ready')
        self.assertEqual(model.transcript.frames.position, 0)
        self.assertTrue(model.transcript.poisoned)

    def test_wrong_role_or_repeated_synthetic_readiness_poison_the_transcript(self):
        for repeated in (False, True):
            with self.subTest(repeated=repeated):
                model, transcript = self.fixture()
                if repeated:
                    transcript.receive('driver', 'driver-ready')
                with self.assertRaisesRegex(I._Refused, 'capability-frame-out-of-order'):
                    transcript.receive('driver' if repeated else 'browser', 'driver-ready')
                with self.assertRaisesRegex(I._Refused, 'closed-capability-transcript'):
                    transcript.receive('browser', 'listener-ready')
                self.assertTrue(all(not pipe.sent for pipe in model.roles.values()))

    def test_synthetic_readiness_does_not_extend_the_first_deadline(self):
        model, transcript = self.fixture()
        with patch.object(K.time, 'monotonic', return_value=model.clock.start + 32):
            with self.assertRaisesRegex(K.Refused, 'capability-deadline'):
                transcript.receive('driver', 'driver-ready')
        self.assertEqual(model.roles['driver'].packets[0], wire('driver-ready'))
        self.assertTrue(transcript.poisoned)

    def test_synthetic_decoy_has_one_canonical_run_scope_and_no_observer_authority(self):
        decoy = I._synthetic_decoy('123')
        self.assertEqual(decoy, b'aihr-browser-isolation-v1:123\n')
        self.assertNotEqual(decoy, I._synthetic_decoy('124'))
        with self.assertRaisesRegex(I._Refused, 'fixed-observer-credential-differs'):
            I._observer_credential(decoy)
        for value in (123, '0123', '0', '123\n', '１２３', '1' * 21, '', '12/path'):
            with self.subTest(value=value), self.assertRaisesRegex(I._Refused, 'fixed-synthetic-decoy-run-differs'):
                I._synthetic_decoy(value)


class HeldEvidenceModel(unittest.TestCase):
    def test_exact_private_observer_rejects_other_roles_realms_and_extra_bytes(self):
        raw = b'postgres://ai_hr_workload_observer:' + b'a' * 64 + b'@127.0.0.1:5433/ai_hr_test_w1'
        I._observer_credential(raw)
        for mutated in [raw + b'\n', raw.replace(b'test_w1', b'dev'), raw.replace(b'5433', b'5432'),
                        raw.replace(b'ai_hr_workload_observer', b'postgres'), raw + b'?sslmode=disable']:
            with self.subTest(), self.assertRaisesRegex(I._Refused, 'fixed-observer-credential-differs'):
                I._observer_credential(mutated)
        frame = {'pid': 77, 'tag': 'aihrbc_0123456789abcdef'}
        native = {'pid': 77, 'tag': frame['tag'], 'start': '1999.12345', 'database': 'ai_hr_test_w1',
                  'login': 'ai_hr_workload_observer'}
        I._require_observer_backend(native, frame, native.copy())
        for change in [{'pid': True}, {'pid': 78}, {'start': '2000.1'}, {'database': 'ai_hr_dev'},
                       {'login': 'postgres'}, {'tag': 'different'}]:
            with self.subTest(), self.assertRaisesRegex(I._Refused, 'fixed-observer-backend-differs'):
                I._require_observer_backend({**native, **change}, frame, native)

    def test_tls_reconciliation_has_one_exact_url_status_body_and_certificate(self):
        positive = (I._INGRESS_URL, 200, I._INGRESS_BODY, b'der', b'der')
        I._require_ingress_response(*positive)
        for index, replacement in [(0, 'https://localhost:3443/'), (1, 307), (2, b'synthetic'),
                                   (3, b'other'), (4, b'foreign')]:
            values = list(positive)
            values[index] = replacement
            with self.subTest(), self.assertRaisesRegex(I._Refused, 'fixed-ingress-response-differs'):
                I._require_ingress_response(*values)

    def test_distinct_held_browser_roles_and_renderer_reuse_actual_kernel_checks(self):
        launcher = {'pid': 1, 'cgroupBirth': (5, 6), 'pidNamespace': 6, 'userNamespace': 7, 'seccompFilters': 1}
        chromium = {**launcher, 'pid': 2}
        renderer = {**launcher, 'pid': 3, 'pidNamespace': 9, 'userNamespace': 10, 'seccompFilters': 2,
                    'argv': [b'--type=renderer']}
        with patch.object(I.select, 'select', return_value=([], [], [])), \
             patch.object(K, 'require_role_listener') as listener:
            I._require_browser_family(K, (11, launcher), (12, chromium), [(13, renderer)])
            listener.assert_called_once_with(11, launcher, K.CONTROL, K.BROWSER)
            with self.assertRaisesRegex(K.Refused, 'native-renderer-sandbox-differs'):
                I._require_browser_family(K, (11, launcher), (12, chromium), [(13, {**renderer, 'seccompFilters': 1})])
            with self.assertRaisesRegex(I._Refused, 'held-browser-renderer-differs'):
                I._require_browser_family(K, (11, launcher), (12, chromium), [(13, {**renderer, 'pid': 2})])

    def test_held_pipe_reads_a_frame_and_refuses_surplus_at_terminal_eof(self):
        clock = K.Deadline()
        with patch.object(I, '_pipe_birth', side_effect=lambda fd: (1, fd)), \
             patch.object(I.os, 'fpathconf', return_value=512), \
             patch.object(I.select, 'select', return_value=([5], [], [])), \
             patch.object(I.os, 'read', side_effect=[b'{"op":', b'"stop"}\nextra']):
            pipe = I._RolePipes(5, 6, 512)
            self.assertEqual(pipe.frame(clock, 60), wire('stop'))
            with self.assertRaisesRegex(I._Refused, 'held-role-output-surplus'):
                pipe.require_eof(clock, 75)

    def test_changed_driver_identity_survives_recheck_pidfd_close_failure(self):
        original = {'pid': 61, 'start': 100}

        def close(fd):
            if fd == 52:
                raise OSError('simulated recheck pidfd close failure')

        with patch.object(K, 'held_role_process', side_effect=[(51, original), (52, {**original, 'start': 101})]), \
             patch.object(I.select, 'select', return_value=([], [], [])), \
             patch.object(I.os, 'close', side_effect=close) as closed:
            driver = I._HeldDriver(K, 61, '123')
            with self.assertRaisesRegex(I._Refused, 'held-driver-changed') as caught:
                driver.current_pid(K)
            self.assertEqual(caught.exception.__notes__, ['held-driver-recheck-pidfd-close-unproved'])
            self.assertEqual(driver.fd, 51)
            driver.close()
        self.assertEqual([call.args[0] for call in closed.call_args_list], [52, 51])


if __name__ == '__main__':
    unittest.main()
