"""Pure source/ownership/timing models. No root, native process, browser or DB."""
import ast
import base64
import contextlib
import hashlib
import itertools
import json
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_next_environment_observation as old
F = old.F
FS = {'actualNamespaceFilesystemVerified': True, 'cacheWrites': 3, 'immutableParentRefusals': 5, 'originalCheckoutReadWriteRefusals': 4}


class Harness:
    def __init__(self, *, fail=None, close_fail=False, ready_drift=False, identity_drift=False, exit_before_reply=False):
        self.events, self.profiles, self.replies, self.fail, self.close_fail = [], [], [], fail, close_fail
        self.started, self.permit, self.finished = False, False, False
        self.ready_calls, self.workers, self.fs_calls = 0, 0, 0
        self.ready_drift, self.identity_drift, self.exit_before_reply = ready_drift, identity_drift, exit_before_reply
        self.plan = {'candidate': 'a'*40, 'sourceDirectory': '/fixture/source', 'runnerUid': 1001, 'runnerGid': 1001,
            'runId': '123', 'nodePath': '/owned/node', 'browserInputPath': '/fixture/browser.json', 'evidenceDirectory': '/fixture/evidence'}
        self.binding = {'nextBuildId': 'BUILD', 'buildSourcePath': '/fixture/producer'}
        self.processes = {42: {'pid': 42, 'start': 7}, 43: {'pid': 43, 'start': 8}}
        self.rows = {F.UNITS[0]: {'unit': F.UNITS[0], 'generation': 'g1', 'id': 'g1', 'phase': 'READY', 'port': 3201, 'admitted': True},
                     F.UNITS[1]: {'unit': F.UNITS[1], 'generation': 'g2', 'id': 'g2', 'phase': 'READY', 'port': 3202, 'admitted': True}}
        self.invocations = {F.UNITS[0]: 'a'*32, F.UNITS[1]: 'b'*32}
        owner = self
        class Runtime:
            def __init__(self):self.full_reads, self.checks, self.verified = 0, 0, False
            def verify_release(self, spec):
                owner.events.append('source-check');self.checks += 1
                if owner.fail == 'source':raise ValueError('synthetic source refusal')
                if not self.verified:self.full_reads += 1;self.verified = True
                return {'entries': 1}
        class Profile:
            def __init__(self, path):
                owner.events.append('profile-open')
                if owner.fail == 'constructor':raise ValueError('synthetic constructor refusal')
                self.closed, self.sha = False, 'c'*64
                self.value = {'source': owner.plan['candidate'], 'build': 'BUILD', 'epoch': 'd'*32, 'units': {u: {'name': u} for u in F.UNITS}}
                if owner.fail == 'source-label':self.value['source'] = 'f'*40
                self.next_runtime = Runtime();owner.profiles.append(self)
            def assert_current(self):
                if self.closed or owner.fail == 'metadata':raise ValueError('synthetic profile drift')
            def close(self):
                owner.events.append('profile-close');self.closed = True
                if owner.close_fail:raise OSError('synthetic close refusal')
        class Host:
            def __init__(self, profile):self.profile, self.next_worker_evidence = profile, {}
            def worker(self, unit, invocation, port):
                self.profile.assert_current();owner.workers += 1;owner.events.append('live-proof')
                if owner.fail == 'live':raise ValueError('synthetic live environment refusal')
                self.profile.next_runtime.verify_release(self.profile.value['units'][unit])
                self.next_worker_evidence[unit] = {'namespace': {'actualKernelMountsVerified': True, 'actualEnvironmentVerified': True}, 'resources': {'aggregateCapsVerified': True}}
                result = dict(owner.processes[42 if unit == F.UNITS[0] else 43])
                if owner.identity_drift:result['start'] += 1
                return result
        self.C = types.SimpleNamespace(Profile=Profile, LinuxHost=Host, PROFILE='/fixed/private/profile',
            process_identity=lambda pid: dict(self.processes[pid]), alive=lambda identity: identity in self.processes.values())
        class Stdin:
            def write(self, value):owner.replies.append(json.loads(value))
            def flush(self):
                owner.events.append('reply-flush')
                if owner.fail == 'flush':raise BrokenPipeError('synthetic pipe refusal')
            def close(self):owner.finished = True
        class Stdout:
            def fileno(self):return 99
            def read(self, count):return b''
        class Browser:
            stdin, stdout = Stdin(), Stdout()
            def poll(self):return None if owner.fail == 'wait' else 1 if owner.exit_before_reply and owner.workers else 0 if owner.finished else None
            def wait(self, timeout):
                if owner.fail == 'wait':raise TimeoutError('synthetic wrapper unsettled')
                owner.finished = True;return 0
            def terminate(self):owner.finished = True
        self.child = Browser()
        class Selector:
            def register(self, *_args):pass
            def select(self, *_args):return [True]
            def close(self):owner.events.append('selector-close')
        self.selector = Selector()

    def start(self, unit, **kwargs):
        self.events.append('owned-start:'+unit)
        if self.fail == 'start':raise OSError('synthetic start refusal')
        self.started = True
        if unit == F.UNITS[0]:assert kwargs == {'timeout': 90}
        else:assert kwargs == {'nonblocking': True}

    def ready(self, unit):
        self.events.append('ready:'+unit)
        if unit == F.UNITS[0]:
            self.ready_calls += 1
            if self.fail == 'ready':return None
            if self.ready_drift and self.ready_calls == 3:return None
        return dict(self.rows[unit])

    def state(self):
        g = {'unit': F.UNITS[0], 'phase': 'READY', 'port': 3201, 'epoch': 'd'*32, 'profile': 'c'*64,
            'invocation': self.invocations[F.UNITS[0]], 'process': dict(self.processes[42])}
        if self.fail == 'generation':g['epoch'] = 'f'*32
        return {'generations': {'g1': g}, 'published': {'ready': ['g1','g2'] if self.permit else ['g1']}}

    def run(self, *args, **kwargs):
        self.fs_calls += 1;self.events.append('filesystem-proof')
        assert kwargs['timeout'] == 10
        return types.SimpleNamespace(stdout=json.dumps(FS).encode())

    def launch(self, *args, **kwargs):
        self.events.append('browser-launch');assert self.started and self.profiles and self.profiles[0].next_runtime.full_reads == 1
        assert kwargs['env'] == {'PATH':'/usr/bin:/bin','HOME':'/fixture/home','LANG':'C.UTF-8','LC_ALL':'C.UTF-8'}
        return self.child

    @contextlib.contextmanager
    def context(self):
        report = {'actualNextBootVerified':False}
        requests = iter((json.dumps({'id':i+1,'operation':op})+'\n').encode() for i,op in enumerate(('start-first','start-second-cold','admit-second','browser-core-finished')))
        browser_report = {'complete':True,'unexpectedBrowserErrors':0,'hydratedAccountControls':6,'nonemptyOwnPayrollView':True,
            'servedPorts':[3201,3202],'logins':[{},{}],'home':[{}],
            'firstHostRequestTiming':{'kind':'ACTUAL_FIRST_HOST_REQUEST_TIMING_NOT_ADMISSION','timeoutMs':90000,'elapsedMs':10,'outcome':'returned','driverFinalElapsedMs':100}}
        with contextlib.ExitStack() as stack:
            for target,name,value in ((F,'report',report),(F,'browser',None),(F,'save',lambda:None),(F,'phase',lambda _name:None),
                (F,'owned_invocations',dict(self.invocations)),(F,'owned_start',self.start),(F,'ready',self.ready),
                (F,'state',self.state),(F,'until',lambda callback,*_args,**_kwargs: callback()),
                (F,'run',self.run),(F,'props',lambda unit,**_kwargs:{'InvocationID':self.invocations[unit]}),
                (F,'cold',lambda unit:dict(self.rows[unit])|{'phase':'WARMING','admitted':False}),
                (F,'write',lambda *_args,**_kwargs:setattr(self,'permit',True)),(F,'regular',lambda *_args,**_kwargs:json.dumps(browser_report).encode()),
                (F,'record_owned_invocation',lambda *_args,**_kwargs:True)):
                stack.enter_context(patch.object(target,name,value))
            stack.enter_context(patch.object(F.time,'monotonic_ns',side_effect=itertools.count(1000000,1000)))
            stack.enter_context(patch.object(F.pwd,'getpwuid',return_value=types.SimpleNamespace(pw_uid=1001,pw_gid=1001,pw_name='fixture',pw_dir='/fixture/home')))
            stack.enter_context(patch.object(F.subprocess,'Popen',side_effect=self.launch))
            stack.enter_context(patch.object(F.selectors,'DefaultSelector',return_value=self.selector))
            stack.enter_context(patch.object(F.os,'read',side_effect=lambda *_args:next(requests)))
            stack.enter_context(patch.object(pathlib.Path,'read_text',return_value=''))
            F.bootstrap_timing()
            yield report


