"""Private terminal transport for the reviewed stopped-operation supplement."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys

OPERATOR_SHA='a8b971d727bcaa9015b6e7c6a20d48020d75dafedb18d69e977c1ff57bb7f2d6'


def build_bootstrap(original, supplement_sha, authority_sha):
    assert all(re.fullmatch('[a-f0-9]{64}',x) for x in (supplement_sha,authority_sha))
    anchor="os.execv('/usr/bin/python3',['python3','-I',str(root/'maintenance_agent.py'),phase,"
    assert original.count(anchor)==1
    extra=''
    for name,digest in [('resume_stopped.py',supplement_sha),('continuation-approval.json',authority_sha)]:
        extra += "\nname="+repr(name)+";digest="+repr(digest)+"\ndata=read(upload/name,2*1024**2);assert hashlib.sha256(data).hexdigest()==digest\n"
        extra += "if not os.path.lexists(root/name):\n fd=os.open(root/name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)\n with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())\n"
        extra += "s=os.lstat(root/name);assert s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and hashlib.sha256(read(root/name,2*1024**2)).hexdigest()==digest\n"
    extra += "fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);os.fsync(fd);os.close(fd)\n"
    return original.replace(anchor,extra+anchor.replace("root/'maintenance_agent.py'","root/'resume_stopped.py'"))


def private_bytes(path):
    s=path.lstat()
    assert stat.S_ISREG(s.st_mode) and not path.is_symlink() and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600
    return path.read_bytes()


def main():
    parser=argparse.ArgumentParser()
    for key in ('packet','ssh-config','controller','retained-source','dependency-root','supplement','continuation-approval'):
        parser.add_argument('--'+key,required=True)
    args=parser.parse_args()
    assert sys.stdin.isatty() and sys.stdout.isatty(),'Use your private interactive terminal'
    packet=Path(args.packet).resolve();operator=packet/'operator.py'
    assert hashlib.sha256(private_bytes(operator)).hexdigest()==OPERATOR_SHA
    supplement=private_bytes(Path(args.supplement).resolve());authority_raw=private_bytes(Path(args.continuation_approval).resolve())
    authority=json.loads(authority_raw);plan_raw=private_bytes(packet/'approved-plan.json');plan=json.loads(plan_raw)
    assert authority['originalPlanSha256']==hashlib.sha256(plan_raw).hexdigest()
    assert authority['operation']==plan['operation'] and authority['supplementSha256']==hashlib.sha256(supplement).hexdigest()
    config=str(Path(args.ssh_config).resolve());upload='/var/tmp/aihr-maintenance-upload-'+plan['operation']
    assert re.fullmatch('[a-f0-9-]{36}',plan['operation'])
    for name,data in [('resume_stopped.py',supplement),('continuation-approval.json',authority_raw)]:
        code="import os,stat,sys,hashlib;directory="+repr(upload)+";name="+repr(name)+";digest="+repr(hashlib.sha256(data).hexdigest())+";s=os.lstat(directory);assert stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o700 and os.path.realpath(directory)==directory;data=sys.stdin.buffer.read(2*1024**2+1);assert len(data)<=2*1024**2 and hashlib.sha256(data).hexdigest()==digest;p=directory+'/'+name\nif not os.path.lexists(p):\n fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)\n with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())\ns=os.lstat(p);assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o600 and hashlib.sha256(open(p,'rb').read()).hexdigest()==digest"
        subprocess.run(['ssh','-F',config,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','aihr-staging','python3 -I -c '+shlex.quote(code)],input=data,check=True)
    spec=importlib.util.spec_from_file_location('reviewed_original_operator',operator)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.BOOTSTRAP=build_bootstrap(module.BOOTSTRAP,hashlib.sha256(supplement).hexdigest(),hashlib.sha256(authority_raw).hexdigest())
    sys.argv=[str(operator),'cutover','--packet',str(packet),'--ssh-config',config,'--controller',args.controller,
              '--retained-source',args.retained_source,'--dependency-root',args.dependency_root]
    module.main()


if __name__=='__main__':main()
