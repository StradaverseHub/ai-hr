"""Hosted-only regression for stopped-operation continuation."""
import base64
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock
import types
import hashlib
import json
import ast

spec=importlib.util.spec_from_file_location('resume',Path(__file__).with_name('resume_stopped.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

class Controls(unittest.TestCase):
    def terminal(self):
        return dict(ActiveState='failed',SubState='failed',MainPID='0',ControlPID='0',
                    ControlGroup=r.CGROUP,Result='exit-code',ExecMainCode='1',ExecMainStatus='143',KillMode='control-group')

    def test_known_exit143_with_no_processes_is_accepted(self):
        self.assertTrue(r.terminal_stop_allowed(self.terminal(),True))

    def test_live_main_control_or_descendant_is_refused(self):
        for key in ('MainPID','ControlPID'):
            v=self.terminal();v[key]='45';self.assertFalse(r.terminal_stop_allowed(v,True))
        self.assertFalse(r.terminal_stop_allowed(self.terminal(),False))

    def test_other_failure_exit_state_or_killmode_is_refused(self):
        for key,value in [('ExecMainStatus','1'),('ExecMainCode','2'),('Result','timeout'),('ActiveState','active'),('SubState','running'),('KillMode','process'),('ControlGroup','/system.slice/other.service')]:
            v=self.terminal();v[key]=value;self.assertFalse(r.terminal_stop_allowed(v,True))

    def test_clean_inactive_state_is_accepted_only_on_success(self):
        v=self.terminal();v.update(ActiveState='inactive',SubState='dead',Result='success')
        self.assertTrue(r.terminal_stop_allowed(v,True));v['Result']='exit-code';self.assertFalse(r.terminal_stop_allowed(v,True))

    def test_real_filesystem_checks_all_descendant_cgroup_procs(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'system.slice').mkdir();service=root/'system.slice/aihr.service'
            self.assertTrue(r.cgroup_empty(root))
            service.mkdir();(service/'cgroup.procs').write_text('');self.assertTrue(r.cgroup_empty(root))
            child=service/'child';child.mkdir();(child/'cgroup.procs').write_text('567\n');self.assertFalse(r.cgroup_empty(root))
            (child/'cgroup.procs').write_text('');self.assertTrue(r.cgroup_empty(root))
            (child/'unsafe').symlink_to(root);self.assertFalse(r.cgroup_empty(root))

    def test_only_documented_volatile_environment_fields_are_ignored(self):
        old={b'AUTH_SESSION_KEY':b'same-secret',b'PORT':b'3000',b'INVOCATION_ID':b'old',b'JOURNAL_STREAM':b'1:2',b'SYSTEMD_EXEC_PID':b'20'}
        new={**old,b'INVOCATION_ID':b'new',b'JOURNAL_STREAM':b'3:4',b'SYSTEMD_EXEC_PID':b'21'}
        self.assertTrue(r.same_restored_environment(old,new))
        for key,value in [(b'AUTH_SESSION_KEY',b'changed'),(b'PORT',b'3001'),(b'NODE_OPTIONS',b'--require evil')]:
            self.assertFalse(r.same_restored_environment(old,{**new,key:value}))

    def test_duplicate_environment_is_refused(self):
        with self.assertRaises(ValueError):r.environment_map(base64.b64encode(b'X=one\0X=two\0'))

    def test_snapshot_only_ignores_process_identity_and_bound_unit_environment_hashes(self):
        old={'observedAt':'old','baseline':{'pid':'20','startedTicks':'10','sourceRef':'same'},'configuration':{'activeProcessEnvironmentSha256':'old','unitPropertiesSha256':'old','primary':'same'}}
        new=copy.deepcopy(old);new['baseline'].update(pid='21',startedTicks='11');new['observedAt']='new';new['configuration'].update(activeProcessEnvironmentSha256='new',unitPropertiesSha256='new')
        self.assertEqual(r.comparable_snapshot(old),r.comparable_snapshot(new));new['configuration']['primary']='different';self.assertNotEqual(r.comparable_snapshot(old),r.comparable_snapshot(new))

    def test_reset_failed_only_after_full_quiescence_then_checks_inactive(self):
        values=self.terminal();calls=[]
        class Host:
            def command(self,args):calls.append(args);return b''
            def require_inactive(self):calls.append('inactive')
        def require(ok,message):
            if not ok:raise ValueError(message)
        with patch.object(r,'stopped_values',return_value=values),patch.object(r,'cgroup_empty',return_value=True):
            r.prove_stopped(Host(),require)
        self.assertEqual(calls,[['/usr/bin/systemctl','reset-failed','aihr.service'],'inactive'])
        calls.clear()
        with patch.object(r,'stopped_values',return_value=values),patch.object(r,'cgroup_empty',return_value=False):
            with self.assertRaises(ValueError):r.prove_stopped(Host(),require)
        self.assertEqual(calls,[])

    def test_continuation_refuses_wrong_phase_before_source_or_any_write(self):
        def require(ok,message):
            if not ok:raise ValueError(message)
        for phase in ('prepared','stopping','ready-for-release','release-started','recovered-before-release'):
            host=types.SimpleNamespace(phase=lambda:phase)
            with self.assertRaises(ValueError):r.continue_cutover(host,{}, {},types.SimpleNamespace(require=require))

    def test_continuation_fresh_source_refusal_precedes_any_mutation(self):
        def reject():raise ValueError('source changed')
        host=types.SimpleNamespace(phase=lambda:'stopped',fresh_source_guard=reject)
        def require(ok,message):
            if not ok:raise ValueError(message)
        with self.assertRaisesRegex(ValueError,'source changed'):
            r.continue_cutover(host,{}, {},types.SimpleNamespace(require=require))

    def continuation_fixture(self):
        env=b'PORT=3000\0AUTH_SESSION_KEY=private\0INVOCATION_ID=old\0'
        new=env.replace(b'INVOCATION_ID=old',b'INVOCATION_ID=new')
        snapshot={'observedAt':'old','baseline':{'pid':'20','startedTicks':'10','sourceRef':'same'},'configuration':{'activeProcessEnvironmentSha256':'old','unitPropertiesSha256':'old','primary':'same'}}
        current=copy.deepcopy(snapshot);current['baseline'].update(pid='21',startedTicks='11')
        unit={'MainPID':'20','ActiveState':'active','ExecStart':'{ path=/opt/node20/bin/node ; argv[]=/opt/node20/bin/node app ; start_time=old ; }','ExecStartEx':'{ path=/opt/node20/bin/node ; argv[]=/opt/node20/bin/node app ; start_time=old ; }','User':'ubuntu'}
        actual={k:v.replace('start_time=old','start_time=new') for k,v in unit.items()};actual['MainPID']='21'
        h=MagicMock();h.root=Path('/private-fixture');h.env_path='/private-env';h.dropin='/private-dropin';h.phase.return_value='stopped';h.proposals.return_value={'snapshot':current,'activeEnvironment':base64.b64encode(new)};h.unit_properties.return_value=actual;h.database.return_value={'same':True};h._records.return_value=[{'sha256':hashlib.sha256(b'original').hexdigest(),'identity':'identity'}]
        def require(ok,message):
            if not ok:raise ValueError(message)
        def read(path):
            if str(path)=='/private-env':return b'original','identity'
            if str(path).endswith('active-environment.private'):return env,'identity'
            if str(path).endswith('unit-properties.private.json'):return json.dumps(unit).encode(),'identity'
            raise ValueError('unexpected path')
        m=types.SimpleNamespace(require=require,read_regular=read,sha=lambda b:hashlib.sha256(b).hexdigest(),file_identity=lambda s:s,exclusive=lambda *a:None,encoded=lambda v:json.dumps(v).encode())
        return h,{'snapshot':snapshot,'database':{'same':True}},{'restoredPid':'21','restoredStartedTicks':'11'},m

    def test_full_continuation_preserves_phases_and_calls_original_guards_before_writes(self):
        h,p,a,m=self.continuation_fixture()
        with patch.object(r.os.path,'lexists',return_value=False),patch.object(r,'prove_restored_process'),patch.object(r,'prove_stopped',return_value={}):
            r.continue_cutover(h,p,a,m)
        phases=[c.args[0] for c in h.save_phase.call_args_list]
        self.assertEqual(phases,['stopping','stopped','environment-written','unit-written','reloaded','ready-for-release'])
        self.assertNotIn('prepared',phases)
        names=[c[0] for c in h.mock_calls]
        self.assertLess(names.index('fresh_source_guard'),names.index('stop'))
        self.assertLess(names.index('assert_baseline_custody'),names.index('write_environment'))
        self.assertLess(names.index('actual_preflight'),len(names)-1)

    def test_changed_database_refuses_before_stop(self):
        h,p,a,m=self.continuation_fixture();h.database.return_value={'changed':True}
        with patch.object(r.os.path,'lexists',return_value=False),self.assertRaisesRegex(ValueError,'Database custody'):
            r.continue_cutover(h,p,a,m)
        h.stop.assert_not_called();h.write_environment.assert_not_called()

    def test_remaining_service_process_refuses_before_configuration_write(self):
        h,p,a,m=self.continuation_fixture()
        with patch.object(r.os.path,'lexists',return_value=False),patch.object(r,'prove_restored_process'),patch.object(r,'prove_stopped',side_effect=ValueError('live descendant')),self.assertRaisesRegex(ValueError,'live descendant'):
            r.continue_cutover(h,p,a,m)
        h.write_environment.assert_not_called();h.write_unit.assert_not_called()

    def test_transport_bootstrap_preserves_original_authority_and_only_changes_executed_helper(self):
        directory=Path(__file__).parent
        def load(name):
            spec=importlib.util.spec_from_file_location(name,directory/(name+'.py'))
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
        wrapper=load('resume_operator');original=load('operator')
        generated=wrapper.build_bootstrap(original.BOOTSTRAP,'a'*64,'b'*64)
        ast.parse(generated)
        self.assertIn("str(root/'resume_stopped.py'),phase",generated)
        self.assertIn("('maintenance_agent.py',agent_sha)",generated)
        self.assertIn("root/'approved-plan.json'",generated)
        self.assertIn("root/'human-approval.json'",generated)
        self.assertIn('os.O_CREAT|os.O_EXCL',generated)
        self.assertNotIn("str(root/'maintenance_agent.py'),phase",generated)
        with self.assertRaises(AssertionError):wrapper.build_bootstrap(original.BOOTSTRAP,'bad','b'*64)
        with self.assertRaises(AssertionError):wrapper.build_bootstrap('unrecognized original','a'*64,'b'*64)

if __name__=='__main__':unittest.main()
