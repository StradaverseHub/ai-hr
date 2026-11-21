"""Install the staging-only pickup timer over the already commissioned queue."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[2]
REMOTE = r"""
import base64, fcntl, hashlib, json, os, pathlib, subprocess, sys, tempfile
root=pathlib.Path('/var/tmp/aihr-deploy/staging-release-queue')
os.umask(0o077)
p=json.load(sys.stdin)
def run(*args):
    return subprocess.run(args,check=True,capture_output=True,text=True,timeout=20).stdout

def install(path,data):
    with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as stream:
        tmp=pathlib.Path(stream.name)
        try:
            stream.write(data);stream.flush();os.fsync(stream.fileno());os.replace(tmp,path)
        finally:
            tmp.unlink(missing_ok=True)

if root.resolve()!=root or root.stat().st_uid!=os.getuid() or root.stat().st_mode&0o777!=0o700:
    raise RuntimeError('Private staging queue required')
engine=root/'upgrade-engine/deploy/upgrade'
for path,sha in p['expected'].items():
    if hashlib.sha256((root/path).read_bytes()).hexdigest()!=sha:
        raise RuntimeError('Unexpected installed release controller: '+path)
live=json.loads(run(sys.executable,'-B',str(root/'staging.py'),'observe'))
if (live['backend'],live['ref'],live['build_id'])!=('canonical',p['baseline'],p['build']):
    raise RuntimeError('Unexpected canonical staging installation')
units=pathlib.Path.home()/'.config/systemd/user'
service=units/'aihr-staging-schema-pickup.service'
timer=units/'aihr-staging-schema-pickup.timer'
service_bytes=f'''[Unit]
Description=Pick up an authorized schema-only staging release
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -B {root}/schema-only.py pickup
TimeoutStartSec=90s
NoNewPrivileges=true
'''.encode()
timer_bytes=b'''[Unit]
Description=Check the staging queue for an authorized schema-only release
[Timer]
OnActiveSec=2s
OnUnitInactiveSec=3s
AccuracySec=1s
[Install]
WantedBy=timers.target
'''
with (root/'operations.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    paths={root/'schema-only.py':base64.b64decode(p['worker'],validate=True),
           engine/'schema-only-host.mjs':base64.b64decode(p['engine'],validate=True),
           service:service_bytes,timer:timer_bytes}
    for target,data in paths.items():
        if target.exists() or target.is_symlink():
            if target.resolve()!=target or target.read_bytes()!=data:
                raise RuntimeError('Unknown installed pickup component: '+target.name)
        else:
            install(target,data)
    run('/opt/node22/bin/node','--check',str(engine/'schema-only-host.mjs'))
run('systemctl','--user','daemon-reload')
run('systemctl','--user','enable','--now',timer.name)
run('systemctl','--user','is-active','--quiet',timer.name)
print(json.dumps({'pickup':'active','baseline':p['baseline'],'build':p['build']}))
"""


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssh-config',type=Path,required=True)
    parser.add_argument('--baseline',required=True)
    parser.add_argument('--build',required=True)
    args=parser.parse_args()
    files={'staging.py':'deploy/cutover/staging.py','coordinator.py':'scripts/staging/coordinator.py',
           'upgrade-engine/deploy/upgrade/index-expansion.mjs':'deploy/upgrade/index-expansion.mjs'}
    encoded=lambda name:base64.b64encode((ROOT/'deploy/upgrade'/name).read_bytes()).decode()
    payload={'baseline':args.baseline,'build':args.build,
             'expected':{name:hashlib.sha256((ROOT/path).read_bytes()).hexdigest() for name,path in files.items()},
             'worker':encoded('schema-only.py'),'engine':encoded('schema-only-host.mjs')}
    subprocess.run(['ssh','-F',str(args.ssh_config.resolve(strict=True)),'-o','BatchMode=yes',
                    '-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12','aihr-staging',
                    'python3 -B -c '+shlex.quote(REMOTE)],
                   input=json.dumps(payload).encode(),check=True,timeout=70)


if __name__=='__main__':
    main()
