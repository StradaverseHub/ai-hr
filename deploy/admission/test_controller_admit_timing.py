"""Pure controls only; real source/argv/journal availability requires hosted HOST."""
import ast
import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import socket
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
S = load('admit_timing_state_models', ROOT/'deploy/admission/test_state.py')
C = S.C
F = load('admit_timing_receiver_models', ROOT/'deploy/admission/test_next_native.py')
H = load('admit_timing_host_models', ROOT/'deploy/admission/test_next_host_view_native.py')

class Stream:
    def __init__(self, failure=None):self.data=[];self.failure=failure;self.closed=0
    def send(self, data, flags):
        self.data.append((data,flags))
        if isinstance(self.failure,BaseException):raise self.failure
        return len(data)-1 if self.failure=='short' else len(data)
    def close(self):self.closed+=1

def observer(failure=None):
    value=C.AdmissionPhaseObserver();value.stream=Stream(failure);value.disabled=False;return value

def messages(value):return [data.decode().rstrip('\n') for data,_ in value.stream.data]

def pair(start=10):
    return [F.ADMISSION_PHASE_PREFIX+json.dumps(row,separators=(',',':')) for row in [
        {'v':1,'q':0,'p':0,'e':'enter','t':start,'d':None},
        {'v':1,'q':1,'p':0,'e':'return','t':start+1,'d':1}]]

def trace():
    rows=[];stack={};stamp=100
    def event(code,kind):
        nonlocal stamp
        stamp+=1
        if kind=='enter':stack[code]=stamp;elapsed=None
        else:elapsed=stamp-stack[code]
        rows.append({'v':1,'q':len(rows),'p':code,'e':kind,'t':stamp,'d':elapsed})
    def span(code):event(code,'enter');event(code,'return')
    span(0);span(1);event(3,'enter');span(4)
    for code in range(5,11):span(code)
    span(11);event(3,'return');event(12,'enter')
    for code in range(14,19):span(code)
    event(12,'return');span(19)
    return [F.ADMISSION_PHASE_PREFIX+json.dumps(row,separators=(',',':')) for row in rows]

def native_rows(values, **changes):
    result=[]
    for message in values:
        row={'_UID':'0','_EXE':'/usr/bin/python3.12','_SYSTEMD_UNIT':F.UNITS[0],
            '_SYSTEMD_INVOCATION_ID':'a'*32,'_TRANSPORT':'stdout',
            '_CMDLINE':'/usr/bin/python3 -I -B '+F.OBSERVER_PATHS['controller']+' admit '+F.UNITS[0], 'MESSAGE':message}
        row.update(changes);result.append(row)
    return result

def raw(rows):return ('\n'.join(json.dumps(row) for row in rows)+'\n').encode()

def binding():
    sources={'fixture':pathlib.Path(F.__file__).read_bytes(),'controller':pathlib.Path(C.__file__).read_bytes()}
    return sources,{'helpers':{name:{'sha256':hashlib.sha256(sources[owner]).hexdigest()} for owner,name in [('fixture','test_next_native.py'),('controller','controller.py')]}}

def receive(rows, **kwargs):
    sources,bound=binding();kwargs={'unit':F.UNITS[0],'invocation':'a'*32,'python_exe':'/usr/bin/python3.12','sources':sources,'binding':bound}|kwargs
    return F.runtime_admission_phase_diagnostic(raw(rows),**kwargs)

def host_rows():
    rows=[]
    for mode,values in [('hook-pre',pair(10)),('hook-pre-handoff',pair(20))]:
        for row in native_rows(values,_SYSTEMD_UNIT=H.UNIT,_PID='2345',_CMDLINE='/usr/bin/python3 -I -B '+str(H.ROOT/'probe.py')+' '+mode):rows.append(row)
    return rows

