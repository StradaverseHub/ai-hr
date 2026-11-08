"""Six native callback/ownership controls, NOT original catalogue execution."""
import json
import os
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import ModuleType

source = Path(__file__).resolve().with_name('adapter.py')
adapter = ModuleType('actual_original_replay_adapter')
adapter.__file__ = str(source)
exec(compile(source.read_bytes(), str(source), 'exec', dont_inherit=True), adapter.__dict__)
kernel = adapter.kernel


class NativeCallbackControls(unittest.TestCase):
    uncertain = False

    def setUp(self):
        self.assertFalse(type(self).uncertain, 'Uncertain prior owner blocks successor')
        self.assertEqual(kernel.own_children(), [])

    def run_owned(self, body, *, initially_closed=False, publish=None, tick=None):
        read, write = os.pipe()
        os.set_blocking(read, False)
        write_open = True
        events = []
        before = signal.getsignal(signal.SIGTERM)

        def close_input():
            nonlocal write_open
            if write_open:
                os.close(write)
                write_open = False

        def observe(packet):
            events.append(packet)
            if publish:
                publish(packet, control, close_input)

        control = adapter.Cancellation(read, time.monotonic() + .4, observe)

        def clock():
            if tick:
                tick(control, close_input)
            return control.clock()

        if initially_closed:
            close_input()
        try:
            try:
                receipt = kernel.supervise([sys.executable, '-I', '-B', '-c', body], .5,
                                           control.event, clock=clock, mandatory=False)
            except BaseException:
                type(self).uncertain = True
                raise
            finally:
                control.disable()
            if not (receipt['reaped'] and receipt['groupQuiescent'] and not receipt['escapedSession']):
                type(self).uncertain = True
            self.assertTrue(receipt['reaped'])
            self.assertTrue(receipt['groupQuiescent'])
            self.assertFalse(receipt['escapedSession'])
            self.assertEqual(kernel.own_children(), [])
            self.assertIs(signal.getsignal(signal.SIGTERM), before)
            return receipt, control, events
        finally:
            close_input()
            os.close(read)

    def test_initial_eof_refuses_ack_before_actual_command_marker(self):
        read, write = os.pipe()
        try:
            os.set_blocking(read, False)
            os.write(write, b'UNEXPECTED')
            byte_control = adapter.Cancellation(read, time.monotonic() + 1, lambda _: None)
            byte_control.poll()
            self.assertTrue(byte_control.cancelled)
        finally:
            os.close(read)
            os.close(write)
        with tempfile.TemporaryDirectory(prefix='replay-no-ack-') as directory:
            marker = Path(directory) / 'must-not-exist'
            receipt, control, _ = self.run_owned('from pathlib import Path;Path('+repr(str(marker))+').write_text("UNEXPECTED")', initially_closed=True)
            self.assertFalse(marker.exists())
            self.assertEqual(receipt['reason'], 'protocol-refused')
            self.assertIsNone(receipt['commandExit'])
            self.assertTrue(control.cancelled)

    def test_late_eof_reaps_term_resistant_descendant_without_harming_foreign_group(self):
        foreign_pid = int(os.environ['AIHR_REPLAY_TEST_FOREIGN_PID'])
        foreign_before = kernel.identity(foreign_pid)
        self.assertNotIn(foreign_before['state'], ('Z', 'X'))
        with tempfile.TemporaryDirectory(prefix='replay-late-eof-') as directory:
            marker = Path(directory) / 'actual-descendant.json'
            body = ('import os,signal,time,json\nfrom pathlib import Path\n'
                    'signal.signal(signal.SIGTERM,signal.SIG_IGN)\np=os.fork()\n'
                    'if p==0:\n'
                    ' signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                    ' fields=Path("/proc/self/stat").read_text().rsplit(")",1)[1].split()\n'
                    ' pending=Path('+repr(str(marker)+'.pending')+')\n'
                    ' pending.write_text(json.dumps({"pid":os.getpid(),"start":int(fields[19])}))\n'
                    ' os.replace(pending,'+repr(str(marker))+')\n'
                    'while True: time.sleep(10)\n')

            def tick(_control, close):
                if marker.exists():
                    close()

            receipt, control, events = self.run_owned(body, tick=tick)
            self.assertEqual(receipt['reason'], 'owner-interrupted')
            self.assertTrue(control.cancelled)
            self.assertTrue(control.requested)
            actual = json.loads(marker.read_text())
            try:
                remaining = kernel.identity(actual['pid'])
            except FileNotFoundError:
                remaining = None
            self.assertTrue(remaining is None or remaining['start'] != actual['start'])
            monitor = next(row['pid'] for row in events if row['kind'] == 'session-admitted')
            self.assertNotEqual(foreign_before['group'], monitor)
            foreign_after = kernel.identity(foreign_pid)
            for key in ('pid', 'start', 'parent', 'group', 'session'):
                self.assertEqual(foreign_before[key], foreign_after[key])
            self.assertNotIn(foreign_after['state'], ('Z', 'X'))

    def test_normal_actual_completion_restores_handler_and_reports_full_native_receipt(self):
        # run_owned closes its test input AFTER settlement. To verify a normal
        # completed receipt, inspect completion before that intentional teardown.
        observed = []

        def publish(packet, control, _close):
            if packet['kind'] == 'stage-ended':
                observed.append(control.completed({key: value for key, value in packet.items() if key != 'kind'}))

        receipt, control, _ = self.run_owned('pass', publish=publish)
        self.assertEqual(receipt['reason'], 'complete')
        self.assertEqual(observed, [True])
        self.assertFalse(control.active)

    def test_eof_during_completion_is_latched_even_after_group_stop_disabled_signalling(self):
        def publish(packet, control, close):
            if packet['kind'] == 'group-stop-before-reap':
                self.assertFalse(control.active)
                close()
            if packet['kind'] == 'stage-ended':
                self.assertFalse(control.completed({key: value for key, value in packet.items() if key != 'kind'}))

        receipt, control, _ = self.run_owned('pass', publish=publish)
        self.assertEqual(receipt['reason'], 'complete')
        self.assertTrue(control.cancelled)
        self.assertFalse(control.requested)

    def test_publisher_failure_during_group_stop_cannot_skip_reaping_or_restore(self):
        def publish(packet, control, _close):
            if packet['kind'] == 'group-stop-before-reap':
                self.assertFalse(control.active)
                raise OSError('FICTIONAL_PRIVATE_PUBLICATION')

        receipt, control, _ = self.run_owned('pass', publish=publish)
        self.assertEqual(receipt['reason'], 'protocol-refused')
        self.assertTrue(control.publisher_failed)
        self.assertNotIn('FICTIONAL_PRIVATE', str(receipt))

    def test_handler_drift_never_invokes_foreign_handler_or_reports_completion(self):
        foreign_calls = []

        def foreign(_sig, _frame):
            foreign_calls.append(True)

        def publish(packet, _control, _close):
            if packet['kind'] == 'session-admitted':
                signal.signal(signal.SIGTERM, foreign)

        receipt, control, _ = self.run_owned('import time;time.sleep(10)', publish=publish)
        self.assertEqual(receipt['reason'], 'deadline')
        self.assertTrue(control.cancelled)
        self.assertFalse(control.requested)
        self.assertEqual(foreign_calls, [])


if __name__ == '__main__':
    unittest.main()
