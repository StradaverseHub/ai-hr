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
            self.assertEqual(value,H.unavailable_admission_handoff());self.assertEqual(read.call_count,1);self.assertNotIn('fictional-secret',json.dumps(value))

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
        inverse=json.loads((ROOT/'deploy/admission/next_controller_admit_timing_inverse.json').read_text())
        for name,row in inverse['files'].items():
            data=(ROOT/name).read_bytes();self.assertEqual(hashlib.sha256(data).hexdigest(),row['currentSha256']);lines=data.decode().splitlines(keepends=True)
            for change in row['changes']:
                self.assertEqual(''.join(lines[change['start']:change['end']]),change['after']);lines[change['start']:change['end']]=change['before'].splitlines(keepends=True)
            restored=''.join(lines).encode();self.assertEqual(restored,base64.b64decode(row['originalBase64']));self.assertEqual(hashlib.sha256(restored).hexdigest(),row['originalSha256'])
        def function(source,name):return ast.get_source_segment(source,next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name==name))
        path='deploy/admission/test_next_host_view_native.py';old=base64.b64decode(inverse['files'][path]['originalBase64']).decode()
        self.assertEqual(function(old,'hook'),function((ROOT/path).read_text(),'hook'))
        for path,digest in inverse['unchangedOwners'].items():self.assertEqual(hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),digest)

if __name__=='__main__':unittest.main()