class BootstrapSessionModels(unittest.TestCase):
    def test_fixed13_slots_are_explicit_not_entered_not_success(self):
        with Harness().context() as report:
            self.assertEqual(len(report['bootstrapTiming']['slots']),13)
            self.assertTrue(all(row['outcome']=='not-entered' and not row['returned'] and row['startUs'] is None for row in report['bootstrapTiming']['slots']))
            self.assertNotIn('runtimeCommands',report)

    def test_numeric_stage_elapsed_is_actual_clock_difference(self):
        with Harness().context() as report:
            persisted=[]
            with patch.object(F,'save',side_effect=lambda:persisted.append(report['bootstrapTiming']['slots'][0]['outcome'])):
                with F.bootstrap_stage(0):self.assertEqual(persisted,['entered'])
            row=report['bootstrapTiming']['slots'][0]
            self.assertEqual(row['elapsedUs'],1);self.assertEqual(row['endUs']-row['startUs'],1);self.assertTrue(row['returned']);self.assertEqual(persisted,['entered','returned'])

    def test_duplicate_bool_negative_or_unknown_stage_refuses(self):
        with Harness().context():
            with F.bootstrap_stage(0):pass
            for slot in (0,True,-1,13,'0'):
                with self.assertRaises(AssertionError):
                    with F.bootstrap_stage(slot):pass

    def test_stage_refusal_keeps_no_error_text_or_fake_success(self):
        with Harness().context() as report:
            with self.assertRaises(ValueError):
                with F.bootstrap_stage(1):raise ValueError('fictional-private-value')
            row=report['bootstrapTiming']['slots'][1]
            self.assertEqual(row['outcome'],'refused');self.assertFalse(row['returned']);self.assertNotIn('fictional',json.dumps(report))

    def test_invalid_timing_code_is_refused_without_reflecting_its_value(self):
        for value in ('fictional-private-code',0,True,2147483648):
            with Harness().context() as report:
                with self.assertRaises(AssertionError):
                    with F.bootstrap_stage(0) as row:row['code']=value
                self.assertIsNone(report['bootstrapTiming']['slots'][0]['code']);self.assertNotIn('fictional',json.dumps(report))

    def test_clock_rollback_refuses_without_clamping(self):
        with Harness().context(),patch.object(F,'bootstrap_clock',side_effect=[10,9]):
            with self.assertRaises(AssertionError):
                with F.bootstrap_stage(0):pass

    def test_body_and_timing_cleanup_failures_are_both_retained(self):
        with Harness().context(),patch.object(F,'bootstrap_clock',side_effect=[10,OSError('clock unavailable')]):
            with self.assertRaises(BaseExceptionGroup) as caught:
                with F.bootstrap_stage(0):raise ValueError('original operation')
            self.assertEqual([type(e) for e in caught.exception.exceptions],[ValueError,OSError])

    def test_profile_source_start_ready_precede_browser_and_one_profile_closes(self):
        h=Harness()
        with h.context() as report:
            F.browser_core(h.plan,h.binding,h.C)
            self.assertEqual(len(h.profiles),1);self.assertEqual(h.profiles[0].next_runtime.full_reads,1)
            self.assertLess(h.events.index('source-check'),h.events.index('owned-start:'+F.UNITS[0]));self.assertLess(h.events.index('ready:'+F.UNITS[0]),h.events.index('browser-launch'))
            self.assertEqual(h.events.count('profile-close'),1);self.assertTrue(h.profiles[0].closed);self.assertTrue(report['actualNextBootVerified'])

    def test_allfive_live_proofs_and_filesystem_controls_still_run(self):
        h=Harness()
        with h.context() as report:
            F.browser_core(h.plan,h.binding,h.C)
            self.assertEqual((h.workers,h.fs_calls),(5,5));self.assertEqual(h.profiles[0].next_runtime.checks,6)
            self.assertEqual(len(report['workers']),3);self.assertEqual(len(report['postBrowserWorkers']),2)

    def test_first_ack_occurs_only_after_live_filesystem_and_rechecked_ready(self):
        h=Harness()
        with h.context() as report:
            F.browser_core(h.plan,h.binding,h.C)
            self.assertLess(h.events.index('live-proof'),h.events.index('filesystem-proof'));self.assertLess(h.events.index('filesystem-proof'),h.events.index('reply-flush'))
            self.assertEqual(h.replies[0],{'id':1,'ok':True,'result':{'port':3201}})
            self.assertEqual(report['bootstrapTiming']['slots'][9]['outcome'],'returned')

    def test_second_cold_and_permit_course_remains_after_first_ack(self):
        h=Harness()
        with h.context() as report:
            F.browser_core(h.plan,h.binding,h.C)
            self.assertLess(h.events.index('reply-flush'),h.events.index('owned-start:'+F.UNITS[1]));self.assertTrue(h.permit)
            self.assertEqual(h.replies[1]['result'],{'port':3202,'admitted':False});self.assertEqual(report['coldBusinessRequests'],0)

    def test_failed_profile_constructor_does_not_launch_or_claim_closed_session(self):
        h=Harness(fail='constructor')
        with h.context() as report:
            with self.assertRaises(ValueError):F.browser_core(h.plan,h.binding,h.C)
            self.assertNotIn('browser-launch',h.events);self.assertEqual(report['bootstrapTiming']['slots'][12]['outcome'],'not-entered')

    def test_source_label_or_metadata_or_full_read_failure_always_closes(self):
        for fail in ('source-label','metadata','source'):
            h=Harness(fail=fail)
            with h.context():
                with self.assertRaises((AssertionError,ValueError)):F.browser_core(h.plan,h.binding,h.C)
                self.assertEqual(h.events.count('profile-close'),1);self.assertNotIn('browser-launch',h.events)

    def test_start_or_ready_generation_failure_never_launches_browser(self):
        for fail in ('start','generation'):
            h=Harness(fail=fail)
            with h.context():
                with self.assertRaises((AssertionError,OSError)):F.browser_core(h.plan,h.binding,h.C)
                self.assertTrue(h.profiles[0].closed);self.assertNotIn('browser-launch',h.events)

    def test_first_live_environment_refusal_cannot_reuse_prepared_ready_ack(self):
        h=Harness(fail='live')
        with h.context() as report:
            with self.assertRaises(ValueError):F.browser_core(h.plan,h.binding,h.C)
            self.assertEqual(h.replies,[]);self.assertEqual(h.fs_calls,0);self.assertTrue(h.profiles[0].closed);self.assertFalse(report['actualNextBootVerified'])

    def test_generation_after_live_proof_drift_refuses_first_ack(self):
        h=Harness(ready_drift=True)
        with h.context():
            with self.assertRaises(AssertionError):F.browser_core(h.plan,h.binding,h.C)
            self.assertEqual(h.replies,[]);self.assertEqual(h.workers,1);self.assertEqual(h.fs_calls,1)

    def test_prepared_process_identity_cannot_admit_replacement(self):
        h=Harness(identity_drift=True)
        with h.context():
            with self.assertRaises(AssertionError):F.browser_core(h.plan,h.binding,h.C)
            self.assertEqual(h.replies,[]);self.assertTrue(h.profiles[0].closed)

    def test_exited_browser_never_receives_fake_first_ack(self):
        h=Harness(exit_before_reply=True)
        with h.context() as report:
            with self.assertRaises(AssertionError):F.browser_core(h.plan,h.binding,h.C)
            self.assertEqual(h.replies,[]);self.assertEqual(report['bootstrapTiming']['browserExit']['wrapperReturnCode'],1)

    def test_original_pipe_failure_preserved_with_close_mandatory(self):
        h=Harness(fail='flush')
        with h.context() as report:
            with self.assertRaises(BrokenPipeError):F.browser_core(h.plan,h.binding,h.C)
            self.assertTrue(h.profiles[0].closed);self.assertEqual(report['bootstrapTiming']['slots'][10]['outcome'],'refused')

    def test_profile_close_failure_prevents_boot_success(self):
        h=Harness(close_fail=True)
        with h.context() as report:
            with self.assertRaises(OSError):F.browser_core(h.plan,h.binding,h.C)
            self.assertFalse(report['actualNextBootVerified']);self.assertEqual(report['bootstrapTiming']['slots'][12]['outcome'],'refused')

    def test_original_and_close_failures_are_both_retained(self):
        h=Harness(fail='live',close_fail=True)
        with h.context():
            with self.assertRaises(BaseExceptionGroup) as caught:F.browser_core(h.plan,h.binding,h.C)
            self.assertEqual([type(e) for e in caught.exception.exceptions],[ValueError,OSError])

    def test_wrapper_settlement_failure_is_mandatory_and_profile_still_closes(self):
        h=Harness(fail='wait')
        with h.context() as report:
            with self.assertRaises(BaseExceptionGroup):F.browser_core(h.plan,h.binding,h.C)
            self.assertTrue(h.profiles[0].closed);self.assertFalse(report['actualNextBootVerified'])

    def test_no_profile_or_live_proof_survives_into_next_operation(self):
        h=Harness()
        with h.context():F.browser_core(h.plan,h.binding,h.C)
        h2=Harness()
        with h2.context():F.browser_core(h2.plan,h2.binding,h2.C)
        self.assertIsNot(h.profiles[0],h2.profiles[0]);self.assertTrue(h.profiles[0].closed and h2.profiles[0].closed)

    def test_clock_metadata_is_numeric_and_unknown_property_bytes_never_reflect(self):
        with Harness().context() as report:
            F.bootstrap_wrapper_exit(0);F.bootstrap_service_exit({'ExecMainStartTimestampMonotonic':'1','ExecMainExitTimestampMonotonic':'2'})
            value=report['bootstrapTiming']['browserExit'];self.assertEqual(value['state'],'observed');self.assertEqual((value['mainStartUs'],value['mainExitUs']),(1,2))
            F.bootstrap_wrapper_exit(1);self.assertEqual(value['wrapperReturnCode'],0)
            with self.assertRaises(AssertionError):F.bootstrap_wrapper_exit(True)
        for bad in ('fictional-secret','-1','1.0','9'*17,'0'):
            with Harness().context() as report:
                F.bootstrap_service_exit({'ExecMainStartTimestampMonotonic':'1','ExecMainExitTimestampMonotonic':bad})
                self.assertEqual(report['bootstrapTiming']['browserExit']['state'],'unavailable');self.assertNotIn('fictional',json.dumps(report))

    def test_successful_actual_shape_is_closed13slots_with_nested_first_clock_and_small_frame(self):
        h=Harness()
        with h.context() as report:
            F.browser_core(h.plan,h.binding,h.C);timing=report['bootstrapTiming'];rows=timing['slots']
            self.assertTrue(all(row['outcome']=='returned' and row['returned'] and row['elapsedUs']==row['endUs']-row['startUs'] for row in rows))
            self.assertLessEqual(rows[5]['startUs'],rows[6]['startUs']);self.assertGreaterEqual(rows[5]['endUs'],rows[10]['endUs'])
            self.assertLessEqual(len(json.dumps(timing,separators=(',',':')).encode()),4096)
            self.assertLessEqual(len(json.dumps({'bootstrapTiming':timing},indent=2).encode())+2,4096)

    def test_whole_protected_owners_original_pipe_manager_functions_and_budgets_are_preserved(self):
        inv=json.loads((ROOT/'deploy/admission/next_bootstrap_session_inverse.json').read_text())
        current=(ROOT/'deploy/admission/test_next_native.py').read_text();parent=base64.b64decode(inv['files']['deploy/admission/test_next_native.py']['originalBase64']).decode()
        def functions(source):return {n.name:ast.get_source_segment(source,n) for n in ast.parse(source).body if isinstance(n,ast.FunctionDef)}
        a,b=functions(current),functions(parent)
        for name in ('runtime_diagnostic_read','manager_environment_snapshot','manager_projection_snapshot','configure','owned_start','ready','until'):
            self.assertEqual(a[name],b[name])
        for literal in ('TOTAL_DEADLINE = time.monotonic() + 480','DEADLINE = TOTAL_DEADLINE - 30','--property=RuntimeMaxSec=300s','left(90)','timeout=5'):
            self.assertIn(literal,current);self.assertIn(literal,parent)
        # This manifest describes the historical249e->8bad construction. New
        # controller instrumentation is current source, never unchanged8bad.
        timing=json.loads((ROOT/'deploy/admission/next_controller_admit_timing_inverse.json').read_text())
        for file,want in inv['unchangedOwners'].items():
            current=(ROOT/file).read_bytes()
            if file in ('deploy/admission/controller.py','.github/ci/singleton-protocol.mjs'):
                row=timing['files'][file];self.assertEqual(hashlib.sha256(current).hexdigest(),row['currentSha256'])
                lines=current.decode().splitlines(keepends=True)
                for edit in row['changes']:
                    self.assertEqual(''.join(lines[edit['start']:edit['end']]),edit['after']);lines[edit['start']:edit['end']]=edit['before'].splitlines(keepends=True)
                current=''.join(lines).encode();self.assertEqual(current,base64.b64decode(row['originalBase64']));self.assertEqual(hashlib.sha256(current).hexdigest(),row['originalSha256'])
            self.assertEqual(hashlib.sha256(current).hexdigest(),want)

    def test_whole_parent_inverse_replays_each_byte_without_historical_pass_transfer(self):
        inv=json.loads((ROOT/'deploy/admission/next_bootstrap_session_inverse.json').read_text())
        self.assertFalse(inv['historicalRunEvidenceTransferred'])
        for path,row in inv['files'].items():
            data=(ROOT/path).read_bytes();self.assertEqual(hashlib.sha256(data).hexdigest(),row['currentSha256']);lines=data.decode().splitlines(keepends=True)
            for edit in row['changes']:
                self.assertEqual(''.join(lines[edit['start']:edit['end']]),edit['after']);lines[edit['start']:edit['end']]=edit['before'].splitlines(keepends=True)
            restored=''.join(lines).encode();self.assertEqual(restored,base64.b64decode(row['originalBase64']));self.assertEqual(hashlib.sha256(restored).hexdigest(),row['originalSha256'])


if __name__=='__main__':unittest.main()
