"""Private-terminal entry point. It cannot create human approval or accept staging.

Run only after the exact maintenance packet has been approved. Sudo passwords stay
in the operator's terminal. Root executes only hash-verified root-owned copies.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import uuid

BOOTSTRAP = r'''
import hashlib,json,os,pathlib,stat,sys
operation,phase,agent_sha,plan_sha,approval_sha,node_sha,source_name,source_sha=sys.argv[1:]
assert __import__('re').fullmatch(r'[a-f0-9-]{36}',operation)
assert phase in ('prepare','cutover','release-started','recover-before-release')
assert all(__import__('re').fullmatch(r'[a-f0-9]{64}',s) for s in (agent_sha,plan_sha,approval_sha,node_sha))
assert __import__('re').fullmatch(r'source-proof-[a-f0-9-]{36}\.json',source_name)
assert __import__('re').fullmatch(r'[a-f0-9]{64}',source_sha)
parent=pathlib.Path('/var/lib/aihr-runtime-maintenance');root=parent/operation
upload=pathlib.Path('/var/tmp/aihr-maintenance-upload-'+operation)
def directory(p,private):
 s=os.lstat(p);assert stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and os.path.realpath(p)==str(p)
 assert s.st_uid==0 and not s.st_mode&0o022
 if private:assert stat.S_IMODE(s.st_mode)==0o700
def read(p,bound):
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd);assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and 0<s.st_size<=bound
  b=b''
  while True:
   c=os.read(fd,1024*1024)
   if not c:break
   b+=c;assert len(b)<=bound
  after=os.fstat(fd);named=os.lstat(p)
  ident=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns,x.st_uid,x.st_gid,x.st_mode)
  assert ident(s)==ident(after)==ident(named)
  return b
 finally:os.close(fd)
if phase=='prepare':
 if not parent.exists():parent.mkdir(mode=0o700)
 directory(parent,True);root.mkdir(mode=0o700);directory(root,True)
 items=[('maintenance_agent.py',agent_sha,2*1024**2),('approved-plan.json',plan_sha,2*1024**2),('human-approval.json',approval_sha,16384),('node.tar.xz',node_sha,80*1024**2)]
 us=os.lstat(upload);assert stat.S_ISDIR(us.st_mode) and not stat.S_ISLNK(us.st_mode) and stat.S_IMODE(us.st_mode)==0o700
 for name,digest,bound in items:
  data=read(upload/name,bound);assert hashlib.sha256(data).hexdigest()==digest
  original=os.lstat(upload/name);assert original.st_uid==us.st_uid and stat.S_IMODE(original.st_mode)==0o600
  fd=os.open(root/name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  assert hashlib.sha256(read(root/name,bound)).hexdigest()==digest
 fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);os.fsync(fd);os.close(fd)
else:
 directory(parent,True);directory(root,True)
for name,digest in [('maintenance_agent.py',agent_sha),('approved-plan.json',plan_sha),('human-approval.json',approval_sha)]:
 assert hashlib.sha256(read(root/name,2*1024**2)).hexdigest()==digest
source=read(upload/source_name,65536);assert hashlib.sha256(source).hexdigest()==source_sha
fd=os.open(root/source_name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'wb') as f:f.write(source);f.flush();os.fsync(f.fileno())
temporary=root/('fresh-source-'+source_name)
fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'wb') as f:f.write(source);f.flush();os.fsync(f.fileno())
os.replace(temporary,root/'fresh-source-proof.json')
fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);os.fsync(fd);os.close(fd)
os.execv('/usr/bin/python3',['python3',str(root/'maintenance_agent.py'),phase,'--plan',str(root/'approved-plan.json'),'--plan-sha256',plan_sha,'--human-approval',str(root/'human-approval.json'),'--archive',str(root/'node.tar.xz'),'--source-proof-sha256',source_sha])
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "cutover", "release-started", "recover-before-release"))
    parser.add_argument("--packet", required=True)
    parser.add_argument("--ssh-config", required=True)
    parser.add_argument("--controller", required=True)
    parser.add_argument("--retained-source", required=True)
    parser.add_argument("--dependency-root", required=True)
    args = parser.parse_args()
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise SystemExit("Run this approved operation in your private interactive terminal; keep sudo input there.")
    packet = Path(args.packet).resolve()
    inputs = {}
    for name in ("maintenance_agent.py", "approved-plan.json", "human-approval.json", "node.tar.xz", "source-proof.mjs"):
        path = packet / name
        info = path.lstat()
        if not path.is_file() or path.is_symlink() or info.st_nlink != 1 or info.st_mode & 0o077:
            raise SystemExit("Expected private regular packet members with mode0600.")
        inputs[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    plan = json.loads((packet / "approved-plan.json").read_text())
    approval = json.loads((packet / "human-approval.json").read_text())
    operation = plan["operation"]
    if not re.fullmatch(r"[a-f0-9-]{36}", operation):
        raise SystemExit("Invalid operation")
    if (approval.get("planSha256") != inputs["approved-plan.json"]
            or approval.get("agentSha256") != inputs["maintenance_agent.py"]
            or approval.get("scope") != "staging-node22-config-and-app-release"
            or approval.get("operatorSha256") != hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
            or approval.get("sourceProofProgramSha256") != inputs["source-proof.mjs"]
            or not approval.get("humanApprovalReference")):
        raise SystemExit("Explicit approval for this exact packet is required; this tool never creates it.")
    config = str(Path(args.ssh_config).resolve())
    ssh = ["ssh", "-F", config, "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15"]
    source_name = "source-proof-" + str(uuid.uuid4()) + ".json"
    source_path = packet / source_name
    dependencies = Path(args.dependency_root).resolve()
    proof_env = {**os.environ, "NODE_PATH": str(dependencies)}
    subprocess.run(["node", "--import", str(dependencies / "tsx/dist/loader.mjs"), str(packet / "source-proof.mjs"),
                    str(Path(args.controller).resolve()), str(packet / "approved-plan.json"),
                    str(Path(args.retained_source).resolve()), config, str(source_path)],
                   env=proof_env, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    source_data = source_path.read_bytes()
    proof = json.loads(source_data)
    if (proof.get("baseline") != plan["baseline"] or proof.get("checksumOutput") != ""
            or proof.get("ledger") != plan["baselineSourceProof"]["ledger"]):
        raise SystemExit("Fresh canonical source/ledger custody differs; no maintenance invoked.")
    upload = "/var/tmp/aihr-maintenance-upload-" + operation
    if args.phase == "prepare":
        subprocess.run(ssh + ["-o", "BatchMode=yes", "aihr-staging", "umask 077; mkdir -- " + shlex.quote(upload)], check=True)
        # The directory is exclusively created for this operation; never replace a previous upload.
        for name in ("maintenance_agent.py", "approved-plan.json", "human-approval.json", "node.tar.xz"):
            subprocess.run(["scp", "-F", config, "-o", "StrictHostKeyChecking=yes", str(packet / name),
                            "aihr-staging:" + upload + "/" + name], check=True)
    subprocess.run(["scp", "-F", config, "-o", "StrictHostKeyChecking=yes", str(source_path),
                    "aihr-staging:" + upload + "/" + source_name], check=True)
    argv = [operation, args.phase, inputs["maintenance_agent.py"], inputs["approved-plan.json"],
            inputs["human-approval.json"], inputs["node.tar.xz"], source_name, hashlib.sha256(source_data).hexdigest()]
    command = "sudo /usr/bin/python3 -c " + shlex.quote(BOOTSTRAP) + " " + " ".join(map(shlex.quote, argv))
    # stdin/stdout inherit the private terminal. No password handling, logging or interception.
    subprocess.run(ssh + ["-tt", "aihr-staging", command], check=True)


if __name__ == "__main__":
    main()
