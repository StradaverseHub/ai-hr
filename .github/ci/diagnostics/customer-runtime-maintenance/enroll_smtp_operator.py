"""Keep root authentication private; run application/DB code only as the existing Ubuntu UID."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys

BOOTSTRAP=r'''
import os,sys,pathlib,stat,hashlib,json,subprocess,pwd,datetime
operation,program_sha,authority_sha=sys.argv[1:]
assert os.geteuid()==0
assert __import__('re').fullmatch('[a-f0-9-]{36}',operation)
assert all(__import__('re').fullmatch('[a-f0-9]{64}',x) for x in (program_sha,authority_sha))
upload=pathlib.Path('/var/tmp/aihr-smtp-enroll-upload-'+operation)
parent=pathlib.Path('/var/lib/aihr-smtp-operator-enrollment');root=parent/operation
assert upload.resolve()==upload
u=upload.lstat();assert stat.S_ISDIR(u.st_mode) and u.st_uid==1000 and stat.S_IMODE(u.st_mode)==0o700
if not parent.exists():parent.mkdir(mode=0o700)
for p in (parent,):
 s=p.lstat();assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700 and p.resolve()==p
def read(p):
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd);assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and 0<s.st_size<=200000 and stat.S_IMODE(s.st_mode)==0o600
  b=os.read(fd,200001);identity=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns,x.st_uid,x.st_gid,x.st_mode,x.st_nlink);assert len(b)==s.st_size and identity(os.fstat(fd))==identity(s)==identity(p.lstat())
  return b,s
 finally:os.close(fd)
root.mkdir(mode=0o700)
for name,digest in [('enroll.mjs',program_sha),('authority.json',authority_sha)]:
 data,s=read(upload/name);assert s.st_uid==1000 and hashlib.sha256(data).hexdigest()==digest
 fd=os.open(root/name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
 copied,info=read(root/name);assert info.st_uid==0 and hashlib.sha256(copied).hexdigest()==digest
authority=json.loads(read(root/'authority.json')[0]);now=datetime.datetime.now(datetime.timezone.utc)
assert authority['operation']==operation and authority['scope']=='grant-staging-internal-smtp-operator'
assert authority['programSha256']==program_sha and authority['humanApprovalReference']
assert authority['username']=='phone-tester' and authority['organization']=='aihr-test' and authority['origin']=='https://onehr-staging.chinhingroup.com'
assert now<datetime.datetime.fromisoformat(authority['expiresAt']) and now-datetime.datetime.fromisoformat(authority['observedAt'])<datetime.timedelta(minutes=120)
assert os.path.realpath('/opt/ai-hr')=='/opt/ai-hr'
state=dict(line.split('=',1) for line in pathlib.Path('/var/tmp/aihr-deploy/current').read_text().splitlines() if '=' in line)
assert state['ref']=='9541b1686d7941f89e564723271e48bf85a21a89' and state['result']=='ok'
assert pathlib.Path('/opt/ai-hr/.next/BUILD_ID').read_text().strip()=='RZT3KRDc_BngwxXFhSv1S'
account=pwd.getpwnam('ubuntu');assert account.pw_uid==1000 and account.pw_gid==1000
assert subprocess.check_output(['/usr/bin/systemctl','show','aihr','-p','ActiveState','--value']).strip()==b'active'
assert subprocess.check_output(['/usr/bin/systemctl','show','aihr','-p','User','--value']).strip()==b'ubuntu'
program=read(root/'enroll.mjs')[0].decode()
# All app dependencies, decryption and SQL execute after dropping OS privilege.
child=subprocess.run(['/opt/node22/bin/node','--env-file=/opt/ai-hr/.env.production','--import','/opt/ai-hr/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',program],input=read(root/'authority.json')[0],cwd='/opt/ai-hr',user=1000,group=1000,extra_groups=[],env={'PATH':'/opt/node22/bin:/usr/bin:/bin','LANG':'C.UTF-8','AIHR_ENROLL_ENTRY':'apply'},stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
if child.returncode:print('SMTP_OPERATOR_ENROLLMENT_REFUSED; retain private evidence');sys.exit(1)
result=json.loads(child.stdout);assert result['kind']=='STAGING_INTERNAL_SMTP_OPERATOR_ENROLLED' and result['canonicalEmailAuthorizationVerified'] is True
fd=os.open(root/'result.json',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'wb') as f:f.write(child.stdout);f.flush();os.fsync(f.fileno())
print(json.dumps(result))
'''


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--packet',required=True)
    parser.add_argument('--ssh-config',required=True)
    args=parser.parse_args()
    if not sys.stdin.isatty() or not sys.stdout.isatty():raise SystemExit('Use your private interactive Terminal; never send sudo credentials to chat.')
    packet=Path(args.packet).resolve();contents={}
    for name in ('enroll.mjs','authority.json'):
        p=packet/name;s=p.lstat()
        assert stat.S_ISREG(s.st_mode) and not p.is_symlink() and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600
        contents[name]=p.read_bytes()
    authority=json.loads(contents['authority.json']);operation=authority['operation']
    assert authority['programSha256']==hashlib.sha256(contents['enroll.mjs']).hexdigest()
    config=str(Path(args.ssh_config).resolve());ssh=['ssh','-F',config,'-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15']
    upload='/var/tmp/aihr-smtp-enroll-upload-'+operation
    subprocess.run(ssh+['-o','BatchMode=yes','aihr-staging','umask 077; mkdir -- '+shlex.quote(upload)],check=True)
    for name in contents:
        subprocess.run(['scp','-F',config,'-o','StrictHostKeyChecking=yes',str(packet/name),'aihr-staging:'+upload+'/'+name],check=True)
    command='sudo /usr/bin/python3 -I -c '+shlex.quote(BOOTSTRAP)+' '+shlex.quote(operation)+' '+hashlib.sha256(contents['enroll.mjs']).hexdigest()+' '+hashlib.sha256(contents['authority.json']).hexdigest()
    subprocess.run(ssh+['-tt','aihr-staging',command],check=True)


if __name__=='__main__':main()
