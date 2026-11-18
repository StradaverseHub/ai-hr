"""Hosted-only real systemd lifecycle controls. Isolated non-login UID, no app/DB/credentials."""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--output',required=True);parser.add_argument('--node',required=True)
args=parser.parse_args()
assert os.geteuid()==0 and re.fullmatch('[a-f0-9]{40}',args.source)
assert Path('/run/systemd/system').is_dir(), 'Actual hosted systemd is required; never skip this control'
node=Path(args.node).resolve();assert node.is_absolute() and node.is_file()
assert subprocess.check_output([str(node),'--version'],text=True).strip()=='v22.23.3'
results=[]

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
update=module('native_drain_update',ROOT/'deploy/systemd/bank_import_worker_upgrade_v1.py')

class NativeSystemdDrain(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='aihr-native-drain-');cls.root=Path(cls.temp.name);cls.root.chmod(0o755)
        cls.dependencies=cls.root/'dependencies'
        shutil.copytree(ROOT/'node_modules',cls.dependencies,symlinks=True)
        cls.name='aihr-drain-'+uuid.uuid4().hex[:12]
        subprocess.run(['/usr/sbin/useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin',cls.name],check=True)
        cls.uid=pwd.getpwnam(cls.name).pw_uid;cls.gid=pwd.getpwnam(cls.name).pw_gid
    @classmethod
    def tearDownClass(cls):
        subprocess.run(['/usr/sbin/userdel',cls.name],check=True)
        cls.temp.cleanup()
    def setUp(self):
        self.suffix=uuid.uuid4().hex[:10];self.unit='aihr-native-drain-'+self.suffix+'.service'
        self.fragment=Path('/run/systemd/system')/self.unit
        self.root=self.__class__.root/self.suffix;self.root.mkdir(mode=0o755)
        self.release=self.root/'releases'/('1'*40);(self.release/'scripts').mkdir(parents=True,mode=0o755)
        (self.root/'releases').chmod(0o755);self.release.chmod(0o755)
        (self.release/'node_modules').symlink_to(self.dependencies,target_is_directory=True)
        self.state=self.root/'state';self.state.mkdir(mode=0o700);os.chown(self.state,self.uid,self.gid)
        self.ready=self.state/'ready'
        self.environment=self.root/'worker.env';self.environment.write_text('DATABASE_URL="postgres://nobody:nothing@127.0.0.1:1/no_database"\n');self.environment.chmod(0o600)
        self.mode='normal';self.exitcode=0;self.commands=[]
        self.base=module('native_drain_base_'+self.suffix,ROOT/'deploy/systemd/bank_import_worker_installer_v2.py')
        self.base.ROOT=self.root;self.base.NODE=node;self.base.USER=self.name;self.base.UNIT=self.fragment;self.base.ENV=self.environment
        self.base.command=self.command
    def unit_text(self,pool=2):
        return '\n'.join(['[Unit]','Description=Isolated hosted drain control','[Service]','Type=simple','User='+self.name,'Group='+self.name,'WorkingDirectory='+str(self.release),'Environment=NODE_ENV=production AIHR_DB_PROCESS_ROLE=worker AIHR_DB_POOL_MAX='+str(pool),'EnvironmentFile='+str(self.environment),'ExecStart='+str(node)+' --import tsx scripts/bank-import-runner.ts','Restart=on-failure','RestartSec=60','TimeoutStopSec=5','NoNewPrivileges=true','PrivateNetwork=true','[Install]','WantedBy=multi-user.target',''])
    def raw(self,*argv):
        return subprocess.run(['/usr/bin/systemctl',*argv],capture_output=True,text=True,timeout=30,check=True)
    def show(self,key):return self.raw('show',self.unit,'--property='+key,'--value').stdout.strip()
    def wait(self,predicate):
        until=time.monotonic()+20
        while time.monotonic()<until:
            if predicate():return
            time.sleep(.05)
        raise AssertionError('Native lifecycle predicate did not settle: '+self.unit)
    def start(self):
        script="process.on('SIGTERM',()=>setTimeout(()=>process.exit("+str(self.exitcode)+"),75));require('node:fs').writeFileSync("+json.dumps(str(self.ready))+",String(process.pid));setInterval(()=>{},1000);"
        (self.release/'scripts/bank-import-runner.ts').write_text(script)
        text=self.unit_text()
        if self.mode=='restart':text=text.replace('RestartSec=60','RestartSec=0.05')
        self.fragment.write_text(text);self.fragment.chmod(0o644)
        self.raw('daemon-reload');self.raw('start',self.unit)
        self.wait(lambda:self.ready.exists() and self.ready.read_text()==self.show('MainPID'))
        report=update.properties(self.base);update.validate_process(self.base,report,'1'*40);return report
    def command(self,argv,**options):
        assert argv[0]=='/usr/bin/systemctl' and argv.count('aihr-bank-import.service')==1
        actual=[self.unit if part=='aihr-bank-import.service'else part for part in argv]
        self.commands.append(actual)
        timeout=options.get('timeout',45)
        if self.base.VERIFIED_OPERATION_DEADLINE is not None:timeout=min(timeout,self.base.VERIFIED_OPERATION_DEADLINE-time.monotonic())
        assert timeout>0
        result=subprocess.run(actual,capture_output=True,text=True,timeout=timeout,check=True)
        if argv[1]=='kill':
            if self.mode=='restart':
                self.wait(lambda:int(self.show('NRestarts'))>0)
            elif self.mode=='pid':
                self.raw('restart',self.unit);self.wait(lambda:self.ready.read_text()==self.show('MainPID'))
            elif self.mode=='config':
                self.fragment.write_text(self.unit_text(pool=3));self.raw('daemon-reload')
        return result
    def run_case(self,mode='normal',exitcode=0,error=None):
        self.mode=mode;self.exitcode=exitcode;initial=self.start();log=io.StringIO();began=time.monotonic()
        with contextlib.redirect_stderr(log):
            if error:
                with self.assertRaisesRegex(ValueError,error):update.drain(self.base,initial,'1'*40)
                accepted=False
            else:
                observed=update.drain(self.base,initial,'1'*40);self.assertEqual(observed,{'pid':int(initial['MainPID']),'state':'drained','forcedKill':False});accepted=True
        lines=log.getvalue().splitlines();self.assertEqual(len(lines),1);proof=json.loads(lines[0]);self.assertEqual(proof['outcome'],'stable'if accepted else'refused')
        if accepted:
            self.assertEqual(proof['reports'][-1],proof['reports'][-2]);self.assertEqual(proof['reports'][-1]['MainPID'],'0');self.assertEqual(proof['reports'][-1]['NRestarts'],'0')
        mutating=[c for c in self.commands if c[1]!='show'];self.assertEqual(mutating,[['/usr/bin/systemctl','kill','--kill-whom=main','--signal=SIGTERM',self.unit]])
        self.assertLess(time.monotonic()-began,330)
        results.append({'case':self.id(),'source':args.source,'unit':self.unit,'accepted':accepted,'elapsedSeconds':time.monotonic()-began,'methodCommands':self.commands,'observations':proof,'initialUid':self.uid,'node':subprocess.check_output([str(node),'--version'],text=True).strip(),'systemd':subprocess.check_output(['/usr/bin/systemctl','--version'],text=True).splitlines()[0]})
    def tearDown(self):
        try:self.raw('stop',self.unit)
        finally:
            self.fragment.unlink(missing_ok=True);self.raw('daemon-reload');self.raw('reset-failed',self.unit) if self.show('LoadState')!='not-found'else None
    def test_real_clean_sigterm_exit_and_full_stability_pair(self):self.run_case()
    def test_real_restart_counter_is_refused(self):self.run_case('restart',7,'restarted')
    def test_real_new_pid_without_restart_counter_is_refused(self):self.run_case('pid',0,'PID changed')
    def test_real_nonzero_exit_is_refused(self):self.run_case('normal',7,'exit successfully')
    def test_real_loaded_environment_drift_is_refused(self):self.run_case('config',0,'configuration differs|configuration changed')

suite=unittest.defaultTestLoader.loadTestsFromTestCase(NativeSystemdDrain)
run=unittest.TextTestRunner(verbosity=2).run(suite)
payload={'kind':'ACTUAL_HOSTED_SYSTEMD_DRAIN_CONTROLS_NOT_APPLICATION_OR_RELEASE_ACCEPTANCE','source':args.source,'testsRun':run.testsRun,'failures':len(run.failures),'errors':len(run.errors),'cases':results,'releaseAuthorized':False}
output=Path(args.output);assert output.is_absolute() and output.parent.is_dir()
with output.open('x')as f:json.dump(payload,f,indent=2);f.write('\n')
raise SystemExit(0 if run.wasSuccessful()else 1)
