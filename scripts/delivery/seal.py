#!/usr/bin/env python3
"""Prepare root-owned immutable release trees before acquiring the installation lease.

The seal is not a provenance/acceptance certificate. An authenticated artifact verifier must
supply the expected tree digest. Live activation checks only the protected root and seal;
application identities cannot modify either. Runtime caches/logs stay outside this tree.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import uuid

POLICY='aihr-delivery-seal/v1'
MAX_FILES=200000
MAX_BYTES=4*1024**3

def require(ok,message):
    if not ok: raise ValueError('Release seal refused: '+message)

def identity(s): return [s.st_dev,s.st_ino,s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode)]
def canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def owner_path(path,uid):
    path=Path(path).absolute()
    require(path.resolve()==path,'Symlinked release path')
    for p in [path,*path.parents]:
        s=p.lstat();require(stat.S_ISDIR(s.st_mode) and s.st_uid==uid and not s.st_mode & 0o022,'Unprotected release ancestor')
    return path

def inspect_tree(root,uid):
    root=owner_path(root,uid);rows=[];total=0
    for current,dirs,files in os.walk(root,followlinks=False):
        for name in sorted(dirs+files):
            p=Path(current)/name;rel=p.relative_to(root).as_posix();s=p.lstat()
            require(len(rows)<MAX_FILES and name!='.delivery-seal.json','Unexpected seal or excessive members')
            require(s.st_uid==uid and s.st_dev==root.stat().st_dev and (stat.S_ISLNK(s.st_mode) or not s.st_mode&0o022),'Unprotected/cross-device member')
            if stat.S_ISDIR(s.st_mode): row={'path':rel,'type':'directory'}
            elif stat.S_ISREG(s.st_mode):
                require(s.st_nlink==1 and s.st_size<=256*1024**2,'Hardlink or excessive file');total+=s.st_size;require(total<=MAX_BYTES,'Excessive release bytes')
                fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
                with os.fdopen(fd,'rb') as stream:
                    before=os.fstat(stream.fileno());h=hashlib.file_digest(stream,'sha256').hexdigest();after=os.fstat(stream.fileno())
                require((before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'Member changed during preparation')
                row={'path':rel,'type':'file','sha256':h,'bytes':s.st_size,'executable':bool(s.st_mode&0o111)}
            elif stat.S_ISLNK(s.st_mode):
                target=os.readlink(p);require(p.resolve(strict=True).is_relative_to(root),'Escaping/dangling symlink');row={'path':rel,'type':'symlink','target':target}
            else: raise ValueError('Unsupported release member')
            rows.append(row)
    require(rows,'Empty release tree');return sorted(rows,key=lambda r:r['path'])

def prepare(root,expected,uid=0):
    require(len(expected)==64 and all(c in '0123456789abcdef' for c in expected),'Expected authenticated tree digest required')
    root=Path(root);rows=inspect_tree(root,uid);actual=hashlib.sha256(canonical(rows)).hexdigest();require(actual==expected,'Tree bytes differ from authenticated artifact')
    # No caller-owned source is published, and no recursive walk is repeated during live switch.
    for current,dirs,files in os.walk(root,topdown=False,followlinks=False):
        for name in files:
            p=Path(current)/name
            if not p.is_symlink(): p.chmod(0o555 if p.stat().st_mode&0o111 else 0o444)
        Path(current).chmod(0o555)
    seal={'policy':POLICY,'id':str(uuid.uuid4()),'treeDigest':actual,'rootIdentity':identity(root.stat()),'files':len(rows),'bytes':sum(r.get('bytes',0) for r in rows)}
    # Root may write its own read-only directory. Tests run this under sudo on a hosted runner.
    p=root/'.delivery-seal.json';fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
    with os.fdopen(fd,'wb') as stream: stream.write(canonical(seal)+b'\n');stream.flush();os.fsync(stream.fileno())
    d=os.open(root,os.O_RDONLY|os.O_DIRECTORY);os.fsync(d);os.close(d)
    return seal

def verify(root,expected,uid=0):
    root=owner_path(root,uid);p=root/'.delivery-seal.json';s=p.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_uid==uid and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o444 and s.st_size<=4096,'Unprotected seal')
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream: seal=json.load(stream)
    require(set(seal)=={'policy','id','treeDigest','rootIdentity','files','bytes'} and seal['policy']==POLICY and seal['treeDigest']==expected and seal['rootIdentity']==identity(root.stat()),'Seal/root identity differs')
    require(stat.S_IMODE(root.stat().st_mode)==0o555,'Release root is writable')
    return seal

def main():
    require(os.getuid()==0,'Production CLI requires root; app users cannot mint seals')
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('mode',choices=['prepare','verify']);p.add_argument('root');p.add_argument('digest');a=p.parse_args()
    print(json.dumps((prepare if a.mode=='prepare' else verify)(a.root,a.digest),sort_keys=True))
if __name__=='__main__': main()
