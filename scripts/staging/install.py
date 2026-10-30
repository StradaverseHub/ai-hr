#!/usr/bin/env python3
"""Commission only the staging coordinator, outside application source; never deploy or restart."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
sys.dont_write_bytecode = True
from coordinator import require, private

INSTALL = r'''
import base64,hashlib,json,os,pathlib,subprocess,sys
os.umask(0o077)
p=json.load(sys.stdin)
root=pathlib.Path('/var/tmp/aihr-deploy/staging-release-queue')
status=subprocess.run(['bash','deploy/deploy-state.sh','status'],cwd='/opt/ai-hr',check=True,capture_output=True,text=True).stdout
s=dict(line.split('=',1) for line in status.splitlines() if '=' in line)
if not(s.get('state')=='ok' and s.get('stale_build')=='0' and s.get('ref')==s.get('built_ref') and s.get('build_id')==s.get('built_build_id')):raise ValueError('Healthy staging required; preserve current release owner')
subprocess.run(['systemctl','is-active','--quiet','aihr'],check=True)
root.mkdir(mode=0o700,exist_ok=True)
st=root.lstat()
if root.resolve()!=root or st.st_uid!=os.getuid() or st.st_mode&0o777!=0o700:raise ValueError('Private canonical coordinator directory required')
path=root/'coordinator.py';data=base64.b64decode(p['bytes'],validate=True)
if hashlib.sha256(data).hexdigest()!=p['sha256']:raise ValueError('Source digest differs')
if path.exists() or path.is_symlink():
 st=path.lstat()
 if path.is_symlink() or not path.is_file() or st.st_uid!=os.getuid() or st.st_mode&0o777!=0o600 or st.st_nlink!=1 or path.read_bytes()!=data:raise ValueError('Existing coordinator differs; explicit reviewed upgrade required')
else:
 with path.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
print(json.dumps({'coordinatorInstalled':True,'sha256':p['sha256'],'applicationChanged':False,'stagingSource':s['built_ref'],'stagingBuild':s['built_build_id']}))
'''


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--ssh-config',type=Path,required=True);a=p.parse_args()
    config=a.ssh_config.resolve();private(config)
    source=Path(__file__).with_name('coordinator.py').read_bytes()
    payload=dict(bytes=base64.b64encode(source).decode(),sha256=hashlib.sha256(source).hexdigest())
    import shlex
    subprocess.run(['ssh','-F',str(config),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12','aihr-staging','python3 -c '+shlex.quote(INSTALL)],input=json.dumps(payload).encode(),check=True,timeout=45)


if __name__=='__main__':main()
