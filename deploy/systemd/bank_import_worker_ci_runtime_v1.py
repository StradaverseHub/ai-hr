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


def source_inventory(base, root, filters):
    """Complete included set, content, links and modes, including untracked canonical extras. Never follows links."""
    base.check(filters and '.next' in filters and 'node_modules' in filters, 'canonical source filters required')
    for p in filters:
        base.check(isinstance(p, str) and not any(x in p for x in ('**', '?', '[')), 'unsupported canonical source filter')
    rows = []
    def walk(path, relative):
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
                  'sourceManifest','sourceManifestSha256','priorLastOkSha256','launch','releaseAuthorized'}
        base.check(set(a) == fields and a['format'] == 1 and a['kind'] == 'ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER' and
                   a['policy'] == POLICY and a['target'] == 'alpha-staging' and a['releaseAuthorized'] is False,
                   'exact administrator CI cutover authority required')
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
        base.check(str(self.directory) == i['directory'] and re.fullmatch('[a-f0-9-]{36}', i['id']) and
                   re.fullmatch('[a-f0-9-]{36}', i['buildRecordId']), 'canonical exact installation IDs required')
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
        self.last, self.transitions = None, []
        self.check_authority()

    def check_authority(self):
        b, a = self.base, self.auth
        b.check(protected_private(b,self.path)==self.auth_identity,'administrator authority inode changed')
        b.check(protected_private(b,Path(a['leaseFile']))==self.lease_identity and sha(b.read_bounded(Path(a['leaseFile']),4096))==a['leaseFileSha256'],'held lease credential identity/content changed')
        b.check(b.read_bounded(self.path,65536) == self.bytes, 'CI cutover authority changed')
        b.check(epoch(a['issuedAt']) <= time.time() < epoch(a['expiresAt']) <= epoch(a['issuedAt']) + 900,
                'finite administrator operation authority expired or not yet valid')
        private_install(b,self.directory.parent,self.owner.pw_uid,True)
        st = private_install(b,self.directory,self.owner.pw_uid,True)
        private_install(b,self.directory/'packet',self.owner.pw_uid,True)
        b.check(not (self.directory/'cleanup-authorized.json').exists() and not (self.directory/'cleanup-authorized.json').is_symlink(),'conditional runtime cannot reuse a cleaned/arrived installation')
        b.check((st.st_dev,st.st_ino) == (a['install']['device'],a['install']['inode']), 'private installation directory identity changed')
        for name,key in [('authorization.json','grantSha256'),('activated.json','activatedSha256'),('runtime.json','runtimeSha256')]:
            private_install(b,self.directory/name,self.owner.pw_uid)
            b.check(sha(b.read_bounded(self.directory/name,1024**2)) == a[key], 'original native installation record differs: '+name)
        self.grant = g = json.loads(b.read_bounded(self.directory/'authorization.json',32768))
        i=a['install']
        grant_fields={'format','kind','policyVersion','target','installId','source','controller','controllerBranch','baseline','baselineBuildId','environmentSha256','runId','runAttempt','runCreatedAt','issuedAt','expiresAt','producerStartedAt','producerCompletedAt','witnessFingerprint','artifact','build'}
        build_fields={'format','capacityProfile','nextBuildId','buildRecordId','buildSourcePath','runtime','provenanceSha256','archiveSha256','archiveBytes','manifestSha256','preparedSha256','successfulObservationSha256','lockSha256','packageSha256'}
        b.check(set(g)==grant_fields and set(g.get('build',{}))==build_fields and set(g.get('artifact',{}))=={'digest','id'},'closed original CI grant selection shape required; native status owns full validation')
        b.check(set(a['launch'])=={'current','processStartTicks','cmdlineSha256'} and set(a['launch']['current'])=={'ref','pid','log','started_at','phase','build_id','built_at'},'closed original launch identity required')
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
        b.check(held.get('releaseAuthorized') is False and all(held.get(k)==a['lease'][k] for k in a['lease']) and held.get('phase')=='installing',
                'same live installing lease required')

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
        actual=source_inventory(b,SOURCE,m['filters'])
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

    def observe(self):
        self.check_authority()
        source=self.source_proof()
        before,_=self.snapshot()
        i=self.auth['install']
        # Exact canonical stagingInstallerCommand('status',...) argv, as the actual installation owner, no shell.
        native=child([str(self.base.NODE),'--env-file=.env.production','--import','tsx','.github/ci/staging-build-install.mjs',
                      'status',self.args.source,i['id'],i['buildRecordId']],self.owner,self.environment,
                     timeout=max(1,min(600,epoch(self.auth['expiresAt'])-time.time())))
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
                runtime.get('releaseAuthorized') is False and runtime.get('migrationLedger')==a['ledger'] and
                isinstance(runtime.get('compiledByteInventory'),dict) and runtime['compiledByteInventory'].get('format')==2,
                'fresh authenticated native CI runtime/compiled/full-ledger proof differs')
        original_runtime=json.loads(b.read_bounded(self.directory/'runtime.json',1024**2))
        b.check({k:v for k,v in runtime.items() if k!='verifiedAt'}=={k:v for k,v in original_runtime.items() if k!='verifiedAt'},'original authenticated active-service runtime identity changed')
        b.check(native.get('activated')==json.loads(b.read_bounded(self.directory/'activated.json',1024**2)),'fresh native activated record differs')
        self.last=stage
        observation={'policy':POLICY,'stage':stage,'native':native,'independentSourceContentProof':source,
                     'currentSha256':sha(raw[0]),'lastOkSha256':sha(raw[1]),'observedAt':datetime.now(timezone.utc).isoformat(),
                     'journeyVerified':False,'releaseAuthorized':False}
        self.transitions.append(observation)
        b.write_new(self.operation/('ci-runtime-observation-%03d.json'%len(self.transitions)),self.fmt.canonical(observation),0o400)
        return observation

    def receipt(self):
        return {'mode':'activate-ci-runtime','policy':POLICY,'authorizationSha256':sha(self.bytes),
                'installationAuthorizationSha256':self.auth['grantSha256'],'installId':self.auth['install']['id'],
                'transitionStages':[row['stage'] for row in self.transitions],
                'transitionSha256':sha(self.fmt.canonical(self.transitions)), 'nativeRuntimeVerified':True,
                'fullSourceContentInventoryVerified':True,'journeyVerified':False}
