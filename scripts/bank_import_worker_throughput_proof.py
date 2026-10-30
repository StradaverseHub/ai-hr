"""CI-only authenticated throughput inputs, proof contract and exact-child cleanup.
No installation, staging-ledger or release authority. Never import a legacy installer validator.
"""
import argparse
import ctypes
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import pwd
import grp
import re
import select
import signal
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO='StradaverseHub/ai-hr'
REPOSITORY_ID=1333414856
PRODUCER_WORKFLOW='.github/workflows/bank-import-worker-package.yml'
CONSUMER_WORKFLOW='.github/workflows/bank-import-worker-package.yml'
REFUSED_SOURCE='968354c00a71df7baccd499eb60757a3307ed61e'
MAX_SECONDS=10800
RESERVE_SECONDS=300
MAX_OUTER=600*1024**2
MEMBERS={'worker-package.zip':512*1024**2,'worker-manifest.json':32*1024**2,'worker-provenance.json':1024**2,'worker-runtime-proof.json':1024**2}
WORKER_LOG_NAMES=['latch-holder.stderr',*[f'worker-{i}.{kind}' for i in range(5) for kind in ['stdout','stderr']]]

def proof_mode(value=None):
    value=os.environ.get('THROUGHPUT_PROOF_MODE','full-100001') if value is None else value
    check(value in ['full-100001','preflight-401'],'unknown proof mode refused')
    return value

def job_seconds(): return 1200 if proof_mode()=='preflight-401' else MAX_SECONDS
def minimum_seconds(): return 60 if proof_mode()=='preflight-401' else 900
def worker_log_names():
    return WORKER_LOG_NAMES if proof_mode()=='full-100001' else ['latch-holder.stderr',*[f'worker-{i}.{kind}' for i in range(16) for kind in ['stdout','stderr']]]

def check(ok,message):
    if not ok: raise ValueError('CI throughput proof refused: '+message)

def canonical(value): return (json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False)+'\n').encode()
def digest(raw): return hashlib.sha256(raw).hexdigest()
def file_hash(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(1024**2),b''): h.update(block)
    return h.hexdigest()
def sha(value):
    check(isinstance(value,str) and re.fullmatch('[a-f0-9]{40}',value),'explicit exact 40-SHA required')
    return value

def source_pin(value):
    sha(value);check(value!=REFUSED_SOURCE,'old application source is explicitly refused');return value

def number(value):
    check(isinstance(value,str) and re.fullmatch('[1-9][0-9]{0,15}',value) and int(value)<=9007199254740991,'positive bounded numeric API ID required')
    return int(value)

def exact(actual,wanted):
    if type(actual) is not type(wanted): return False
    if isinstance(wanted,dict): return set(actual)==set(wanted) and all(exact(actual[k],v) for k,v in wanted.items())
    if isinstance(wanted,list): return len(actual)==len(wanted) and all(exact(a,b) for a,b in zip(actual,wanted))
    return actual==wanted

def ordinary_source_ledger(source):
    source=Path(source);journal=source/'db/migrations/meta/_journal.json'
    check(journal.is_file() and not journal.is_symlink() and journal.stat().st_size<=4*1024**2,'bounded regular source journal required')
    raw=journal.read_bytes();entries=json.loads(raw)['entries']
    check(isinstance(entries,list) and 0<len(entries)<=5000,'nonempty bounded ordinary source journal required')
    tags=set();indices=set();expected=[]
    for row in entries:
        tag=row.get('tag');when=row.get('when');idx=row.get('idx')
        check(isinstance(tag,str) and re.fullmatch('[A-Za-z0-9_-]+',tag) and tag not in tags,'unique safe ordinary SQL tag required')
        check(type(when) is int and 0<when<=9007199254740991 and type(idx) is int and idx>=0 and idx not in indices,'ordinary timestamp/index required')
        tags.add(tag);indices.add(idx);path=source/'db/migrations'/f'{tag}.sql'
        check(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(source.resolve()) and path.stat().st_size<=256*1024**2,'bounded regular ordinary SQL required')
        expected.append({'created_at':str(when),'hash':file_hash(path)})
    return {'kind':'FRESH_ORDINARY_SOURCE_JOURNAL_NOT_STAGING_LEDGER','rows':len(expected),'sha256':digest(json.dumps(expected,sort_keys=True,separators=(',',':')).encode()),'journalSha256':digest(raw)}

def validate_581_policy_contract(raw,ledger,bank_sql_hash):
    check(isinstance(raw,bytes) and digest(raw)=='0ec4efea88ff081124c96922f3f84988e4dc1e082a7e46d25d2ae7b59550137e','unknown 581-entry raw source journal refused')
    journal=json.loads(raw);entries=journal['entries']
    check(isinstance(entries,list) and len(entries)==581 and digest(canonical(entries[:580]))=='85d457d4d2ab8d616ef1ddfa245559038f45754da3560b126d690c701ba740a8','exact complete 580-entry predecessor required')
    tail=[{'idx':693,'version':'7','when':1793330000063,'tag':'0720_lifecycle_v9_self_equipment','breakpoints':True},{'idx':694,'version':'7','when':1793330000065,'tag':'0728_feedback_release_evidence','breakpoints':True},{'idx':695,'version':'7','when':1793330000075,'tag':'0691_bank_import_point_read','breakpoints':True}]
    check(exact(entries[-3:],tail) and [i for i,row in enumerate(entries) if row.get('tag')=='0691_bank_import_point_read']==[580],'exact registered V9/Feedback/Bank tail required')
    expected={'kind':'FRESH_ORDINARY_SOURCE_JOURNAL_NOT_STAGING_LEDGER','rows':581,'sha256':'38d86c3d2a32cc1203ca8f6456d43da4ee4c1dd65a424f25cdda6881920a7973','journalSha256':'0ec4efea88ff081124c96922f3f84988e4dc1e082a7e46d25d2ae7b59550137e'}
    check(exact(ledger,expected),'complete 581-entry actual ordinary SQL ledger differs')
    check(bank_sql_hash=='be6f8d38850fadd9151d58ea7476d8f60e09a0bf2b2b078e0196f4cb90c5bfe9','registered 581-contract Bank SQL bytes differ')

def require_registered_policy(source):
    raw=(Path(source)/'db/migrations/meta/_journal.json').read_bytes()
    if len(json.loads(raw)['entries'])==581:
        # This finite alternative is fed by ALL actual source SQL bytes, never a
        # staging ledger, count-only waiver or a guessed final application SHA.
        validate_581_policy_contract(raw,ordinary_source_ledger(source),file_hash(Path(source)/'db/migrations/0691_bank_import_point_read.sql'))
        return
    entries=json.loads((Path(source)/'db/migrations/meta/_journal.json').read_bytes())['entries']
    matches=[i for i,row in enumerate(entries) if row['tag']=='0691_bank_import_point_read']
    check(len(matches)==1 and matches[0]==566,'registered policy must follow the complete ordinary 566-entry predecessor')
    i=matches[0]
    wanted=[(677,1793330000013,'0687_assistant_question_budget'),(678,1793330000014,'0688_payroll_txn_import_attempts'),(679,1793330000015,'0689_rewards_unit_governance'),(680,1793330000016,'0690_rewards_policy_pair_membership'),(681,1793330000017,'0691_bank_import_point_read')]
    check([(r['idx'],r['when'],r['tag']) for r in entries[i-4:i+1]]==wanted,'actual registered predecessor sequence differs')
    check(file_hash(Path(source)/'db/migrations/0691_bank_import_point_read.sql')=='be6f8d38850fadd9151d58ea7476d8f60e09a0bf2b2b078e0196f4cb90c5bfe9','registered policy SQL bytes differ')

def validate_runtime_witness(proof,source,controller,archive,archive_bytes,manifest,ledger,run_id,fmt):
    fields={'format','kind','source','controllerSource','producerSha256','formatSha256','archiveSha256','manifestSha256','provenanceSha256','packageSha256','lockSha256','runtime','runId','runAttempt','rootOwnedReadOnly','extractedOutsideCheckout','modulePathsClean','roleProof','migrationLedger','emptyQueue','nativeFixture','cli','sourceDependencyBytesVerified','extractedPostRunVerified','releaseAuthorized'}
    check(isinstance(proof,dict) and set(proof)==fields,'closed new producer runtime proof required')
    provenance={'format':2,'kind':'WORKER_BYTES_ONLY_NOT_RELEASE_AUTHORITY','source':source,'controllerSource':controller,'producerSha256':manifest['producerSha256'],'formatSha256':manifest['formatSha256'],'runtime':manifest['runtime'],'archiveSha256':archive,'archiveBytes':archive_bytes,'manifestSha256':digest(fmt.canonical(manifest)),'packageSha256':manifest['packageSha256'],'lockSha256':manifest['lockSha256'],'entries':len(manifest['entries']),'unpackedBytes':sum(r['size'] for r in manifest['entries'] if r['type']=='file')}
    expected={'format':1,'kind':'CI_EXTRACTED_WORKER_RUNTIME_NOT_RELEASE','source':source_pin(source),'controllerSource':sha(controller),'producerSha256':manifest['producerSha256'],'formatSha256':manifest['formatSha256'],'archiveSha256':archive,'manifestSha256':digest(fmt.canonical(manifest)),'provenanceSha256':digest(fmt.canonical(provenance)),'packageSha256':manifest['packageSha256'],'lockSha256':manifest['lockSha256'],'runtime':fmt.RUNTIME,'runId':run_id,'runAttempt':1,'rootOwnedReadOnly':True,'extractedOutsideCheckout':True,'modulePathsClean':True,'sourceDependencyBytesVerified':True,'extractedPostRunVerified':True,'releaseAuthorized':False}
    check(all(exact(proof.get(k),v) for k,v in expected.items()),'source/controller/runtime/hash/dependency proof binding differs')
    check(exact(proof['migrationLedger'],ledger),'fresh ordinary source ledger differs; staging ledger is a separate target')
    roles=[{'rolname':'ai_hr_app','rolsuper':False,'rolbypassrls':False,'queue_owner':False},{'rolname':'ai_hr_owner','rolsuper':False,'rolbypassrls':False,'queue_owner':True}]
    check(isinstance(proof['roleProof'],list) and exact(sorted(proof['roleProof'],key=lambda r:r.get('rolname','')),roles),'actual app/physical queue owner privileges differ')
    empty=proof['emptyQueue'];check(isinstance(empty,dict) and set(empty)=={'before','after','publicTables','contentSha256','noHrMutation','exitCode','stdoutSha256','stderrSha256'},'closed empty queue witness required')
    check(type(empty['publicTables']) is int and 0<empty['publicTables']<=2000 and isinstance(empty['contentSha256'],str) and re.fullmatch('[a-f0-9]{64}',empty['contentSha256']),'nonempty complete empty-queue content fingerprint required')
    check(all(exact(empty[k],v) for k,v in {'before':0,'after':0,'noHrMutation':True,'exitCode':0,'stdoutSha256':digest(b''),'stderrSha256':digest(b'')}.items()),'empty CLI mutation/output proof differs')
    check(exact(proof['nativeFixture'],{'syntheticOnly':True,'previewValid':1,'previewInvalid':1,'previewHrUnchanged':True,'saved':1,'failed':0,'total':2,'processed':2,'auditItems':1,'sourceChunksReleased':True,'nativeAuditOrdinals':[1],'nativeCheckpoint':[{'ordinal':1,'state':'applied'},{'ordinal':2,'state':'invalid'}],'cliInvocations':5}),'native save/audit/checkpoint representative proof differs')
    check(exact(proof['cli'],{'invocations':6,'exitCodes':[0]*6,'noUnexpectedStderr':True}),'six actual CLI invocations required')
    return provenance