class AdmitTimingModels(unittest.TestCase):
    def test_real_socket_pair_uses_actual_factory_and_does_not_change_original_flags(self):
        left,right=socket.socketpair();realdup=os.dup;flags=C.fcntl.fcntl(left,C.fcntl.F_GETFL)
        try:
            with patch.object(C.os,'dup',side_effect=lambda fd:realdup(left.fileno())):
                value=C.AdmissionPhaseObserver.from_stderr()
            with value.stage(0):pass
            value.close();right.settimeout(1)
            data=right.recv(4096).decode().splitlines()
            self.assertEqual([json.loads(v[len(F.ADMISSION_PHASE_PREFIX):])['e'] for v in data],['enter','return'])
            self.assertEqual(C.fcntl.fcntl(left,C.fcntl.F_GETFL),flags);self.assertGreater(left.fileno(),0)
        finally:left.close();right.close()

    def test_file_stderr_emits_nothing_and_closes_only_duplicate(self):
        read,write=os.pipe();realdup=os.dup
        try:
            with patch.object(C.os,'dup',side_effect=lambda fd:realdup(write)):
                value=C.AdmissionPhaseObserver.from_stderr()
            self.assertTrue(value.disabled)
            with value.stage(0):pass
            value.close();os.write(write,b'x');self.assertEqual(os.read(read,1),b'x')
        finally:os.close(read);os.close(write)

    def test_nondefault_python_socket_timeout_disables_without_dup_or_flag_change(self):
        with patch.object(C.socket,'getdefaulttimeout',return_value=1),patch.object(C.os,'dup') as duplicate:
            self.assertTrue(C.AdmissionPhaseObserver.from_stderr().disabled);duplicate.assert_not_called()

    def test_exact_clock_elapsed_closed_fields_and_actual_send_flags(self):
        value=observer()
        with patch.object(C.time,'monotonic_ns',side_effect=[1000000,1005000]):
            with value.stage(0):pass
        parsed=F.parse_admission_phase_messages(messages(value),2)
        self.assertEqual(parsed['events'][1],{'v':1,'q':1,'p':0,'e':'return','t':1005,'d':5})
        self.assertTrue(all(flags==socket.MSG_DONTWAIT|socket.MSG_NOSIGNAL for _,flags in value.stream.data))

    def test_nested_same_stage_is_single_use_not_a_heartbeat(self):
        value=observer()
        with value.stage(0):
            with value.stage(0):pass
        with value.stage(0):pass
        self.assertEqual(len(value.stream.data),2)

    def test_short_eagain_eintr_and_send_errors_latch_no_application_retry(self):
        for failure in ['short',BlockingIOError(),InterruptedError(),OSError()]:
            value=observer(failure)
            with value.stage(0):pass
            with value.stage(1):pass
            self.assertTrue(value.disabled);self.assertEqual(len(value.stream.data),1)

    def test_async_send_abort_latches_and_propagates_before_original_body(self):
        for error in [KeyboardInterrupt(),SystemExit(7)]:
            value=observer(error);body=[]
            with self.assertRaises(type(error)) as caught:
                with value.stage(0):body.append('must-not-enter')
            self.assertIs(caught.exception,error);self.assertTrue(value.disabled)
            self.assertEqual(body,[]);self.assertEqual(len(value.stream.data),1)

    def test_original_baseexception_identity_survives_observer_failure(self):
        value=observer('short');error=KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt) as caught:
            with value.stage(0):raise error
        self.assertIs(caught.exception,error);self.assertEqual(len(value.stream.data),1)
        value=observer();primary=ValueError('fictional-original')
        with self.assertRaises(ValueError) as caught:
            with value.stage(0):
                value.stream.failure=KeyboardInterrupt()
                raise primary
        self.assertIs(caught.exception,primary);self.assertTrue(value.disabled)

    def test_backward_invalid_and_overflow_clock_disable_without_clamping(self):
        for clocks in [[1000000,999000],[-1],[9007199254740992000]]:
            value=observer()
            with patch.object(C.time,'monotonic_ns',side_effect=clocks):
                with value.stage(0):pass
            self.assertTrue(value.disabled);self.assertLessEqual(len(value.stream.data),1)

    def test_invalid_stage_never_changes_body_execution(self):
        for code in [True,-1,20,[],None]:
            value=observer();body=[]
            with value.stage(code):body.append('executed')
            self.assertEqual(body,['executed']);self.assertTrue(value.disabled);self.assertEqual(value.stream.data,[])

    def test_duplicate_close_is_safe_and_original_stream_not_closed(self):
        value=observer();stream=value.stream;value.close();value.close();self.assertEqual(stream.closed,1)

    def test_actual_main_refusal_and_short_prefix_do_not_claim_original_literal_capture(self):
        value=observer('short');stream=value.stream;output=io.StringIO()
        with patch.object(C.argparse.ArgumentParser,'parse_args',return_value=types.SimpleNamespace(operation='admit',unit=F.UNITS[0])),patch.object(C.os,'geteuid',return_value=0),patch.object(C,'INSTALLED',pathlib.Path(C.__file__).absolute()),patch.object(C,'secure_path'),patch.object(C,'Profile',side_effect=C.Refused('fixed-safe-refusal')),patch.object(C.AdmissionPhaseObserver,'from_stderr',return_value=value),contextlib.redirect_stderr(output):
            self.assertEqual(C.main(),1)
        mixed=stream.data[0][0][:-1].decode()+output.getvalue().rstrip('\n')
        self.assertEqual(receive(native_rows([mixed]))['state'],'unavailable');self.assertIn('fixed-safe-refusal',output.getvalue());self.assertEqual(stream.closed,1)

    def test_full_valid_trace_and_finite_report_frames(self):
        value=F.parse_admission_phase_messages(trace(),len(trace()))
        self.assertTrue(value['traceComplete']);self.assertEqual(value['activeStageCodes'],[]);self.assertEqual(value['lastReturnedStage'],19)
        self.assertLessEqual(len(json.dumps(value,separators=(',',':')).encode()),8192);self.assertLessEqual(len(json.dumps(value,indent=2).encode()),16384)
        emitted=observer()
        for _ in range(41):emitted.emit(19,'raised',9007199254740991,9007199254740991)
        self.assertEqual(len(emitted.stream.data),40);self.assertTrue(emitted.disabled)
        self.assertTrue(all(len(data)==97 for data,_ in emitted.stream.data[10:]));self.assertTrue(all(len(data)<=128 for data,_ in emitted.stream.data))

    def test_interrupted_prefix_retains_only_observed_active_stack(self):
        values=trace();index=next(i for i,v in enumerate(values) if json.loads(v[len(F.ADMISSION_PHASE_PREFIX):])['p']==8)
        value=F.parse_admission_phase_messages(values[:index+1],index+1)
        self.assertFalse(value['traceComplete']);self.assertEqual(value['activeStageCodes'],[3,8]);self.assertEqual(value['lastEnteredStage'],8)

    def test_duplicate_unknown_extra_fields_boolean_integer_and_invalid_duration_reject(self):
        for change in [{'v':True},{'q':True},{'p':20},{'e':'ok'},{'t':True},{'t':-1},{'t':9007199254740992},{'d':0},{'private':'fictional-secret'}]:
            values=pair();row=json.loads(values[0][len(F.ADMISSION_PHASE_PREFIX):]);row.update(change);values[0]=F.ADMISSION_PHASE_PREFIX+json.dumps(row)
            with self.assertRaises((ValueError,TypeError)):F.parse_admission_phase_messages(values,2)
        values=pair();values[0]=values[0][:-1]+',"v":1}'
        with self.assertRaises(ValueError):F.parse_admission_phase_messages(values,2)
        values=pair();row=json.loads(values[1][len(F.ADMISSION_PHASE_PREFIX):]);row['d']=0;values[1]=F.ADMISSION_PHASE_PREFIX+json.dumps(row)
        with self.assertRaises(ValueError):F.parse_admission_phase_messages(values,2)

    def test_profile_close_exit_rejects_any_later_previously_unused_stage(self):
        for outcome in ('return','raised'):
            prefix=pair()
            for row in [dict(v=1,q=2,p=19,e='enter',t=12,d=None),dict(v=1,q=3,p=19,e=outcome,t=13,d=1)]:
                prefix.append(F.ADMISSION_PHASE_PREFIX+json.dumps(row,separators=(',',':')))
            observed=F.parse_admission_phase_messages(prefix,4)
            self.assertEqual(observed['traceComplete'],outcome=='return')
            self.assertEqual(observed['activeStageCodes'],[])
            self.assertNotIn(1,[row['p'] for row in observed['events']])
            # An early main failure can close without admission. The unused
            # later stage satisfied all the old schema/sequence/stack guards.
            tail=[dict(v=1,q=4,p=1,e='enter',t=14,d=None),dict(v=1,q=5,p=1,e='return',t=15,d=1)]
            values=prefix+[F.ADMISSION_PHASE_PREFIX+json.dumps(row,separators=(',',':')) for row in tail]
            with self.assertRaises(ValueError):F.parse_admission_phase_messages(values,6)
            self.assertEqual(receive(native_rows(values)),F.unavailable_admission_phases())

    def test_sequence_gap_duplicate_exit_without_enter_and_illegal_stage_parent_reject(self):
        for values in [pair()[1:],pair()+pair(),pair()+[pair()[0]],trace()[2:],pair()+[F.ADMISSION_PHASE_PREFIX+json.dumps({'v':1,'q':2,'p':8,'e':'enter','t':20,'d':None})]]:
            with self.assertRaises(ValueError):F.parse_admission_phase_messages(values,len(values))

    def test_raw_count_exact64_overflow_empty_and_overlong_frames_reject(self):
        for values,count in [(pair(),64),(pair(),True),([],1),(pair()*21,42),([F.ADMISSION_PHASE_PREFIX+'x'*128],1)]:
            with self.assertRaises(ValueError):F.parse_admission_phase_messages(values,count)

    def test_full_next_receiver_requires_every_native_field_and_exact_c_argv(self):
        self.assertEqual(receive(native_rows(pair()))['state'],'incomplete-prefix')
        for key,value in [('_UID','1001'),('_EXE','/bin/sh'),('_SYSTEMD_UNIT',H.UNIT),('_SYSTEMD_INVOCATION_ID','b'*32),('_CMDLINE','/usr/bin/python3 -I -B /usr/local/lib/aihr-admission/next_fixture_poststart.py '+F.UNITS[0]),('_TRANSPORT','journal'),('_LINE_BREAK','eof'),('_LINE_BREAK','nul'),('_LINE_BREAK','line-max'),('_LINE_BREAK','pid-change')]:
            self.assertEqual(receive(native_rows(pair(),**{key:value}))['state'],'unavailable')

    def test_full_next_receiver_requires_both_exact_source_hashes_and_no_partial_claim(self):
        sources,bound=binding()
        for name in ['controller.py','test_next_native.py']:
            bad=copy.deepcopy(bound);bad['helpers'][name]['sha256']='0'*64
            value=receive(native_rows(pair()),sources=sources,binding=bad)
            self.assertEqual(value,F.unavailable_admission_phases());self.assertNotIn('fictional-secret',json.dumps(value))

    def test_original_literal_receiver_and_helper_owners_remain_independent(self):
        terminal='Admission failed: ValueError; reconcile before retry';rows=native_rows(pair()+[terminal])
        value=F.runtime_journal_observation(raw(rows),F.UNITS[0],'a'*32,'/usr/bin/python3.12',{})
        self.assertEqual(value['closedExceptions'],['ValueError']);self.assertEqual(receive(rows)['events'],F.parse_admission_phase_messages(pair(),3)['events'])

    def test_host_four_packets_require_exact_distinct_argv_and_actual_same_private_pid(self):
        value=H.parse_host_admission_handoff(raw(host_rows()),'a'*32,'/usr/bin/python3.12',F)
        self.assertEqual(value['state'],'observed');self.assertTrue(value['samePidObserved']);self.assertNotIn('2345',json.dumps(value));self.assertFalse(value['fullControllerAdmissionVerified'])

    def test_cached_old_or_new_host_metadata_is_never_reclassified_by_order(self):
        for command in ['hook-pre','hook-pre-handoff']:
            rows=host_rows()
            for row in rows:row['_CMDLINE']='/usr/bin/python3 -I -B '+str(H.ROOT/'probe.py')+' '+command
            with self.assertRaises((AssertionError,ValueError)):H.parse_host_admission_handoff(raw(rows),'a'*32,'/usr/bin/python3.12',F)

    def test_host_foreign_pid_metadata_transport_or_source_course_reject(self):
        for key,value in [('_PID','2346'),('_PID','02345'),('_UID','1001'),('_CMDLINE','/usr/bin/python3 -I -B '+str(H.ROOT/'probe.py')+' hook'),('_EXE','/bin/sh'),('_SYSTEMD_UNIT',F.UNITS[0]),('_SYSTEMD_INVOCATION_ID','b'*32),('_TRANSPORT','journal'),('_LINE_BREAK','eof')]:
            rows=host_rows();rows[-1][key]=value
            with self.assertRaises((AssertionError,ValueError)):H.parse_host_admission_handoff(raw(rows),'a'*32,'/usr/bin/python3.12',F)

    def test_host_clock_reverse_truncated_duplicate_or_missing_pairs_reject(self):
        rows=host_rows();rows[2]['MESSAGE']=pair(1)[0];rows[3]['MESSAGE']=pair(1)[1]
        for value in [rows,host_rows()[:2],host_rows()+host_rows(),host_rows()+[{}]*60]:
            with self.assertRaises((AssertionError,ValueError)):H.parse_host_admission_handoff(raw(value),'a'*32,'/usr/bin/python3.12',F)

    def test_host_single_bounded_read_unavailable_has_no_boolean_or_raw_claim(self):
        failures=[TimeoutError('fictional-secret'),OSError('fictional-secret')]
        for error in failures:
            with patch.object(H,'secure'),patch.object(H,'limit',return_value=.5),patch.object(F,'runtime_diagnostic_read',side_effect=error) as read:
                value=H.host_admission_handoff(F,'a'*32)
            self.assertEqual(value,H.unavailable_admission_handoff(2));self.assertEqual(read.call_count,1);self.assertNotIn('fictional-secret',json.dumps(value))

    def test_actual_prestart_is_one_fixed_same_pid_exec_with_observer_closed_first(self):
        value=observer();stream=value.stream;calls=[]
        with patch.object(H,'handoff_observer',return_value=value),patch.object(H,'secure'),patch.object(H.os,'execve',side_effect=lambda *args:calls.append((args,stream.closed))):H.prestart_handoff()
        self.assertEqual(len(calls),1);args,closed=calls[0];self.assertEqual(closed,1)
        self.assertEqual(args,('/usr/bin/python3',['/usr/bin/python3','-I','-B',str(H.ROOT/'probe.py'),'hook-pre-handoff'],H.ENV));self.assertEqual(len(stream.data),2)

    def test_actual_state_admit_with_observer_preserves_ready_and_idempotent_fencing(self):
        model=S.StateTests('runTest');model.setUp()
        try:
            value=observer();model.controller.admission_timing=value
            generation=model.admit();before=model.controller.store.read()
            self.assertEqual(before['generations'][generation['id']]['phase'],'READY')
            model.controller.admit(generation['unit'],generation['invocation']);self.assertEqual(before,model.controller.store.read())
            with self.assertRaises(C.Refused):model.controller.admit(generation['unit'],'f'*32)
        finally:model.tearDown()

    def test_actual_state_repeat_health_has_one_repeat_span_and_no_added_attempt(self):
        model=S.StateTests('runTest');model.setUp()
        try:
            generation=model.reserve();value=observer();model.controller.admission_timing=value;calls=[]
            def health(port):calls.append(port);return len(calls)==2
            model.host.health=health
            with patch.object(C.time,'sleep') as sleep:model.controller.admit(generation['unit'],generation['invocation'])
            rows=[json.loads(v[len(F.ADMISSION_PHASE_PREFIX):]) for v in messages(value)]
            self.assertEqual(len(calls),2);self.assertEqual([row['e'] for row in rows if row['p']==11],['enter','return']);sleep.assert_called_once_with(.05)
        finally:model.tearDown()

    def test_actual_state_publication_failure_still_raises_and_does_not_admit(self):
        model=S.StateTests('runTest');model.setUp()
        try:
            generation=model.reserve();model.host.ready.add(generation['port']);model.host.fail_validate=True
            value=observer();model.controller.admission_timing=value
            with self.assertRaises(C.Refused):model.controller.admit(generation['unit'],generation['invocation'])
            self.assertNotEqual(model.controller.store.read()['generations'][generation['id']]['phase'],'READY')
            rows=[json.loads(v[len(F.ADMISSION_PHASE_PREFIX):]) for v in messages(value)];self.assertIn((16,'raised'),[(r['p'],r['e']) for r in rows])
        finally:model.tearDown()

    def test_actual_linux_worker_resource_typed_runtime_and_final_guards_remain_ordered(self):
        calls=[];identity={'pid':101,'startTicks':7};unit=F.UNITS[0]
        runtime=types.SimpleNamespace(resource_state=lambda *args:calls.append('resource') or {},
            worker=lambda *args:calls.append('runtime') or {'proof':True})
        profile=types.SimpleNamespace(next_runtime=runtime,value={'units':{unit:{'workerUid':1001,'executable':'/usr/bin/node','releaseDirectory':'/opt/fictional'}},'runtimePackage':{'manifestSha256':'a'*64}})
        host=C.LinuxHost(profile);value=observer();host.admission_timing=value
        props={'ActiveState':'activating','SubState':'start-post','MainPID':'101'}
        host.invocation=lambda *args:calls.append('invocation') or props
        host.next_bindings=lambda *args:calls.append('typed') or {}
        host.owns_listener=lambda *args:calls.append('listener') or True
        with patch.object(C,'process_identity',return_value=identity),patch.object(C,'alive',return_value=True),patch.object(C.pathlib.Path,'stat',return_value=types.SimpleNamespace(st_uid=1001)),patch.object(C.os.path,'realpath',side_effect=lambda name:'/usr/bin/node' if name.endswith('/exe') else '/opt/fictional'):
            self.assertEqual(host.worker(unit,'a'*32,3201),identity)
        self.assertEqual(calls,['invocation','resource','typed','runtime','listener','invocation'])
        rows=[json.loads(v[len(F.ADMISSION_PHASE_PREFIX):]) for v in messages(value)]
        self.assertEqual([row['p'] for row in rows if row['e']=='enter'],[5,6,7,8,9])
        self.assertEqual(host.next_worker_evidence[unit]['namespace'],{'proof':True})

    def test_actual_main_profile_close_failure_is_not_hidden_by_observer(self):
        value=observer(OSError());stream=value.stream;failure=ValueError('fictional-private-close')
        def close():
            stream.closed+=1
            raise KeyboardInterrupt()
        stream.close=close
        profile=types.SimpleNamespace(value={'controllerDigest':hashlib.sha256(pathlib.Path(C.__file__).read_bytes()).hexdigest(),'units':{F.UNITS[0]:{}}},close=lambda:(_ for _ in ()).throw(failure))
        controller=types.SimpleNamespace(host=types.SimpleNamespace(),admit=lambda *args:None)
        with patch.object(C.argparse.ArgumentParser,'parse_args',return_value=types.SimpleNamespace(operation='admit',unit=F.UNITS[0])),patch.object(C.os,'geteuid',return_value=0),patch.object(C,'INSTALLED',pathlib.Path(C.__file__).absolute()),patch.object(C,'secure_path'),patch.object(C,'Profile',return_value=profile),patch.object(C,'Controller',return_value=controller),patch.object(C.AdmissionPhaseObserver,'from_stderr',return_value=value),patch.dict(C.os.environ,{'INVOCATION_ID':'a'*32},clear=True):
            with self.assertRaises(ValueError) as caught:C.main()
        self.assertIs(caught.exception,failure);self.assertEqual(stream.closed,1)

    def test_metadata_duplicate_fields_and_complete_json_eof_are_unavailable(self):
        for mode in ['eof','nul','pid-change','line-max']:
            self.assertEqual(receive(native_rows(pair(),_LINE_BREAK=mode)),F.unavailable_admission_phases())
        rows=native_rows(pair());encoded=raw(rows).decode().replace('"_UID": "0"','"_UID": "0", "_UID": "0"')
        sources,bound=binding()
        value=F.runtime_admission_phase_diagnostic(encoded.encode(),F.UNITS[0],'a'*32,'/usr/bin/python3.12',sources,bound)
        self.assertEqual(value,F.unavailable_admission_phases())

    def test_source_hook_guard_body_and_controller_lexical_rewind_are_whole(self):
        for manifest in ('next_controller_admit_terminal_inverse.json','next_controller_admit_timing_inverse.json'):
            inverse=json.loads((ROOT/'deploy/admission'/manifest).read_text())
            for name,row in inverse['files'].items():
                data=(ROOT/name).read_bytes();self.assertEqual(hashlib.sha256(data).hexdigest(),row['currentSha256']);lines=data.decode().splitlines(keepends=True)
                for change in row['changes']:
                    self.assertEqual(''.join(lines[change['start']:change['end']]),change['after']);lines[change['start']:change['end']]=change['before'].splitlines(keepends=True)
                restored=''.join(lines).encode();self.assertEqual(restored,base64.b64decode(row['originalBase64']));self.assertEqual(hashlib.sha256(restored).hexdigest(),row['originalSha256'])
        def function(source,name):return ast.get_source_segment(source,next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name==name))
        path='deploy/admission/test_next_host_view_native.py';old=base64.b64decode(inverse['files'][path]['originalBase64']).decode()
        self.assertEqual(function(old,'hook'),function((ROOT/path).read_text(),'hook'))
        for path,digest in inverse['unchangedOwners'].items():self.assertEqual(hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),digest)


    def _read_handoff_result(self, data=None, status=0, invocation='a'*32, error=None):
        with patch.object(H.pathlib.Path,'resolve',return_value=pathlib.Path('/usr/bin/python3.12')), \
                patch.object(H,'secure'),patch.object(H,'limit',return_value=.5), \
                patch.object(H.time,'monotonic',return_value=100),patch.object(H,'DEADLINE',200), \
                patch.object(F,'runtime_diagnostic_read',return_value=(status,raw(host_rows()) if data is None else data),side_effect=error) as read:
            value=H.host_admission_handoff(F,invocation)
        read.assert_called_once_with(['/usr/bin/journalctl','--system','--no-pager','--quiet','--output=json',
            '--output-fields=_UID,_EXE,_CMDLINE,_PID,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,_TRANSPORT,_LINE_BREAK,MESSAGE',
            '--lines=64','_SYSTEMD_UNIT='+H.UNIT,'_SYSTEMD_INVOCATION_ID='+invocation],100.5)
        return value

    def _assert_handoff_result(self, value, code):
        positive=code==0
        self.assertEqual(value,{'kind':'ACTUAL_SAME_PID_EXEC_JOURNAL_AVAILABILITY_NOT_ADMISSION',
            'state':'observed' if positive else 'unavailable','beforePairVerified':positive,'afterPairVerified':positive,
            'samePidObserved':positive,'exactDistinctArgvObserved':positive,'actualSharedEmitterTransportVerified':positive,
            'fullControllerAdmissionVerified':False,'nextApplicationVerified':False,'releaseEligible':False,'refusalCode':code})
        self.assertIs(type(value['refusalCode']),int)
        for name in ('beforePairVerified','afterPairVerified','samePidObserved','exactDistinctArgvObserved',
                'actualSharedEmitterTransportVerified','fullControllerAdmissionVerified','nextApplicationVerified','releaseEligible'):
            self.assertIs(type(value[name]),bool)

    def test_handoff_refusal_01_real_pair_is_code_zero_and_never_admission(self):
        self._assert_handoff_result(self._read_handoff_result(),0)
        # Unrelated non-packet rows stay ignorable under the original line cap.
        self._assert_handoff_result(self._read_handoff_result(raw([{'MESSAGE':'fictional unrelated log'}]+host_rows())),0)

    def test_handoff_refusal_02_preflight_code_one_precedes_any_read(self):
        for target in ('resolve','secure','limit'):
            patches={'resolve':patch.object(H.pathlib.Path,'resolve',side_effect=OSError('fictional-private-path')),
                'secure':patch.object(H,'secure',side_effect=AssertionError('fictional-private-owner')),
                'limit':patch.object(H,'limit',side_effect=AssertionError('fictional-private-deadline'))}
            with self.subTest(target=target),patch.object(F,'runtime_diagnostic_read') as read, \
                    patch.object(H.pathlib.Path,'resolve',return_value=pathlib.Path('/usr/bin/python3.12')), \
                    patch.object(H,'secure'),patch.object(H,'limit',return_value=.5),patches[target]:
                value=H.host_admission_handoff(F,'a'*32)
            read.assert_not_called();self._assert_handoff_result(value,1)

    def test_handoff_refusal_03_read_code_two_does_not_clear_mandatory_settlement(self):
        for error in (TimeoutError('fictional-private-timeout'),RuntimeError('fictional-private-settlement'),KeyboardInterrupt('fictional-private-async')):
            def refused(*_args):
                F.report['diagnosticChildrenSettled']=False
                raise error
            with self.subTest(error=type(error).__name__),patch.object(F,'report',{}):
                self._assert_handoff_result(self._read_handoff_result(error=refused),2)
                self.assertIs(F.report['diagnosticChildrenSettled'],False)
        source=pathlib.Path(H.__file__).read_text()
        final=source.index("report['admissionHandoffTransportSettled'] = not")
        self.assertLess(final,source.index("errors.append(RuntimeError('Component diagnostic transport settlement unavailable'))",final))

    def test_handoff_refusal_04_nonzero_status_code_three_precedes_bad_raw(self):
        for status in (-1,1,127):
            with self.subTest(status=status):self._assert_handoff_result(self._read_handoff_result(b'fictional-private-invalid-json',status),3)

    def test_handoff_refusal_05_input_and_line_codes_four_five_preserve_bounds(self):
        for data in ('fictional-private-string',b'x'*131073):
            with self.subTest(kind=type(data).__name__):self._assert_handoff_result(self._read_handoff_result(data),4)
        for invocation in ('','not-an-invocation'):
            self._assert_handoff_result(self._read_handoff_result(b'bad-json',invocation=invocation),4)
        for data in (b'',b'\n'*64,raw(host_rows()+[{}]*60)):
            self._assert_handoff_result(self._read_handoff_result(data),5)
        self._assert_handoff_result(self._read_handoff_result(raw(host_rows()+[{}]*59)),0)

    def test_handoff_refusal_06_json_code_six_does_not_reflect_private_rows(self):
        duplicate=b'{"MESSAGE":"fictional-private-row","MESSAGE":"fictional-private-duplicate"}\n'
        for data in (b'fictional-private-malformed\n',b'\xff\n',duplicate,duplicate+raw(host_rows())):
            value=self._read_handoff_result(data);self._assert_handoff_result(value,6)
            self.assertNotIn('fictional-private',json.dumps(value))

    def test_handoff_refusal_07_origin_argv_pid_codes_seven_eight_nine_short_circuit(self):
        changes=[(7,key,value) for key,value in [('_UID','1001'),('_EXE','/bin/fictional-private'),
            ('_SYSTEMD_UNIT','fictional-private.service'),('_SYSTEMD_INVOCATION_ID','b'*32),('_TRANSPORT','journal'),('_LINE_BREAK','eof')]]
        changes += [(8,'_CMDLINE',None),(8,'_CMDLINE','fictional-private-command')]
        changes += [(9,'_PID',value) for value in (None,'0','02345','2147483648','12345678901','fictional-private-pid')]
        for code,key,value in changes:
            rows=host_rows();rows[0][key]=value
            with self.subTest(code=code,key=key):self._assert_handoff_result(self._read_handoff_result(raw(rows)),code)
        rows=host_rows();rows[0].update(_UID='1001',_CMDLINE='fictional-private-command',_PID='0')
        self._assert_handoff_result(self._read_handoff_result(raw(rows)),7)
        rows[0]['_UID']='0';self._assert_handoff_result(self._read_handoff_result(raw(rows)),8)
        rows[0]['_CMDLINE']=host_rows()[0]['_CMDLINE'];self._assert_handoff_result(self._read_handoff_result(raw(rows)),9)

    def test_handoff_refusal_08_pair_codes_ten_eleven_keep_cached_metadata_untrusted(self):
        for rows,code in ((host_rows()[2:],10),(host_rows()[:2],11),(host_rows()+host_rows(),10)):
            self._assert_handoff_result(self._read_handoff_result(raw(rows)),code)
        for command in ('hook-pre','hook-pre-handoff'):
            rows=host_rows()
            for row in rows:row['_CMDLINE']='/usr/bin/python3 -I -B '+str(H.ROOT/'probe.py')+' '+command
            self._assert_handoff_result(self._read_handoff_result(raw(rows)),10)
        rows=host_rows();rows[1]['_PID']='2346'
        self._assert_handoff_result(self._read_handoff_result(raw(rows)),10)
        rows=host_rows();rows[3]['_PID']='2346'
        self._assert_handoff_result(self._read_handoff_result(raw(rows)),11)

    def test_handoff_refusal_09_codec_codes_twelve_thirteen_keep_before_order(self):
        for index,code in ((0,12),(2,13)):
            rows=host_rows();rows[index]['MESSAGE']=F.ADMISSION_PHASE_PREFIX+'fictional-private-malformed'
            self._assert_handoff_result(self._read_handoff_result(raw(rows)),code)
        rows=host_rows()[:2];rows[0]['MESSAGE']=F.ADMISSION_PHASE_PREFIX+'fictional-private-malformed'
        # Before decoder refusal precedes the later missing after pair.
        self._assert_handoff_result(self._read_handoff_result(raw(rows)),12)

    def test_handoff_refusal_10_shape_codes_fourteen_fifteen_keep_before_order(self):
        for index,code in ((1,14),(3,15)):
            rows=host_rows();row=json.loads(rows[index]['MESSAGE'][len(F.ADMISSION_PHASE_PREFIX):]);row['e']='raised'
            rows[index]['MESSAGE']=F.ADMISSION_PHASE_PREFIX+json.dumps(row,separators=(',',':'))
            self._assert_handoff_result(self._read_handoff_result(raw(rows)),code)
            if index==1:self._assert_handoff_result(self._read_handoff_result(raw(rows[:2])),14)

    def test_handoff_refusal_11_same_pid_clock_codes_sixteen_seventeen_are_ordered(self):
        rows=host_rows();rows[2]['MESSAGE']=pair(1)[0];rows[3]['MESSAGE']=pair(1)[1]
        self._assert_handoff_result(self._read_handoff_result(raw(rows)),17)
        for row in rows[2:]:row['_PID']='2346'
        self._assert_handoff_result(self._read_handoff_result(raw(rows)),16)
        rows=host_rows()
        for row in rows[2:]:row['_PID']='2346'
        self._assert_handoff_result(self._read_handoff_result(raw(rows)),16)
        # The existing non-strict clock relation permits a shared boundary.
        rows=host_rows();rows[2]['MESSAGE']=pair(11)[0];rows[3]['MESSAGE']=pair(11)[1]
        self._assert_handoff_result(self._read_handoff_result(raw(rows)),0)

    def test_handoff_refusal_12_unexpected_invalid_code_privacy_and_exact_size(self):
        for error in (KeyError('fictional-private-unknown'),KeyboardInterrupt('fictional-private-async')):
            with patch.object(H,'parse_host_admission_handoff',side_effect=error):
                self._assert_handoff_result(self._read_handoff_result(),18)
        for code in (True,False,None,'1',0,-1,19,1.0):
            for make in (H.unavailable_admission_handoff,H._HandoffRefusal):
                with self.subTest(code=code,make=make.__name__),self.assertRaises(AssertionError):make(code)
        baseline={'kind':'ACTUAL_SAME_PID_EXEC_JOURNAL_AVAILABILITY_NOT_ADMISSION','state':'unavailable',
            'beforePairVerified':False,'afterPairVerified':False,'samePidObserved':False,'exactDistinctArgvObserved':False,
            'actualSharedEmitterTransportVerified':False,'fullControllerAdmissionVerified':False,'nextApplicationVerified':False,'releaseEligible':False}
        self.assertEqual(len(json.dumps(baseline,separators=(',',':')).encode()),340)
        self.assertEqual(len(json.dumps(baseline).encode()),359)
        for code in range(1,19):
            value=H.unavailable_admission_handoff(code);self._assert_handoff_result(value,code)
            self.assertEqual(len(json.dumps(value,separators=(',',':')).encode()),356+(code>=10))
            self.assertEqual(len(json.dumps(value).encode()),377+(code>=10))
            self.assertNotIn('fictional-private',json.dumps(value))
        worst=H.unavailable_admission_handoff(18)
        self.assertEqual(2*(len(json.dumps(worst,separators=(',',':')).encode())-340),34)
        self.assertEqual(2*(len(json.dumps(worst).encode())-359),38)

