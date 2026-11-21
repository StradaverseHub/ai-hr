"""Upgrade the commissioned staging coordinator in place, preserving its queue and lease epoch."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[2]
FILES = {
    'coordinator.py': 'scripts/staging/coordinator.py',
    'staging.py': 'deploy/cutover/staging.py',
    'canonical-deploy.sh': 'deploy/cutover/canonical-deploy.sh',
}
ENGINE = ['index-expansion.mjs', 'staging-index.mjs']
REMOTE = r'''
import base64, fcntl, hashlib, json, os, pathlib, sqlite3, subprocess, sys, tempfile
root=pathlib.Path('/var/tmp/aihr-deploy/staging-release-queue')
os.umask(0o077)
p=json.load(sys.stdin)
def digest(content):
    return hashlib.sha256(content).hexdigest()
def owned(path, mode):
    stat=path.lstat()
    if path.resolve()!=path or stat.st_uid!=os.getuid() or stat.st_mode&0o777!=mode:
        raise RuntimeError("Unexpected staging installation ownership")
def install(path,data):
    with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as stream:
        tmp=pathlib.Path(stream.name)
        try:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
            os.replace(tmp,path)
        finally:
            tmp.unlink(missing_ok=True)
owned(root,0o700)
for name in ('cutover.json','operations.lock','queue.sqlite3'):
    owned(root/name,0o600)
engine=root/'upgrade-engine'
with (root/'operations.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    db=sqlite3.connect(root/'queue.sqlite3',timeout=5,isolation_level=None)
    db.execute('BEGIN IMMEDIATE')
    try:
        if db.execute('SELECT batch FROM lease').fetchone()[0]:
            raise RuntimeError("An operator holds the shared staging lease")
        old={}
        for name, checksum in p['previous'].items():
            owned(root/name,0o600)
            old[name]=(root/name).read_bytes()
            if digest(old[name])!=checksum:
                raise RuntimeError("Unknown installed controller version: " + name)
        if engine.exists() or engine.is_symlink():
            raise RuntimeError("The staging upgrade engine is already present")
        backup=pathlib.Path(tempfile.mkdtemp(prefix='before-index-lane-',dir=root))
        for name,data in old.items():
            install(backup/name,data)
        incoming=pathlib.Path(tempfile.mkdtemp(prefix='.index-engine-',dir=root))
        node=incoming/'deploy/upgrade'
        node.mkdir(parents=True)
        (incoming/'.github').symlink_to('/opt/ai-hr/.github', target_is_directory=True)
        for name,data in p['engine'].items():
            install(node/name,base64.b64decode(data,validate=True))
            subprocess.run(['/opt/node22/bin/node','--check',str(node/name)],check=True,
                           capture_output=True,timeout=10)
        try:
            os.rename(incoming,engine)
            for name in ('canonical-deploy.sh','staging.py','coordinator.py'):
                install(root/name,base64.b64decode(p['files'][name],validate=True))
            observed=subprocess.run([sys.executable,'-B','staging.py','observe'],cwd=root,
                                    check=True,capture_output=True,text=True,timeout=30)
            live=json.loads(observed.stdout)
            if live.get('backend')!='canonical' or (live['ref'],live['build_id'])!=(p['baseline'],p['build']):
                raise RuntimeError("Unexpected canonical staging baseline")
        except BaseException:
            for name,data in old.items():
                install(root/name,data)
            if engine.exists():
                os.rename(engine,backup/'uncommissioned-engine')
            raise
        fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        print(json.dumps({'indexExpansionCommissioned':True,'source':live['ref'],'build':live['build_id']}))
    finally:
        db.execute('ROLLBACK')
        db.close()
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssh-config', type=Path, required=True)
    parser.add_argument('--previous', required=True)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--build', required=True)
    args = parser.parse_args()
    sha256 = lambda value: hashlib.sha256(value).hexdigest()
    encoded = lambda path: base64.b64encode(path.read_bytes()).decode()
    previous = {name: sha256(subprocess.check_output(['git','show',args.previous+':'+file], cwd=ROOT))
                for name, file in FILES.items()}
    payload = {'previous':previous, 'files':{name:encoded(ROOT/file) for name,file in FILES.items()},
               'engine':{name:encoded(Path(__file__).with_name(name)) for name in ENGINE},
               'baseline':args.baseline, 'build':args.build}
    subprocess.run(['ssh','-F',str(args.ssh_config.resolve(strict=True)),'-o','BatchMode=yes',
                    '-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12','aihr-staging',
                    'python3 -B -c '+shlex.quote(REMOTE)],
                   input=json.dumps(payload).encode(),check=True,timeout=60)


if __name__=='__main__':
    main()