def verify_source_bytes(source,manifest):
    source=Path(source).resolve()
    for row in manifest['entries']:
        name=row['path']
        check(isinstance(name,str) and 0<len(name.encode())<=4096 and not name.startswith('/') and '\\' not in name and all(part not in ('','.','..') for part in name.split('/')) and not any(ord(c)<32 or ord(c)==127 for c in name),'safe bounded manifest relative path required for source comparison')
        path=source/name;check(path.resolve().is_relative_to(source),'source/dependency entry escapes frozen checkout: '+json.dumps(name,ensure_ascii=True))
        if row['type']=='file':
            actual_type='missing';actual_size=None;actual_hash=None;error_number=None
            try:
                info=path.lstat();actual_size=info.st_size
                actual_type='file' if stat.S_ISREG(info.st_mode) else 'symlink' if stat.S_ISLNK(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'other'
                if actual_type=='file' and info.st_size<=256*1024**2: actual_hash=file_hash(path)
            except OSError as error:
                error_number=error.errno
            if not (actual_type=='file' and actual_size==row['size'] and actual_hash==row['sha256'] and error_number is None):
                detail={'path':name,'expectedType':'file','expectedSize':row['size'],'expectedSha256':row['sha256'],'actualType':actual_type,'actualSize':actual_size,'actualSha256':actual_hash,'readErrno':error_number}
                check(False,'accepted file differs from frozen source/dependency bytes: '+json.dumps(detail,sort_keys=True,ensure_ascii=True))
        elif row['type']=='symlink': check(path.is_symlink() and os.readlink(path)==row['target'],'accepted source/dependency link differs')
        else: check(path.is_dir() and not path.is_symlink(),'accepted source/dependency directory differs')
    if any(r['path']=='node_modules' for r in manifest['entries']): dependency_inventory(source,manifest)

def authenticated_inputs():
    root=root_directory();protected(root,True);path=root/'authenticated.json';protected(path)
    check(path.stat().st_size<=4*1024**2,'bounded authenticated metadata required')
    raw=path.read_bytes();value=json.loads(raw)
    check(raw==canonical(value) and set(value)=={'format','kind','repositoryId','consumerController','consumerRun','producer','members','producerRun','producerJob','artifact','consumerJobStartedAt','mode'},'closed canonical authenticated metadata required')
    check(proof_mode(value['mode'])==proof_mode(),'authenticated packet proof mode differs from current workflow')
    check(exact(value['format'],1) and value['kind']=='AUTHENTICATED_API_INPUT_NOT_RELEASE' and exact(value['repositoryId'],REPOSITORY_ID) and value['consumerController']==os.environ['GITHUB_SHA'] and exact(value['consumerRun'],number(os.environ['GITHUB_RUN_ID'])),'authenticated metadata belongs to another controller/run')
    pins=value['producer'];check(set(pins)=={'producer','source','run','job','artifact','digest'},'closed accepted identity pins required')
    sha(pins['producer']);source_pin(pins['source'])
    check_metadata(value['producerRun'],[value['producerJob']],value['artifact'],pins)
    package=root/'accepted';protected(package,True)
    check(set(value['members'])==set(MEMBERS) and {p.name for p in package.iterdir()}==set(MEMBERS),'closed authenticated packet required')
    for name,bound in MEMBERS.items():
        path=package/name;info=protected(path)
        check(0<info.st_size<=bound and file_hash(path)==value['members'][name],'authenticated packet member bytes changed')
    protected(root/'api-artifact.zip')
    check(file_hash(root/'api-artifact.zip')==pins['digest'],'authenticated outer artifact bytes changed')
    return value

def load_module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);loaded=importlib.util.module_from_spec(spec);spec.loader.exec_module(loaded);return loaded

def frozen_git_result(result,operation):
    check(operation in ['rev-parse','status','ls-tree','check-ignore'],'fixed frozen Git operation required')
    if result.returncode!=0 or result.stderr!='':
        raw=result.stderr.encode('utf8',errors='replace')
        detail={'operation':operation,'exitCode':result.returncode,'stderrBytes':len(raw),'stderrSha256':digest(raw),'stderrFirst4096Bytes':raw[:4096].decode('utf8',errors='replace')}
        check(False,'frozen checkout Git check failed: '+json.dumps(detail,sort_keys=True,ensure_ascii=True))
    return result.stdout.strip()

def pinned_source_objects(source,wanted,registry):
    source=Path(source)
    check(source.is_absolute() and source.resolve(strict=True)==source,'literal source checkout required')
    for parent in [source,*source.parents]: check(not parent.is_symlink(),'source checkout ancestor is a symlink')
    def git(*words):
        result=registry.run(['/usr/bin/git','-c','safe.directory='+str(source),'-C',str(source),*words],env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},timeout=60)
        return frozen_git_result(result,words[0])
    check(git('rev-parse','HEAD')==wanted and not git('status','--porcelain','--untracked-files=all'),'clean independently pinned source required')
    tree=git('ls-tree','-rz','--full-tree',wanted);records=tree.split('\0')
    for record in records:
        if not record: continue
        metadata,name=record.split('\t',1);mode,kind,blob=metadata.split()
        check(not (name=='node_modules' or name.startswith('node_modules/')),'tracked node_modules may never be replaced')
        check(kind=='blob' and mode in ['100644','100755','120000'] and not name.startswith('/') and all(part not in ['','.','..'] for part in name.split('/')),'regular committed source object required')
        path=source/name
        check(path.parent.resolve().is_relative_to(source),'committed source ancestor escapes checkout')
        info=path.lstat()
        if mode=='120000':
            check(stat.S_ISLNK(info.st_mode),'committed source link changed');raw=os.readlink(path).encode()
        else:
            check(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_size<=256*1024**2,'bounded committed regular file required');raw=path.read_bytes()
        check(hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==blob,'actual committed source bytes differ from pinned Git object: '+json.dumps(name,ensure_ascii=True))
    check(git('check-ignore','--','node_modules')=='node_modules','replacement target must be ignored by pinned source')

def dependency_inventory(source,manifest):
    target=Path(source)/'node_modules';check(target.is_dir() and not target.is_symlink(),'real authoritative node_modules required')
    actual={'node_modules'}
    for base,dirs,files in os.walk(target,followlinks=False):
        for name in dirs+files:
            path=Path(base)/name;actual.add(path.relative_to(source).as_posix());info=path.lstat()
            if stat.S_ISREG(info.st_mode): check(info.st_nlink==1,'authoritative dependency hardlink refused')
    expected={r['path'] for r in manifest['entries'] if r['path']=='node_modules' or r['path'].startswith('node_modules/')}
    check(actual==expected,'authoritative dependency inventory differs; no extras or missing entries permitted')

def closed_dependencies(source,manifest): verify_source_bytes(source,manifest)

def dependency_identity(path):
    info=protected(path,True);return {'dev':info.st_dev,'ino':info.st_ino,'uid':info.st_uid}

def fsync_directory(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)

def rename_no_replace(source,destination):
    # Linux/glibc only. No check-then-rename or overwrite-capable fallback.
    check(os.uname().sysname=='Linux','atomic Linux renameat2 required')
    check(Path(source).is_absolute() and Path(destination).is_absolute(),'absolute fixed dependency rename paths required')
    libc=ctypes.CDLL(None,use_errno=True)
    try: rename=libc.renameat2
    except AttributeError: check(False,'libc renameat2 unavailable; replacement refused')
    rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];rename.restype=ctypes.c_int
    result=rename(-100,os.fsencode(source),-100,os.fsencode(destination),1)  # AT_FDCWD, RENAME_NOREPLACE
    if result!=0:
        error=ctypes.get_errno();raise OSError(error,'atomic dependency renameat2(RENAME_NOREPLACE) refused')

def parse_mountinfo(raw):
    check(isinstance(raw,bytes) and 0<len(raw)<=4*1024**2 and raw.endswith(b'\n') and b'\0' not in raw,'bounded complete mountinfo required')
    lines=raw.splitlines();check(0<len(lines)<=65536,'bounded mountinfo line count required')
    escapes={b'040':32,b'011':9,b'012':10,b'134':92};points=[]
    def decode(field):
        out=bytearray();index=0
        while index<len(field):
            if field[index]==92:
                token=field[index+1:index+4];check(token in escapes,'unknown/truncated mountinfo escape; cleanup refused');out.append(escapes[token]);index+=4
            else: out.append(field[index]);index+=1
        return os.fsdecode(bytes(out))
    for line in lines:
        words=line.split(b' ');check(all(words) and words.count(b'-')==1,'malformed mountinfo fields; cleanup refused');separator=words.index(b'-')
        check(separator>=6 and len(words)==separator+4 and words[0].isdigit() and words[1].isdigit() and re.fullmatch(rb'[0-9]+:[0-9]+',words[2]),'malformed mountinfo identity; cleanup refused')
        root,point=decode(words[3]),decode(words[4])
        check(root.startswith('/') and point.startswith('/') and os.path.normpath(root)==root and os.path.normpath(point)==point,'noncanonical mountinfo paths; cleanup refused')
        points.append(Path(point))
    return points