class FreshChildOriginModels(unittest.TestCase):
    def rows(self):
        result=[]
        for mode,pid,values in [('hook-post',2345,pair(10)),('hook-post-child',2346,pair(20))]:
            result.extend(native_rows(values,_SYSTEMD_UNIT=H.UNIT,_PID=str(pid),_CMDLINE='/usr/bin/python3 -I -B '+str(H.ROOT/'probe.py')+' '+mode))
        return result

    def parse(self,rows=None,**changes):
        return H.parse_fresh_child_handoff(raw(self.rows() if rows is None else rows),changes.get('invocation','a'*32),'/usr/bin/python3.12',F,changes.get('parent',2345),changes.get('child',2346))

    def test_fresh_origin_real_codec_requires_distinct_private_live_identities(self):
        value=self.parse();self.assertEqual(value['kind'],'ACTUAL_FRESH_CHILD_JOURNAL_AVAILABILITY_NOT_ADMISSION')
        self.assertTrue(value['parentPairVerified'] and value['childPairVerified'] and value['distinctPidsObserved'])
        self.assertNotIn('samePidObserved',value);self.assertFalse(value['fullControllerAdmissionVerified'] or value['nextApplicationVerified'] or value['releaseEligible'])
        with self.assertRaises(AssertionError):self.parse(parent=2345,child=2345)
        with self.assertRaises(AssertionError):self.parse(parent=2347)

    def test_fresh_origin_missing_duplicate_cached_pid_and_incomplete_newline_refuse(self):
        rows=self.rows()
        for changed in (rows[:-1],rows+[rows[0]],[dict(r,_PID='2345') for r in rows],[dict(r,_CMDLINE=rows[0]['_CMDLINE']) for r in rows],list(reversed(rows))):
            with self.subTest(rows=len(changed)),self.assertRaises(AssertionError):self.parse(changed)
        with self.assertRaises(AssertionError):H.parse_fresh_child_handoff(raw(rows)[:-1],'a'*32,'/usr/bin/python3.12',F,2345,2346)
        rows=self.rows();rows[2]['MESSAGE']=pair(0)[0]
        with self.assertRaises(AssertionError):self.parse(rows)

    def test_fresh_origin_foreign_privilege_argv_linebreak_and_source_binding_refuse(self):
        for key,value in [('_UID','65534'),('_EXE','/foreign'),('_SYSTEMD_UNIT',H.FOREIGN),('_SYSTEMD_INVOCATION_ID','b'*32),('_TRANSPORT','journal'),('_CMDLINE','foreign'),('_LINE_BREAK','pid-change')]:
            rows=self.rows();rows[0][key]=value
            with self.subTest(key=key),self.assertRaises(AssertionError):self.parse(rows)
        import types
        binding={name:'a'*64 for name in H.HOST_SOURCES}
        with patch.object(H,'_held_host_file',side_effect=[json.dumps(binding).encode(),b'not sealed']),patch.object(H.types,'ModuleType') as module:
            with self.assertRaises(AssertionError):H._bound_host_module('next_fixture_poststart.py','model')
            module.assert_not_called()

    def test_fresh_schedule_absolute_frontiers_and_invocation_bound_records_are_not_authority(self):
        with patch.object(H,'TOTAL_DEADLINE',127),patch.object(H,'DEADLINE',120),patch.object(H,'PHASE_DEADLINE',107),patch.object(H,'WORK_PHASE_ACTIVE',True),patch.object(H.time,'monotonic',return_value=106.75):
            self.assertEqual(H.limit(3),.25)
            with patch.object(H,'STARTED',100):
                H._advance_work_phase(11);self.assertEqual(H.PHASE_DEADLINE,111)
                with patch.object(H.time,'monotonic',return_value=111.1),self.assertRaises(AssertionError):H._advance_work_phase(13)
        with patch.object(H,'TOTAL_DEADLINE',127),patch.object(H,'DEADLINE',126),patch.object(H,'PHASE_DEADLINE',107),patch.object(H,'WORK_PHASE_ACTIVE',False),patch.object(H.time,'monotonic',return_value=121):
            self.assertEqual(H.limit(3),3)  # Existing cleanup frontier remains independent.
        for packet in [b'{"version":true,"invocation":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',b'{"version":1,"version":1,"invocation":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',b'{"version":1,"invocation":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}',b'{"version":1,"invocation":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","extra":0}']:
            with patch.object(H,'_held_host_file',return_value=packet),self.assertRaises(AssertionError):H._read_host_record('post-child-ready.json','a'*32)
        with patch.object(H,'_held_host_file',return_value=b'{"version":1,"invocation":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'),patch.object(H.pathlib.Path,'lstat') as stat_,patch.object(H.pathlib.Path,'unlink') as unlink:
            with self.assertRaises(AssertionError):H._forget_record('post-child-ready.json','a'*32,(stat_.return_value.st_dev,stat_.return_value.st_ino))
            unlink.assert_not_called()
        old, new = 'a'*32, 'b'*32
        candidates = ['', old, old, new]
        self.assertEqual([H._new_invocation_ready(value, old) for value in candidates], [False, False, False, True])
        self.assertTrue(H._new_invocation_ready(new, None))
        for candidate, previous in [(True,old),('foreign',old),(new,''),(new,False)]:
            with self.subTest(candidate=candidate),self.assertRaises(AssertionError):H._new_invocation_ready(candidate,previous)
        for now, accepted in [(105.94,True),(105.95,False),(106,False)]:
            with self.subTest(now=now),patch.object(H,'STARTED',100),patch.object(H,'TOTAL_DEADLINE',127),patch.object(H,'DEADLINE',120),patch.object(H,'PHASE_DEADLINE',107),patch.object(H,'WORK_PHASE_ACTIVE',True),patch.object(H.time,'monotonic',return_value=now):
                if accepted:H._admit_initial_observer_slot()
                else:
                    with self.assertRaises(AssertionError):H._admit_initial_observer_slot()
        with patch.object(H,'WORK_PHASE_ACTIVE',False),self.assertRaises(AssertionError):H._admit_initial_observer_slot()


if __name__ == '__main__':
    unittest.main()
