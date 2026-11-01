"""Disposable GitHub VM commissioning proof. No application DB, mail or real HR worker is used."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import sys
import time
import http.client

REPO=Path(__file__).resolve().parents[2]
WEB=sys.argv[1]
FIXTURE='aihr-control-fixture'
STATE=Path('/var/lib/aihr-control-fixture')
SOURCE=Path('/var/lib/aihr-control-fixture-code')
POLICY=Path('/etc/aihr/runner-fixture-policy.json')
SOCKET='/run/aihr-runner-control.sock'
KEY='ai-alerts'
UNIT='aihr-ai-alerts'
ACTOR='11111111-1111-1111-1111-111111111111'

def run(*args,**options):
    result=subprocess.run(args,text=True,capture_output=True,timeout=30,**options)
    if result.returncode:
        print(result.stdout,file=sys.stderr);print(result.stderr,file=sys.stderr)
        result.check_returncode()
    return result

def root_request(body):
    class UnixConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(20);self.sock.connect(SOCKET)
    client=UnixConnection('localhost');client.request('POST','/v1/runners',json.dumps(body),{'Content-Type':'application/json'})
    response=client.getresponse();value=json.loads(response.read());client.close();return response.status,value

def request(body):
    # A fresh real OS session acquires the socket group added by the actual installer.
    result=run('/usr/sbin/runuser','--user',WEB,'--','/usr/bin/python3','-I','-B',str(Path(__file__).resolve()),'--client',input=json.dumps(body))
    return json.loads(result.stdout)

def status():
    code,value=request({'op':'status'});assert code==200,value
    return value,next(row for row in value['runners'] if row['id']==KEY)

def configure(row,enabled,schedule=None):
    return request({'op':'configure','id':KEY,'actor':ACTOR,'revision':row['revision'],'enabled':enabled,'schedule':schedule})

def wait_until(predicate,seconds=180):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if predicate():return
        time.sleep(1)
    raise AssertionError('Real fixture timer did not reach the expected state')

def executions():
    path=STATE/'executions.jsonl'
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

def main():
    assert os.geteuid()==0 and os.environ.get('GITHUB_ACTIONS')=='true','Disposable Actions root fixture only'
    assert Path('/proc/1/comm').read_text().strip()=='systemd','A real systemd VM is required'
    assert not SOURCE.exists() and not STATE.exists() and not Path(SOCKET).exists(),'Fresh task-owned fixture required'
    web=pwd.getpwnam(WEB);assert web.pw_uid>0
    run('/usr/sbin/useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin',FIXTURE)
    identity=pwd.getpwnam(FIXTURE)
    SOURCE.mkdir(mode=0o755);STATE.mkdir(mode=0o700);os.chown(STATE,identity.pw_uid,identity.pw_gid)
    (SOURCE/'tick.py').write_text("import json,os,time\nwith open('/var/lib/aihr-control-fixture/executions.jsonl','a') as f:f.write(json.dumps({'uid':os.getuid(),'at':time.time()})+'\\n')\n")
    os.chmod(SOURCE/'tick.py',0o644)
    binary=str(Path('/usr/bin/python3').resolve())
    unit=f'''[Unit]
Description=Disposable runner-control fixture; no HR or DB
[Service]
Type=oneshot
User={FIXTURE}
Group={FIXTURE}
WorkingDirectory={SOURCE}
ExecStart={binary} {SOURCE}/tick.py
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths={STATE}
[Install]
WantedBy=multi-user.target
'''
    timer=f'''[Unit]
Description=Disposable runner-control timer
[Timer]
OnBootSec=1s
OnUnitInactiveSec=2min
AccuracySec=1s
Unit={UNIT}.service
[Install]
WantedBy=timers.target
'''
    for suffix,text in [('service',unit),('timer',timer)]:
        path=Path('/etc/systemd/system')/(UNIT+'.'+suffix);assert not path.exists();path.write_text(text);os.chmod(path,0o644)
    run('/usr/bin/systemctl','daemon-reload')
    POLICY.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    policy={'environment':'staging','webUid':web.pw_uid,'jobs':{KEY:{'managed':True,'note':'Disposable CI fixture, no HR or DB.'}}}
    POLICY.write_text(json.dumps(policy));os.chmod(POLICY,0o600)
    run('/usr/bin/python3','-I','-B',str(REPO/'deploy/runner-control/install.py'),'--policy',str(POLICY),'--web-user',WEB)
    try:
        # Root can reach the socket but is NOT the enrolled web UID.
        assert root_request({'op':'status'})[0]==409
        _,initial=status();assert initial['installed'] and not initial['enabled']
        code,_=configure(initial,True);assert code==200
        wait_until(lambda:len(executions())>=1)
        wait_until(lambda:status()[1]['health']=='success')
        _,first=status();time.sleep(2);_,second=status();assert first['revision']==second['revision'],'Monotonic runtime updates changed the configuration revision'
        code,_=configure(first,True,{'minutes':1});assert code==200
        # A prior revision must now be stale after the actual schedule changed.
        code,_=configure(first,False);assert code==409
        _,scheduled=status();assert scheduled['enabled'] and scheduled['nextRun'] and '1min' in scheduled['schedule']
        # At least three invocations include the edited completion interval, not only boot triggers.
        # Never manually start the fixture service.
        wait_until(lambda:len(executions())>=3)
        _,completed=status();code,_=configure(completed,False);assert code==200
        _,disabled=status();assert not disabled['enabled']
        actual=executions();assert len(actual)>=3 and all(row['uid']==identity.pw_uid for row in actual)
        assert run('/usr/bin/systemctl','show',UNIT+'.timer','--property=ActiveState','--value').stdout.strip()=='inactive'
        # Simulate only the production policy in this disposable VM, never a production installation.
        policy['environment']='production';Path('/etc/aihr/runner-control/policy.json').write_text(json.dumps(policy))
        code,production=request({'op':'status'});assert code==200
        for key in ['replacement-holidays','backups']:
            held=next(row for row in production['runners'] if row['id']==key);assert held['hold']
            code,_=request({'op':'configure','id':key,'actor':ACTOR,'revision':held['revision'],'enabled':True,'schedule':None});assert code==409
        audits=[json.loads(line) for line in Path('/var/lib/aihr-runner-control/audit.jsonl').read_text().splitlines()]
        assert any(row['outcome']=='applied' and row['enabled'] for row in audits)
        assert any(row['outcome']=='applied' and not row['enabled'] for row in audits)
        proof={'kind':'DISPOSABLE_SYSTEMD_FIXTURE_NOT_STAGING_ACCEPTANCE','source':os.environ.get('GITHUB_SHA'),'runId':os.environ.get('GITHUB_RUN_ID'),'executions':actual,'dedicatedUid':identity.pw_uid,'activation':True,'intervalEdit':True,'stableRevision':True,'staleEditRefused':True,'disabled':True,'wrongUidRefused':True,'simulatedProductionHoldsRefused':True,'auditOutcomes':[row['outcome'] for row in audits]}
        output=Path(os.environ['RUNNER_TEMP'])/'runner-control-systemd-proof.json';output.write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof))
    finally:
        for unit in [UNIT+'.timer','aihr-runner-control.socket']:
            subprocess.run(['/usr/bin/systemctl','disable','--now',unit],capture_output=True)
        subprocess.run(['/usr/bin/systemctl','stop','aihr-runner-control.service'],capture_output=True)

if __name__=='__main__':
    if WEB=='--client':print(json.dumps(root_request(json.load(sys.stdin))))
    else:main()
