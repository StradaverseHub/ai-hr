"""Package reviewed operator-only bytes outside the application. No target access or execution."""
import hashlib,io,json,os,re,subprocess,sys,tarfile,tempfile
from pathlib import Path

SOURCE='f2ca511f4ded441399fd30437bb75553bb92efbb'
def require(value,message):
    if not value:raise ValueError(message)
def canonical(value):return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
def archive(ref,*paths):
    raw=subprocess.check_output(['git','archive','--format=tar',ref,*paths])
    return tarfile.open(fileobj=io.BytesIO(raw),mode='r:')
def safe(name):return name and not name.startswith('/') and all(p not in ('','..','.') for p in name.split('/'))
def package(destination):
    require(not subprocess.check_output(['git','status','--porcelain']).strip(),'Freeze a clean reviewed controller before packaging')
    controller=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();require(re.fullmatch('[a-f0-9]{40}',controller),'Exact controller required')
    destination=Path(destination).absolute();require(not destination.exists(),'Fresh private output directory required')
    destination.mkdir(mode=0o700)
    files=[]
    with archive(controller,'.github/ci','scripts/staging') as tar:
        for member in tar:
            if member.isdir():continue
            require(member.isfile() and safe(member.name) and member.size<=16*1024**2,'Unsupported tool member')
            data=tar.extractfile(member).read();path=destination/member.name;path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            path.write_bytes(data);path.chmod(0o600);files.append({'path':member.name,'sha256':hashlib.sha256(data).hexdigest()})
    source=[]
    git_modes={}
    for entry in subprocess.check_output(['git','ls-tree','-r','-z','--full-tree',SOURCE]).split(b'\0'):
        if not entry:continue
        meta,name=entry.split(b'\t',1);mode,kind,oid=meta.decode().split();name=name.decode()
        require(kind=='blob' and mode in ('100644','100755','120000'),'Only immutable file/link source modes supported')
        git_modes[name]=0o777 if mode=='120000' else int(mode,8)&0o777
    # Use the exact published transfer filter, through real rsync, rather than treating excluded
    # environment/native/history files as missing runtime source or inventing a second filter.
    release=subprocess.check_output(['git','show',SOURCE+':scripts/improve/release.ts'],text=True)
    block=release.split('export function deploymentRsyncArgs(',1)[1].split('\n}\n',1)[0]
    excludes=re.findall(r"'--exclude',\s*'([^']+)'",block)
    require(0<len(excludes)<=64 and block.count("'--exclude'")==len(excludes),'Canonical transfer filter must remain literal and complete')
    with tempfile.TemporaryDirectory(prefix='cleanup-canonical-source-') as scratch:
        original=Path(scratch)/'original';filtered=Path(scratch)/'filtered';original.mkdir();filtered.mkdir()
        with archive(SOURCE) as tar:
            for member in tar:
                if member.isdir():continue
                require(safe(member.name) and (member.isfile() or member.issym()) and member.size<=64*1024**2,'Unsupported frozen source member')
                data=member.linkname.encode() if member.issym() else tar.extractfile(member).read()
                path=original/member.name;path.parent.mkdir(parents=True,exist_ok=True)
                require(path.parent.resolve().is_relative_to(original.resolve()),'Archive parent may not follow a link')
                if member.issym():os.symlink(member.linkname,path)
                else:path.write_bytes(data)
                require(member.name in git_modes,'Archive member absent from immutable Git tree')
                source.append({'path':member.name,'kind':'link' if member.issym() else 'file','mode':git_modes[member.name],'sha256':hashlib.sha256(data).hexdigest()})
        args=['rsync','-a','--omit-dir-times']
        for pattern in excludes:args.extend(['--exclude',pattern])
        subprocess.run([*args,str(original)+'/',str(filtered)+'/'],check=True,timeout=120)
        source=[row for row in source if os.path.lexists(filtered/row['path'])]
    require(0<len(source)<=20000 and len({r['path'] for r in source})==len(source),'Bounded complete source inventory required')
    source_bytes=canonical({'source':SOURCE,'files':sorted(source,key=lambda r:r['path'])})
    (destination/'source-files.json').write_bytes(source_bytes);(destination/'source-files.json').chmod(0o600)
    files.append({'path':'source-files.json','sha256':hashlib.sha256(source_bytes).hexdigest()})
    require(len(files)<=1500 and len({r['path'] for r in files})==len(files),'Bounded unique tool inventory required')
    manifest=canonical({'format':1,'kind':'REVIEWED_EXTERNAL_SINGLE_INSTALL_CLEANUP_TOOL','controller':controller,'files':sorted(files,key=lambda r:r['path'])})
    (destination/'post-arrival-tool.json').write_bytes(manifest);(destination/'post-arrival-tool.json').chmod(0o600)
    return {'kind':'PACKAGED_NOT_AUTHORIZED_CLEANUP_TOOL','controller':controller,'toolSha256':hashlib.sha256(manifest).hexdigest(),'files':len(files),'sourceFiles':len(source),'executionAuthorized':False}
if __name__=='__main__':
    require(len(sys.argv)==2,'Usage: post-arrival-cleanup-package.py NEW_PRIVATE_DIRECTORY')
    print(json.dumps(package(sys.argv[1])))