def mountinfo_points():
    try:
        with Path('/proc/self/mountinfo').open('rb') as incoming: raw=incoming.read(4*1024**2+1)
        return parse_mountinfo(raw)
    except OSError: check(False,'mountinfo unavailable; dependency cleanup refused')

def reject_mounted_tree(path):
    path=Path(path);check(path.is_absolute() and path.resolve(strict=True)==path,'literal dependency cleanup tree required')
    points=mountinfo_points()
    check(not any(point==path or point.is_relative_to(path) for point in points),'mountpoint at/inside dependency tree; retained for runner disposal')

def cleanup_dependency_staging(root):
    root=Path(root);journal=root/'dependency-provision.json'
    if not journal.exists(): return
    protected(journal);value=json.loads(journal.read_bytes())
    check(set(value)=={'format','kind','source','sourceSha','archiveSha256','manifestSha256','state','stageIdentity','oldIdentity','newIdentity','cleanup'} and value['format']==1 and value['kind']=='EXACT_AUTHENTICATED_DEPENDENCIES_NOT_RELEASE','closed dependency provision journal required')
    for name,key in [('dependency-stage','stageIdentity'),('dependency-quarantine','oldIdentity')]:
        path=root/name;state=value['cleanup'][name]
        check(state in ['pending','remove-pending','removed'],'closed dependency cleanup state required')
        try:
            info=path.lstat()
            check(stat.S_ISDIR(info.st_mode) and not path.is_symlink(),'real dependency staging directory required')
            if name=='dependency-stage': protected(path,True)
            reject_mounted_tree(path)  # Includes same-device binds, before any tree traversal.
        except FileNotFoundError:
            not_created=value['state']=='stage-create-pending' and name=='dependency-stage' and value[key] is None or name=='dependency-quarantine' and value['state'] in ['stage-create-pending','extracting','quarantine-pending']
            check(state in ['remove-pending','removed'] or state=='pending' and not_created,'uncertain missing dependency staging');value['cleanup'][name]='removed';atomic_root(journal,value);continue
        identity={'dev':info.st_dev,'ino':info.st_ino,'uid':info.st_uid}
        if value[key] is None:
            check(name=='dependency-stage' and value['state']=='stage-create-pending' and not any(path.iterdir()),'unidentified dependency staging retained; runner disposal required')
            value[key]=identity;atomic_root(journal,value)
        check(identity==value[key] and state!='removed','dependency staging inode changed; retained for runner disposal')
        check(shutil.rmtree.avoids_symlink_attacks,'fd-safe dependency staging removal required')
        for base,dirs,_ in os.walk(path,followlinks=False):
            for child in dirs:
                item=Path(base)/child
                if not item.is_symlink(): check(item.stat().st_dev==info.st_dev,'foreign mount in dependency staging; removal refused')
        value['cleanup'][name]='remove-pending';atomic_root(journal,value);reject_mounted_tree(path);shutil.rmtree(path)
        value['cleanup'][name]='removed';atomic_root(journal,value)

def provision_dependencies(source,manifest,archive,fmt,registry,wanted):
    # Only this disposable checkout's ignored dependency directory can be replaced.
    source=Path(source);check(source==Path(os.environ['GITHUB_WORKSPACE'])/'source','fixed disposable source checkout required')
    check(str(source.stat().st_uid)==os.environ.get('SUDO_UID') and source.stat().st_uid>0,'original runner-owned checkout required')
    pinned_source_objects(source,wanted,registry)
    verify_source_bytes(source,{'entries':[r for r in manifest['entries'] if r['path']!='node_modules' and not r['path'].startswith('node_modules/')]})
    root=registry.root;protected(root,True);journal=root/'dependency-provision.json';target=source/'node_modules'
    binding={'source':str(source),'sourceSha':wanted,'archiveSha256':file_hash(archive),'manifestSha256':digest(fmt.canonical(manifest))}
    if journal.exists():
        protected(journal);value=json.loads(journal.read_bytes())
        check(all(value.get(k)==v for k,v in binding.items()) and value.get('state')=='installed','incomplete/different provision cannot be retried or reset; retain failure evidence')
        check(dependency_identity(target)==value['newIdentity'],'installed dependency inode changed; no automatic reprovision')
        closed_dependencies(source,manifest);cleanup_dependency_staging(root);return
    check(target.is_dir() and not target.is_symlink(),'fresh ignored real dependency directory required')
    old=target.lstat();check(old.st_uid==source.stat().st_uid,'fresh dependency owner differs from runner')
    stage=root/'dependency-stage';quarantine=root/'dependency-quarantine'
    check(not stage.exists() and not quarantine.exists() and not stage.is_symlink() and not quarantine.is_symlink(),'new fixed dependency staging names required')
    check(root.stat().st_dev==source.stat().st_dev==old.st_dev,'atomic same-device dependency replacement required')
    value={'format':1,'kind':'EXACT_AUTHENTICATED_DEPENDENCIES_NOT_RELEASE',**binding,'state':'stage-create-pending','stageIdentity':None,'oldIdentity':{'dev':old.st_dev,'ino':old.st_ino,'uid':old.st_uid},'newIdentity':None,'cleanup':{'dependency-stage':'pending','dependency-quarantine':'pending'}}
    atomic_root(journal,value);stage.mkdir(mode=0o700);value['stageIdentity']=dependency_identity(stage);value['state']='extracting';atomic_root(journal,value)
    extracted=fmt.extract_archive(archive,stage,wanted,manifest['lockSha256'],manifest['packageSha256'])
    check(exact(extracted,manifest),'staged authenticated manifest changed');closed_dependencies(stage,manifest)
    value['newIdentity']=dependency_identity(stage/'node_modules')
    check(target.lstat().st_dev==old.st_dev and target.lstat().st_ino==old.st_ino,'fresh dependency inode changed before atomic replacement')
    pinned_source_objects(source,wanted,registry)
    value['state']='quarantine-pending';atomic_root(journal,value);rename_no_replace(target,quarantine);fsync_directory(source);fsync_directory(root)
    value['state']='install-pending';atomic_root(journal,value);rename_no_replace(stage/'node_modules',target);fsync_directory(source);fsync_directory(stage)
    value['state']='installed';atomic_root(journal,value)
    check(dependency_identity(target)==value['newIdentity'],'authoritative installed dependency inode differs')
    closed_dependencies(source,manifest);pinned_source_objects(source,wanted,registry);cleanup_dependency_staging(root)

def verify_packet(source,producer):
    inputs=authenticated_inputs();pins=inputs['producer'];package=root_directory()/'accepted';source=Path(source).resolve(strict=True);producer=Path(producer).resolve(strict=True)
    controller=Path(__file__).resolve().parent.parent
    registry=Registry(root_directory())
    check(len({controller,source,producer})==3 and all(not a.is_relative_to(b) for a in [controller,source,producer] for b in [controller,source,producer] if a!=b),'three separate frozen checkouts required')
    for checkout,wanted in [(controller,os.environ['GITHUB_SHA']),(source,pins['source']),(producer,pins['producer'])]:
        def git(*words):
            result=registry.run(['/usr/bin/git','-c','safe.directory='+str(checkout),'-C',str(checkout),*words],env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},timeout=60)
            return frozen_git_result(result,words[0])
        check(git('rev-parse','HEAD')==wanted and not git('status','--porcelain','--untracked-files=all'),'clean pinned checkout required')
    fmt=load_module('authenticated_throughput_format',producer/'deploy/systemd/bank_import_worker_format.py')
    provenance_raw=(package/'worker-provenance.json').read_bytes();provenance=json.loads(provenance_raw)
    check(provenance_raw==fmt.canonical(provenance),'canonical accepted provenance required')
    check(provenance.get('producerSha256')==file_hash(producer/'scripts/bank-import-worker-package.py') and provenance.get('formatSha256')==file_hash(producer/'deploy/systemd/bank_import_worker_format.py'),'pinned producer source bytes differ')
    manifest=fmt.inspect_archive(package/'worker-package.zip',pins['source'],file_hash(source/'pnpm-lock.yaml'),file_hash(source/'package.json'))
    check(fmt.canonical(manifest)==(package/'worker-manifest.json').read_bytes(),'inner and outer manifests differ');fmt.require_activation_manifest(manifest,pins['producer'])
    ledger=ordinary_source_ledger(source);require_registered_policy(source)
    raw=(package/'worker-runtime-proof.json').read_bytes();proof=json.loads(raw);check(raw==fmt.canonical(proof),'canonical accepted runtime witness required')
    expected=validate_runtime_witness(proof,pins['source'],pins['producer'],inputs['members']['worker-package.zip'],(package/'worker-package.zip').stat().st_size,manifest,ledger,pins['run'],fmt)
    check(exact(provenance,expected) and inputs['members']['worker-provenance.json']==digest(fmt.canonical(expected)),'closed provenance/hash linkage differs')
    provision_dependencies(source,manifest,package/'worker-package.zip',fmt,registry,pins['source'])
    # inspect_archive checks closed membership/size; independently stream every actual
    # inner payload byte as well as comparing the installed source/dependency bytes.
    with zipfile.ZipFile(package/'worker-package.zip') as archive:
        for row in manifest['entries']:
            if row['type']!='file': continue
            h=hashlib.sha256();count=0
            with archive.open('payload/'+row['path']) as incoming:
                for block in iter(lambda:incoming.read(1024**2),b''):
                    count+=len(block);check(count<=row['size'],'inner payload exceeds manifest size');h.update(block)
            check(count==row['size'] and h.hexdigest()==row['sha256'],'actual inner ZIP member differs from frozen source/dependencies')
    return inputs,manifest,ledger

