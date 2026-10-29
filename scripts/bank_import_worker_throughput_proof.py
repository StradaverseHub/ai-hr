"""CI-only authenticated throughput inputs, proof contract and exact-child cleanup.
No installation, staging-ledger or release authority. Never import a legacy installer validator.
"""
import argparse
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
CONSUMER_WORKFLOW='.github/workflows/bank-import-worker-throughput.yml'
REFUSED_SOURCE='968354c00a71df7baccd499eb60757a3307ed61e'
MAX_SECONDS=10800
RESERVE_SECONDS=300
MAX_OUTER=600*1024**2
MEMBERS={'worker-package.zip':512*1024**2,'worker-manifest.json':32*1024**2,'worker-provenance.json':1024**2,'worker-runtime-proof.json':1024**2}
WORKER_LOG_NAMES=['latch-holder.stderr',*[f'worker-{i}.{kind}' for i in range(5) for kind in ['stdout','stderr']]]

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

def require_registered_policy(source):
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
        path=source/row['path'];check(path.resolve().is_relative_to(source),'source/dependency entry escapes frozen checkout')
        if row['type']=='file': check(path.is_file() and not path.is_symlink() and path.stat().st_size==row['size'] and file_hash(path)==row['sha256'],'accepted file differs from frozen source/dependency bytes')
        elif row['type']=='symlink': check(path.is_symlink() and os.readlink(path)==row['target'],'accepted source/dependency link differs')
        else: check(path.is_dir() and not path.is_symlink(),'accepted source/dependency directory differs')

def authenticated_inputs():
    root=root_directory();protected(root,True);path=root/'authenticated.json';protected(path)
    check(path.stat().st_size<=4*1024**2,'bounded authenticated metadata required')
    raw=path.read_bytes();value=json.loads(raw)
    check(raw==canonical(value) and set(value)=={'format','kind','repositoryId','consumerController','consumerRun','producer','members','producerRun','producerJob','artifact','consumerJobStartedAt'},'closed canonical authenticated metadata required')
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

