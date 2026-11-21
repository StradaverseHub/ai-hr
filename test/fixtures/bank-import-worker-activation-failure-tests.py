"""Real guarded activation spine: preserve safe original failures and narrowly record stopped state."""
import contextlib,io,json,shutil,tempfile,unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
core=ModuleType('activation_failure_fixture');core.__file__=str(ROOT/'test/fixtures/bank-import-worker-ci-runtime-tests.py')
exec(Path(core.__file__).read_text().rsplit('\nunittest.main()',1)[0],core.__dict__)
ci,update,guard=core.ci,core.update,core.guard
SECRET='PRIVATE_ACTIVATION_FAILURE_CANARY_9143'

class ActivationFailureTests(unittest.TestCase):
    def failed(self,f,error,*,quarantine_error=False,observation_fault=None):
        original=ci.RuntimeObservation.complete_fence
        publish=ci.RuntimeObservation.publish_stopped_failure_observation
        output=io.StringIO()
        def fence(o,*args,**kw):
            if o.started_sha is not None:
                o.slot('F4',20)
                raise error
            return original(o,*args,**kw)
        def observed(o,result,observe):
            if observation_fault:observation_fault(o,result)
            return publish(o,result,observe)
        with contextlib.ExitStack()as stack:
            stack.enter_context(f.ports());stack.enter_context(patch.object(ci.RuntimeObservation,'complete_fence',fence))
            stack.enter_context(patch.object(ci.RuntimeObservation,'publish_stopped_failure_observation',observed))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()));stack.enter_context(contextlib.redirect_stderr(output))
            if quarantine_error:stack.enter_context(patch.object(ci.RuntimeObservation,'authorize_quarantine',side_effect=OSError(SECRET)))
            with self.assertRaisesRegex(RuntimeError,'explicit administrator recovery'):
                guard.launch(['guarded-activate-ci-runtime','--approval',str(f.authorization),'--approval-sha256',ci.sha(f.authorization.read_bytes())],f.fmt,f.base,ci,update)
        raw=output.getvalue();self.assertNotIn(SECRET,raw)
        cause=json.loads(raw.splitlines()[0]);self.assertEqual(cause['kind'],'WORKER_ACTIVATION_FAILURE_CAUSE')
        self.assertFalse((f.operation/'activated.json').exists());self.assertFalse((f.app/'releases'/f.source/'worker-install-v2.json').exists())
        return cause['failure'],json.loads(raw.splitlines()[-1])

    def test_exact_native_details_survive_outer_handler_and_both_failure_records(self):
        details={'reason':'DEADLINE','returnCodeBeforeCleanup':None,'returnCodeAfterCleanup':-15,'elapsedMs':20001,
                 'remainingMs':-1,'budgetMs':20000,'stdoutBytes':7,'stderrBytes':9}
        with tempfile.TemporaryDirectory()as tmp:
            f=core.Fixture(Path(tmp));cause,result=self.failed(f,ci.NativeProofFailure(details))
            self.assertEqual(cause['native'],details);self.assertEqual(cause['category'],'NATIVE_PROOF');self.assertEqual(cause['slot'],'F4')
            for name in ('activation-failed.json','activation-failure-observation.json'):
                self.assertEqual(json.loads((f.operation/name).read_bytes())['failure'],cause)
            self.assertTrue(result['stopped']);self.assertTrue(result['disabled']);self.assertNotIn('observationUnavailable',result)

    def test_arbitrary_errors_cannot_export_messages_paths_or_payloads(self):
        for error in (OSError(SECRET),ValueError(SECRET)):
            with self.subTest(error=type(error).__name__),tempfile.TemporaryDirectory()as tmp:
                f=core.Fixture(Path(tmp));cause,_=self.failed(f,error)
                self.assertEqual(cause['category'],'OTHER');self.assertNotIn(SECRET,json.dumps(cause))

    def test_original_cause_is_printed_even_if_quarantine_authorization_fails(self):
        base=core.load_native('actual_failure_base','bank_import_worker_installer_v2.py')
        with self.assertRaises(ValueError)as caught:base.check(False,'aggregate cutover stage deadline exceeded')
        with tempfile.TemporaryDirectory()as tmp:
            f=core.Fixture(Path(tmp));cause,result=self.failed(f,caught.exception,quarantine_error=True)
            self.assertEqual(cause['category'],'STAGE_DEADLINE');self.assertTrue(result['ownedProcessQuarantineRefused'])

    def test_stopped_observation_refuses_foreign_or_uncertain_state(self):
        def fail_lock(o,r):o.guard.verify_install=lambda:core.check(False,'lost lock')
        cases={
            'foreign-unit':lambda o,r:o.base.UNIT.write_text(SECRET),
            'reused-pid':lambda o,r:(ci.PROCESS_ROOT/str(o.started_identity['pid'])).mkdir(),
            'restart':lambda o,r:f.report.update(NRestarts='1'),
            'nonterminal':lambda o,r:f.report.update(ActiveState='active'),
            'enabled':lambda o,r:f.report.update(UnitFileState='enabled'),
            'environment':lambda o,r:o.base.ENV.write_text(SECRET),
            'boot':lambda o,r:ci.BOOT_ID.write_text(SECRET),
            'lock':fail_lock,
            'authority':lambda o,r:(o.operation/'ci-worker-quarantine-authority.json').write_text(SECRET),
            'intent':lambda o,r:(o.operation/'ci-worker-start-request.json').write_text(SECRET),
            'started':lambda o,r:(o.operation/'ci-worker-started.json').write_text(SECRET),
            'success':lambda o,r:r.update(accepted=True),
        }
        for name,fault in cases.items():
            with self.subTest(name=name),tempfile.TemporaryDirectory()as tmp:
                f=core.Fixture(Path(tmp));_,result=self.failed(f,ValueError('fixture guard failure'),observation_fault=fault)
                self.assertTrue(result['observationUnavailable']);self.assertFalse((f.operation/'activation-failure-observation.json').exists())

    def test_active_failure_fence_still_refuses_stopped_process(self):
        def active_fence(o,r):
            with self.assertRaises(ValueError):o.quarantine_fence()
        with tempfile.TemporaryDirectory()as tmp:
            f=core.Fixture(Path(tmp));_,result=self.failed(f,ValueError('fixture guard failure'),observation_fault=active_fence)
            self.assertNotIn('observationUnavailable',result)

unittest.main()