def check_metadata(run,jobs,artifact,pins):
    for value in [run.get('id'),run.get('run_attempt'),artifact.get('id'),*[v for j in jobs for v in [j.get('id'),j.get('run_id'),j.get('run_attempt')]]]:
        check(type(value) is int,'API identity integers must not be booleans or strings')
    check(run.get('id')==pins['run'] and run.get('run_attempt')==1 and run.get('event')=='workflow_dispatch' and run.get('path')==PRODUCER_WORKFLOW and run.get('head_sha')==pins['producer'] and run.get('status')=='completed' and run.get('conclusion')=='success','producer first-attempt completed successful run differs')
    for key in ['repository','head_repository']: check(run.get(key,{}).get('id')==REPOSITORY_ID and run[key].get('full_name')==REPO,'producer repository differs')
    check(len(jobs)==1,'exact one producer job required');job=jobs[0]
    check(job.get('id')==pins['job'] and job.get('name')=='worker-package' and job.get('run_id')==pins['run'] and job.get('run_attempt')==1 and job.get('head_sha')==pins['producer'] and job.get('status')=='completed' and job.get('conclusion')=='success' and job.get('labels')==['ubuntu-24.04'],'exact successful standard-runner producer job differs')
    check(artifact.get('id')==pins['artifact'] and artifact.get('name')=='worker-package-v2' and artifact.get('expired') is False and artifact.get('digest')=='sha256:'+pins['digest'] and type(artifact.get('size_in_bytes')) is int and 0<artifact['size_in_bytes']<=MAX_OUTER,'closed bounded artifact metadata differs')
    origin=artifact.get('workflow_run',{})
    check(origin.get('id')==pins['run'] and origin.get('head_sha')==pins['producer'] and origin.get('repository_id')==REPOSITORY_ID and origin.get('head_repository_id')==REPOSITORY_ID,'artifact repository/run/controller differs')
    check(parse_time(job.get('started_at'))<=parse_time(artifact.get('created_at'))<=parse_time(job.get('completed_at')),'artifact must belong to the completed producer job time interval')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args): return None

def api(route):
    check((route=='/repos/'+REPO or route.startswith('/repos/'+REPO+'/')) and '..' not in route,'fixed known repository API route required')
    token=os.environ.get('GH_TOKEN','');check(token and '\n' not in token,'ephemeral read-only API token required')
    req=urllib.request.Request('https://api.github.com'+route,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
    with urllib.request.build_opener(NoRedirect()).open(req,timeout=60) as response:
        raw=response.read(4*1024**2+1);check(len(raw)<=4*1024**2,'bounded API metadata required');return json.loads(raw)

def parse_time(value):
    from datetime import datetime
    check(isinstance(value,str) and value.endswith('Z'),'trusted UTC API timestamp required')
    return datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()

def remaining_job_seconds(started_at,now,first_step):
    started=parse_time(started_at);check(started<=first_step+5 and first_step<=now+5 and now>=started,'trusted job start/runner clock differs')
    remaining=math.floor(job_seconds()-(now-started)-RESERVE_SECONDS)
    check(minimum_seconds()<=remaining<=job_seconds()-RESERVE_SECONDS,'whole-job preflight plus cleanup/evidence reserve exhausts proof budget')
    return remaining

def invocation():
    e=os.environ
    check(e.get('GITHUB_ACTIONS')=='true' and e.get('CI')=='true' and e.get('RUNNER_ENVIRONMENT')=='github-hosted' and e.get('GITHUB_REPOSITORY')==REPO and e.get('GITHUB_REPOSITORY_ID')==str(REPOSITORY_ID) and e.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and e.get('GITHUB_RUN_ATTEMPT')=='1' and os.uname().sysname=='Linux','original manual standard public GitHub runner only')
    sha(e.get('GITHUB_SHA'));number(e.get('GITHUB_RUN_ID',''))

def current_job():
    invocation();run=number(os.environ['GITHUB_RUN_ID']);head=os.environ['GITHUB_SHA']
    repo=api('/repos/'+REPO);check(repo.get('id')==REPOSITORY_ID and repo.get('full_name')==REPO and repo.get('private') is False,'known public repository required')
    own=api(f'/repos/{REPO}/actions/runs/{run}')
    check(own.get('head_sha')==head and own.get('run_attempt')==1 and own.get('path')==CONSUMER_WORKFLOW and own.get('event')=='workflow_dispatch' and own.get('status')=='in_progress','consumer API controller identity differs')
    listing=api(f'/repos/{REPO}/actions/runs/{run}/attempts/1/jobs?per_page=100');jobs=listing.get('jobs',[])
    check(listing.get('total_count')==1 and len(jobs)==1,'one current consumer job required');job=jobs[0]
    check(job.get('name')=='throughput' and job.get('run_id')==run and job.get('head_sha')==head and job.get('run_attempt')==1 and job.get('status')=='in_progress' and job.get('labels')==['ubuntu-24.04'],'current standard-runner job differs')
    first=float(os.environ.get('THROUGHPUT_FIRST_STEP_EPOCH','nan'));return job,remaining_job_seconds(job.get('started_at'),time.time(),first)

def probe_suffix(probe_case):
    check(probe_case in [None,'kernel-eof','kernel-orphan'],'unknown kernel probe scope refused')
    return '' if probe_case is None else '-'+probe_case

def root_directory(probe_case=None):
    invocation();return Path('/opt')/('aihr-throughput-'+os.environ['GITHUB_RUN_ID']+'-1'+probe_suffix(probe_case))

def cgroup_root(probe_case=None):
    invocation();return Path('/sys/fs/cgroup')/('aihr-throughput-'+os.environ['GITHUB_RUN_ID']+'-1'+probe_suffix(probe_case))

def cgroup_members(folder):
    protected(folder,True);protected(folder/'cgroup.procs')
    words=(folder/'cgroup.procs').read_text().split()
    check(len(words)<=128 and all(re.fullmatch('[1-9][0-9]*',word) for word in words),'bounded owned cgroup inventory required')
    return sorted({int(word) for word in words})

def in_cgroup(pid,folder):
    relative='/'+folder.relative_to('/sys/fs/cgroup').as_posix()
    check((Path('/proc')/str(pid)/'cgroup').read_text().splitlines()==['0::'+relative],'process escaped exact owned cgroup')

def auxiliary_contracts(root,manifest):
    """Only packaged Linux esbuild services are permitted auxiliary executables.
    Their complete expected contract is persisted before their parent is released.
    The root-owned cgroup proves inherited membership even after reparenting.
    """
    root=Path(root).resolve();result=[]
    for row in manifest['entries']:
        if row['type']!='file' or not row['path'].endswith('/@esbuild/linux-x64/bin/esbuild'): continue
        executable=root/row['path'];package=executable.parent.parent/'package.json'
        info=json.loads(package.read_bytes());version=info.get('version')
        check(info.get('name')=='@esbuild/linux-x64' and isinstance(version,str) and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',version),'manifest esbuild package identity required')
        check(file_hash(executable)==row['sha256'],'manifest esbuild executable bytes differ')
        result.append({'exe':str(executable.resolve(strict=True)),'sha256':row['sha256'],'argv':[str(executable),'--service='+version,'--ping']})
    check(0<len(result)<=16,'bounded manifest esbuild auxiliary closure required')
    return result

def atomic_root(path,value):
    # A controller killed mid-write must not block the independent cleanup writer.
    # Each pending inode is exclusive; readers consume only the atomically replaced
    # canonical name, while an interrupted pending inode remains failure evidence.
    path=Path(path);temporary=path.with_name(path.name+'.new-'+str(os.getpid())+'-'+str(time.monotonic_ns()))
    fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as stream: stream.write(canonical(value));stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path);directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(directory)
    finally: os.close(directory)

def protected(path,directory=False):
    path=Path(path);info=path.lstat();check(not path.is_symlink() and info.st_uid==0 and not info.st_mode&0o022 and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink==1),'root-protected regular ownership required');return info

def private_log(path):
    # Parent-created evidence must remain protected even with runner umask 0002.
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    return os.fdopen(fd,'wb')

def evidence_bytes(path,raw,*,refresh=False,mode=0o400):
    """Atomic root-owned evidence; retries accept exact bytes, never partial output."""
    path=Path(path);check(len(raw)<=1024**2,'bounded evidence bytes required')
    if os.path.lexists(path):
        check(protected(path).st_size<=1024**2,'existing evidence exceeds bound')
        if path.read_bytes()==raw: return
        check(refresh,'existing bounded evidence bytes differ')
    temporary=path.with_name('.evidence-pending-'+str(os.getpid())+'-'+str(time.monotonic_ns()))
    fd=os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,mode)
    try:
        with os.fdopen(fd,'wb') as stream: stream.write(raw);stream.flush();os.fsync(stream.fileno())
        if refresh: os.replace(temporary,path)
        else: os.link(temporary,path);temporary.unlink()
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if temporary.exists(): temporary.unlink()

def extract_packet(archive,destination,wanted):
    check(file_hash(archive)==wanted,'API artifact ZIP digest differs')
    destination=Path(destination);destination.mkdir(mode=0o700)
    with zipfile.ZipFile(archive) as z:
        entries=z.infolist();check(len(entries)==4 and len({i.filename for i in entries})==4 and {i.filename for i in entries}==set(MEMBERS),'exact closed four-member artifact ZIP required')
        for item in entries:
            kind=stat.S_IFMT(item.external_attr>>16)
            check(not item.is_dir() and kind in (0,stat.S_IFREG) and not item.flag_bits&1 and item.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED) and 0<item.file_size<=MEMBERS[item.filename],'bounded regular unencrypted artifact member required')
            path=destination/item.filename;fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o400);count=0
            with os.fdopen(fd,'wb') as output,z.open(item) as incoming:
                for block in iter(lambda:incoming.read(1024**2),b''):
                    count+=len(block);check(count<=item.file_size,'artifact member exceeded bound');output.write(block)
                output.flush();os.fsync(output.fileno())
            check(count==item.file_size,'artifact member length differs')
    return {name:file_hash(destination/name) for name in MEMBERS}

def download_artifact(artifact_id,path,expected_size):
    endpoint=f'https://api.github.com/repos/{REPO}/actions/artifacts/{artifact_id}/zip';deadline=time.monotonic()+180
    token=os.environ['GH_TOKEN'];opener=urllib.request.build_opener(NoRedirect());headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}
    for _ in range(4):
        check(time.monotonic()<deadline,'artifact transfer deadline exceeded')
        try: response=opener.open(urllib.request.Request(endpoint,headers=headers),timeout=60)
        except urllib.error.HTTPError as error:
            check(error.code in (301,302,303,307,308),'artifact API download refused')
            endpoint=urllib.parse.urljoin(endpoint,error.headers.get('Location',''));url=urllib.parse.urlsplit(endpoint)
            check(url.scheme=='https' and url.port in (None,443) and not url.username and not url.password and (url.hostname or '').endswith(('.blob.core.windows.net','.actions.githubusercontent.com')),'artifact redirect host refused')
            headers={};continue  # Never forward the repository token to a CDN.
        with response:
            fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
            output=os.fdopen(fd,'wb')
            with output:
                count=0
                while True:
                    check(time.monotonic()<deadline,'artifact transfer deadline exceeded');block=response.read(1024**2)
                    if not block: break
                    count+=len(block);check(count<=MAX_OUTER and count<=expected_size,'artifact transfer exceeded authenticated size');output.write(block)
                output.flush();os.fsync(output.fileno())
        check(count==expected_size,'artifact transfer length differs');return
    check(False,'artifact redirect limit exceeded')

