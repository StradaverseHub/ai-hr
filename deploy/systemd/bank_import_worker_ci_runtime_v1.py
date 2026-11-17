"""Root-pinned one-operation CI worker cutover. Loaded only by the self-contained upgrade bundle.
All application JavaScript runs after dropping to the actual private-install owner. No deploy records are written.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

POLICY = 'aihr-worker-ci-runtime/v1'
SOURCE = Path('/opt/ai-hr')
STATE = Path('/var/tmp/aihr-deploy')
COORDINATOR = STATE / 'staging-release-queue/coordinator.py'
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')
PROCESS_ROOT = Path('/proc')
MAX_MANIFEST = 32 * 1024**2


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def epoch(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


READINESS_PROBE = "process.stdout.write(JSON.stringify({kind:'CI_WORKER_READINESS_POLICY_V1',required:process.env.AIHR_IMPORT_WORKER_REQUIRED??null,waitSeconds:process.env.AIHR_IMPORT_WORKER_WAIT_SECONDS??null}))"
LEDGER_FIELDS = {'format','kind','rows','expectedSha256','actualSha256','releaseAuthorized'}


def native_timestamp(base,value,issued,now,fresh=False):
    base.check(isinstance(value,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',value),'native evidence timestamp shape invalid')
    instant=epoch(value)
    base.check(issued<=instant<=now+60 and (not fresh or now-instant<=60),'native evidence timestamp is invalid or stale')
    return instant


def runtime_identity(base,runtime,issued,now,fresh=False):
    # Exactly these two native timestamps vary. Never recursively ignore arbitrary metadata.
    ledger=runtime.get('migrationLedger',{})
    base.check(isinstance(ledger,dict) and set(ledger)==LEDGER_FIELDS|{'verifiedAt'},'exact seven-field native ledger required')
    top=native_timestamp(base,runtime.get('verifiedAt'),issued,now,fresh)
    nested=native_timestamp(base,ledger['verifiedAt'],issued,now,fresh)
    base.check(nested<=top,'native ledger verification postdates its runtime proof')
    stable={k:v for k,v in runtime.items()if k!='verifiedAt'}
    stable['migrationLedger']={k:v for k,v in ledger.items()if k!='verifiedAt'}
    return stable


def record(raw):
    rows = raw.decode().splitlines()
    pairs = [line.split('=', 1) for line in rows]
    if any(len(pair) != 2 for pair in pairs) or len(dict(pairs)) != len(pairs):
        raise ValueError('CI runtime cutover refused: malformed deployment record')
    return dict(pairs)


def excluded(path, filters):
    # Same closed glob grammar as canonicalSourceExclusions; directory exclusions prune the whole subtree.
    return any(re.fullmatch(re.escape(p.strip('/')).replace(r'\*', '[^/]*'), path if p.startswith('/') else path.rsplit('/', 1)[-1]) is not None for p in filters)


def canonical_filters(base,root):
    """Read the actual owner's closed literal exclude arguments without executing web-owned JS as root.
    The ordinary preparation generator calls the owners themselves; this only refuses schema/filter drift.
    """
    text=base.read_bounded(root/'scripts/improve/release.ts',1024**2).decode()
    start=text.find('export function deploymentRsyncArgs(')
    end=text.find('\n}',start)
    base.check(start>=0 and end>start,'canonical deployment filter owner shape changed')
    body=text[start:end]
    filters=[match[1] for match in re.findall(r"['\"]--exclude['\"]\s*,\s*(['\"])(.*?)\1",body)]
    base.check(filters and '.next' in filters and 'node_modules' in filters,'complete actual deployment exclude arguments required')
    return filters


def source_inventory(base, root, filters, deadline=None):
    """Complete included set, content, links and modes, including untracked canonical extras. Never follows links."""
    base.check(filters and '.next' in filters and 'node_modules' in filters, 'canonical source filters required')
    for p in filters:
        base.check(isinstance(p, str) and not any(x in p for x in ('**', '?', '[')), 'unsupported canonical source filter')
    rows = []
    def walk(path, relative):
        base.check(deadline is None or time.time()<deadline,'source inventory operation deadline exceeded')
        base.check(len(rows) < 200000, 'source inventory exceeds bound')
        before = path.lstat()
        mode = stat.S_IMODE(before.st_mode)
        if stat.S_ISDIR(before.st_mode):
            row = {'path': relative, 'kind': 'directory', 'mode': mode}
            rows.append(row)
            names = sorted(os.listdir(path))
            for name in names:
                child = relative + '/' + name if relative else name
                if not excluded(child, filters):
                    walk(path / name, child)
            base.check(names == sorted(os.listdir(path)), 'source directory changed during inventory')
        elif stat.S_ISREG(before.st_mode):
            raw = base.read_bounded(path, 256 * 1024**2)
            rows.append({'path': relative, 'kind': 'file', 'mode': mode, 'sha256': sha(raw)})
        elif stat.S_ISLNK(before.st_mode):
            target = os.readlink(path)
            base.check(not os.path.isabs(target) and (path.parent / target).resolve(strict=True) != root.resolve() and (path.parent / target).resolve(strict=True).is_relative_to(root.resolve()), 'source link escapes frozen tree')
            rows.append({'path': relative, 'kind': 'link', 'mode': mode, 'target': target})
        else:
            base.check(False, 'source inventory contains a special node')
        after = path.lstat()
        base.check((before.st_dev, before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                   (after.st_dev, after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'source node changed during inventory')
    walk(root, '')
    return rows


def private_install(base, path, uid, directory=False):
    path = Path(path)
    base.check(path.is_absolute() and path.resolve() == path, 'canonical private installation path required')
    info = path.lstat()
    base.check(info.st_uid == uid and not stat.S_ISLNK(info.st_mode), 'private installation owner changed')
    base.check(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 if directory else
               stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode & 0o077, 'private installation protection differs')
    return info


MAX_NATIVE_STDOUT = 32 * 1024**2
MAX_NATIVE_STDERR = 64 * 1024


def bounded_process(argv, **options):
    """Hard streaming bounds and one finite deadline, including silent children. Kill only this new child session.
    Do not reap/poll before failure cleanup: the unreaped child retains its PID, preventing process-group ID reuse.
    """
    supplied=options.pop('input',None)
    timeout=options.pop('timeout',600)
    deadline=time.monotonic()+timeout
    if supplied is not None and len(supplied.encode())>8192:
        raise ValueError('CI runtime cutover refused: native request exceeds bound')
    process=subprocess.Popen(argv,stdin=subprocess.PIPE if supplied is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,**options)
    streams=selectors.DefaultSelector()
    output={};sizes={};reaped=False
    try:
        if supplied is not None:
            process.stdin.write(supplied.encode());process.stdin.close()
        for name,pipe,limit in [('out',process.stdout,MAX_NATIVE_STDOUT),('err',process.stderr,MAX_NATIVE_STDERR)]:
            os.set_blocking(pipe.fileno(),False);streams.register(pipe,selectors.EVENT_READ,(name,limit));output[name]=[];sizes[name]=0
        while streams.get_map():
            remaining=deadline-time.monotonic()
            if remaining<=0:raise ValueError('native proof deadline exceeded')
            for key,_ in streams.select(min(remaining,.25)):
                name,limit=key.data;block=os.read(key.fd,65536)
                if not block:streams.unregister(key.fileobj);continue
                sizes[name]+=len(block)
                if sizes[name]>limit:raise ValueError('native proof output exceeds hard bound')
                output[name].append(block)
        result=process.wait(timeout=max(.001,deadline-time.monotonic()));reaped=True
        if result:raise ValueError('native proof command failed')
        return b''.join(output['out'])
    except BaseException:
        # No shell, no foreign service/unit/PID, and only our unreaped new session is targeted.
        if not reaped:
            try:os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                process.wait(timeout=5)
        raise ValueError('CI runtime cutover refused: bounded native owner proof failed (private diagnostics withheld)') from None
    finally:
        streams.close()
        for pipe in (process.stdout,process.stderr):
            if pipe:pipe.close()


def child(argv, identity, environment, *, input=None, timeout=600):
    """Fixed caller-owned argv only. Drop all supplementary groups/UID/GID BEFORE exec, never root JS."""
    raw=bounded_process(argv,cwd=str(SOURCE),env=environment,user=identity.pw_uid,group=identity.pw_gid,
                        extra_groups=[],input=input,timeout=timeout)
    return json.loads(raw)


def protected_private(base,path):
    base.root_protected(path,regular=True)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        base.check(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and not info.st_mode&0o077,
                   'root-private non-linked operation credential required')
        return info.st_dev,info.st_ino
    finally:os.close(fd)


class RuntimeObservation:
    def __init__(self, base, fmt, args, operation, drain_bytes):
        self.base, self.fmt, self.args, self.operation = base, fmt, args, operation
        self.path = Path(args.ci_runtime_authorization)
        self.auth_identity=protected_private(base,self.path)
        self.bytes = base.read_bounded(self.path, 65536)
        base.check(sha(self.bytes) == args.ci_runtime_authorization_sha256, 'root CI cutover authorization hash differs')
        a = self.auth = json.loads(self.bytes)
        fields = {'format','kind','policy','target','issuedAt','expiresAt','identity','drainSha256','helperSha256','nodeSha256',
                  'install','grantSha256','activatedSha256','runtimeSha256','environmentSha256','dotenvSha256','ledger',
                  'bootIdSha256','webPid','webStartedMonotonicUs','lease','leaseFile','leaseFileSha256','coordinatorSha256',
                  'sourceManifest','sourceManifestSha256','priorLastOkSha256','launch','releaseAuthorized','firstStageApproval','firstStageApprovalSha256','readiness'}
        base.check(set(a) == fields and a['format'] == 1 and a['kind'] == 'ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER' and
                   a['policy'] == POLICY and a['target'] == 'alpha-staging' and a['releaseAuthorized'] is False,
                   'exact administrator CI cutover authority required')
        self.first_path=Path(a['firstStageApproval'])
        self.first_identity=protected_private(base,self.first_path)
        self.first_bytes=base.read_bounded(self.first_path,65536)
        base.check(sha(self.first_bytes)==a['firstStageApprovalSha256'],'pre-drain administrator approval hash differs')
        base.check(a['drainSha256'] == sha(drain_bytes) and a['identity'] == json.loads(drain_bytes)['identity'], 'authorization and original drain identity differ')
        base.check(a['identity']['source'] == args.source and a['identity']['build_id'] == args.build_id, 'authorization candidate differs')
        base.root_protected(Path(sys.argv[0]), regular=True)
        base.check(sha(base.read_bounded(Path(sys.argv[0]), 16*1024**2)) == a['helperSha256'] and
                   sha(base.read_bounded(base.NODE, 128*1024**2)) == a['nodeSha256'], 'root-pinned helper/runtime differs')
        i = a['install']
        base.check(set(i) == {'id','buildRecordId','runId','controller','directory','uid','gid','device','inode'} and
                   isinstance(i['uid'], int) and i['uid'] > 0, 'exact native installation owner and selection required')
        self.owner = pwd.getpwuid(i['uid'])
        base.check(self.owner.pw_uid == i['uid'] and self.owner.pw_gid == i['gid'], 'native private-install group differs')
        self.directory = Path(self.owner.pw_dir) / '.aihr-ci-builds' / i['id']
        base.check(str(self.directory) == i['directory'] and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', i['id']) and
                   re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', i['buildRecordId']), 'canonical exact installation IDs required')
        self.lease_identity=protected_private(base,Path(a['leaseFile']))
        lease_bytes = base.read_bounded(Path(a['leaseFile']), 4096)
        base.check(sha(lease_bytes) == a['leaseFileSha256'], 'pinned held lease credential differs')
        self.lease = json.loads(lease_bytes)
        base.check(set(self.lease)=={'protocol','batch','epoch','candidate','token','releaseAuthorized'} and a['lease'] == {k:self.lease[k] for k in ('batch','epoch','candidate')} and
                   self.lease.get('protocol') == 'aihr-staging-queue/v1' and self.lease['candidate'] == args.source and
                   re.fullmatch('[a-f0-9]{64}', self.lease.get('token','')) and self.lease.get('releaseAuthorized') is False,
                   'exact held lease identity required')
        self.environment = {'PATH':'/opt/node22/bin:/usr/bin:/bin', 'LANG':'C.UTF-8', 'HOME':self.owner.pw_dir,
                            'USER':self.owner.pw_name, 'LOGNAME':self.owner.pw_name, 'AIHR_STAGING_NODE_GUARDED':'1',
                            'AIHR_STAGING_BATCH':self.lease['batch'], 'AIHR_STAGING_EPOCH':str(self.lease['epoch']),
                            'AIHR_STAGING_CANDIDATE':args.source, 'AIHR_STAGING_TOKEN':self.lease['token']}
        self.last, self.transitions, self.last_lease_phase = None, [], None
        self.check_authority()

    def check_authority(self):
        b, a = self.base, self.auth
        b.check(protected_private(b,self.path)==self.auth_identity,'administrator authority inode changed')
        b.check(protected_private(b,Path(a['leaseFile']))==self.lease_identity and sha(b.read_bounded(Path(a['leaseFile']),4096))==a['leaseFileSha256'],'held lease credential identity/content changed')
        b.check(b.read_bounded(self.path,65536) == self.bytes, 'CI cutover authority changed')
        b.root_protected(Path(sys.argv[0]),regular=True);b.root_protected(b.NODE,regular=True)
        b.check(sha(b.read_bounded(Path(sys.argv[0]),16*1024**2))==a['helperSha256'] and sha(b.read_bounded(b.NODE,128*1024**2))==a['nodeSha256'],'root-pinned helper/runtime changed')
        b.root_protected(self.operation/'drained.json',regular=True)
        b.check(sha(b.read_bounded(self.operation/'drained.json',65536))==a['drainSha256'],'original protected drain record changed')
        b.check(epoch(a['issuedAt']) <= time.time() < epoch(a['expiresAt']) <= epoch(a['issuedAt']) + 900,
                'finite administrator operation authority expired or not yet valid')
        private_install(b,self.directory.parent,self.owner.pw_uid,True)
        st = private_install(b,self.directory,self.owner.pw_uid,True)
        # The unmodified operator may clean packet/retained build during stability checks.
        # Native status allowCleanup validates the genuine cleanup authority and retained original audit bytes.
        # Do not turn its owned cleanup into an identity change or grant a separate cleanup waiver here.
        b.check((st.st_dev,st.st_ino) == (a['install']['device'],a['install']['inode']), 'private installation directory identity changed')
        for name,key in [('authorization.json','grantSha256'),('activated.json','activatedSha256'),('runtime.json','runtimeSha256')]:
            private_install(b,self.directory/name,self.owner.pw_uid)
            b.check(sha(b.read_bounded(self.directory/name,1024**2)) == a[key], 'original native installation record differs: '+name)
        self.grant = g = json.loads(b.read_bounded(self.directory/'authorization.json',32768))
        b.check(protected_private(b,self.first_path)==self.first_identity and b.read_bounded(self.first_path,65536)==self.first_bytes,'pre-drain administrator approval identity/content changed')
        first=json.loads(self.first_bytes)
        first_fields={'format','kind','policy','target','issuedAt','expiresAt','identity','helperSha256','nodeSha256','lease','leaseFileSha256','sourceManifestSha256','environmentSha256','dotenvSha256','readiness','gate','releaseAuthorized'}
        gate_fields={'source','controller','runId','build','artifact','witnessFingerprint','policyVersion'}
        b.check(set(first)==first_fields and first['format']==1 and first['kind']=='ADMIN_REVIEWED_CI_WORKER_DRAIN_PINS' and first['policy']==POLICY and first['target']=='alpha-staging' and first['releaseAuthorized'] is False and set(first['gate'])==gate_fields,'closed pre-drain administrator approval required')
        b.check(all(first[k]==a[k] for k in ('identity','helperSha256','nodeSha256','lease','leaseFileSha256','sourceManifestSha256','environmentSha256','dotenvSha256','readiness')),'pre-drain and activation administrator shared pins differ')
        drain_time=(self.operation/'drained.json').stat().st_mtime
        b.check(epoch(first['issuedAt'])<=drain_time<=epoch(first['expiresAt']) and drain_time<=epoch(a['issuedAt']),'pre-drain approval was not valid when original drain completed or activation approval predates drain')
        b.check(first['gate']=={k:g[k] for k in gate_fields},'later CI grant differs from the original pre-drain full-gate/build provenance tuple')
        i=a['install']
        grant_fields={'format','kind','policyVersion','target','installId','source','controller','controllerBranch','baseline','baselineBuildId','environmentSha256','runId','runAttempt','runCreatedAt','issuedAt','expiresAt','producerStartedAt','producerCompletedAt','witnessFingerprint','artifact','build'}
        build_fields={'format','capacityProfile','nextBuildId','buildRecordId','buildSourcePath','runtime','provenanceSha256','archiveSha256','archiveBytes','manifestSha256','preparedSha256','successfulObservationSha256','lockSha256','packageSha256'}
        b.check(set(g)==grant_fields and set(g.get('build',{}))==build_fields and set(g.get('artifact',{}))=={'digest','id'},'closed original CI grant selection shape required; native status owns full validation')
        b.check(set(a['launch'])=={'current','processStartTicks','cmdlineSha256'} and set(a['launch']['current'])=={'ref','pid','log','started_at','phase','build_id','built_at'},'closed original launch identity required')
        b.check(set(a['readiness'])=={'required','waitSeconds'} and a['readiness']['required']=='1' and a['readiness']['waitSeconds'] in (None,'600'),'source-bound REQUIRED1 and WAIT unset/exact600 policy required')
        b.check(set(a['ledger'])=={'format','kind','rows','expectedSha256','actualSha256','releaseAuthorized'} and a['ledger']['format']==1 and a['ledger']['releaseAuthorized'] is False,'closed full-ledger identity required')
        b.check(g.get('kind') == 'OPERATOR_AUTHORIZED_STAGING_CI_BUILD_INSTALL' and g.get('format') == 2 and
                g.get('target') == 'alpha-staging' and g.get('installId') == i['id'] and g.get('source') == self.args.source and
                g.get('controller') == i['controller'] and g.get('runId') == i['runId'] and
                g.get('baseline') == self.args.previous_web_source and g.get('baselineBuildId') == self.args.previous_web_build and
                g.get('build',{}).get('buildRecordId') == i['buildRecordId'] and g['build'].get('nextBuildId') == self.args.build_id and
                g.get('environmentSha256') == a['environmentSha256'] and
                g['build'].get('lockSha256') == self.args.lock_sha256 and g['build'].get('packageSha256') == self.args.package_sha256,
                'original CI grant and administrator/drain pins differ')
        b.check(time.time() < epoch(g['expiresAt']) and epoch(a['expiresAt']) <= epoch(g['expiresAt']), 'original CI grant expired or operation exceeds it')
        b.check(sha(b.read_bounded(SOURCE/'.env.production',1024**2)) == a['dotenvSha256'] and
                sha(b.read_bounded(self.base.ENV,1024**2)) == self.args.worker_env_sha256, 'web/worker private environment changed')
        b.check(sha(b.read_bounded(BOOT_ID,4096)) == a['bootIdSha256'], 'boot identity changed')
        b.check(a['ledger'].get('kind')=='READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE' and isinstance(a['ledger'].get('rows'),int) and a['ledger']['rows']>0 and
                all(re.fullmatch('[a-f0-9]{64}',a['ledger'].get(k,'')) for k in ('expectedSha256','actualSha256')),'full ordered ledger pin required')
        b.check(sha(b.read_bounded(COORDINATOR,1024**2)) == a['coordinatorSha256'], 'approved lease coordinator bytes changed')
        held = child(['/usr/bin/python3',str(COORDINATOR)],self.owner,self.environment,
                     input=json.dumps({'protocol':'aihr-staging-queue/v1','action':'assert','actor':'worker-ci-runtime',**self.lease}),timeout=15)
        b.check(held.get('releaseAuthorized') is False and all(held.get(k)==a['lease'][k] for k in a['lease']) and held.get('phase') in ('installing','arrived'),
                'same live installing/arrived lease required')
        phase=held['phase']
        b.check(self.last_lease_phase!='arrived' or phase=='arrived','held lease phase backslid')
        if phase=='arrived':
            stage,_=self.snapshot();b.check(stage=='O','arrived lease requires strict native successful deployment')
        self.last_lease_phase=phase
        b.check(time.time()<min(epoch(a['expiresAt']),epoch(g['expiresAt'])),'operation or original grant expired during authority proof')

    def source_proof(self):
        b,a=self.base,self.auth
        path=Path(a['sourceManifest']);b.root_protected(path,regular=True)
        raw=b.read_bounded(path,MAX_MANIFEST);b.check(sha(raw)==a['sourceManifestSha256'],'root-pinned complete source manifest differs')
        m=json.loads(raw)
        b.check(m.get('format')==1 and m.get('kind')=='CANONICAL_FROZEN_SOURCE_CONTENT_INVENTORY' and m.get('source')==self.args.source and
                m.get('policy')==POLICY and isinstance(m.get('entries'),list) and len(m['entries'])>100,'complete frozen source inventory required')
        for path,key in [('scripts/improve/release.ts','releaseSha256'),('.github/ci/normal-cleanup-fences.mjs','filterOwnerSha256')]:
            b.check(sha(b.read_bounded(SOURCE/path,1024**2))==m[key],'canonical source filter owner differs')
        b.check(m['filters']==canonical_filters(b,SOURCE),'manifest filters differ from actual canonical deployment owner')
        actual=source_inventory(b,SOURCE,m['filters'],deadline=epoch(a['expiresAt']))
        b.check(actual==m['entries'],'canonical full source content/link/mode/set differs')
        return {'manifestSha256':a['sourceManifestSha256'],'includedNodes':len(actual),'fullSourceChecksumVerified':True}

    def snapshot(self):
        b,a=self.base,self.auth
        for _ in range(8):
            b.check(not (STATE/'pending').exists() and not (STATE/'pending').is_symlink(),'staging deployment pending')
            raw=[b.read_bounded(STATE/name,65536) for name in ('current','last-ok')]
            current,prior=map(record,raw)
            fields={'ref','pid','log','started_at','phase','result','exit_code','build_id','built_at'}
            b.check(set(current) in (fields,fields|{'finished_at'}) and set(prior)==fields|{'finished_at'},'closed native deployment record fields required')
            if raw != [b.read_bounded(STATE/name,65536) for name in ('current','last-ok')]:
                time.sleep(.05);continue
            b.check(b.read_bounded(SOURCE/'.next/BUILD_ID',1024).decode().strip()==self.args.build_id,'candidate build changed')
            identity={k:v for k,v in current.items() if k not in ('result','exit_code','finished_at')}
            b.check(identity==a['launch']['current'] and current.get('ref')==self.args.source and current.get('phase')=='ci-build-health' and
                    current.get('build_id')==self.args.build_id,'original CI deployment launch identity changed')
            verdict=current.get('result')
            b.check(verdict in ('','ok'),'CI deployment failed or entered a forbidden state')
            if verdict=='ok':
                b.check(current.get('exit_code')=='0' and bool(current.get('finished_at')) and prior.get('result')=='' and
                        {k:v for k,v in current.items() if k!='result'}=={k:v for k,v in prior.items() if k!='result'}, 'native successful finish publication differs')
                b.deployment_state(self.args.source,self.args.build_id)
                return 'O',raw
            # Running deploy PID must remain the actual original process, never a reused PID.
            pid=current.get('pid','');b.check(re.fullmatch('[1-9][0-9]*',pid),'original deploy PID required')
            try:
                process=PROCESS_ROOT/pid;start=process.joinpath('stat').read_text().rsplit(')',1)[1].split()[19]
                live=start==a['launch']['processStartTicks'] and sha(b.read_bounded(process/'cmdline',65536))==a['launch']['cmdlineSha256']
            except (FileNotFoundError,ProcessLookupError):live=False
            if not live:
                time.sleep(.05);continue
            if current.get('exit_code','')=='' and not current.get('finished_at') and sha(raw[1])==a['priorLastOkSha256']:
                b.check(prior.get('result')=='' or prior.get('result')=='ok','prior last-ok is invalid')
                b.check(prior.get('ref')==self.args.previous_web_source and prior.get('build_id')==self.args.previous_web_build,'old last-ok baseline differs')
                return 'R0',raw
            if current.get('exit_code')=='0' and current.get('finished_at') and current==prior:
                return 'R1',raw
            # Native finish updates exit_code, finished_at, last-ok and finally result in separate atomic writes.
            # Only bounded retries admit these intermediate unpublished shapes; never call finish ourselves.
            time.sleep(.05)
        raise ValueError('CI runtime cutover refused: no coherent native running/finish publication snapshot')

    def cleanup_retry_authority(self):
        """Authenticate only the unmodified normal operator's owned-cleanup shape; never authorizes a successful proof."""
        b,a=self.base,self.auth
        self.check_authority();stage,_=self.snapshot()
        b.check(stage=='O','only strict successful deployment may retry a native owned-cleanup race')
        path=self.directory/'cleanup-authorized.json';private_install(b,path,self.owner.pw_uid)
        raw=b.read_bounded(path,65536);c=json.loads(raw)
        fields={'format','kind','sourceDirectory','source','installId','buildRecordId','nextBuildId','authorizationSha256','witnessFingerprint','directory','activeDirectory','retainedDirectory','packetDirectory','sourceProof','sourceProofSha256','authorizedAt'}
        activated=json.loads(b.read_bounded(self.directory/'activated.json',1024**2))
        private_install(b,self.directory/'store.json',self.owner.pw_uid)
        store=json.loads(b.read_bounded(self.directory/'store.json',4096))
        b.check(set(c)==fields and c['format']==1 and c['kind']=='OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL' and
                c['sourceDirectory']==str(SOURCE) and c['source']==self.args.source and c['installId']==a['install']['id'] and
                c['buildRecordId']==a['install']['buildRecordId'] and c['nextBuildId']==self.args.build_id and
                c['authorizationSha256']==a['grantSha256'] and c['witnessFingerprint']==self.grant['witnessFingerprint'] and
                c['directory']=={'device':a['install']['device'],'inode':a['install']['inode']} and
                c['activeDirectory']==activated['activation']['activeDirectory'] and c['retainedDirectory']==activated['activation']['retainedDirectory'] and
                c['packetDirectory']==store['packetDirectory'] and sha(canonical(c['sourceProof']))==c['sourceProofSha256'],
                'exact same-install native normal cleanup authority required')
        proof=c['sourceProof'];proof_fields={'format','kind','source','installId','buildRecordId','nextBuildId','authorizationSha256','witnessFingerprint','outputSha256','checkedAt'}
        b.check(set(store)=={'format','installId','directory','packetDirectory'} and store['format']==1 and store['installId']==a['install']['id'] and store['directory']==c['directory'],'original same-install store required')
        b.check(set(proof)==proof_fields and proof['format']==1 and proof['kind']=='OPERATOR_OBSERVED_SOURCE_CHECKSUM_FOR_OWNED_CLEANUP' and all(proof[k]==c[k] for k in ('source','installId','buildRecordId','nextBuildId','authorizationSha256','witnessFingerprint')) and proof['outputSha256']==sha(b''),'original native operator zero-difference source checksum authority required')
        approved=native_timestamp(b,c['authorizedAt'],epoch(self.grant['issuedAt']),time.time())
        checked=native_timestamp(b,proof['checkedAt'],epoch(self.grant['issuedAt']),time.time())
        b.check(checked<=approved<=checked+60,'native cleanup checksum was not fresh when authorized')
        self.source_proof()
        return sha(raw)

    def native_status(self):
        i=self.auth['install'];retry_deadline=None
        for attempt in range(3):
            timeout=min(600,epoch(self.auth['expiresAt'])-time.time())
            if retry_deadline is not None:timeout=min(timeout,retry_deadline-time.monotonic())
            self.base.check(timeout>0,'bounded normal-cleanup native proof recovery expired')
            try:
                return child([str(self.base.NODE),'--env-file=.env.production','--import','tsx','.github/ci/staging-build-install.mjs',
                              'status',self.args.source,i['id'],i['buildRecordId']],self.owner,self.environment,timeout=timeout),attempt+1
            except ValueError:
                if attempt==2:raise
                cleanup_sha=self.cleanup_retry_authority()
                if retry_deadline is None:retry_deadline=time.monotonic()+60
                self.base.check(time.monotonic()<retry_deadline,'bounded normal-cleanup native proof recovery expired')
                self.base.write_new(self.operation/('ci-runtime-native-retry-%03d-%d.json'%(len(self.transitions)+1,attempt+1)),
                                    self.fmt.canonical({'policy':POLICY,'nativeProofAccepted':False,'retry':attempt+1,'cleanupAuthorizationSha256':cleanup_sha,
                                                        'reason':'Native read-only status failed during authenticated same-install normal cleanup; no success inferred',
                                                        'journeyVerified':False}),0o400)
                time.sleep(.1)
        raise ValueError('fresh native proof required')

    def observe(self):
        started=time.monotonic()
        self.check_authority()
        source=self.source_proof()
        before,_=self.snapshot()
        i=self.auth['install']
        # Exact canonical stagingInstallerCommand('status',...) argv, as the actual installation owner, no shell.
        native,attempts=self.native_status()
        self.check_authority()
        self.source_proof()
        stage,raw=self.snapshot()
        b,a=self.base,self.auth
        b.check({'R0':0,'R1':1,'O':2}[stage]>={'R0':0,'R1':1,'O':2}[before], 'native CI finish backslid during proof')
        b.check(self.last is None or {'R0':0,'R1':1,'O':2}[stage]>={'R0':0,'R1':1,'O':2}[self.last], 'native CI finish backslid')
        b.check(set(native)=={'authorizationSha256','verified','activated','runtime','releaseAuthorized'},'closed native status record required')
        runtime=native.get('runtime',{})
        runtime_fields={'format','kind','source','installId','buildRecordId','nextBuildId','authorizationSha256','pid','startedMonotonicUs','healthStatus','compiledByteInventory','migrationLedger','verifiedAt','releaseAuthorized','fullSourceChecksumVerified','fullMigrationLedgerVerified'}
        b.check(set(runtime)==runtime_fields,'closed native active-service proof required')
        b.check(native.get('authorizationSha256')==a['grantSha256'] and native.get('releaseAuthorized') is False and
                runtime.get('kind')=='CI_BUILD_ACTIVE_SERVICE_VERIFIED_NOT_FULL_ARRIVAL' and runtime.get('format')==1 and
                runtime.get('authorizationSha256')==a['grantSha256'] and runtime.get('source')==self.args.source and
                runtime.get('installId')==i['id'] and runtime.get('buildRecordId')==i['buildRecordId'] and
                runtime.get('nextBuildId')==self.args.build_id and runtime.get('pid')==a['webPid'] and
                runtime.get('startedMonotonicUs')==a['webStartedMonotonicUs'] and runtime.get('healthStatus')==200 and
                runtime.get('fullMigrationLedgerVerified') is True and runtime.get('fullSourceChecksumVerified') is False and
                runtime.get('releaseAuthorized') is False and
                isinstance(runtime.get('compiledByteInventory'),dict) and runtime['compiledByteInventory'].get('format')==2,
                'fresh authenticated native CI runtime/compiled/full-ledger proof differs')
        original_runtime=json.loads(b.read_bounded(self.directory/'runtime.json',1024**2))
        b.check(set(original_runtime)==runtime_fields,'closed original native runtime required')
        stable=runtime_identity(b,runtime,epoch(self.grant['issuedAt']),time.time(),fresh=True)
        original_stable=runtime_identity(b,original_runtime,epoch(self.grant['issuedAt']),time.time())
        b.check(stable['migrationLedger']==a['ledger'] and stable==original_stable,'original authenticated active-service/full-ledger identity changed')
        readiness=child([str(self.base.NODE),'--env-file=.env.production','-e',READINESS_PROBE],self.owner,self.environment,timeout=15)
        b.check(readiness=={'kind':'CI_WORKER_READINESS_POLICY_V1',**a['readiness']},'actual unchanged native REQUIRED/wait policy differs')
        if self.last_lease_phase=='arrived':b.check(stage=='O','arrived proof requires exact successful candidate')
        b.check(native.get('activated')==json.loads(b.read_bounded(self.directory/'activated.json',1024**2)),'fresh native activated record differs')
        self.last=stage
        observation={'policy':POLICY,'stage':stage,'native':native,'independentSourceContentProof':source,
                     'currentSha256':sha(raw[0]),'lastOkSha256':sha(raw[1]),'observedAt':datetime.now(timezone.utc).isoformat(),
                     'leasePhase':self.last_lease_phase,'timing':{'elapsedSeconds':time.monotonic()-started,'nativeStatusAttempts':attempts},'journeyVerified':False,'releaseAuthorized':False}
        self.check_authority()
        self.transitions.append(observation)
        b.write_new(self.operation/('ci-runtime-observation-%03d.json'%len(self.transitions)),self.fmt.canonical(observation),0o400)
        return observation

    def receipt(self):
        return {'mode':'activate-ci-runtime','policy':POLICY,'authorizationSha256':sha(self.bytes),
                'installationAuthorizationSha256':self.auth['grantSha256'],'firstStageApprovalSha256':self.auth['firstStageApprovalSha256'],'installId':self.auth['install']['id'],
                'transitionStages':[row['stage'] for row in self.transitions],
                'leasePhases':[row['leasePhase'] for row in self.transitions],
                'transitionSha256':sha(self.fmt.canonical(self.transitions)), 'nativeRuntimeVerified':True,
                'fullSourceContentInventoryVerified':True,'journeyVerified':False}
