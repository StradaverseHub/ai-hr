"""GHA-only producer: committed runtime source plus locked, actually installed Linux dependencies."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import zipfile

# Defense in depth for a direct invocation: imports must never dirty the frozen source.
sys.dont_write_bytecode=True

def main():
    root,output=map(lambda value:Path(value).absolute(),sys.argv[1:3]);source=sys.argv[3]
    controller=Path(__file__).resolve().parents[1]
    spec=importlib.util.spec_from_file_location('worker_format',Path(__file__).resolve().parents[1]/'deploy/systemd/bank_import_worker_format.py')
    fmt=importlib.util.module_from_spec(spec);spec.loader.exec_module(fmt)
    runtime=json.load(sys.stdin);fmt.require(runtime==fmt.RUNTIME,'producer runtime')
    fmt.require(root.resolve()==root and output.resolve()==output and not output.exists() and not output.is_relative_to(root),'canonical new output outside source')
    def git(*args): return subprocess.check_output(['git','-C',str(root),*args])
    def controller_git(*args): return subprocess.check_output(['git','-C',str(controller),*args])
    controller_source=controller_git('rev-parse','HEAD').decode().strip()
    fmt.require(not controller_git('status','--porcelain','--untracked-files=all'),'exact clean controller required')
    fmt.require(git('rev-parse','HEAD').decode().strip()==source and not git('status','--porcelain','--untracked-files=all'),'exact clean candidate required')
    entries={};files={};links={};total=0
    def parents(path):
        for parent in Path(path).parents:
            if str(parent)!='.': entries.setdefault(parent.as_posix(),{'path':parent.as_posix(),'type':'directory'})
    def add_file(path,expected_blob=None,executable=None):
        nonlocal total
        fmt.safe_path(path);actual=root/path;before=actual.lstat()
        fmt.require(stat.S_ISREG(before.st_mode) and before.st_size<=fmt.MAX_FILE,'regular bounded producer file')
        raw=actual.read_bytes();after=actual.lstat()
        fmt.require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'producer file changed')
        if expected_blob is not None: fmt.require(hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==expected_blob,'source differs from committed Git blob')
        mode=0o755 if (executable if executable is not None else before.st_mode&0o111) else 0o644
        entries[path]={'path':path,'type':'file','size':len(raw),'sha256':fmt.digest(raw),'mode':mode};files[path]=actual;parents(path);total+=len(raw)
        fmt.require(total<=fmt.MAX_TOTAL and len(entries)<=fmt.MAX_ENTRIES,'producer tree bounds')
    def add_link(path,expected_blob=None):
        fmt.safe_path(path);target=os.readlink(root/path)
        if expected_blob is not None:
            raw=target.encode();fmt.require(hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==expected_blob,'committed source link differs')
        entries[path]={'path':path,'type':'symlink','target':target};links[path]=target;parents(path)
    for record in git('ls-tree','-rz','--full-tree',source).split(b'\0'):
        if not record: continue
        info,name=record.split(b'\t',1);mode,kind,blob=info.decode().split();name=name.decode()
        if name not in fmt.ROOT_FILES and name.split('/')[0] not in fmt.ROOT_DIRS: continue
        if any(p.startswith('.env') or p in ('.git','.improve','.next','scratchpad','backups') for p in name.split('/')): continue
        fmt.require(kind=='blob' and mode in ('100644','100755','120000'),'committed regular source or internal link required')
        if mode=='120000': add_link(name,blob)
        else: add_file(name,blob,mode=='100755')
    modules=root/'node_modules';fmt.require(modules.is_dir() and not modules.is_symlink(),'real installed dependencies required')
    for base,dirs,names in os.walk(modules,followlinks=False):
        for name in list(dirs)+names:
            path=Path(base)/name;relative=path.relative_to(root).as_posix()
            if name.startswith('.env') or name in ('.git','.improve','.next','scratchpad','backups'):
                if name in dirs: dirs.remove(name)
                continue
            if path.is_symlink():
                add_link(relative)
                if name in dirs: dirs.remove(name)
            elif path.is_dir(): entries[relative]={'path':relative,'type':'directory'};parents(relative)
            else: add_file(relative)
    entries['node_modules']={'path':'node_modules','type':'directory'}
    manifest={'format':2,'kind':'bank-import-worker-package-v2','source':source,'controllerSource':controller_source,'producerSha256':fmt.digest(Path(__file__).read_bytes()),'formatSha256':fmt.digest((controller/'deploy/systemd/bank_import_worker_format.py').read_bytes()),'runtime':runtime,'lockSha256':entries['pnpm-lock.yaml']['sha256'],'packageSha256':entries['package.json']['sha256'],'entries':[entries[p] for p in sorted(entries)]}
    fmt.require_activation_manifest(manifest,controller_source)
    fmt.validate_manifest(manifest,source);raw_manifest=fmt.canonical(manifest);fmt.require(len(raw_manifest)<=fmt.MAX_MANIFEST,'manifest bytes')
    output.mkdir(mode=0o700,parents=True);archive_path=output/'worker-package.zip'
    with zipfile.ZipFile(archive_path,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
        archive.writestr('worker-manifest.json',raw_manifest)
        for name in sorted(files):
            row=entries[name];raw=files[name].read_bytes();fmt.require(len(raw)==row['size'] and fmt.digest(raw)==row['sha256'],'dependency/source changed before archive')
            archive.writestr('payload/'+name,raw)
    fmt.require(archive_path.stat().st_size<=fmt.MAX_ARCHIVE,'archive bytes')
    fmt.inspect_archive(archive_path,source,manifest['lockSha256'],manifest['packageSha256'])
    fmt.require(git('rev-parse','HEAD').decode().strip()==source and not git('status','--porcelain','--untracked-files=all'),'candidate changed during packaging')
    fmt.require(controller_git('rev-parse','HEAD').decode().strip()==controller_source and not controller_git('status','--porcelain','--untracked-files=all'),'controller changed during packaging')
    (output/'worker-manifest.json').write_bytes(raw_manifest)
    h=hashlib.sha256()
    with archive_path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024**2),b''): h.update(block)
    provenance={'format':2,'kind':'WORKER_BYTES_ONLY_NOT_RELEASE_AUTHORITY','source':source,'controllerSource':controller_source,'producerSha256':manifest['producerSha256'],'formatSha256':manifest['formatSha256'],'runtime':runtime,'archiveSha256':h.hexdigest(),'archiveBytes':archive_path.stat().st_size,'manifestSha256':fmt.digest(raw_manifest),'packageSha256':manifest['packageSha256'],'lockSha256':manifest['lockSha256'],'entries':len(entries),'unpackedBytes':total}
    (output/'worker-provenance.json').write_bytes(fmt.canonical(provenance));print(json.dumps(provenance))

if __name__=='__main__': main()
