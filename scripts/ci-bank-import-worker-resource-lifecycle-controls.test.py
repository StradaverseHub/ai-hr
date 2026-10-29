"""Pure interrupted-resource lifecycle controls. No native allocation or process execution."""
import copy
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('resource_lifecycle_subject',Path(__file__).with_name('bank_import_worker_throughput_proof.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

@contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='bank-resource-lifecycle-') as temporary:
        base=Path(temporary);opt=base/'opt';opt.mkdir();proc=base/'proc';proc.mkdir();root=opt/'registry';root.mkdir()
        registry=object.__new__(p.Registry);registry.root=root
        registry.data={'resources':[]};snapshots=[]
        registry.save=lambda:snapshots.append(copy.deepcopy(registry.data))
        def paths(value): return opt if str(value)=='/opt' else proc if str(value)=='/proc' else Path(value)
        # Tests use ordinary private temp directories; real protected() remains unchanged.
        with patch.object(p,'Path',side_effect=paths),patch.object(p,'protected',side_effect=lambda path,directory=False:Path(path).lstat()),patch.dict(os.environ,{'GITHUB_RUN_ID':'123','GITHUB_SHA':'a'*40,'THROUGHPUT_PROOF_MODE':'full-100001'}):
            yield registry,snapshots,opt,proc

class ResourceLifecycle(unittest.TestCase):
    def test_closed_probe_scopes_refuse_cross_scope_wrong_run_and_unreleased_baseline(self):
        with patch.object(p,'invocation'),patch.dict(os.environ,{'GITHUB_RUN_ID':'123'}):
            self.assertEqual(str(p.root_directory()),'/opt/aihr-throughput-123-1')
            self.assertEqual(str(p.root_directory('kernel-eof')),'/opt/aihr-throughput-123-1-kernel-eof')
            for scope in ['',True,'other','../kernel-eof']:
                with self.assertRaises(ValueError): p.root_directory(scope)
            with patch.object(p.os,'geteuid',return_value=0):
                for path,scope in [('/opt/aihr-throughput-124-1-kernel-eof','kernel-eof'),('/opt/aihr-throughput-123-1-kernel-orphan','kernel-eof')]:
                    with self.assertRaises(ValueError): p.Registry(path,scope)
        for scope in [None,'kernel-orphan']:
            registry=object.__new__(p.Registry);registry._probe_case=scope
            with self.assertRaises(ValueError): registry.popen(['/never/executed'],_release=False)
            with self.assertRaises(AttributeError): registry.probe_case='kernel-eof'
        p.check_gate_namespace(Path('/opt/aihr-throughput-123-1-kernel-eof'),'kernel-eof')
        for path,scope in [('/opt/aihr-throughput-123-1-kernel-eof',None),('/opt/aihr-throughput-123-1-kernel-orphan','kernel-eof'),('/tmp/aihr-throughput-123-1-kernel-eof','kernel-eof')]:
            with self.assertRaises(ValueError): p.check_gate_namespace(Path(path),scope)

    def test_area_intent_precedes_failed_allocation(self):
        with fixture() as (registry,snapshots,opt,proc):
            real_mkdir=Path.mkdir
            def mkdir(path,*args,**kwargs):
                if path.name=='aihr-large-throughput-ci-123_1': raise OSError('injected allocation failure')
                return real_mkdir(path,*args,**kwargs)
            with patch.object(Path,'mkdir',mkdir),self.assertRaises(OSError): registry.prepare_area()
            self.assertEqual(snapshots[-1]['resources'][0]['state'],'create-pending')
            registry.cleanup_resources();registry.cleanup_resources()
            self.assertEqual(registry.data['resources'][0]['state'],'removed')

    def test_area_removal_interruption_and_log_export_are_retryable(self):
        with fixture() as (registry,snapshots,opt,proc):
            area=registry.prepare_area();(area/'worker-4.stderr').write_bytes(b'original failure\n')
            save=registry.save
            def interrupted():
                if registry.data['resources'][0]['state']=='removed': raise RuntimeError('after rmtree')
                save()
            registry.save=interrupted
            with self.assertRaises(RuntimeError): registry.cleanup_resources()
            self.assertFalse(area.exists());self.assertEqual(snapshots[-1]['resources'][0]['state'],'remove-pending')
            registry.data=copy.deepcopy(snapshots[-1]);registry.save=save
            registry.cleanup_resources();registry.cleanup_resources()
            self.assertEqual((registry.root/'cleanup-worker-4.stderr').read_bytes(),b'original failure\n')

    def test_area_foreign_inode_and_nonempty_unidentified_area_refuse(self):
        with fixture() as (registry,snapshots,opt,proc):
            area=registry.prepare_area();resource=registry.data['resources'][0];resource['ino']+=1
            with self.assertRaises(ValueError): registry.cleanup_resources()
            resource.update(ino=None,dev=None,state='create-pending');(area/'unknown').write_text('foreign')
            with self.assertRaises(ValueError): registry.cleanup_resources()
            self.assertTrue(area.exists())

    def user_resource(self):
        return {'type':'user','name':'aihr-import-throughput-ci','uid':60000,'gid':60000,'home':'/nonexistent','shell':'/usr/sbin/nologin','gecos':'aihr-ci-123-'+'a'*40,'state':'create-pending'}

    def test_pending_user_wrong_marker_refuses_all_removal(self):
        with fixture() as (registry,snapshots,opt,proc):
            resource=self.user_resource();registry.data['resources']=[resource]
            user=SimpleNamespace(pw_name=resource['name'],pw_uid=60000,pw_gid=60000,pw_dir='/nonexistent',pw_shell='/usr/sbin/nologin',pw_gecos='foreign')
            group=SimpleNamespace(gr_name=resource['name'],gr_gid=60000,gr_mem=[])
            with patch.object(p.pwd,'getpwnam',return_value=user),patch.object(p.pwd,'getpwall',return_value=[user]),patch.object(p.grp,'getgrgid',return_value=group),patch.object(p.grp,'getgrall',return_value=[group]),patch.object(p.subprocess,'run') as remove:
                with self.assertRaises(ValueError): registry.cleanup_resources()
                remove.assert_not_called()

    def test_removed_user_remaining_group_recovers_exact_pending_identity(self):
        with fixture() as (registry,snapshots,opt,proc):
            resource=self.user_resource();resource['state']='remove-pending';registry.data['resources']=[resource]
            group=SimpleNamespace(gr_name=resource['name'],gr_gid=60000,gr_mem=[]);groups=[group]
            def lookup(gid):
                if groups: return groups[0]
                raise KeyError(gid)
            def remove(argv,**kwargs):
                self.assertEqual(argv,['/usr/sbin/groupdel',resource['name']]);groups.clear();return SimpleNamespace(returncode=0)
            with patch.object(p.pwd,'getpwnam',side_effect=KeyError),patch.object(p.pwd,'getpwall',return_value=[]),patch.object(p.grp,'getgrgid',side_effect=lookup),patch.object(p.grp,'getgrall',side_effect=lambda:list(groups)),patch.object(p.subprocess,'run',side_effect=remove) as called:
                registry.cleanup_resources();registry.cleanup_resources();self.assertEqual(called.call_count,1)
            self.assertEqual(resource['state'],'removed')

    def test_user_creation_intent_is_saved_before_any_account_command(self):
        with fixture() as (registry,snapshots,opt,proc):
            def command(argv,**kwargs):
                self.assertEqual(snapshots[-1]['resources'][0]['state'],'create-pending')
                self.assertEqual(snapshots[-1]['resources'][0]['uid'],60000)
                raise RuntimeError('interrupted group allocation')
            registry.run=command
            with patch.object(p.pwd,'getpwall',return_value=[]),patch.object(p.grp,'getgrall',return_value=[]),self.assertRaises(RuntimeError): registry.prepare_user()
        with fixture() as (registry,snapshots,opt,proc):
            commands=[]
            def command(argv,**kwargs):
                commands.append(argv)
                self.assertEqual(snapshots[-1]['resources'][0]['state'],'create-pending')
                if argv[0]=='/usr/sbin/groupadd': return SimpleNamespace(returncode=0)
                self.assertIn('--system',argv);self.assertIn('--no-create-home',argv);self.assertIn('--no-log-init',argv)
                self.assertNotIn('--key',argv);self.assertNotIn('CREATE_MAIL_SPOOL=no',argv)
                raise RuntimeError('interrupted user allocation')
            registry.run=command
            with patch.object(p.pwd,'getpwall',return_value=[]),patch.object(p.grp,'getgrall',return_value=[]),self.assertRaises(RuntimeError): registry.prepare_user()
            self.assertEqual(len(commands),2)

    def test_initialization_recovery_accepts_only_owned_empty_pending_namespaces(self):
        with fixture() as (registry,snapshots,opt,proc):
            root=opt/'initializing';root.mkdir();group=opt/'cgroup';group.mkdir();intent=opt/'intent.json'
            data={'runId':123,'controller':'a'*40,'state':'preparing','rootIdentity':None,'namespaceIdentity':None,'probeCase':None}
            intent.write_bytes(p.canonical(data))
            with patch.object(p,'root_directory',return_value=root),patch.object(p,'cgroup_root',return_value=group),patch.object(p,'initialization_path',return_value=intent),patch.object(p,'cgroup_members',return_value=[]):
                with self.assertRaises(ValueError): p.initialization_intent('kernel-eof')
                self.assertTrue(p.recover_initialization());self.assertTrue(p.recover_initialization());self.assertFalse(group.exists())
                data=json.loads(intent.read_bytes());data['rootIdentity']['ino']+=1;intent.write_bytes(p.canonical(data))
                with self.assertRaises(ValueError): p.recover_initialization()

    def test_bounded_evidence_exact_retry_and_fixed_mode_budgets(self):
        with fixture() as (registry,snapshots,opt,proc):
            path=opt/'evidence';p.evidence_bytes(path,b'original');p.evidence_bytes(path,b'original')
            with self.assertRaises(ValueError): p.evidence_bytes(path,b'changed')
            p.evidence_bytes(path,b'changed',refresh=True);self.assertEqual(path.read_bytes(),b'changed')
            with self.assertRaises(ValueError): p.evidence_bytes(path,b'x'*(1024**2+1))
            started=p.parse_time('2026-10-30T00:00:00Z')
            self.assertEqual(p.remaining_job_seconds('2026-10-30T00:00:00Z',started+600,started+10),9900)
            with patch.dict(os.environ,{'THROUGHPUT_PROOF_MODE':'preflight-401'}):
                self.assertEqual(p.remaining_job_seconds('2026-10-30T00:00:00Z',started+300,started+10),600)
                self.assertIn('worker-15.stderr',p.worker_log_names());self.assertNotIn('worker-16.stderr',p.worker_log_names())
                with self.assertRaises(ValueError): p.remaining_job_seconds('2026-10-30T00:00:00Z',started+841,started+10)
            self.assertNotIn('worker-5.stderr',p.worker_log_names())
            with patch.dict(os.environ,{'THROUGHPUT_PROOF_MODE':'unknown'}),self.assertRaises(ValueError): p.job_seconds()

if __name__=='__main__':
    if not (os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('CI')=='true' and os.uname().sysname=='Linux'):
        raise SystemExit('Resource controls require disposable GitHub Linux CI; no local execution.')
    unittest.main()