# Registry/gated child protocol is deliberately separate from installer/service management.
def proc_snapshot(pid):
    root=Path('/proc')/str(pid);raw=(root/'stat').read_text();parts=raw.rsplit(')',1)[1].split()
    status={r.split(':',1)[0]:r.split(':',1)[1].split() for r in (root/'status').read_text().splitlines() if ':' in r}
    return {'pid':pid,'parent':int(parts[1]),'start':parts[19],'uid':status['Uid'],'gid':status['Gid'],'exe':str((root/'exe').resolve(strict=True)),'cwd':str((root/'cwd').resolve(strict=True)),'argv':(root/'cmdline').read_bytes().split(b'\0')[:-1],'env':(root/'environ').read_bytes()}

def serial_identity(value):
    return {**value,'argv':[x.decode('utf8') for x in value['argv']],'envSha256':digest(value['env'])}|{'env':None}

def same_identity(actual,expected):
    return all(actual[k]==expected[k] for k in ['pid','start','uid','gid','exe','cwd','argv']) and digest(actual['env'])==expected['envSha256']

class Registry:
    def __init__(self,path,probe_case=None):
        probe_suffix(probe_case);self._probe_case=probe_case
        check(os.geteuid()==0,'root registry orchestration required');self.root=Path(path);check(self.root==root_directory(probe_case),'fixed current-run registry namespace required');protected(self.root,True)
        self.path=self.root/'registry.json';protected(self.path);self.data=json.loads(self.path.read_bytes())
        check(set(self.data)=={'format','runId','controller','children','forcedCleanup','createdChildren','finishedChildren','resources','namespace'} and self.data['format']==1 and self.data['runId']==number(os.environ['GITHUB_RUN_ID']) and self.data['controller']==os.environ['GITHUB_SHA'] and isinstance(self.data['children'],list) and len(self.data['children'])<=128 and type(self.data['createdChildren']) is int and type(self.data['finishedChildren']) is int and 0<=self.data['finishedChildren']<=self.data['createdChildren']<=25000 and isinstance(self.data['resources'],list) and len(self.data['resources'])<=3,'closed bounded current-controller registry required')
        check(set(self.data['namespace'])=={'dev','ino','state'} and self.data['namespace']['state'] in ['present','remove-pending','removed'],'closed cgroup namespace lifecycle required')
        self.gate=self.root/'gate.py';protected(self.gate);check(file_hash(self.gate)==file_hash(__file__),'registry gate bytes differ from current controller')
        intent=initialization_intent(probe_case)
        check(intent['state']=='ready' and intent['rootIdentity']=={'dev':self.root.stat().st_dev,'ino':self.root.stat().st_ino},'registry initialization/scope is not ready')
    def save(self): atomic_root(self.path,self.data)
    @property
    def probe_case(self): return self._probe_case
    def cgroup_directory(self): return cgroup_root(getattr(self,'probe_case',None))
    def worker_name(self):
        case=getattr(self,'probe_case',None);probe_suffix(case)
        return 'aihr-import-throughput-ci' if case is None else 'aihr-import-'+case+'-ci'
    def prepare_area(self):
        check(not any(r['type']=='area' for r in self.data['resources']),'one exact runtime area allocation required')
        path=Path('/opt')/('aihr-large-throughput-ci-'+os.environ['GITHUB_RUN_ID']+'_1'+probe_suffix(getattr(self,'probe_case',None)))
        check(not os.path.lexists(path),'runtime allocation path already exists; refusing adoption')
        resource={'type':'area','path':str(path),'dev':None,'ino':None,'state':'create-pending'}
        self.data['resources'].append(resource);self.save()
        path.mkdir(mode=0o755)
        info=protected(path,True);resource.update(dev=info.st_dev,ino=info.st_ino,state='present');self.save()
        return path
    def prepare_user(self):
        name=self.worker_name()
        check(not any(r['type']=='user' for r in self.data['resources']),'one exact worker allocation required')
        check(not any(u.pw_name==name for u in pwd.getpwall()) and not any(g.gr_name==name for g in grp.getgrall()),'worker account/group already exists; refusing adoption')
        used={u.pw_uid for u in pwd.getpwall()}|{u.pw_gid for u in pwd.getpwall()}|{g.gr_gid for g in grp.getgrall()}
        candidates=[i for i in range(60000,65000) if i not in used];check(candidates,'no free bounded worker UID/GID')
        identity=candidates[0];marker='aihr-ci-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_SHA']
        resource={'type':'user','name':name,'uid':identity,'gid':identity,'home':'/nonexistent','shell':'/usr/sbin/nologin','gecos':marker,'state':'create-pending'}
        self.data['resources'].append(resource);self.save()
        # shadow useradd skips mail creation for --system; CREATE_MAIL_SPOOL
        # belongs to /etc/default/useradd, not the --key login.defs overrides.
        for argv in [['/usr/sbin/groupadd','--gid',str(identity),name],['/usr/sbin/useradd','--system','--no-log-init','--no-create-home','--uid',str(identity),'--gid',str(identity),'--home-dir','/nonexistent','--shell','/usr/sbin/nologin','--comment',marker,name]]:
            result=self.run(argv,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},timeout=20)
            check(result.returncode==0,'exact worker allocation failed; stderr='+result.stderr[-12000:])
        user=pwd.getpwnam(name)
        check((user.pw_uid,user.pw_gid,user.pw_dir,user.pw_shell,user.pw_gecos)==(identity,identity,resource['home'],resource['shell'],marker),'allocated worker identity differs')
        resource['state']='present';self.save();return user
    def register_area(self,path):
        path=Path(path);info=protected(path,True)
        check(path.parent==Path('/opt') and re.fullmatch('aihr-large-throughput-ci-[A-Za-z0-9_]+',path.name) and getattr(self,'probe_case',None) is None and not any(r['type']=='area' for r in self.data['resources']),'one exact newly owned runtime area required')
        self.data['resources'].append({'type':'area','path':str(path),'dev':info.st_dev,'ino':info.st_ino,'state':'present'});self.save()
    def register_user(self,user):
        check(user.pw_name=='aihr-import-throughput-ci' and user.pw_uid>0 and user.pw_gid>0 and user.pw_dir=='/nonexistent' and user.pw_shell=='/usr/sbin/nologin' and not any(r['type']=='user' for r in self.data['resources']),'one dedicated native worker user required')
        self.data['resources'].append({'type':'user','name':user.pw_name,'uid':user.pw_uid,'gid':user.pw_gid,'home':user.pw_dir,'shell':user.pw_shell,'gecos':user.pw_gecos,'state':'present'});self.save()
    def register_receipt(self,path,info):
        check(not any(r['type']=='receipt' for r in self.data['resources']),'one exact receipt publication required')
        self.data['resources'].append({'type':'receipt','path':str(path),'dev':info.st_dev,'ino':info.st_ino});self.save()
    def invalidate_receipt(self):
        for resource in self.data['resources']:
            if resource['type']!='receipt': continue
            path=Path(resource['path'])
            try: info=path.lstat()
            except FileNotFoundError: continue
            check(not path.is_symlink() and (info.st_dev,info.st_ino)==(resource['dev'],resource['ino']),'receipt inode changed; refusing uncertain removal')
            path.unlink()
    def cleanup_resources(self):
        for resource in self.data['resources']:
            if resource['type']=='area':
                path=Path(resource['path']);state=resource['state']
                expected='aihr-large-throughput-ci-'+os.environ['GITHUB_RUN_ID']+'_1'+probe_suffix(getattr(self,'probe_case',None))
                check(path.parent==Path('/opt') and (path.name==expected or getattr(self,'probe_case',None) is None and re.fullmatch('aihr-large-throughput-ci-[A-Za-z0-9_]+',path.name)) and state in ['create-pending','present','remove-pending','removed'],'invalid owned runtime lifecycle')
                try: info=protected(path,True)
                except FileNotFoundError:
                    check(state in ['create-pending','remove-pending','removed'],'unexplained missing runtime area')
                    resource['state']='removed';self.save();continue
                if resource['ino'] is None:
                    check(state=='create-pending' and not any(path.iterdir()),'unidentified nonempty runtime area; no removal authorized')
                    resource.update(dev=info.st_dev,ino=info.st_ino);self.save()
                check((info.st_dev,info.st_ino)==(resource['dev'],resource['ino']) and state!='removed','runtime area identity changed; refusing recursive removal')
                # Keep bounded original stdout/stderr failure evidence before removal.
                for name in worker_log_names():
                    log=path/name
                    if not log.exists(): continue
                    protected(log)
                    with log.open('rb') as incoming: raw=incoming.read(64*1024)
                    evidence_bytes(self.root/('cleanup-'+name),raw)
                resource['state']='remove-pending';self.save()
                check(shutil.rmtree.avoids_symlink_attacks,'fd-safe recursive owned-area removal required');shutil.rmtree(path)
                resource['state']='removed';self.save()
            elif resource['type']=='user':
                check(resource['name']==self.worker_name(),'worker belongs to another probe namespace')
                state=resource['state'];check(state in ['create-pending','present','remove-pending','removed'],'invalid worker lifecycle')
                try: user=pwd.getpwnam(resource['name'])
                except KeyError: user=None
                try: group=grp.getgrgid(resource['gid'])
                except KeyError: group=None
                check(not any(u.pw_uid==resource['uid'] and u.pw_name!=resource['name'] for u in pwd.getpwall()),'worker UID reused by foreign account; removal refused')
                check(not any(g.gr_name==resource['name'] and g.gr_gid!=resource['gid'] for g in grp.getgrall()),'worker group name reused; removal refused')
                if user is None: check(state in ['create-pending','remove-pending','removed'],'unexplained missing worker account')
                else:
                    check(state!='removed' and (user.pw_uid,user.pw_gid,user.pw_dir,user.pw_shell,user.pw_gecos)==(resource['uid'],resource['gid'],resource['home'],resource['shell'],resource['gecos']),'native user identity/ownership marker changed; removal refused')
                if group is not None: check(state!='removed' and group.gr_name==resource['name'] and not group.gr_mem,'native group identity changed; removal refused')
                check(not any(p.pw_gid==resource['gid'] and p.pw_uid!=resource['uid'] for p in pwd.getpwall()),'worker group has a foreign primary user')
                for entry in Path('/proc').iterdir():
                    if not entry.name.isdecimal(): continue
                    try: status=(entry/'status').read_text().splitlines()
                    except (FileNotFoundError,ProcessLookupError): continue
                    uids=[line.split(':',1)[1].split() for line in status if line.startswith('Uid:')]
                    check(len(uids)==1 and str(resource['uid']) not in uids[0],'remaining native UID process; no foreign signal or user removal')
                resource['state']='remove-pending';self.save()
                if user is not None:
                    result=subprocess.run(['/usr/sbin/userdel',resource['name']],env={'PATH':'/usr/bin:/bin'},capture_output=True,timeout=10)
                    check(result.returncode==0,'owned worker user removal failed')
                try: group=grp.getgrgid(resource['gid'])
                except KeyError: group=None
                if group is not None:
                    check(group.gr_name==resource['name'] and not group.gr_mem,'worker group changed after user removal')
                    result=subprocess.run(['/usr/sbin/groupdel',resource['name']],env={'PATH':'/usr/bin:/bin'},capture_output=True,timeout=10)
                    check(result.returncode==0,'owned worker group removal failed')
                resource['state']='removed';self.save()
    def owned(self,record):
        actual=proc_snapshot(record['pid']);check(actual['start']==record['start'],'refusing reused PID')
        choices=[record['gate'],record['exec']]
        valid=False
        for expected in choices:
            compare={**expected,'argv':[v.encode() for v in expected['argv']]}
            if same_identity(actual,compare): valid=True;break
        check(valid,'foreign child UID/GID/exe/cwd/argv/environment; no signal sent')
        if actual['parent']!=record['parent']:
            try: parent=proc_snapshot(record['parent']);check(parent['start']!=record['parentStart'],'registered parent still alive; foreign reparenting refused')
            except FileNotFoundError: pass
        return actual
    def mark_exit(self,p):
        for record in self.data['children']:
            if record.get('pid')==p.pid and record['state']=='active':
                record['state']='finished';record['returncode']=p.returncode;self.save();self.reap_empty();return
    def group_for(self,record):
        check(re.fullmatch('child-[0-9]{5}',record['cgroup']) and record['state'] in ['create-pending','created','active','finished','remove-pending','removed'],'invalid registered cgroup lifecycle')
        parent=self.cgroup_directory();info=protected(parent,True)
        check({'dev':info.st_dev,'ino':info.st_ino}==record['namespace'],'owned cgroup namespace inode changed')
        check(record['namespace']=={k:self.data['namespace'][k] for k in ['dev','ino']} and self.data['namespace']['state']=='present','child belongs to another/removing namespace')
        group=parent/record['cgroup']
        try: info=protected(group,True)
        except FileNotFoundError:
            check(record['state'] in ['create-pending','remove-pending','removed'],'uncertain missing cgroup');return None
        identity={'dev':info.st_dev,'ino':info.st_ino}
        if record['groupIdentity'] is None:
            # A durable creation intent precedes mkdir. Before its inode has been
            # saved, NO gate may launch; recover only this exact empty namespace.
            check(record['state']=='create-pending' and not cgroup_members(group) and not any(p.is_dir() for p in group.iterdir()),'unidentified/nonempty pending cgroup; no signal permitted')
            record['groupIdentity']=identity;record['state']='created';self.save()
        check(record['groupIdentity']==identity,'owned child cgroup inode changed')
        return group
    def create_group(self,auxiliaries):
        parent=self.cgroup_directory();info=protected(parent,True)
        check(self.data['namespace']=={'dev':info.st_dev,'ino':info.st_ino,'state':'present'},'owned cgroup namespace changed')
        record={'cgroup':'child-'+str(self.data['createdChildren']).zfill(5),'namespace':{'dev':info.st_dev,'ino':info.st_ino},'groupIdentity':None,'state':'create-pending','auxiliaries':auxiliaries or []}
        self.data['children'].append(record);self.data['createdChildren']+=1;self.save()
        group=parent/record['cgroup'];group.mkdir(mode=0o755)
        self.group_for(record)  # Persist exact inode BEFORE Popen or gate release.
        return group,record
    def remove_group(self,record):
        group=self.group_for(record)
        if group is not None:
            check(not cgroup_members(group) and not any(p.is_dir() for p in group.iterdir()),'only exact empty owned cgroups may be removed')
            record['state']='remove-pending';self.save()  # Durable BEFORE rmdir.
            group.rmdir()
        record['state']='removed';self.save()
        self.data['children'].remove(record);self.data['finishedChildren']+=1;self.save()
    def remove_namespace(self):
        check(not self.data['children'],'cannot remove a namespace with registered child groups')
        parent=self.cgroup_directory();expected=self.data['namespace']
        try: info=protected(parent,True)
        except FileNotFoundError:
            check(expected['state'] in ['remove-pending','removed'],'uncertain missing cgroup namespace')
        else:
            check({'dev':info.st_dev,'ino':info.st_ino}=={k:expected[k] for k in ['dev','ino']},'owned namespace inode changed')
            check(not cgroup_members(parent) and not any(p.is_dir() for p in parent.iterdir()),'unregistered or populated namespace; removal refused')
            expected['state']='remove-pending';self.save();parent.rmdir()
        expected['state']='removed';self.save()
    def reap_empty(self):
        # Retain every live or uncertain descendant, but avoid quadratic registry
        # writes and thousands of empty cgroups during bounded progress sampling.
        for record in list(self.data['children']):
            if record['state'] not in ['finished','remove-pending','removed']: continue
            group=self.group_for(record)
            if group is None or not cgroup_members(group): self.remove_group(record)
    def popen(self,argv,*,cwd='/',env=None,gate_timeout=30,auxiliaries=None,_release=True,**options):
        check(_release is True or _release is False and getattr(self,'probe_case',None)=='kernel-eof','unreleased gate is restricted to exact EOF probe scope')
        env=dict(sorted((env or {}).items()));uid=options.pop('user',os.geteuid());gid=options.pop('group',os.getegid());options.pop('extra_groups',None);mask=options.pop('umask',0o022)
        check(type(uid) is int and type(gid) is int,'numeric owned child identities required')
        self.reap_empty();check(self.data['createdChildren']<25000 and len(self.data['children'])<128,'owned child registry count bound exceeded')
        group,record=self.create_group(auxiliaries)
        config_r,config_w=os.pipe();ready_r,ready_w=os.pipe();release_r,release_w=os.pipe()
        gate_argv=[sys.executable,'-I','-B',str(self.gate),'gate',str(config_r),str(ready_w),str(release_r)]
        p=None
        try:
            p=subprocess.Popen(gate_argv,cwd=cwd,env=env,pass_fds=(config_r,ready_w,release_r),**options)
            os.close(config_r);config_r=None;os.close(ready_w);ready_w=None;os.close(release_r);release_r=None
            config={'argv':argv,'env':env,'cwd':str(cwd),'uid':uid,'gid':gid,'mask':mask,'cgroup':str(group),'probeCase':getattr(self,'probe_case',None)}
            config_stream=os.fdopen(config_w,'wb');config_w=None
            with config_stream as stream: stream.write(canonical(config))
            ready,_,_=select.select([ready_r],[],[],gate_timeout);check(ready and os.read(ready_r,1)==b'R','owned gate readiness timeout')
            actual=proc_snapshot(p.pid);check(actual['parent']==os.getpid() and actual['uid']==[str(uid)]*4 and actual['gid']==[str(gid)]*4 and actual['exe']==str(Path(sys.executable).resolve()) and actual['cwd']==str(Path(cwd).resolve()) and actual['argv']==[v.encode() for v in gate_argv],'exact gated child identity differs')
            in_cgroup(p.pid,group);check(cgroup_members(group)==[p.pid],'gated cgroup must contain only the unreleased direct child')
            gate=serial_identity(actual)
            expected={**gate,'exe':str(Path(argv[0]).resolve()),'argv':argv,'envSha256':digest(b''.join((k+'='+v).encode()+b'\0' for k,v in env.items()))}
            record.update({'pid':p.pid,'start':actual['start'],'parent':os.getpid(),'parentStart':proc_snapshot(os.getpid())['start'],'gate':gate,'exec':expected,'state':'active'});self.save()
            if _release:
                os.write(release_w,b'X');os.close(release_w);release_w=None
            else:
                p._aihr_probe_release_fd=release_w;release_w=None
            return p
        except BaseException:
            try:
                if p is not None and p.poll() is None: p.kill();p.wait(timeout=2)
            except BaseException as cleanup_error: print('Unreleased direct gate cleanup also failed: '+type(cleanup_error).__name__,file=sys.stderr)
            raise
        finally:
            for fd in [config_r,config_w,ready_r,ready_w,release_r,release_w]:
                if fd is not None: os.close(fd)
    def run(self,argv,*,cwd='/',env=None,timeout=60,input=None,**options):
        until=time.monotonic()+timeout
        p=self.popen(argv,cwd=cwd,env=env,gate_timeout=min(30,timeout),stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,**options)
        try:
            out,err=p.communicate(input,timeout=max(0.001,until-time.monotonic()));self.mark_exit(p);return subprocess.CompletedProcess(argv,p.returncode,out,err)
        except BaseException:
            try:
                if p.poll() is None:
                    self.owned(next(r for r in self.data['children'] if r['pid']==p.pid));p.kill();p.communicate(timeout=2)
                self.mark_exit(p)
            except BaseException as cleanup_error:
                # Preserve the original command exception. Durable cgroup records
                # remain available to the workflow's independent always cleanup.
                print('Owned command cleanup also failed: '+type(cleanup_error).__name__,file=sys.stderr)
            raise
    def assert_empty(self):
        deadline=time.monotonic()+2
        while True:
            self.reap_empty()
            if not self.data['children']: break
            check(all(r['state']=='finished' for r in self.data['children']),'unreaped direct child prevents completion')
            check(time.monotonic()<deadline,'surviving owned descendants invalidate proof completion');time.sleep(0.02)
        for record in self.data['children']:
            check(re.fullmatch('child-[0-9]{5}',record['cgroup']),'invalid registered cgroup name')
            check(not cgroup_members(self.cgroup_directory()/record['cgroup']),'surviving owned descendants invalidate proof completion')
        check(not self.data['children'] and self.data['createdChildren']==self.data['finishedChildren'],'unreaped child registry prevents success')
        check(not self.data['forcedCleanup'],'forced cleanup invalidates every receipt')
    def cleanup(self):
        # Freeze before inventory, so inherited descendants cannot fork or exec
        # between validation and individual signals. Never use cgroup.kill.
        until=time.monotonic()+90;forced=False
        for record in list(self.data['children']):
            check(time.monotonic()<until,'bounded registry cleanup deadline exceeded')
            group=self.group_for(record)
            if group is None: self.remove_group(record);continue
            members=cgroup_members(group)
            if record['state'] in ['create-pending','created']:
                # An unreleased gate gets EOF if its parent dies. It has no
                # authority to exec; never signal an unidentified pending child.
                deadline=min(until,time.monotonic()+3)
                while members and time.monotonic()<deadline:
                    time.sleep(0.02);members=cgroup_members(group)
                check(not members,'unidentified pre-release process remains; no signal sent')
            if members:
                protected(group/'cgroup.freeze');(group/'cgroup.freeze').write_text('1')
                try:
                    deadline=min(until,time.monotonic()+3)
                    while 'frozen 1' not in (group/'cgroup.events').read_text().splitlines():
                        check(time.monotonic()<deadline,'owned cgroup did not freeze');time.sleep(0.02)
                    members=cgroup_members(group);identities=[]
                    for pid in members:
                        actual=proc_snapshot(pid);in_cgroup(pid,group)
                        if pid==record['pid']: self.owned(record)
                        else:
                            expected=record['exec'];check(actual['uid']==expected['uid'] and actual['gid']==expected['gid'] and actual['cwd']==expected['cwd'] and digest(actual['env'])==expected['envSha256'],'auxiliary credential/cwd/environment differs')
                            matches=[a for a in record['auxiliaries'] if actual['exe']==a['exe'] and actual['argv']==[v.encode() for v in a['argv']]]
                            check(len(matches)==1 and file_hash(actual['exe'])==matches[0]['sha256'],'unknown or changed auxiliary; no signal sent')
                        identities.append(serial_identity(actual))
                    check(cgroup_members(group)==members,'frozen membership changed; no signal sent')
                    record['cleanupIdentities']=identities;self.data['forcedCleanup']=True;self.save();forced=True
                    for expected in identities:
                        actual=proc_snapshot(expected['pid']);in_cgroup(actual['pid'],group)
                        check(same_identity(actual,{**expected,'argv':[v.encode() for v in expected['argv']]}),'frozen PID identity changed; no signal sent')
                        os.kill(actual['pid'],signal.SIGKILL)
                finally: (group/'cgroup.freeze').write_text('0')
                deadline=min(until,time.monotonic()+5)
                while cgroup_members(group):
                    check(time.monotonic()<deadline,'owned cgroup remains populated after cleanup');time.sleep(0.02)
            self.remove_group(record)
        self.data['forcedCleanup']=self.data['forcedCleanup'] or forced;self.save()
        self.remove_namespace()
        self.cleanup_resources()
        cleanup_dependency_staging(self.root)
        check(not self.data['forcedCleanup'],'forced cleanup invalidates every receipt')

