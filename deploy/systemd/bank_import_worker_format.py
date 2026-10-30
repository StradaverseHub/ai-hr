"""Closed worker byte format. No credentials, subprocesses, source execution or release authority."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import zipfile

MAX_ARCHIVE = 512 * 1024**2
MAX_TOTAL = 3 * 1024**3
MAX_FILE = 256 * 1024**2
MAX_MANIFEST = 32 * 1024**2
MAX_ENTRIES = 200000
ROOT_FILES = {'package.json', 'pnpm-lock.yaml', 'tsconfig.json'}
LEGACY_ROOT_DIRS = {'app','components','content','core','data','db','deploy','lib','messages','packs','public','scripts','types','node_modules'}
ROOT_DIRS = LEGACY_ROOT_DIRS|{'assets','i18n','localization'}
RUNTIME = {'node':'22.23.3','abi':'127','platform':'linux','arch':'x64','glibc':'2.39'}

def require(ok, message):
    if not ok: raise ValueError('Worker package refused: '+message)

def canonical(value):
    return (json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False)+'\n').encode()

def digest(data): return hashlib.sha256(data).hexdigest()

def safe_path(value):
    require(isinstance(value,str) and 0<len(value.encode())<=4096 and '\\' not in value and not any(ord(c)<32 or ord(c)==127 for c in value),'invalid path')
    parts=value.split('/')
    require(not value.startswith('/') and all(p not in ('','.','..') for p in parts),'unsafe path')
    require(parts[0] in ROOT_DIRS or value in ROOT_FILES,'unexpected payload root')
    require(not any(p.startswith('.env') or p in ('.git','.improve','.next','scratchpad','backups') for p in parts),'private/build state in payload')
    return value

def validate_manifest(manifest, source, lock_hash=None, package_hash=None):
    require(isinstance(manifest,dict),'manifest object')
    version=manifest.get('format');fields={'format','kind','source','runtime','lockSha256','packageSha256','entries'}
    if version==2: fields|={'controllerSource','producerSha256','formatSha256'}
    require(version in (1,2) and set(manifest)==fields,'manifest fields')
    require(manifest['kind']=='bank-import-worker-package-v'+str(version) and re.fullmatch('[a-f0-9]{40}',source or '') and manifest['source']==source,'source identity')
    if version==2:
        require(isinstance(manifest['controllerSource'],str) and re.fullmatch('[a-f0-9]{40}',manifest['controllerSource']),'controller identity')
        for key in ['producerSha256','formatSha256']: require(isinstance(manifest[key],str) and re.fullmatch('[a-f0-9]{64}',manifest[key]),'controller byte identity')
    require(manifest['runtime']==RUNTIME,'runtime identity')
    for field,wanted in [('lockSha256',lock_hash),('packageSha256',package_hash)]:
        require(isinstance(manifest[field],str) and re.fullmatch('[a-f0-9]{64}',manifest[field]) and (wanted is None or manifest[field]==wanted),'independent package/lock identity')
    rows=manifest['entries'];require(isinstance(rows,list) and 0<len(rows)<=MAX_ENTRIES,'entry count')
    entries={};total=0
    for row in rows:
        require(isinstance(row,dict),'entry object');path=safe_path(row.get('path'));kind=row.get('type')
        require(version==2 or path in ROOT_FILES or path.split('/')[0] in LEGACY_ROOT_DIRS,'unexpected v1 payload root')
        require(path not in entries,'duplicate entry')
        if kind=='file':
            require(set(row)=={'path','type','size','sha256','mode'} and type(row['size']) is int and 0<=row['size']<=MAX_FILE and row['mode'] in (0o644,0o755) and isinstance(row['sha256'],str) and re.fullmatch('[a-f0-9]{64}',row['sha256']),'file entry')
            total+=row['size']
        elif kind=='directory': require(set(row)=={'path','type'},'directory entry')
        elif kind=='symlink':
            require(set(row)=={'path','type','target'} and isinstance(row['target'],str) and 0<len(row['target'].encode())<=4096 and not row['target'].startswith('/') and '\\' not in row['target'] and not any(ord(c)<32 or ord(c)==127 for c in row['target']),'relative link')
        else: require(False,'entry type')
        entries[path]=row
    require(total<=MAX_TOTAL and [r['path'] for r in rows]==sorted(entries),'total bytes and canonical entry order')
    for path in entries:
        parent=PurePosixPath(path).parent
        while str(parent)!='.':
            require(entries.get(str(parent),{}).get('type')=='directory','missing/non-directory ancestor')
            parent=parent.parent
    def resolve_link(path, seen):
        parts=path.split('/')
        for index in range(1,len(parts)+1):
            prefix='/'.join(parts[:index]);row=entries.get(prefix)
            if row and row['type']=='symlink':
                require(prefix not in seen and len(seen)<64,'cyclic/deep link')
                target=posixpath.normpath(posixpath.join(posixpath.dirname(prefix),row['target'],*parts[index:]))
                safe_path(target)
                return resolve_link(target,seen|{prefix})
        require(path in entries,'dangling link');return path
    for path,row in entries.items():
        if row['type']=='symlink':
            resolved=resolve_link(path,set())
            require(not path.startswith(resolved+'/'),'link points at its own ancestor')
    for path in ROOT_FILES|{'scripts/bank-import-runner.ts','node_modules/tsx/package.json'}:
        require(entries[resolve_link(path,set())]['type']=='file','required runtime input absent')
    for path,field in [('package.json','packageSha256'),('pnpm-lock.yaml','lockSha256')]:
        require(entries[path]['type']=='file' and entries[path]['sha256']==manifest[field],'manifest/package bytes differ')
    return entries

def require_activation_manifest(manifest,controller=None):
    """Historical v1 packets remain byte evidence only; corrected activation requires v2 inputs."""
    require(manifest.get('format')==2 and manifest.get('kind')=='bank-import-worker-package-v2','v1 is not an activation packet')
    if controller is not None: require(manifest['controllerSource']==controller,'activation controller differs')
    entries=validate_manifest(manifest,manifest['source'])
    for path in ['localization/registry.ts','i18n/config.ts']:
        require(entries.get(path,{}).get('type')=='file','country/localization runtime closure missing')
    return entries

def inspect_archive(path, source, lock_hash=None, package_hash=None):
    path=Path(path);info=path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and 0<info.st_size<=MAX_ARCHIVE,'bounded regular archive')
    with zipfile.ZipFile(path) as archive:
        members=archive.infolist();require(0<len(members)<=MAX_ENTRIES+1,'ZIP membership count')
        names=[member.filename for member in members];require(len(names)==len(set(names)),'duplicate ZIP member')
        require('worker-manifest.json' in names,'manifest absent')
        raw_info=archive.getinfo('worker-manifest.json');require(raw_info.file_size<=MAX_MANIFEST and not raw_info.flag_bits&1,'bounded unencrypted manifest')
        raw=archive.read(raw_info);manifest=json.loads(raw);require(canonical(manifest)==raw,'canonical manifest bytes')
        entries=validate_manifest(manifest,source,lock_hash,package_hash)
        expected={'worker-manifest.json'}|{'payload/'+p for p,r in entries.items() if r['type']=='file'}
        require(set(names)==expected,'closed ZIP membership')
        for member in members:
            require(not member.flag_bits&1 and member.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED) and not member.is_dir(),'unsupported ZIP member')
            if member.filename!='worker-manifest.json':
                require(member.file_size==entries[member.filename[8:]]['size'],'ZIP file size differs')
        return manifest

def extract_archive(path, destination, source, lock_hash=None, package_hash=None):
    """Caller supplies an empty private root-owned destination and authenticated root-owned snapshot."""
    destination=Path(destination)
    require(destination.is_dir() and not destination.is_symlink() and destination.resolve()==destination and not any(destination.iterdir()),'empty canonical destination required')
    manifest=inspect_archive(path,source,lock_hash,package_hash);entries={r['path']:r for r in manifest['entries']}
    with zipfile.ZipFile(path) as archive:
        for name,row in entries.items():
            if row['type']=='directory': (destination/name).mkdir(mode=0o755,parents=True,exist_ok=True)
        for name,row in entries.items():
            if row['type']!='file': continue
            output=destination/name;h=hashlib.sha256();count=0
            fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,row['mode'])
            with os.fdopen(fd,'wb') as target, archive.open('payload/'+name) as incoming:
                while True:
                    block=incoming.read(1024**2)
                    if not block: break
                    count+=len(block);require(count<=row['size'],'decompressed file exceeds bound');target.write(block);h.update(block)
                target.flush();os.fsync(target.fileno())
            require(count==row['size'] and h.hexdigest()==row['sha256'],'file bytes differ')
        for name,row in entries.items():
            if row['type']=='symlink': os.symlink(row['target'],destination/name)
    for name,row in entries.items():
        actual=destination/name
        if row['type']=='symlink': require(actual.resolve(strict=True).is_relative_to(destination),'extracted link escapes')
    return manifest
