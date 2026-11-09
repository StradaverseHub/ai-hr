"""Closed five-unit byte receiver. Never executes or authorizes archive contents.
The actual API owner authenticates ZIP digest/size BEFORE calling this receiver.
"""
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
import re
import stat
import sys
import zipfile
ROOT=Path(__file__).resolve().parents[2]

def require(value):
    if not value:
        raise ValueError('Closed employee evidence receiver refused')

def profile(file,unit):
    registry=json.loads((ROOT/'.github/ci/employee-lifecycle-profile.json').read_bytes())
    require(registry['version']==1 and len(registry['files'])==5)
    rows=[row for row in registry['files'] if row['file']==file];require(len(rows)==1)
    descriptor={'version':1,'profile':'controlled-database-v1','workers':1,'isolation':'job-postgres-cluster'}
    expected='db-'+hashlib.sha256(json.dumps({'file':file,'descriptor':descriptor},separators=(',',':')).encode()).hexdigest()[:16]
    require(unit==expected and re.fullmatch(r'db-[a-f0-9]{16}',unit) is not None)
    row=rows[0];require(row['clockDirectory'] in (None,'employee-choice-native-purpose','employee-choice-exact-ascii-purpose','employee-choice-exact-ascii'))
    return row,json.loads((ROOT/'.github/ci/employee-lifecycle-evidence-profile.json').read_bytes())

def allowed(name,unit,row,rule,directory=False):
    if not isinstance(name,str) or '\\' in name or '\0' in name or name.startswith('/') or any(part in ('','.','..') for part in name.split('/')):
        return False
    folder=row['clockDirectory']
    if directory:
        return folder is not None and (name==folder or name in [folder+'/'+clock+'.ready' for clock in rule['clockNames']])
    if name in [value.replace('{UNIT}',unit) for value in rule['rootNames']]:
        return True
    for prefix in rule['sequencePrefixes']:
        start=prefix.replace('{UNIT}',unit)
        if name.startswith(start):
            suffix=name[len(start):]
            if re.fullmatch(r'[1-9][0-9]?\.json',suffix) and int(suffix[:-5])<=rule['sequenceMaximum']:
                return True
    if folder is None or not name.startswith(folder+'/'):
        return False
    base=name[len(folder)+1:]
    if '/' in base:
        return False
    if base in rule['clockNames'] or base==rule['reportByStage'].get(row['stage']):
        return True
    if row['planPhases']!=44:
        return False
    match=re.fullmatch(r'native-log-part-([1-9][0-9]{0,2})\.(stdout|stderr)\.log\.gz',base)
    return base in rule['planNames'] or match is not None and int(match[1])<=rule['gzipParts']

def extract(archive,destination,unit,file,expected_digest):
    row,rule=profile(file,unit);archive=Path(archive);destination=Path(destination)
    require(archive.is_absolute() and destination.is_absolute() and archive.resolve()==archive and destination.parent.resolve()==destination.parent)
    fd=os.open(archive,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        original=os.fstat(fd);require(stat.S_ISREG(original.st_mode) and original.st_nlink==1 and 0<original.st_size<=rule['archiveBytes'])
        require(re.fullmatch(r'sha256:[a-f0-9]{64}',expected_digest) is not None)
        digest=hashlib.sha256();received=0
        while True:
            chunk=os.read(fd,65536)
            if not chunk:
                break
            received+=len(chunk);require(received<=original.st_size);digest.update(chunk)
        require(received==original.st_size and 'sha256:'+digest.hexdigest()==expected_digest);os.lseek(fd,0,os.SEEK_SET)
        destination.mkdir(mode=0o700)
        with os.fdopen(os.dup(fd),'rb') as stream,zipfile.ZipFile(stream) as zip_:
            entries=zip_.infolist();require(0<len(entries)<=rule['entries'])
            require(sum(entry.file_size for entry in entries)<=rule['expandedBytes'])
            names=set();files=[];total=0
            for entry in entries:
                name=entry.filename[:-1] if entry.is_dir() else entry.filename
                require(name not in names and allowed(name,unit,row,rule,entry.is_dir()));names.add(name)
                mode=entry.external_attr>>16;kind=stat.S_IFMT(mode)
                require(kind in (0,stat.S_IFREG,stat.S_IFDIR) and not entry.flag_bits&1)
                require(0<=entry.file_size<=rule['memberBytes'] and entry.file_size<=max(1,entry.compress_size)*rule['maximumZipRatio'])
                target=destination/PurePosixPath(name)
                if entry.is_dir():
                    require(kind in (0,stat.S_IFDIR) and entry.file_size==0);target.mkdir(mode=0o700,parents=True,exist_ok=True);continue
                require(kind!=stat.S_IFDIR);target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                out=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                count=0;digest=hashlib.sha256()
                try:
                    with zip_.open(entry) as data:
                        while True:
                            chunk=data.read(65536)
                            if not chunk:
                                break
                            count+=len(chunk);total+=len(chunk);require(count<=entry.file_size and total<=rule['expandedBytes'])
                            digest.update(chunk);offset=0
                            while offset<len(chunk):
                                size=os.write(out,chunk[offset:]);require(size>0);offset+=size
                    actual=os.fstat(out);require(count==entry.file_size==actual.st_size and stat.S_ISREG(actual.st_mode) and actual.st_nlink==1 and actual.st_uid==os.getuid())
                finally:
                    os.close(out)
                files.append({'name':name,'bytes':count,'sha256':digest.hexdigest()})
            require(original.st_size==os.fstat(fd).st_size and original.st_mtime_ns==os.fstat(fd).st_mtime_ns and original.st_ctime_ns==os.fstat(fd).st_ctime_ns)
        return {'kind':'CLOSED_EMPLOYEE_ARCHIVE_BYTES_NOT_AUTHORITY','unit':unit,'file':file,'archiveDigest':expected_digest,'members':sorted(files,key=lambda row:row['name']),'releaseAuthorized':False}
    finally:
        os.close(fd)

if __name__=='__main__':
    require(len(sys.argv)==6)
    print(json.dumps(extract(*sys.argv[1:]),separators=(',',':')))