def check_gate_namespace(gate_root,probe_case):
    suffix=probe_suffix(probe_case)
    check(gate_root.parent==Path('/opt') and re.fullmatch('aihr-throughput-[1-9][0-9]*-1'+re.escape(suffix),gate_root.name),'gate/configuration probe namespace mismatch')

def gate_main(words):
    check(len(words)==3 and os.geteuid()==0,'root owned gate invocation required')
    config_fd,ready_fd,release_fd=map(int,words)
    with os.fdopen(config_fd,'rb') as incoming: raw=incoming.read(1024**2+1)
    check(len(raw)<=1024**2,'gate configuration bound');c=json.loads(raw)
    check(set(c)=={'argv','env','cwd','uid','gid','mask','cgroup','probeCase'} and isinstance(c['argv'],list) and c['argv'] and all(isinstance(v,str) and '\0' not in v for v in c['argv']) and isinstance(c['env'],dict),'closed gate configuration required')
    gate_root=Path(__file__).resolve().parent
    check(gate_root.parent==Path('/opt') and re.fullmatch('aihr-throughput-[1-9][0-9]*-1(?:-kernel-(?:eof|orphan))?',gate_root.name),'fixed root-owned gate namespace required');protected(gate_root,True);protected(__file__)
    check_gate_namespace(gate_root,c['probeCase'])
    group=Path(c['cgroup']);check(group.parent==Path('/sys/fs/cgroup')/gate_root.name and re.fullmatch('child-[0-9]{5}',group.name),'fixed registered cgroup required');protected(group,True);protected(group/'cgroup.procs');(group/'cgroup.procs').write_text(str(os.getpid()));in_cgroup(os.getpid(),group)
    os.chdir(c['cwd']);os.setgroups([]);os.setgid(c['gid']);os.setuid(c['uid']);os.umask(c['mask']);os.write(ready_fd,b'R');os.close(ready_fd)
    release=os.read(release_fd,1);os.close(release_fd)
    if release!=b'X': os._exit(125)
    os.execve(c['argv'][0],c['argv'],c['env'])