def verify_packet(source,producer):
    inputs=authenticated_inputs();pins=inputs['producer'];package=root_directory()/'accepted';source=Path(source).resolve(strict=True);producer=Path(producer).resolve(strict=True)
    controller=Path(__file__).resolve().parent.parent
    registry=Registry(root_directory())
    check(len({controller,source,producer})==3 and all(not a.is_relative_to(b) for a in [controller,source,producer] for b in [controller,source,producer] if a!=b),'three separate frozen checkouts required')
    for checkout,wanted in [(controller,os.environ['GITHUB_SHA']),(source,pins['source']),(producer,pins['producer'])]:
        def git(*words):
            result=registry.run(['/usr/bin/git','-c','safe.directory='+str(checkout),'-C',str(checkout),*words],env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},timeout=60)
            check(result.returncode==0 and result.stderr=='','frozen checkout Git check failed');return result.stdout.strip()
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
    verify_source_bytes(source,manifest)
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
    for value in [run.get('id'),run.get('run_attempt'),artifact.get('id'),*[v for j in jobs for v in [j.get('id'),j.get('run_id'),j.get('run_attempt')]]:
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
    remaining=math.floor(MAX_SECONDS-(now-started)-RESERVE_SECONDS)
    check(900<=remaining<=MAX_SECONDS-RESERVE_SECONDS,'whole-job preflight plus cleanup/evidence reserve exhausts proof budget')
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

def root_directory():
    invocation();return Path('/opt')/('aihr-throughput-'+os.environ['GITHUB_RUN_ID']+'-1')

def cgroup_root():
    invocation();return Path('/sys/fs/cgroup')/('aihr-throughput-'+os.environ['GITHUB_RUN_ID']+'-1')

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
        check(info.get('name')=='@esbuild/linux-x64' and isinstance(version,str) and re.fullmatch('[0-9]+\.[0-9]+\.[0-9]+',version),'manifest esbuild package identity required')
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
        with response,Path(path).open('xb') as output:
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
    def __init__(self,path):
        check(os.geteuid()==0,'root registry orchestration required');self.root=Path(path);check(self.root==root_directory(),'fixed current-run registry namespace required');protected(self.root,True)
        self.path=self.root/'registry.json';protected(self.path);self.data=json.loads(self.path.read_bytes())
        check(set(self.data)=={'format','runId','controller','children','forcedCleanup','createdChildren','finishedChildren','resources','namespace'} and self.data['format']==1 and self.data['runId']==number(os.environ['GITHUB_RUN_ID']) and self.data['controller']==os.environ['GITHUB_SHA'] and isinstance(self.data['children'],list) and len(self.data['children'])<=128 and type(self.data['createdChildren']) is int and type(self.data['finishedChildren']) is int and 0<=self.data['finishedChildren']<=self.data['createdChildren']<=25000 and isinstance(self.data['resources'],list) and len(self.data['resources'])<=3,'closed bounded current-controller registry required')
        check(set(self.data['namespace'])=={'dev','ino','state'} and self.data['namespace']['state'] in ['present','remove-pending','removed'],'closed cgroup namespace lifecycle required')
        self.gate=self.root/'gate.py';protected(self.gate);check(file_hash(self.gate)==file_hash(__file__),'registry gate bytes differ from current controller')
    def save(self): atomic_root(self.path,self.data)
    def register_area(self,path):
        path=Path(path);info=protected(path,True)
        check(path.parent==Path('/opt') and re.fullmatch('aihr-large-throughput-ci-[A-Za-z0-9_]+',path.name) and not any(r['type']=='area' for r in self.data['resources']),'one exact newly owned runtime area required')
        self.data['resources'].append({'type':'area','path':str(path),'dev':info.st_dev,'ino':info.st_ino});self.save()
    def register_user(self,user):
        check(user.pw_name=='aihr-import-throughput-ci' and user.pw_uid>0 and user.pw_gid>0 and user.pw_dir=='/nonexistent' and user.pw_shell=='/usr/sbin/nologin' and not any(r['type']=='user' for r in self.data['resources']),'one dedicated native worker user required')
        self.data['resources'].append({'type':'user','name':user.pw_name,'uid':user.pw_uid,'gid':user.pw_gid,'home':user.pw_dir,'shell':user.pw_shell});self.save()
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
                path=Path(resource['path']);info=protected(path,True)
                check((info.st_dev,info.st_ino)==(resource['dev'],resource['ino']),'runtime area identity changed; refusing recursive removal')
                # Keep bounded original stdout/stderr failure evidence before removal.
                for name in WORKER_LOG_NAMES:
                    log=path/name
                    if not log.exists(): continue
                    protected(log)
                    with log.open('rb') as incoming: raw=incoming.read(64*1024)
                    fd=os.open(self.root/('cleanup-'+name),os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o400)
                    with os.fdopen(fd,'wb') as out: out.write(raw);out.flush();os.fsync(out.fileno())
                check(shutil.rmtree.avoids_symlink_attacks,'fd-safe recursive owned-area removal required');shutil.rmtree(path)
            elif resource['type']=='user':
                user=pwd.getpwnam(resource['name']);group=grp.getgrgid(resource['gid'])
                check((user.pw_uid,user.pw_gid,user.pw_dir,user.pw_shell)==(resource['uid'],resource['gid'],resource['home'],resource['shell']) and group.gr_name==resource['name'] and not group.gr_mem,'native user/group identity changed; removal refused')
                check(not any(p.pw_gid==resource['gid'] and p.pw_uid!=resource['uid'] for p in pwd.getpwall()),'worker group has a foreign primary user')
                for entry in Path('/proc').iterdir():
                    if not entry.name.isdecimal(): continue
                    try: status=(entry/'status').read_text().splitlines()
                    except (FileNotFoundError,ProcessLookupError): continue
                    uids=[line.split(':',1)[1].split() for line in status if line.startswith('Uid:')]
                    check(len(uids)==1 and str(resource['uid']) not in uids[0],'remaining native UID process; no foreign signal or user removal')
                result=subprocess.run(['/usr/sbin/userdel',resource['name']],env={'PATH':'/usr/bin:/bin'},capture_output=True,timeout=10)
                check(result.returncode==0,'owned worker user removal failed')
                try: group=grp.getgrgid(resource['gid'])
                except KeyError: continue
                check(group.gr_name==resource['name'] and not group.gr_mem,'worker group changed after user removal')
                result=subprocess.run(['/usr/sbin/groupdel',resource['name']],env={'PATH':'/usr/bin:/bin'},capture_output=True,timeout=10)
                check(result.returncode==0,'owned worker group removal failed')
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
        parent=cgroup_root();info=protected(parent,True)
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
        parent=cgroup_root();info=protected(parent,True)
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
        parent=cgroup_root();expected=self.data['namespace']
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
    def popen(self,argv,*,cwd='/',env=None,gate_timeout=30,auxiliaries=None,**options):
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
            config={'argv':argv,'env':env,'cwd':str(cwd),'uid':uid,'gid':gid,'mask':mask,'cgroup':str(group)}
            config_stream=os.fdopen(config_w,'wb');config_w=None
            with config_stream as stream: stream.write(canonical(config))
            ready,_,_=select.select([ready_r],[],[],gate_timeout);check(ready and os.read(ready_r,1)==b'R','owned gate readiness timeout')
            actual=proc_snapshot(p.pid);check(actual['parent']==os.getpid() and actual['uid']==[str(uid)]*4 and actual['gid']==[str(gid)]*4 and actual['exe']==str(Path(sys.executable).resolve()) and actual['cwd']==str(Path(cwd).resolve()) and actual['argv']==[v.encode() for v in gate_argv],'exact gated child identity differs')
            in_cgroup(p.pid,group);check(cgroup_members(group)==[p.pid],'gated cgroup must contain only the unreleased direct child')
            gate=serial_identity(actual)
            expected={**gate,'exe':str(Path(argv[0]).resolve()),'argv':argv,'envSha256':digest(b''.join((k+'='+v).encode()+b'\0' for k,v in env.items()))}
            record.update({'pid':p.pid,'start':actual['start'],'parent':os.getpid(),'parentStart':proc_snapshot(os.getpid())['start'],'gate':gate,'exec':expected,'state':'active'});self.save()
            os.write(release_w,b'X');os.close(release_w);release_w=None
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
            check(not cgroup_members(cgroup_root()/record['cgroup']),'surviving owned descendants invalidate proof completion')
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
        check(not self.data['forcedCleanup'],'forced cleanup invalidates every receipt')

def gate_main(words):
    check(len(words)==3 and os.geteuid()==0,'root owned gate invocation required')
    config_fd,ready_fd,release_fd=map(int,words)
    with os.fdopen(config_fd,'rb') as incoming: raw=incoming.read(1024**2+1)
    check(len(raw)<=1024**2,'gate configuration bound');c=json.loads(raw)
    check(set(c)=={'argv','env','cwd','uid','gid','mask','cgroup'} and isinstance(c['argv'],list) and c['argv'] and all(isinstance(v,str) and '\0' not in v for v in c['argv']) and isinstance(c['env'],dict),'closed gate configuration required')
    gate_root=Path(__file__).resolve().parent
    check(gate_root.parent==Path('/opt') and re.fullmatch('aihr-throughput-[1-9][0-9]*-1',gate_root.name),'fixed root-owned gate namespace required');protected(gate_root,True);protected(__file__)
    group=Path(c['cgroup']);check(group.parent==Path('/sys/fs/cgroup')/gate_root.name and re.fullmatch('child-[0-9]{5}',group.name),'fixed registered cgroup required');protected(group,True);protected(group/'cgroup.procs');(group/'cgroup.procs').write_text(str(os.getpid()));in_cgroup(os.getpid(),group)
    os.chdir(c['cwd']);os.setgroups([]);os.setgid(c['gid']);os.setuid(c['uid']);os.umask(c['mask']);os.write(ready_fd,b'R');os.close(ready_fd)
    release=os.read(release_fd,1);os.close(release_fd)
    if release!=b'X': os._exit(125)
    os.execve(c['argv'][0],c['argv'],c['env'])

def initialize():
    check(os.geteuid()==0,'root accepted-input namespace required');root=root_directory();root.mkdir(mode=0o700)
    check(Path('/sys/fs/cgroup/cgroup.controllers').is_file(),'cgroup v2 required; no weaker descendant cleanup fallback')
    cgroup_root().mkdir(mode=0o755);protected(cgroup_root(),True)
    info=protected(cgroup_root(),True)
    atomic_root(root/'registry.json',{'format':1,'runId':number(os.environ['GITHUB_RUN_ID']),'controller':os.environ['GITHUB_SHA'],'children':[],'forcedCleanup':False,'createdChildren':0,'finishedChildren':0,'resources':[],'namespace':{'dev':info.st_dev,'ino':info.st_ino,'state':'present'}})
    fd=os.open(root/'gate.py',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o400)
    with os.fdopen(fd,'wb') as out: out.write(Path(__file__).read_bytes());out.flush();os.fsync(out.fileno())
    return root

def export_cleanup_evidence(root,destination):
    destination=Path(destination);info=destination.lstat()
    check(destination.resolve(strict=True)==destination and destination.name=='bank-throughput-evidence' and stat.S_ISDIR(info.st_mode) and str(info.st_uid)==os.environ.get('SUDO_UID') and not info.st_mode&0o022,'original private runner evidence directory required')
    for name in ['registry.json','budget.json',*[p.name for p in root.glob('cleanup-*')]]:
        path=root/name
        if not path.exists(): continue
        check(name in ['registry.json','budget.json',*['cleanup-'+value for value in WORKER_LOG_NAMES]],'closed cleanup evidence names required')
        protected(path)
        with path.open('rb') as incoming: raw=incoming.read(1024**2+1)
        check(len(raw)<=1024**2,'bounded cleanup evidence required')
        fd=os.open(destination/('owned-'+name),os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o644)
        with os.fdopen(fd,'wb') as outgoing: outgoing.write(raw);outgoing.flush();os.fsync(outgoing.fileno())

def cli():
    if len(sys.argv)>1 and sys.argv[1]=='gate': gate_main(sys.argv[2:]);return
    parser=argparse.ArgumentParser(allow_abbrev=False);sub=parser.add_subparsers(dest='mode',required=True)
    auth=sub.add_parser('authenticate');auth.add_argument('--producer',required=True);auth.add_argument('--source',required=True);auth.add_argument('--run',required=True);auth.add_argument('--job',required=True);auth.add_argument('--artifact',required=True);auth.add_argument('--digest',required=True)
    verify=sub.add_parser('verify');verify.add_argument('--source',required=True);verify.add_argument('--producer-controller',required=True)
    prepare=sub.add_parser('prepare')
    for name in ['source','producer-controller','node']: prepare.add_argument('--'+name,required=True)
    measure=sub.add_parser('measure')
    for name in ['controller','source','producer-controller','node','report']: measure.add_argument('--'+name,required=True)
    sub.add_parser('budget')
    cleanup=sub.add_parser('cleanup');cleanup.add_argument('--measurement-result',required=True,choices=['success','failure','cancelled','skipped','']);cleanup.add_argument('--evidence-dir',required=True)
    args=parser.parse_args();invocation()
    if args.mode=='budget':
        job,seconds=current_job();print(json.dumps({'jobId':job['id'],'startedAt':job['started_at'],'maxSeconds':seconds,'wholeJobSeconds':MAX_SECONDS,'cleanupEvidenceReserveSeconds':RESERVE_SECONDS}));return
    if args.mode=='cleanup':
        root=root_directory();registry=None;failure=None
        try:
            if root.exists(): registry=Registry(root);registry.cleanup()
        except BaseException as error: failure=error
        if registry is not None and (failure is not None or args.measurement_result!='success'):
            try: registry.invalidate_receipt()
            except BaseException as error:
                print('Exact receipt invalidation also failed: '+str(error),file=sys.stderr)
                if failure is None: failure=error
        if root.exists():
            try: export_cleanup_evidence(root,Path(args.evidence_dir).absolute())
            except BaseException as error:
                print('Bounded cleanup evidence export also failed: '+str(error),file=sys.stderr)
                if failure is None: failure=error
        if failure is not None: raise failure
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
        job,seconds=current_job()
        # This is computed after ALL checkout/setup/download/verification/migration
        # work. The proof supervisor begins at its own module entry, with only the
        # remaining whole-job budget and a separate five-minute evidence reserve.
        argv=[sys.executable,'-I','-B',str(Path(args.controller).resolve()/'scripts/ci-bank-import-large-throughput.py'),'--controller',args.controller,'--producer-controller',args.producer_controller,'--application-source',inputs['producer']['source'],'--source',args.source,'--package-dir',str(root_directory()/'accepted'),'--node',args.node,'--accepted-controller',inputs['producer']['producer'],'--accepted-run-id',str(inputs['producer']['run']),'--report',args.report,'--max-seconds',str(seconds)]
        for name,key in [('archive-sha256','worker-package.zip'),('manifest-sha256','worker-manifest.json'),('provenance-sha256','worker-provenance.json'),('runtime-proof-sha256','worker-runtime-proof.json')]: argv+=['--'+name,inputs['members'][key]]
        atomic_root(root_directory()/'budget.json',{'consumerJobId':job['id'],'jobStartedAt':job['started_at'],'proofBudgetSeconds':seconds,'calculatedAtEpoch':time.time(),'wholeJobSeconds':MAX_SECONDS,'evidenceCleanupReserveSeconds':RESERVE_SECONDS})
        seconds=remaining_job_seconds(job['started_at'],time.time(),float(os.environ['THROUGHPUT_FIRST_STEP_EPOCH']))-10
        check(seconds>=900,'post-fsync handoff exhausts remaining proof budget');argv[argv.index('--max-seconds')+1]=str(seconds)
        # Never persist or expose the read-only API token to the native controller.
        env={k:v for k,v in os.environ.items() if k not in ['GH_TOKEN','GITHUB_TOKEN']}
        os.execve(sys.executable,argv,env)
    pins={'producer':sha(args.producer),'source':source_pin(args.source),'run':number(args.run),'job':number(args.job),'artifact':number(args.artifact),'digest':args.digest}
    check(re.fullmatch('[a-f0-9]{64}',pins['digest']),'independently pinned artifact digest required')
    current,seconds=current_job();run=api(f'/repos/{REPO}/actions/runs/{pins["run"]}');listing=api(f'/repos/{REPO}/actions/runs/{pins["run"]}/attempts/1/jobs?per_page=100');check(listing.get('total_count')==len(listing.get('jobs',[])),'truncated producer jobs refused')
    artifact=api(f'/repos/{REPO}/actions/artifacts/{pins["artifact"]}');check_metadata(run,listing.get('jobs',[]),artifact,pins)
    root=initialize();archive=root/'api-artifact.zip';download_artifact(pins['artifact'],archive,artifact['size_in_bytes']);members=extract_packet(archive,root/'accepted',pins['digest'])
    atomic_root(root/'authenticated.json',{'format':1,'kind':'AUTHENTICATED_API_INPUT_NOT_RELEASE','repositoryId':REPOSITORY_ID,'consumerController':os.environ['GITHUB_SHA'],'consumerRun':number(os.environ['GITHUB_RUN_ID']),'producer':pins,'members':members,'producerRun':run,'producerJob':listing['jobs'][0],'artifact':artifact,'consumerJobStartedAt':current['started_at']})
    print(json.dumps({'authenticated':True,'source':pins['source'],'producerController':pins['producer'],'acceptedRun':pins['run'],'acceptedArtifact':pins['artifact'],'maxSecondsAfterPreflight':seconds,'releaseAuthorized':False}))

if __name__=='__main__': cli()
