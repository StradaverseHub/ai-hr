"""Pure constructor/decoder/failure/source models; no actual manager, app or DB."""
import ast
import base64
import hashlib
import json
import pathlib
import stat
import sys
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_next_environment_observation as old
N, P, F = old.N, old.P, old.F
H = old.load('manager_host_model', ROOT / 'deploy/admission/test_next_host_view_native.py')
PUBLIC = b'#!/bin/sh\n# Default to "out-of-proc" attestation\necho SGX_AESM_ADDR=1\n'


def payload(*rows):
    return json.dumps({'type': 'as', 'data': list(rows)}, ensure_ascii=False).encode()


class ManagerEnvironmentModels(unittest.TestCase):
    def test_primary_busctl255_variant_as_has_direct_string_array(self):
        self.assertEqual(N.manager_environment_keys(b'{"type":"as","data":["Z=fictional=a","A="]}'), ('A', 'Z'))
        self.assertEqual(N.manager_environment_keys(payload()), ())
        self.assertEqual(N.manager_environment_keys(payload('A=鍵', '_=fictional')), ('A', '_'))

    def test_nested_array_is_not_the_primary_busctl_wire_format(self):
        for value in ({'type': 'as', 'data': [['A=x']]}, {'type': 'a{ss}', 'data': ['A=x']},
                {'type': 'as', 'data': {'A': 'x'}}, {'data': ['A=x']}, {'type': 'as', 'data': [], 'extra': True}):
            with self.assertRaisesRegex(ValueError, '^Manager environment metadata refused$'):
                N.manager_environment_keys(json.dumps(value).encode())

    def test_duplicate_json_fields_or_assignment_names_refuse(self):
        for raw in (b'{"type":"as","type":"as","data":[]}', b'{"type":"as","data":[],"data":[]}', payload('A=x', 'A=y')):
            with self.assertRaises(ValueError):N.manager_environment_keys(raw)

    def test_malformed_utf8_json_types_and_deep_json_refuse_without_reflection(self):
        for raw in (b'\xff', b'{fictional-secret', b'null', b'[]', b'"fictional-secret"', b'['*1500 + b']'*1500, b''):
            with self.assertRaisesRegex(ValueError, '^Manager environment metadata refused$') as caught:N.manager_environment_keys(raw)
            self.assertNotIn('fictional-secret', str(caught.exception))
        for raw in ('{}', bytearray(b'{}'), memoryview(b'{}'), None):
            with self.assertRaises(ValueError):N.manager_environment_keys(raw)

    def test_exact_raw_byte_limit_has_no_value_size_or_value_hash_output(self):
        prefix=b'{"type":"as","data":["A=';suffix=b'"]}'
        raw=prefix+b'x'*(131072-len(prefix)-len(suffix))+suffix
        self.assertEqual(len(raw),131072);self.assertEqual(N.manager_environment_keys(raw),('A',))
        with self.assertRaises(ValueError):N.manager_environment_keys(raw+b' ')

    def test_exact128_key_limit_and129_refusal(self):
        self.assertEqual(len(N.manager_environment_keys(payload(*('A'+str(i)+'=x' for i in range(128))))),128)
        with self.assertRaises(ValueError):N.manager_environment_keys(payload(*('A'+str(i)+'=x' for i in range(129))))

    def test_name_grammar_and128_boundary_are_closed(self):
        self.assertEqual(N.manager_environment_keys(payload('A'*128+'=x')),('A'*128,))
        for name in ('A'*129,'','1A','A-B','A B','鍵','A\nB','A\0B'):
            with self.assertRaises(ValueError):N.manager_environment_keys(payload(name+'=x'))
        for row in ('NO_ASSIGNMENT',7,None,True,'A=x\0y'):
            with self.assertRaises(ValueError):N.manager_environment_keys(payload(row))

    def test_generic_projection_has_no_sgx_special_case(self):
        keys=('SGX_AESM_ADDR','FUTURE_MANAGER_KEY','INVOCATION_ID','NODE_ENV','LC_CTYPE','_')
        self.assertEqual(N.manager_unset_environment(keys),('FUTURE_MANAGER_KEY','LC_CTYPE','SGX_AESM_ADDR','_'))
        self.assertNotIn('SGX', __import__('inspect').getsource(N.manager_unset_environment))

    def test_every_existing_app_fleet_systemd_name_is_preserved(self):
        allowed=N.APP_ENVIRONMENT|N.FLEET_ENVIRONMENT|N.SYSTEMD_ENVIRONMENT
        self.assertNotIn('MAINPID',allowed);self.assertIn('INVOCATION_ID',allowed)
        self.assertEqual(N.manager_unset_environment(tuple(sorted(allowed))),())
        self.assertEqual(N.manager_unset_environment(tuple(sorted(allowed|{'FUTURE_MANAGER_KEY'}))),('FUTURE_MANAGER_KEY',))

    def test_forbidden_loader_credentials_and_observation_names_never_become_allowed(self):
        names=('LD_PRELOAD','NODE_OPTIONS','GITHUB_TOKEN','LANGUAGE','FICTIONAL_OTHER')
        self.assertEqual(N.manager_unset_environment(names),tuple(sorted(names)))
        for name in names:self.assertNotIn(name,N.APP_ENVIRONMENT|N.FLEET_ENVIRONMENT|N.SYSTEMD_ENVIRONMENT)

    def test_non_tuple_duplicate_or_invalid_projection_input_refuses(self):
        for value in (['A'],{'A':'x'},('A','A'),('A=B',),(True,),('A'*129,),tuple('A'+str(i) for i in range(129))):
            with self.assertRaises(ValueError):N.manager_unset_environment(value)

    def test_mainpid_collision_refuses_all_exec_control_input_erasure(self):
        for keys in (('MAINPID',),('SGX_AESM_ADDR','MAINPID'),('MAINPID','INVOCATION_ID')):
            with self.assertRaisesRegex(ValueError,'control-input collision refused'):N.manager_unset_environment(keys)
        tree=ast.parse((ROOT/'deploy/admission/next_fixture_poststart.py').read_text())
        consumed=set()
        for node in ast.walk(tree):
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Attribute) and isinstance(node.func.value.value,ast.Name) and node.func.value.value.id=='os' and node.func.value.attr=='environ' and node.args and isinstance(node.args[0],ast.Constant):consumed.add(node.args[0].value)
            if isinstance(node,ast.Subscript) and isinstance(node.value,ast.Attribute) and isinstance(node.value.value,ast.Name) and node.value.value.id=='os' and node.value.attr=='environ' and isinstance(node.slice,ast.Constant):consumed.add(node.slice.value)
        self.assertEqual(consumed,{'MAINPID','INVOCATION_ID'})

    def test_actual_guard620_still_refuses_unknown_process_fields(self):
        runtime=N.NextRuntime.__new__(N.NextRuntime);runtime.require=old.require
        runtime.private_environment={'values':{}};runtime.value={'resourceEnvelope':{'workers':2}}
        values={'NODE_ENV':'production','PORT':'3201','AIHR_APP_WORKERS':'2','AIHR_DB_TOTAL_CONNECTIONS':'16','AIHR_DB_POOL_MAX':'8'}
        runtime._environment(old.raw(values),3201)
        for name in ('SGX_AESM_ADDR','FUTURE_MANAGER_KEY'):
            with self.assertRaisesRegex(AssertionError,'Unqualified actual worker environment field'):runtime._environment(old.raw(values|{name:'fictional'}),3201)

    def snapshot(self, result=(0,payload('SGX_AESM_ADDR=fictional')),uid=0,deadline=102.0):
        with patch.object(F.os,'geteuid',return_value=uid),patch.object(F.time,'monotonic',return_value=100.0),patch.object(F,'runtime_diagnostic_read',return_value=result) as read:
            value=F.manager_environment_snapshot(N,deadline)
            self.assertEqual(read.call_args.args,(list(F.MANAGER_ENVIRONMENT_ARGUMENTS),deadline))
            return value

    def test_shared_constructor_uses_only_fixed_local_typed_manager_read(self):
        self.assertEqual(self.snapshot(),('SGX_AESM_ADDR',))
        self.assertEqual(F.MANAGER_ENVIRONMENT_ARGUMENTS,('/usr/bin/busctl','--system','--json=short','get-property','org.freedesktop.systemd1','/org/freedesktop/systemd1','org.freedesktop.systemd1.Manager','Environment'))

    def test_shared_constructor_refuses_uid_deadline_nonzero_bool_and_malformed_transport(self):
        for kwargs in ({'uid':1},{'deadline':100.0},{'deadline':103.01},{'deadline':102},{'result':(1,payload())},{'result':(False,payload())},{'result':(0,b'fictional-secret')}):
            with self.assertRaises((AssertionError,ValueError)):self.snapshot(**kwargs)

    def test_full_two_slot_ledger_records_only_completed_settled_counts(self):
        ledger=[]
        with patch.object(F,'report',{'currentPhase':'protected-native-configuration','configuration':{'stage':'unit-files'}}),patch.object(F,'DEADLINE',120.0),patch.object(F.time,'monotonic',return_value=100.0),patch.object(F,'manager_environment_snapshot',return_value=('SGX_AESM_ADDR','NODE_ENV')) as read:
            self.assertEqual(F.manager_projection_snapshot(N,ledger,0),('SGX_AESM_ADDR',))
            self.assertEqual(read.call_args.args,(N,103.0))
            F.report['configuration']['stage']='manager-reload'
            self.assertEqual(F.manager_projection_snapshot(N,ledger,1),('SGX_AESM_ADDR',))
        self.assertEqual(ledger,[{'ordinal':i,'outcome':'complete','returned':True,'settled':True,'keyCount':2,'unsetCount':1} for i in (0,1)])
        self.assertNotIn('SGX',json.dumps(ledger));self.assertNotIn('fictional',json.dumps(ledger))

    def test_full_ledger_order_third_slot_and_phase_refuse_before_read(self):
        for ledger,ordinal,report in (([],1,{}),([],False,{}),([{},{}],2,{}),([],0,{'currentPhase':'wrong'}),([],0,{'currentPhase':'protected-native-configuration','configuration':{'stage':'manager-reload'}})):
            with patch.object(F,'report',report),patch.object(F,'manager_environment_snapshot') as read:
                with self.assertRaises(AssertionError):F.manager_projection_snapshot(N,ledger,ordinal)
                read.assert_not_called()

    def test_full_failed_transport_or_projection_retains_entered_refused_prefix(self):
        for value in (RuntimeError('fictional-secret'),('MAINPID',)):
            ledger=[]
            with patch.object(F,'report',{'currentPhase':'protected-native-configuration','configuration':{'stage':'unit-files'}}),patch.object(F,'manager_environment_snapshot',side_effect=value if isinstance(value,Exception) else None,return_value=value):
                with self.assertRaises((RuntimeError,ValueError)):F.manager_projection_snapshot(N,ledger,0)
            self.assertEqual(ledger,[{'ordinal':0,'outcome':'refused','returned':False,'settled':False,'keyCount':None,'unsetCount':None}])

    def test_host_uses_actual_same_constructor_twice_with_stricter_half_second_budget(self):
        ledger=[]
        with patch.object(H.time,'monotonic',return_value=100.0),patch.object(H,'limit',side_effect=lambda cap=3:cap),patch.object(F,'manager_environment_snapshot',return_value=('SGX_AESM_ADDR',)) as read:
            for ordinal in (0,1):self.assertEqual(H.host_manager_snapshot(N,F,ledger,ordinal),('SGX_AESM_ADDR',))
            self.assertEqual(read.call_count,2)
            self.assertTrue(all(call.args==(N,100.5) for call in read.call_args_list))
        self.assertTrue(all(row['settled'] for row in ledger))
        with self.assertRaises(AssertionError):H.host_manager_snapshot(N,F,ledger,2)

    def test_host_failed_read_has_no_success_or_value_reflection(self):
        ledger=[]
        with patch.object(H,'limit',return_value=.5),patch.object(F,'manager_environment_snapshot',side_effect=TimeoutError('fictional-secret')):
            with self.assertRaises(TimeoutError):H.host_manager_snapshot(N,F,ledger,0)
        self.assertEqual(ledger[0]['outcome'],'refused');self.assertFalse(ledger[0]['settled']);self.assertNotIn('fictional',json.dumps(ledger))

    def public_probe(self,raw=PUBLIC,overrides=True,close_error=False,changed=False):
        info=types.SimpleNamespace(st_dev=1,st_ino=2,st_uid=0,st_gid=0,st_mode=stat.S_IFREG|0o755,st_nlink=1,st_size=len(raw),st_mtime_ns=1,st_ctime_ns=1)
        later=types.SimpleNamespace(**(vars(info)|{'st_ino':3})) if changed else info
        with patch.object(H,'limit',return_value=1),patch.object(H,'sgx_default_overrides_absent',return_value=overrides),patch.object(H,'secure'),patch.object(pathlib.Path,'lstat',return_value=info),patch.object(H.os,'open',return_value=100),patch.object(H.os,'fstat',side_effect=[info,later]),patch.object(H.os,'read',side_effect=[raw,b'']),patch.object(H.os,'close',side_effect=OSError('fictional-private') if close_error else None):
            return H.installed_public_sgx_source()

    def test_known_public_source_match_is_not_execution_history_or_next_acceptance(self):
        result=self.public_probe();self.assertEqual(hashlib.sha256(PUBLIC).hexdigest(),H.PUBLIC_SGX_GENERATOR_SHA)
        self.assertEqual(result['state'],'matched-public-source');self.assertEqual(result['knownPublicSourceSha256'],H.PUBLIC_SGX_GENERATOR_SHA)
        self.assertTrue(result['defaultOverridesAbsent'])
        for key in ('customGeneratorPathObserved','exclusiveOriginVerified','nextApplicationVerified','releaseEligible'):self.assertFalse(result[key])

    def test_unknown_changed_oversized_override_or_close_failure_never_exports_file_hash(self):
        for kwargs in ({'raw':b'fictional-secret'},{'raw':b'x'*4097},{'overrides':False},{'changed':True},{'close_error':True}):
            result=self.public_probe(**kwargs);self.assertEqual(result['state'],'unavailable');self.assertIsNone(result['knownPublicSourceSha256'])
            self.assertNotIn('fictional',json.dumps(result))

    def test_fixed_override_paths_require_absent_leaf_and_safe_known_parents(self):
        directory=types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0)
        def absent_leaf(path):
            if path.name=='linux-base-sgx':raise FileNotFoundError()
            return directory
        with patch.object(H,'limit',return_value=1),patch.object(pathlib.Path,'lstat',autospec=True,side_effect=absent_leaf):self.assertTrue(H.sgx_default_overrides_absent())
        with patch.object(H,'limit',return_value=1),patch.object(pathlib.Path,'lstat',return_value=directory):self.assertFalse(H.sgx_default_overrides_absent())
        with patch.object(H,'limit',return_value=1),patch.object(pathlib.Path,'lstat',return_value=types.SimpleNamespace(st_mode=stat.S_IFLNK|0o777,st_uid=0)):
            with self.assertRaises(AssertionError):H.sgx_default_overrides_absent()

    def test_public_source_probe_budget_or_metadata_failure_is_explicitly_unavailable(self):
        with patch.object(H,'limit',side_effect=TimeoutError('fictional-private')):
            value=H.installed_public_sgx_source()
        self.assertEqual(value['state'],'unavailable');self.assertIsNone(value['knownPublicSourceSha256'])
        self.assertFalse(value['exclusiveOriginVerified']);self.assertNotIn('fictional',json.dumps(value))

    def test_whole_parent_history_and_unchanged_guards_pipe_observers_and_stock_exec(self):
        inverse=json.loads((ROOT/'deploy/admission/next_manager_environment_inverse.json').read_text())
        self.assertEqual(inverse['base'],'5383d212e073206db552d7f95a362895c3023323')
        def parent(path):
            row=inverse['files'][path];raw=base64.b64decode(row['originalBase64'],validate=True)
            self.assertEqual(hashlib.sha256(raw).hexdigest(),row['originalSha256'])
            return raw.decode()
        def segment(source,name):
            tree=ast.parse(source);node=next(n for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==name)
            return ast.get_source_segment(source,node)
        for path,names in {'deploy/admission/next_profile.py':('_environment','observe_owned_environment','validate_key_name_digests','validate_plain_key_names'), 'deploy/admission/test_next_native.py':('runtime_diagnostic_read','runtime_environment_journal_observation')}.items():
            current=(ROOT/path).read_text()
            for name in names:self.assertEqual(segment(current,name),segment(parent(path),name))
        current=(ROOT/'deploy/admission/test_next_native.py').read_text();before=parent('deploy/admission/test_next_native.py')
        stock=next(line for line in before.splitlines() if line.startswith("ExecStart={plan['nodePath']}"))
        self.assertIn(stock,current);self.assertEqual(current.count('manager_projection_snapshot(N, projection_ledger,'),2)
        host='deploy/admission/test_next_host_view_native.py'
        self.assertIn('TOTAL_DEADLINE = time.monotonic() + 27',parent(host))
        # Source equivalence only: one T0 owns the total, work and phase
        # frontiers. No execution of H or refreshed native allowance is implied.
        assignments={
            'STARTED':'time.monotonic()', 'TOTAL_DEADLINE':'STARTED + 27',
            'DEADLINE':'TOTAL_DEADLINE - 7', 'PHASE_DEADLINE':'STARTED + 7',
        }
        clock_owners={
            'limit':"""def limit(cap=3):
    frontier = min(DEADLINE, PHASE_DEADLINE) if WORK_PHASE_ACTIVE else DEADLINE
    left = frontier - time.monotonic()
    require(left > 0, 'Host conformance aggregate deadline exceeded')
    return min(cap, left)
""",
            '_advance_work_phase':"""def _advance_work_phase(offset):
    global PHASE_DEADLINE
    require(WORK_PHASE_ACTIVE and offset in (11, 13, 17, 20)
            and STARTED + offset > PHASE_DEADLINE, 'Closed work phase transition')
    limit()
    PHASE_DEADLINE = STARTED + offset
""",
        }
        def clock_contract(source):
            tree=ast.parse(source)
            for name,expression in assignments.items():
                nodes=[node for node in tree.body if isinstance(node,ast.Assign)
                       and any(isinstance(target,ast.Name) and target.id==name for target in node.targets)]
                self.assertEqual(len(nodes),1)
                self.assertEqual(ast.dump(nodes[0],include_attributes=False),
                                 ast.dump(ast.parse(name+' = '+expression).body[0],include_attributes=False))
            for name,expected in clock_owners.items():
                nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name==name]
                self.assertEqual(len(nodes),1)
                self.assertEqual(ast.dump(nodes[0],include_attributes=False),
                                 ast.dump(ast.parse(expected).body[0],include_attributes=False))
        current_host=(ROOT/host).read_text();clock_contract(current_host)
        for original,changed in (
                ('TOTAL_DEADLINE = STARTED + 27','TOTAL_DEADLINE = time.monotonic() + 27'),
                ('TOTAL_DEADLINE = STARTED + 27','TOTAL_DEADLINE = STARTED + 28'),
                ('DEADLINE = TOTAL_DEADLINE - 7','DEADLINE = TOTAL_DEADLINE - 6'),
                ('PHASE_DEADLINE = STARTED + 7','PHASE_DEADLINE = time.monotonic() + 7'),
                ('min(DEADLINE, PHASE_DEADLINE) if WORK_PHASE_ACTIVE else DEADLINE','DEADLINE'),
                ('left = frontier - time.monotonic()','left = frontier - STARTED'),
                ('    limit()  # The previous absolute frontier must still be live.\n','')):
            self.assertEqual(current_host.count(original),1)
            mutated=current_host.replace(original,changed,1);self.assertNotEqual(mutated,current_host)
            with self.assertRaises(AssertionError):clock_contract(mutated)
        for path,row in inverse['files'].items():
            current=(ROOT/path).read_bytes();self.assertEqual(hashlib.sha256(current).hexdigest(),row['currentSha256'])
            lines=current.decode().splitlines(keepends=True)
            for edit in row['changes']:
                self.assertEqual(''.join(lines[edit['start']:edit['end']]),edit['after']);lines[edit['start']:edit['end']]=edit['before'].splitlines(keepends=True)
            restored=''.join(lines).encode();self.assertEqual(restored,base64.b64decode(row['originalBase64']));self.assertEqual(hashlib.sha256(restored).hexdigest(),row['originalSha256'])


if __name__=='__main__':unittest.main()