def initialization_path(probe_case=None):
    root=root_directory(probe_case);return root.with_name(root.name+'-init.json')

def initialization_intent(probe_case=None):
    path=initialization_path(probe_case);check(protected(path).st_size<=65536,'bounded initialization intent required');raw=path.read_bytes();data=json.loads(raw)
    check(raw==canonical(data),'canonical initialization intent required')
    check(set(data)=={'runId','controller','state','rootIdentity','namespaceIdentity','probeCase'} and data['runId']==number(os.environ['GITHUB_RUN_ID']) and data['controller']==os.environ['GITHUB_SHA'] and data['probeCase']==probe_case and data['state'] in ['preparing','ready','aborted'],'exact initialization intent required')
    return data

def recover_initialization(probe_case=None):
    """No child/allocation is authorized until the complete gate/registry is ready."""
    path=initialization_path(probe_case);root=root_directory(probe_case)
    if not os.path.lexists(path):
        check(not os.path.lexists(root) and not os.path.lexists(cgroup_root(probe_case)),'namespace exists without owned initialization intent; manual inspection required')
        return True
    data=initialization_intent(probe_case)
    if os.path.lexists(root):
        info=protected(root,True);actual={'dev':info.st_dev,'ino':info.st_ino}
        if data['rootIdentity'] is None:
            check(data['state']=='preparing' and not any(root.iterdir()),'unidentified nonempty initialization root; manual inspection required')
            data['rootIdentity']=actual;atomic_root(path,data)
        check(data['rootIdentity']==actual,'initialization root inode changed')
    else: check(data['rootIdentity'] is None and data['state']!='ready','owned initialization root unexpectedly missing')
    if data['state']=='ready': return False
    group=cgroup_root(probe_case)
    if os.path.lexists(group):
        info=protected(group,True);actual={'dev':info.st_dev,'ino':info.st_ino}
        check(data['namespaceIdentity'] in (None,actual) and not cgroup_members(group) and not any(p.is_dir() for p in group.iterdir()),'uncertain/populated initialization cgroup; manual inspection required')
        # Retain exact identity before removal. Initialization has never released a gate.
        data['namespaceIdentity']=actual;atomic_root(path,data);group.rmdir()
    data['state']='aborted';atomic_root(path,data);return True

def initialize(probe_case=None):
    check(os.geteuid()==0,'root accepted-input namespace required');root=root_directory(probe_case)
    check(not os.path.lexists(root) and not os.path.lexists(cgroup_root(probe_case)) and not os.path.lexists(initialization_path(probe_case)),'initialization namespace already exists; refusing adoption')
    data={'runId':number(os.environ['GITHUB_RUN_ID']),'controller':os.environ['GITHUB_SHA'],'state':'preparing','rootIdentity':None,'namespaceIdentity':None,'probeCase':probe_case}
    atomic_root(initialization_path(probe_case),data)  # BEFORE either namespace allocation.
    root.mkdir(mode=0o700);info=protected(root,True);data['rootIdentity']={'dev':info.st_dev,'ino':info.st_ino};atomic_root(initialization_path(probe_case),data)
    check(Path('/sys/fs/cgroup/cgroup.controllers').is_file(),'cgroup v2 required; no weaker descendant cleanup fallback')
    cgroup_root(probe_case).mkdir(mode=0o755);info=protected(cgroup_root(probe_case),True)
    data['namespaceIdentity']={'dev':info.st_dev,'ino':info.st_ino};atomic_root(initialization_path(probe_case),data)
    atomic_root(root/'registry.json',{'format':1,'runId':number(os.environ['GITHUB_RUN_ID']),'controller':os.environ['GITHUB_SHA'],'children':[],'forcedCleanup':False,'createdChildren':0,'finishedChildren':0,'resources':[],'namespace':{'dev':info.st_dev,'ino':info.st_ino,'state':'present'}})
    fd=os.open(root/'gate.py',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o400)
    with os.fdopen(fd,'wb') as out: out.write(Path(__file__).read_bytes());out.flush();os.fsync(out.fileno())
    data['state']='ready';atomic_root(initialization_path(probe_case),data)
    return root

def export_cleanup_evidence(root,destination,probe_case=None):
    probe_suffix(probe_case);prefix='owned-' if probe_case is None else 'owned-'+probe_case+'-'
    destination=Path(destination);info=destination.lstat()
    check(destination.resolve(strict=True)==destination and destination.name=='bank-throughput-evidence' and stat.S_ISDIR(info.st_mode) and str(info.st_uid)==os.environ.get('SUDO_UID') and not info.st_mode&0o022,'original private runner evidence directory required')
    for name in ['registry.json','budget.json','dependency-provision.json',*[p.name for p in root.glob('cleanup-*')]]:
        path=root/name
        if not path.exists(): continue
        check(name in ['registry.json','budget.json','dependency-provision.json',*['cleanup-'+value for value in worker_log_names()]],'closed cleanup evidence names required')
        protected(path)
        with path.open('rb') as incoming: raw=incoming.read(1024**2+1)
        check(len(raw)<=1024**2,'bounded cleanup evidence required')
        evidence_bytes(destination/(prefix+name),raw,refresh=True,mode=0o644)

