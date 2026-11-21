"""Actual native children: failure causes stay actionable without disclosing payloads."""
import importlib.util,json,os,sys,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('safe_native_failure_owner',ROOT/'deploy/systemd/bank_import_worker_ci_runtime_v1.py')
owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)

class NativeFailureTests(unittest.TestCase):
    def run_failure(self,code,**options):
        with self.assertRaises(owner.NativeProofFailure)as raised:
            owner.bounded_process([sys.executable,'-I','-c',code],**options)
        failure=raised.exception
        self.assertEqual(set(failure.details),{'reason','returnCodeBeforeCleanup','returnCodeAfterCleanup','elapsedMs','remainingMs','budgetMs','stdoutBytes','stderrBytes'})
        self.assertTrue(all(value is None or type(value)is int for key,value in failure.details.items()if key!='reason'))
        return failure
    def test_nonzero_reports_exact_exit_and_sizes_without_any_private_payload(self):
        secret='CANARY_PRIVATE_NATIVE_PAYLOAD_7789'
        code="import os,sys;print(os.environ['PRIVATE_CANARY']);sys.stderr.write(sys.stdin.read());sys.exit(7)"
        failure=self.run_failure(code,input=secret,env={'PRIVATE_CANARY':secret},timeout=2)
        self.assertEqual(failure.details['reason'],'CHILD_EXIT');self.assertEqual(failure.details['returnCodeBeforeCleanup'],7)
        self.assertEqual(failure.details['stdoutBytes'],len(secret)+1);self.assertEqual(failure.details['stderrBytes'],len(secret))
        self.assertNotIn(secret,str(failure));self.assertNotIn(code,str(failure));self.assertNotIn('PRIVATE_CANARY',str(failure));self.assertNotIn(sys.executable,str(failure))
    def test_silent_child_is_classified_deadline_and_owned_child_is_reaped(self):
        start=time.monotonic();failure=self.run_failure('import time;time.sleep(60)',timeout=.05)
        self.assertEqual(failure.details['reason'],'DEADLINE');self.assertIsNone(failure.details['returnCodeBeforeCleanup']);self.assertIsNotNone(failure.details['returnCodeAfterCleanup']);self.assertLess(time.monotonic()-start,2)
    def test_closed_pipes_with_live_child_is_classified_wait_timeout(self):
        failure=self.run_failure('import os,time;os.close(1);os.close(2);time.sleep(60)',timeout=1)
        self.assertEqual(failure.details['reason'],'WAIT_TIMEOUT');self.assertIsNotNone(failure.details['returnCodeAfterCleanup'])
    def test_stdout_and_stderr_bounds_are_distinct_without_exported_bytes(self):
        for stream,field,reason in [('stdout','MAX_NATIVE_STDOUT','STDOUT_BOUND'),('stderr','MAX_NATIVE_STDERR','STDERR_BOUND')]:
            with self.subTest(stream=stream),patch.object(owner,field,128):
                failure=self.run_failure('import sys;sys.'+stream+'.write("CANARY_PRIVATE_OUTPUT_"*1024);sys.'+stream+'.flush()',timeout=2)
                self.assertEqual(failure.details['reason'],reason);self.assertNotIn('CANARY_PRIVATE_OUTPUT',str(failure))
    def test_success_bytes_are_returned_unchanged(self):
        self.assertEqual(owner.bounded_process([sys.executable,'-I','-c','import sys;sys.stdout.buffer.write(b"exact native proof")'],timeout=2),b'exact native proof')
    def test_interrupt_is_explicit_and_original_owned_child_cleanup_still_runs(self):
        real=owner.selectors.DefaultSelector()
        with patch.object(owner.selectors,'DefaultSelector',return_value=real),patch.object(real,'select',side_effect=KeyboardInterrupt):
            failure=self.run_failure('import time;time.sleep(60)',timeout=2)
        self.assertEqual(failure.details['reason'],'INTERRUPTED');self.assertIsNotNone(failure.details['returnCodeAfterCleanup'])

unittest.main()