def cleanup_scope(probe_case,measurement_result,evidence_dir):
    root=root_directory(probe_case);registry=None;failure=None
    try:
        if not recover_initialization(probe_case):
            registry=Registry(root,probe_case)
            try: registry.cleanup()
            except ValueError as error:
                # A probe intentionally invalidates its own receipt. This never waives baseline failure.
                check(probe_case=='kernel-orphan' and str(error)=='CI throughput proof refused: forced cleanup invalidates every receipt' and registry.data['forcedCleanup'] and not registry.data['children'] and registry.data['namespace']['state']=='removed','independent namespace cleanup failed: '+str(error))
    except BaseException as error: failure=error
    if registry is not None and (probe_case is not None or failure is not None or measurement_result!='success'):
        try: registry.invalidate_receipt()
        except BaseException as error:
            print('Exact receipt invalidation also failed: '+str(error),file=sys.stderr)
            if failure is None: failure=error
    try:
        export_cleanup_evidence(root,evidence_dir,probe_case)
        intent=initialization_path(probe_case)
        if os.path.lexists(intent):
            initialization_intent(probe_case)
            prefix='owned-' if probe_case is None else 'owned-'+probe_case+'-'
            evidence_bytes(Path(evidence_dir)/(prefix+'initialization.json'),intent.read_bytes(),refresh=True,mode=0o644)
    except BaseException as error:
        print('Bounded cleanup evidence export also failed: '+str(error),file=sys.stderr)
        if failure is None: failure=error
    if failure is not None: raise failure

def cleanup_deadline(signum,frame):
    raise TimeoutError('Independent namespace cleanup deadline exceeded; remaining scopes must still be attempted')

def cli():
    if len(sys.argv)>1 and sys.argv[1]=='gate': gate_main(sys.argv[2:]);return
    parser=argparse.ArgumentParser(allow_abbrev=False);sub=parser.add_subparsers(dest='mode',required=True)
    auth=sub.add_parser('authenticate');auth.add_argument('--producer',required=True);auth.add_argument('--source',required=True);auth.add_argument('--run',required=True);auth.add_argument('--job',required=True);auth.add_argument('--artifact',required=True);auth.add_argument('--digest',required=True)
    verify=sub.add_parser('verify');verify.add_argument('--source',required=True);verify.add_argument('--producer-controller',required=True)
    prepare=sub.add_parser('prepare')
    for name in ['source','producer-controller','node']: prepare.add_argument('--'+name,required=True)
    measure=sub.add_parser('measure')
    for name in ['controller','source','producer-controller','node','report']: measure.add_argument('--'+name,required=True)
    measure.add_argument('--mode',dest='proof_mode',choices=['full-100001','preflight-401'],default='full-100001')
    sub.add_parser('budget')
    cleanup=sub.add_parser('cleanup');cleanup.add_argument('--measurement-result',required=True,choices=['success','failure','cancelled','skipped','']);cleanup.add_argument('--evidence-dir',required=True)
    args=parser.parse_args();invocation()
    if args.mode=='budget':
        job,seconds=current_job();print(json.dumps({'jobId':job['id'],'startedAt':job['started_at'],'maxSeconds':seconds,'wholeJobSeconds':job_seconds(),'cleanupEvidenceReserveSeconds':RESERVE_SECONDS,'mode':proof_mode()}));return
    if args.mode=='cleanup':
        failures=[];previous=signal.signal(signal.SIGALRM,cleanup_deadline)
        for case in [None,'kernel-eof','kernel-orphan']:
            signal.setitimer(signal.ITIMER_REAL,55 if case is None else 15)
            try: cleanup_scope(case,args.measurement_result,Path(args.evidence_dir).absolute())
            except BaseException as error:
                failures.append(error);print('Independent cleanup failed for '+str(case)+': '+str(error),file=sys.stderr)
            finally: signal.setitimer(signal.ITIMER_REAL,0)
        signal.signal(signal.SIGALRM,previous)
        if failures: raise failures[0]
        print(json.dumps({'ownedRegistryCleanupSucceeded':True,'releaseAuthorized':False}));return
    if args.mode in ['verify','prepare','measure']:
        inputs,manifest,ledger=verify_packet(args.source,args.producer_controller)
        if args.mode=='verify':
            print(json.dumps({'verifiedActualSourceAndDependencies':True,'migrationLedger':ledger,'releaseAuthorized':False}));return
        if args.mode=='prepare':
            source=Path(args.source).resolve(strict=True);node=Path(args.node).resolve(strict=True);registry=Registry(root_directory())
            check(json.loads((source/'package.json').read_bytes())['scripts']['db:migrate']=='drizzle-kit migrate','normal source migration CLI changed; explicit review required')
            uid=source.stat().st_uid;user=pwd.getpwuid(uid)
            check(uid>0 and str(uid)==os.environ.get('SUDO_UID'),'original runner identity required for normal migration/catalog bootstrap')
            app='postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test';owner='postgres://ai_hr_owner@127.0.0.1:5433/ai_hr_test'
            env={'PATH':str(node.parent)+':/usr/bin:/bin','HOME':user.pw_dir,'LANG':'C.UTF-8','TZ':'Asia/Kuala_Lumpur','NODE_ENV':'production','CI':'true','GITHUB_ACTIONS':'true','DATABASE_URL':app,'MIGRATION_DATABASE_URL':owner,'TEST_DATABASE_URL':app,'TEST_MIGRATION_DATABASE_URL':owner}
            auxiliary=auxiliary_contracts(source,manifest)
            # Invoke the exact package.json normal Drizzle CLI, with Node explicit
            # so the gate can pin its executable and contain its own esbuild service.
            commands=[([str(node),str(source/'node_modules/drizzle-kit/bin.cjs'),'migrate'],600),([str(node),'--import','tsx','scripts/seed-catalogs.ts'],300)]
            for argv,cap in commands:
                available=remaining_job_seconds(inputs['consumerJobStartedAt'],time.time(),float(os.environ['THROUGHPUT_FIRST_STEP_EPOCH']))
                result=registry.run(argv,cwd=source,env=env,timeout=min(cap,available),user=uid,group=user.pw_gid,extra_groups=[],umask=0o077,auxiliaries=auxiliary)
                check(result.returncode==0,'normal migration/catalog command failed; bounded stderr='+result.stderr[-12000:])
            registry.assert_empty();verify_source_bytes(source,manifest)
            print(json.dumps({'normalDrizzleMigrationAndCatalogBootstrap':True,'migrationLedger':ledger,'releaseAuthorized':False}));return
        check(Path(args.controller).resolve()==Path(__file__).resolve().parent.parent,'measure must use this exact consumer controller')
        check(proof_mode(args.proof_mode)==proof_mode(),'CLI and authenticated workflow proof modes differ')
        job,seconds=current_job()
        # This is computed after ALL checkout/setup/download/verification/migration
        # work. The proof supervisor begins at its own module entry, with only the
        # remaining whole-job budget and a separate five-minute evidence reserve.
        argv=[sys.executable,'-I','-B',str(Path(args.controller).resolve()/'scripts/ci-bank-import-large-throughput.py'),'--controller',args.controller,'--producer-controller',args.producer_controller,'--application-source',inputs['producer']['source'],'--source',args.source,'--package-dir',str(root_directory()/'accepted'),'--node',args.node,'--accepted-controller',inputs['producer']['producer'],'--accepted-run-id',str(inputs['producer']['run']),'--report',args.report,'--max-seconds',str(seconds)]
        argv+=['--mode',args.proof_mode]
        for name,key in [('archive-sha256','worker-package.zip'),('manifest-sha256','worker-manifest.json'),('provenance-sha256','worker-provenance.json'),('runtime-proof-sha256','worker-runtime-proof.json')]: argv+=['--'+name,inputs['members'][key]]
        atomic_root(root_directory()/'budget.json',{'consumerJobId':job['id'],'jobStartedAt':job['started_at'],'proofBudgetSeconds':seconds,'calculatedAtEpoch':time.time(),'wholeJobSeconds':job_seconds(),'evidenceCleanupReserveSeconds':RESERVE_SECONDS,'mode':args.proof_mode})
        seconds=remaining_job_seconds(job['started_at'],time.time(),float(os.environ['THROUGHPUT_FIRST_STEP_EPOCH']))-10
        check(seconds>=minimum_seconds(),'post-fsync handoff exhausts remaining proof budget');argv[argv.index('--max-seconds')+1]=str(seconds)
        # Never persist or expose the read-only API token to the native controller.
        env={k:v for k,v in os.environ.items() if k not in ['GH_TOKEN','GITHUB_TOKEN']}
        os.execve(sys.executable,argv,env)
    pins={'producer':sha(args.producer),'source':source_pin(args.source),'run':number(args.run),'job':number(args.job),'artifact':number(args.artifact),'digest':args.digest}
    check(re.fullmatch('[a-f0-9]{64}',pins['digest']),'independently pinned artifact digest required')
    current,seconds=current_job();run=api(f'/repos/{REPO}/actions/runs/{pins["run"]}');listing=api(f'/repos/{REPO}/actions/runs/{pins["run"]}/attempts/1/jobs?per_page=100');check(listing.get('total_count')==len(listing.get('jobs',[])),'truncated producer jobs refused')
    artifact=api(f'/repos/{REPO}/actions/artifacts/{pins["artifact"]}');check_metadata(run,listing.get('jobs',[]),artifact,pins)
    root=initialize();archive=root/'api-artifact.zip';download_artifact(pins['artifact'],archive,artifact['size_in_bytes']);members=extract_packet(archive,root/'accepted',pins['digest'])
    atomic_root(root/'authenticated.json',{'format':1,'kind':'AUTHENTICATED_API_INPUT_NOT_RELEASE','repositoryId':REPOSITORY_ID,'consumerController':os.environ['GITHUB_SHA'],'consumerRun':number(os.environ['GITHUB_RUN_ID']),'producer':pins,'members':members,'producerRun':run,'producerJob':listing['jobs'][0],'artifact':artifact,'consumerJobStartedAt':current['started_at'],'mode':proof_mode()})
    print(json.dumps({'authenticated':True,'source':pins['source'],'producerController':pins['producer'],'acceptedRun':pins['run'],'acceptedArtifact':pins['artifact'],'maxSecondsAfterPreflight':seconds,'releaseAuthorized':False}))

if __name__=='__main__': cli()
