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
import shutil
import signal
import stat
import subprocess
import sys
import time

POLICY = 'aihr-worker-ci-runtime/v2'
SOURCE = Path('/opt/ai-hr')
STATE = Path('/var/tmp/aihr-deploy')
COORDINATOR = STATE / 'staging-release-queue/coordinator.py'
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')
PROCESS_ROOT = Path('/proc')
RUNTIME_ROOT = Path('/opt/node22')
MAX_MANIFEST = 32 * 1024**2
LOADER_PROBE = r"""import{openSync,readFileSync,fstatSync,lstatSync,closeSync,constants}from'node:fs';import{parseEnv}from'node:util';import{createHash}from'node:crypto';import assert from'node:assert/strict';const name='.env.production',fd=openSync(name,constants.O_RDONLY|constants.O_NOFOLLOW),identity=s=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String);try{const before=fstatSync(fd,{bigint:true});assert(before.isFile()&&before.nlink===1n&&before.size<=1048576n);const raw=readFileSync(fd);assert(JSON.stringify(identity(before))===JSON.stringify(identity(fstatSync(fd,{bigint:true})))&&JSON.stringify(identity(before))===JSON.stringify(identity(lstatSync(name,{bigint:true}))));const active=parseEnv(raw.toString('utf8')),keys=Object.keys(active).sort();const forbidden=k=>/^(?:LD_|DYLD_|PYTHON)/.test(k)||['NODE_PATH','NODE_V8_COVERAGE','NODE_COMPILE_CACHE','NODE_REDIRECT_WARNINGS','NODE_ICU_DATA','NODE_EXTRA_CA_CERTS','NODE_REPL_EXTERNAL_MODULE','OPENSSL_CONF','OPENSSL_MODULES'].includes(k);const tsx={disabledValueSafe:active.TSX_DISABLE_CACHE===undefined||active.TSX_DISABLE_CACHE==='1',disablePresent:Object.hasOwn(active,'TSX_DISABLE_CACHE'),tsconfigPathAbsent:!Object.hasOwn(active,'TSX_TSCONFIG_PATH')};const options=active.NODE_OPTIONS,match=options===undefined?null:/^--max[-_]old[-_]space[-_]size=(\d+)$/.exec(options),memoryOnly=options===undefined||(match!==null&&Number(match[1])>=128&&Number(match[1])<=65536),nodeOptions={policy:'aihr-worker-node-options-memory/v1',present:options!==undefined,memoryOnly,sha256:createHash('sha256').update(options??'').digest('hex')};process.stdout.write(JSON.stringify({format:1,kind:'ACTIVE_NODE_DOTENV_LOADER_KEYS_V2',keys,safe:keys.every(k=>!forbidden(k))&&memoryOnly&&tsx.disabledValueSafe&&tsx.tsconfigPathAbsent,caPresent:keys.includes('NODE_EXTRA_CA_CERTS'),nodeOptions,tsx,sha256:createHash('sha256').update(raw).digest('hex')}));}finally{closeSync(fd)}"""


ACTIVE_OPERATION_GUARD = None
FENCES = None  # Injected reviewed, root-pinned metadata primitive; never a source import.
SLOT_DEADLINE = None
ACTIVATION_FIELDS = {'format','kind','policy','target','issuedAt','expiresAt','identity','drainSha256','helperSha256','nodeSha256','python','nodeOptions','install','grantSha256','activatedSha256','runtimeSha256','environmentSha256','dotenvSha256','ledger','bootIdSha256','webPid','webStartedMonotonicUs','lease','leaseFile','leaseFileSha256','coordinatorSha256','sourceManifest','sourceManifestSha256','priorLastOkSha256','launch','releaseAuthorized','firstStageApproval','firstStageApprovalSha256','readiness','operationsLock'}
FIRST_APPROVAL_FIELDS = {'format','kind','policy','target','issuedAt','expiresAt','identity','helperSha256','nodeSha256','python','nodeOptions','lease','leaseFile','leaseFileSha256','coordinatorSha256','sourceManifestSha256','environmentSha256','dotenvSha256','readiness','gate','releaseAuthorized','operationsLock'}


def require_operation_guard(base):
    base.check(ACTIVE_OPERATION_GUARD is not None and ACTIVE_OPERATION_GUARD.stage in ('activate-ci-runtime','activate-prepared-ci-runtime','recover-ci-runtime','recover-published-ci-runtime'),'fixed root guarded activation invocation required')
    ACTIVE_OPERATION_GUARD.verify()
    return ACTIVE_OPERATION_GUARD


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class SimpleCheck:
    @staticmethod
    def check(ok,message):
        if not ok:raise ValueError('CI runtime cutover refused: '+message)


def verify_node_options_pins(base,pins):
    base.check(isinstance(pins,dict) and set(pins)=={'policy','sha256'} and pins['policy']=='aihr-worker-node-options-memory/v1' and isinstance(pins['sha256'],str) and re.fullmatch('[a-f0-9]{64}',pins['sha256']),'closed independently pinned Node memory-options policy required')


def verify_python(base,pins):
    """Root Python inspects only trusted executable bytes/paths; no application imports."""
    base.check(set(pins)=={'path','sha256','version'} and re.fullmatch(r'/usr/bin/python3\.[0-9]+',pins['path']) and re.fullmatch('[a-f0-9]{64}',pins['sha256']) and re.fullmatch(r'3\.[0-9]+\.[0-9]+',pins['version']),'closed root-pinned Python runtime required')
    base.check(tuple(map(int,pins['version'].split('.'))) >= (3,11,0),'Python safe_path runtime >=3.11 required')
    path=Path(pins['path']);base.root_protected(path,regular=True)
    base.check(Path('/usr/bin/python3').resolve(strict=True)==path and Path(shutil.which('python3',path='/opt/node22/bin:/usr/bin:/bin')).resolve(strict=True)==path,'fixed native Python resolution differs')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        before=os.fstat(fd);digest=hashlib.sha256();total=0
        while True:
            chunk=os.read(fd,1024**2)
            if not chunk:break
            total+=len(chunk);base.check(total<=128*1024**2,'bounded pinned Python required');digest.update(chunk)
        identity=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        base.check(identity(before)==identity(os.fstat(fd))==identity(path.lstat()) and digest.hexdigest()==pins['sha256'],'root-pinned Python bytes/identity changed')
    finally:os.close(fd)


def assert_python_runtime(base,owner,environment,pins):
    verify_python(base,pins)
    result=child([pins['path'],'-c',"import json,sys;print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'safePath':sys.flags.safe_path,'noUserSite':sys.flags.no_user_site}))"],owner,environment,timeout=15)
    base.check(result=={'version':pins['version'],'safePath':True,'noUserSite':1},'actual Python version/safe_path/user-site policy differs')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def bounded_file_sha256(base,path,limit):
    """Fresh complete bytes on EVERY call, with bounded memory and stable no-follow identity.

    Runtime verification must not allocate two copies of the 120MB executable at
    each nested guard boundary. This is not a cache or a metadata-only byte proof.
    """
    identity=lambda s:tuple(getattr(s,k)for k in('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns'))
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        before=os.fstat(fd)
        base.check(stat.S_ISREG(before.st_mode)and before.st_nlink==1 and before.st_size<=limit,'bounded non-linked runtime input required')
        base.check(identity(before)==identity(Path(path).lstat()),'runtime named/opened identity differs')
        digest=hashlib.sha256();total=0
        while True:
            base.check(SLOT_DEADLINE is None or time.monotonic()<SLOT_DEADLINE,'aggregate proof slot expired')
            block=os.read(fd,1024**2)
            if not block:break
            total+=len(block);base.check(total<=limit,'runtime input exceeds bound');digest.update(block)
        base.check(total==before.st_size and identity(before)==identity(os.fstat(fd))==identity(Path(path).lstat()),'runtime bytes or named identity changed during fresh hash')
        base.check(SLOT_DEADLINE is None or time.monotonic()<SLOT_DEADLINE,'aggregate proof slot expired')
        return digest.hexdigest()
    finally:os.close(fd)


def epoch(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


READINESS_PROBE = "process.stdout.write(JSON.stringify({kind:'CI_WORKER_READINESS_POLICY_V1',required:process.env.AIHR_IMPORT_WORKER_REQUIRED??null,waitSeconds:process.env.AIHR_IMPORT_WORKER_WAIT_SECONDS??null}))"
FAST_PROBE = """import assert from 'node:assert/strict';import{execFileSync}from'node:child_process';import{readFileSync}from'node:fs';import{fingerprintStagingEnvironment}from'./.github/ci/staging-environment.mjs';import{collectMigrationLedger}from'./.github/ci/staging-migration-ledger.mjs';import{validateInstallGrant}from'./.github/ci/ci-install-grant.mjs';
const directory=process.argv[1],grant=JSON.parse(readFileSync(directory+'/authorization.json'));validateInstallGrant(grant);const show=key=>execFileSync('/usr/bin/systemctl',['show','aihr','--property='+key,'--value'],{encoding:'utf8',timeout:3000}).trim();
const pid=show('MainPID'),started=show('ExecMainStartTimestampMonotonic');assert(show('ActiveState')==='active');const port=process.env.PORT??'3000';assert(/^[1-9][0-9]{0,4}$/.test(port)&&Number(port)<=65535);const response=await fetch('http://127.0.0.1:'+port+'/health',{redirect:'manual',signal:AbortSignal.timeout(3000)});assert(response.status===200);await response.body?.cancel();
const result={kind:'CI_WORKER_COMPLETE_FENCE_V2',pid,startedMonotonicUs:Number(started),bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8'),build:readFileSync('.next/BUILD_ID','utf8').trim(),environmentSha256:fingerprintStagingEnvironment('/opt/ai-hr'),migrationLedger:collectMigrationLedger('/opt/ai-hr'),healthStatus:200,readiness:{required:process.env.AIHR_IMPORT_WORKER_REQUIRED??null,waitSeconds:process.env.AIHR_IMPORT_WORKER_WAIT_SECONDS??null}};assert(show('MainPID')===pid&&show('ExecMainStartTimestampMonotonic')===started&&show('ActiveState')==='active');process.stdout.write(JSON.stringify(result));"""
LEDGER_FIELDS = {'format','kind','rows','expectedSha256','actualSha256','releaseAuthorized'}


class NativePublicationPending(ValueError):
    """Only a new known native wx/write/fsync publication; never an audit-byte outcome."""


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


def source_excluder(filters):
    """Compile the same closed canonical grammar once per complete observation."""
    patterns=tuple((p.startswith('/'),re.compile(re.escape(p.strip('/')).replace(r'\*','[^/]*')))for p in filters)
    def matches(path):
        basename=path.rsplit('/',1)[-1]
        return any(pattern.fullmatch(path if anchored else basename)is not None for anchored,pattern in patterns)
    return matches


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
    """Canonical complete bytes, exact set, modes and links, through held no-follow descriptors."""
    base.check(filters and '.next' in filters and 'node_modules' in filters, 'canonical source filters required')
    for pattern in filters:
        base.check(isinstance(pattern,str) and not any(x in pattern for x in ('**','?','[')),'unsupported canonical source filter')
    exclude_source=source_excluder(filters)
    root=Path(root);base.check(root.resolve(strict=True)==root,'canonical source root required')
    rows=[]
    def clock():base.check(deadline is None or time.time()<deadline,'source inventory operation deadline exceeded')
    def identity(info):return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
    def walk(fd,relative):
        clock();before=os.fstat(fd);base.check(stat.S_ISDIR(before.st_mode),'source directory descriptor required')
        rows.append({'path':relative,'kind':'directory','mode':stat.S_IMODE(before.st_mode)})
        names=sorted(os.listdir(fd))
        for name in names:
            clock();base.check(len(rows)<200000,'source inventory exceeds bound')
            child=relative+'/'+name if relative else name
            if exclude_source(child):continue
            initial=os.stat(name,dir_fd=fd,follow_symlinks=False);mode=stat.S_IMODE(initial.st_mode)
            if stat.S_ISDIR(initial.st_mode):
                opened=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                try:
                    base.check(identity(initial)==identity(os.fstat(opened)),'source directory changed while opening')
                    walk(opened,child)
                    base.check(identity(initial)==identity(os.fstat(opened))==identity(os.stat(name,dir_fd=fd,follow_symlinks=False)),'source directory changed during content proof')
                finally:os.close(opened)
            elif stat.S_ISREG(initial.st_mode):
                base.check(initial.st_nlink==1 and initial.st_size<=256*1024**2,'bounded non-linked source file required')
                opened=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
                try:
                    base.check(identity(initial)==identity(os.fstat(opened)),'source file changed while opening')
                    digest=hashlib.sha256();total=0
                    while True:
                        clock();chunk=os.read(opened,1024**2)
                        if not chunk:break
                        total+=len(chunk);base.check(total<=256*1024**2,'source file exceeds bound');digest.update(chunk)
                    base.check(total==initial.st_size and identity(initial)==identity(os.fstat(opened))==identity(os.stat(name,dir_fd=fd,follow_symlinks=False)),'source file changed during content proof')
                    rows.append({'path':child,'kind':'file','mode':mode,'sha256':digest.hexdigest()})
                finally:os.close(opened)
            elif stat.S_ISLNK(initial.st_mode):
                target=os.readlink(name,dir_fd=fd);resolved=(root/child).resolve(strict=True)
                base.check(not os.path.isabs(target) and resolved!=root and resolved.is_relative_to(root),'source link escapes frozen tree')
                rows.append({'path':child,'kind':'link','mode':mode,'target':target})
                base.check(identity(initial)==identity(os.stat(name,dir_fd=fd,follow_symlinks=False)),'source link changed during content proof')
            else:base.check(False,'source inventory contains a special node')
        base.check(names==sorted(os.listdir(fd)) and identity(before)==identity(os.fstat(fd)),'source directory changed during complete enumeration')
    opened=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        before=os.fstat(opened);walk(opened,'')
        base.check(identity(before)==identity(os.fstat(opened))==identity(root.lstat()),'source root named/descriptor identity changed')
    finally:os.close(opened)
    return rows


def private_install(base, path, uid, directory=False, build=False):
    path = Path(path)
    base.check(path.is_absolute() and path.resolve() == path, 'canonical private installation path required')
    info = path.lstat()
    base.check(info.st_uid == uid and not stat.S_ISLNK(info.st_mode), 'private installation owner changed')
    base.check(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) in ({0o700,0o755} if build else {0o700}) if directory else
               stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and not info.st_mode & 0o077, 'private installation protection differs')
    return info


MAX_NATIVE_STDOUT = 32 * 1024**2
MAX_NATIVE_STDERR = 64 * 1024


class NativeProofFailure(ValueError):
    """Only fixed categories and numeric process metadata may leave the protected runner."""
    def __init__(self,details):
        self.details=details
        super().__init__('CI runtime cutover refused: bounded native owner proof failed; safe details '+json.dumps(details,sort_keys=True,separators=(',',':')))


def bounded_process(argv, **options):
    """Hard streaming bounds and one finite deadline, including silent children. Kill only this new child session.
    Do not reap/poll before failure cleanup: the unreaped child retains its PID, preventing process-group ID reuse.
    """
    supplied=options.pop('input',None)
    timeout=options.pop('timeout',600)
    if not 0<timeout<=600:raise ValueError('CI runtime cutover refused: finite positive native child budget required')
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
    except BaseException as error:
        # Preserve the actual failure branch before cleanup, without publishing
        # argv, environment, input, stdout, stderr, or arbitrary exception text.
        message=error.args[0]if type(error)is ValueError and error.args and type(error.args[0])is str else None
        reason={'native proof deadline exceeded':'DEADLINE','native proof command failed':'CHILD_EXIT'}.get(message,'OTHER')
        if message=='native proof output exceeds hard bound':reason='STDOUT_BOUND'if sizes.get('out',0)>MAX_NATIVE_STDOUT else'STDERR_BOUND'
        if isinstance(error,subprocess.TimeoutExpired):reason='WAIT_TIMEOUT'
        if isinstance(error,(KeyboardInterrupt,SystemExit)):reason='INTERRUPTED'
        before_cleanup=process.returncode
        elapsed_ms=round((time.monotonic()-(deadline-timeout))*1000)
        remaining_ms=round((deadline-time.monotonic())*1000)
        # No shell, no foreign service/unit/PID, and only our unreaped new session is targeted.
        if not reaped:
            try:os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                process.wait(timeout=5)
        details={'reason':reason,'returnCodeBeforeCleanup':before_cleanup,'returnCodeAfterCleanup':process.returncode,
                 'elapsedMs':elapsed_ms,'remainingMs':remaining_ms,'budgetMs':round(timeout*1000),
                 'stdoutBytes':sizes.get('out',0),'stderrBytes':sizes.get('err',0)}
        raise NativeProofFailure(details) from None
    finally:
        streams.close()
        for pipe in (process.stdout,process.stderr):
            if pipe:pipe.close()


def child(argv, identity, environment, *, input=None, timeout=600, operation_fd=None, node_options=None):
    """Fixed caller-owned argv only. Drop all supplementary groups/UID/GID BEFORE exec, never root JS."""
    safe_runtime={'PYTHONNOUSERSITE':'1','PYTHONSAFEPATH':'1','TSX_DISABLE_CACHE':'1'}
    if any(re.fullmatch(r'NODE_OPTIONS|NODE_PATH|NODE_V8_COVERAGE|NODE_COMPILE_CACHE|NODE_REDIRECT_WARNINGS|NODE_ICU_DATA|NODE_EXTRA_CA_CERTS|NODE_REPL_EXTERNAL_MODULE|LD_.*|DYLD_.*|PYTHON.*|OPENSSL_CONF|OPENSSL_MODULES|TSX_TSCONFIG_PATH|TSX_DISABLE_CACHE',key) and not(key in safe_runtime and environment[key]==safe_runtime[key])for key in environment):
        raise ValueError('CI runtime cutover refused: unreviewed controlled loader environment')
    fds=ACTIVE_OPERATION_GUARD.inherited_fds() if ACTIVE_OPERATION_GUARD is not None else (() if operation_fd is None else (operation_fd,))
    # The parser runs the pinned Node as owner with NO dotenv and NO application
    # imports. Its output contains active key names/booleans/hash, never values.
    if '--env-file=.env.production' in argv:
        if node_options is None and ACTIVE_OPERATION_GUARD is not None:node_options=ACTIVE_OPERATION_GUARD.a['nodeOptions']
        if node_options is None:raise ValueError('CI runtime cutover refused: explicit reviewed Node options pin required')
        verify_node_options_pins(SimpleCheck(),node_options)
        end=min(time.monotonic()+timeout,SLOT_DEADLINE) if SLOT_DEADLINE is not None else time.monotonic()+timeout
        raw=(SOURCE/'.env.production').read_bytes()
        parsed=json.loads(bounded_process([argv[0],'--input-type=module','-e',LOADER_PROBE],cwd=str(SOURCE),env=environment,user=identity.pw_uid,group=identity.pw_gid,extra_groups=[],timeout=max(0,end-time.monotonic()),pass_fds=fds))
        keys=parsed.get('keys')
        valid_keys=isinstance(keys,list) and all(isinstance(k,str)for k in keys) and keys==sorted(set(keys)) and not any(re.match(r'^(?:LD_|DYLD_|PYTHON)',k)or k in {'NODE_PATH','NODE_V8_COVERAGE','NODE_COMPILE_CACHE','NODE_REDIRECT_WARNINGS','NODE_ICU_DATA','NODE_EXTRA_CA_CERTS','NODE_REPL_EXTERNAL_MODULE','OPENSSL_CONF','OPENSSL_MODULES'}for k in keys)
        options=parsed.get('nodeOptions',{})
        valid_options=isinstance(options,dict) and set(options)=={'policy','present','memoryOnly','sha256'} and {k:options[k]for k in ('policy','sha256')}==node_options and options['memoryOnly']is True and type(options['present'])is bool and isinstance(keys,list) and options['present']==('NODE_OPTIONS'in keys)
        tsx=parsed.get('tsx',{})
        valid_tsx=isinstance(tsx,dict) and set(tsx)=={'disabledValueSafe','disablePresent','tsconfigPathAbsent'} and tsx['disabledValueSafe']is True and tsx['tsconfigPathAbsent']is True and type(tsx['disablePresent'])is bool and isinstance(keys,list) and tsx['disablePresent']==('TSX_DISABLE_CACHE'in keys) and 'TSX_TSCONFIG_PATH'not in keys
        if set(parsed)!={'format','kind','keys','safe','caPresent','nodeOptions','tsx','sha256'} or parsed['format']!=1 or parsed['kind']!='ACTIVE_NODE_DOTENV_LOADER_KEYS_V2' or not valid_keys or not valid_options or not valid_tsx or parsed['safe']is not True or parsed['caPresent']is not False or parsed['sha256']!=sha(raw) or (SOURCE/'.env.production').read_bytes()!=raw:
            raise ValueError('CI runtime cutover refused: active dotenv loader input is outside reviewed coverage')
        timeout=min(timeout,end-time.monotonic())
    environment={**environment,**safe_runtime}
    if SLOT_DEADLINE is not None:timeout=min(timeout,SLOT_DEADLINE-time.monotonic())
    if timeout<=0:raise ValueError('CI runtime cutover refused: aggregate proof slot expired')
    raw=bounded_process(argv,cwd=str(SOURCE),env=environment,user=identity.pw_uid,group=identity.pw_gid,
                        extra_groups=[],input=input,timeout=timeout,pass_fds=fds)
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


def worker_identity(base,report,source):
    """Independent actual UID/cgroup/source/PID-start identity, never a PID number alone."""
    base.check(report.get('ActiveState')=='active' and report.get('SubState')=='running' and report.get('NRestarts')=='0','owned worker is not the original running process')
    pid=report.get('MainPID','');base.check(re.fullmatch('[1-9][0-9]*',pid),'owned worker PID required')
    owner=pwd.getpwnam(base.USER);process=PROCESS_ROOT/pid
    base.check(process.stat().st_uid==owner.pw_uid and (process/'cwd').resolve()==base.ROOT/'releases'/source,'owned worker UID/source differs')
    base.check(base.read_bounded(process/'cmdline',65536).split(b'\0')[:-1]==[str(base.NODE).encode(),b'--import',b'tsx',b'scripts/bank-import-runner.ts'],'owned worker executable/argv differs')
    status=base.read_bounded(process/'status',65536).decode()
    ids=next((line.split()[1:]for line in status.splitlines()if line.startswith('Uid:')),[])
    base.check(ids and all(value==str(owner.pw_uid)for value in ids),'owned worker effective/saved/fs UID differs')
    group=base.command(['/usr/bin/systemctl','show','aihr-bank-import.service','--property=ControlGroup','--value']).stdout.strip()
    memberships=[line.split(':',2)[-1]for line in base.read_bounded(process/'cgroup',65536).decode().splitlines()]
    base.check(group.endswith('/aihr-bank-import.service') and group in memberships,'owned worker cgroup differs')
    start=base.read_bounded(process/'stat',65536).decode().rsplit(')',1)[1].split()[19]
    base.check(re.fullmatch('[1-9][0-9]*',start),'owned worker process start identity unavailable')
    return {'pid':pid,'startTicks':start,'uid':owner.pw_uid,'source':source,'cgroup':group}


class RuntimeObservation:
    def __init__(self, base, fmt, args, operation, drain_bytes, *, recovery=None, prepared=None):
        self.recovery=recovery
        self.prepared=prepared
        self.overall_deadline=getattr(base,'RECOVERY_OVERALL_DEADLINE',None) if recovery is not None or prepared is not None else None
        self.drain_operation=Path(recovery['originalOperation']) if recovery is not None else operation
        self.base, self.fmt, self.args, self.operation = base, fmt, args, operation
        self.path = Path(args.ci_runtime_authorization)
        self.auth_identity=protected_private(base,self.path)
        self.bytes = base.read_bounded(self.path, 65536)
        base.check(sha(self.bytes) == args.ci_runtime_authorization_sha256, 'root CI cutover authorization hash differs')
        a = self.auth = json.loads(self.bytes)
        fields = ACTIVATION_FIELDS if prepared is None else RECOVERY.NORMAL_FIELDS if recovery is None else RECOVERY.FIELDS
        published=getattr(ACTIVE_OPERATION_GUARD,'stage',None)=='recover-published-ci-runtime'
        if published:fields=PUBLISHED.LIVE_FIELDS
        kind=PUBLISHED.KINDS[ACTIVE_OPERATION_GUARD.stage]if published else 'ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER' if prepared is None else RECOVERY.KINDS[ACTIVE_OPERATION_GUARD.stage]
        base.check(set(a) == fields and a['format'] == 1 and a['kind'] == kind and
                   a['policy'] == POLICY and a['target'] == 'alpha-staging' and a['releaseAuthorized'] is False,
                   'exact administrator CI cutover authority required')
        base.check((prepared is None or a.get('preparedWorker')==prepared) and (recovery is None or a.get('recovery')==recovery),'explicit prepared/recovery selection differs')
        self.guard=require_operation_guard(base)
        base.check(self.guard.path==self.path and self.guard.bytes==self.bytes and self.guard.a['operationsLock']==a['operationsLock'],'exact guarded activation approval required')
        self.guard.observer=self
        if recovery is not None:self.ci=self.guard.ci
        self.start_intent=None;self.started_identity=None;self.started_sha=None;self.start_capture_pending=False
        self.first_path=Path(a['firstStageApproval'])
        self.first_identity=protected_private(base,self.first_path)
        self.first_bytes=base.read_bounded(self.first_path,65536)
        base.check(sha(self.first_bytes)==a['firstStageApprovalSha256'],'pre-drain administrator approval hash differs')
        base.check(a['drainSha256'] == sha(drain_bytes) and a['identity'] == json.loads(drain_bytes)['identity'], 'authorization and original drain identity differ')
        base.check(a['identity']['source'] == args.source and a['identity']['build_id'] == args.build_id, 'authorization candidate differs')
        base.root_protected(Path(sys.argv[0]), regular=True)
        base.check(sha(base.read_bounded(Path(sys.argv[0]), 16*1024**2)) == a['helperSha256'] and
                   bounded_file_sha256(base,base.NODE,128*1024**2) == a['nodeSha256'], 'root-pinned helper/runtime differs')
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
        self.slot_name=None;self.fence_count=0;self.audits=[];self.content_proofs=[];self.metadata=None;self.private_seen={};self.cleaned=set()
        self.check_authority()

    def slot(self,name,seconds):
        """One absolute deadline shared by every subprocess in a stage; never reset per child."""
        global SLOT_DEADLINE
        self.check_slot()
        remaining=min(epoch(self.auth['expiresAt']),epoch(self.grant['expiresAt']) if self.recovery is None else epoch(self.auth['expiresAt']))-time.time()
        self.base.check(remaining>0,'success authority expired before stage')
        self.slot_name=name;SLOT_DEADLINE=min(time.monotonic()+min(seconds,remaining),self.overall_deadline if self.overall_deadline is not None else float('inf'))
        self.base.VERIFIED_OPERATION_DEADLINE=SLOT_DEADLINE

    def check_slot(self):
        self.base.check(SLOT_DEADLINE is None or time.monotonic()<SLOT_DEADLINE,'aggregate cutover stage deadline exceeded')

    def failure_deadline(self,seconds):
        # Failure-only exact-owned-process quarantine is separately bounded. This
        # resets no success slot and confers no activation/receipt/arrival authority.
        global SLOT_DEADLINE
        SLOT_DEADLINE=time.monotonic()+seconds
        self.base.VERIFIED_OPERATION_DEADLINE=SLOT_DEADLINE

    def failure_summary(self,error):
        """Snapshot before failure-only clocks change; never serialize arbitrary exception data."""
        stages={'M0','M1','S0','S1','A0','A1','receipt',*[f'F{i}'for i in range(10)],*[f'W/F{i}'for i in range(1,4)]}
        result={'slot':self.slot_name if self.slot_name in stages else 'OTHER','category':'OTHER',
                'stageRemainingMs':None if SLOT_DEADLINE is None else round((SLOT_DEADLINE-time.monotonic())*1000)}
        if type(error)is NativeProofFailure:
            details=error.details
            reasons={'DEADLINE','CHILD_EXIT','STDOUT_BOUND','STDERR_BOUND','WAIT_TIMEOUT','INTERRUPTED','OTHER'}
            numbers={'returnCodeBeforeCleanup','returnCodeAfterCleanup','elapsedMs','remainingMs','budgetMs','stdoutBytes','stderrBytes'}
            if (type(details)is dict and set(details)==numbers|{'reason'} and details['reason']in reasons and
                    all(details[k]is None or type(details[k])is int for k in numbers)):
                result.update(category='NATIVE_PROOF',native=dict(details))
        elif type(error)is ValueError and error.args==('Worker installation refused: aggregate cutover stage deadline exceeded',):
            result['category']='STAGE_DEADLINE'
        return result

    def check_authority(self):
        b, a = self.base, self.auth
        self.guard.verify_install()
        b.check(protected_private(b,self.path)==self.auth_identity,'administrator authority inode changed')
        b.check(protected_private(b,Path(a['leaseFile']))==self.lease_identity and sha(b.read_bounded(Path(a['leaseFile']),4096))==a['leaseFileSha256'],'held lease credential identity/content changed')
        b.check(b.read_bounded(self.path,65536) == self.bytes, 'CI cutover authority changed')
        b.root_protected(Path(sys.argv[0]),regular=True);b.root_protected(b.NODE,regular=True)
        b.check(sha(b.read_bounded(Path(sys.argv[0]),16*1024**2))==a['helperSha256'] and bounded_file_sha256(b,b.NODE,128*1024**2)==a['nodeSha256'],'root-pinned helper/runtime changed')
        b.root_protected(self.drain_operation/'drained.json',regular=True)
        b.check(sha(b.read_bounded(self.drain_operation/'drained.json',65536))==a['drainSha256'],'original protected drain record changed')
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
        first_fields=FIRST_APPROVAL_FIELDS
        gate_fields={'source','controller','runId','build','artifact','witnessFingerprint','policyVersion'}
        b.check(set(first)==first_fields and first['format']==1 and first['kind']=='ADMIN_REVIEWED_CI_WORKER_DRAIN_PINS' and first['policy']==POLICY and first['target']=='alpha-staging' and first['releaseAuthorized'] is False and set(first['gate'])==gate_fields,'closed pre-drain administrator approval required')
        b.check(all(first[k]==a[k] for k in ('identity',*(() if self.recovery is not None else ('helperSha256',)),'nodeSha256','python','nodeOptions','lease','leaseFileSha256','sourceManifestSha256','environmentSha256','dotenvSha256','readiness','operationsLock','leaseFile','coordinatorSha256')),'pre-drain and activation administrator shared pins differ')
        drain_time=(self.drain_operation/'drained.json').stat().st_mtime
        b.check(epoch(first['issuedAt'])<=drain_time<=epoch(first['expiresAt']) and drain_time<=epoch(a['issuedAt']),'pre-drain approval was not valid when original drain completed or activation approval predates drain')
        i=a['install']
        grant_fields={'format','kind','policyVersion','target','installId','source','controller','controllerBranch','baseline','baselineBuildId','environmentSha256','runId','runAttempt','runCreatedAt','issuedAt','expiresAt','producerStartedAt','producerCompletedAt','witnessFingerprint','artifact','build'}
        build_fields={'format','capacityProfile','nextBuildId','buildRecordId','buildSourcePath','runtime','provenanceSha256','archiveSha256','archiveBytes','manifestSha256','preparedSha256','successfulObservationSha256','lockSha256','packageSha256'}
        b.check(set(g)==grant_fields and set(g.get('build',{}))==build_fields and set(g.get('artifact',{}))=={'digest','id'},'closed original CI grant selection shape required; native status owns full validation')
        b.check(first['gate']=={k:g[k] for k in gate_fields},'later CI grant differs from the original pre-drain full-gate/build provenance tuple')
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
        if self.recovery is None:
            b.check(time.time() < epoch(g['expiresAt']) and epoch(a['expiresAt']) <= epoch(g['expiresAt']), 'original CI grant expired or operation exceeds it')
        else:RECOVERY.check_history(self)
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
        b.check(time.time()<min(epoch(a['expiresAt']),epoch(g['expiresAt']) if self.recovery is None else epoch(a['expiresAt'])),'operation or original grant expired during authority proof')

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
        deadline=min(epoch(a['expiresAt']),time.time()+max(0,SLOT_DEADLINE-time.monotonic())) if SLOT_DEADLINE is not None else epoch(a['expiresAt'])
        actual=source_inventory(b,SOURCE,m['filters'],deadline=deadline)
        b.check(actual==m['entries'],'canonical full source content/link/mode/set differs')
        return {'manifestSha256':a['sourceManifestSha256'],'includedNodes':len(actual),'fullSourceChecksumVerified':True}

    def content_audit(self):
        self.base.check(len(self.content_proofs)<2,'exactly two source content slots permitted')
        self.slot('S'+str(len(self.content_proofs)),60)
        self.check_authority();proof=self.source_proof();self.check_slot()
        self.content_proofs.append(proof)

    def private_fence(self):
        """Original bytes stay immutable; only exact native cleanup publications/removals progress."""
        b=self.base;uid=self.owner.pw_uid
        initial_root=FENCES.metadata(private_install(b,self.directory,uid,True))
        original={'authorization.json','store.json','verified.json','activated.json','runtime.json','activate-intent.json','activate-result.json'}
        allowed={'audit','normal-cleanup.lock','normal-cleanup-ready.json','normal-cleanup-commit.json','normal-cleanup-consumed.json','cleanup-authorized.json','cleanup-intent.json','cleanup-result.json','normal-cleanup-owned-cleanup.json'}
        names=set(os.listdir(self.directory));b.check(names<=original|allowed|{'packet','next'} and original<=names,'unknown/missing private installation member')
        previous=getattr(self,'private_names',None)
        records={};audit_directories={};intent_valid=False;packet_bytes={}
        audit_members={'system-testing.json':'preparedSha256','successful-build.json':'successfulObservationSha256','build-provenance.json':'provenanceSha256','bytes/build-bundle-files.json':'manifestSha256'}
        def audit_directory(path):
            st=private_install(b,path,uid,True);key=str(path.relative_to(self.directory));members=set(os.listdir(path));metadata=FENCES.metadata(st)
            prior=getattr(self,'private_audit_directories',{}).get(key)
            if prior is not None:
                b.check(all(prior['metadata'][k]==metadata[k]for k in ('device','inode','mode','uid','gid')),'retained audit directory identity/mode changed')
            audit_directories[key]={'metadata':metadata,'members':sorted(members)}
            return members
        def read(path,bound=MAX_MANIFEST):
            expected=private_install(b,path,uid)
            key=str(path.relative_to(self.directory));new_publication=key not in self.private_seen and (key in allowed-{'audit'} or key.startswith('audit/'))
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
            try:
                before=os.fstat(fd)
                core=('device','inode','mode','uid','gid','nlink')
                b.check(all(FENCES.metadata(expected)[k]==FENCES.metadata(before)[k]for k in core),'private named/opened record identity differs')
                if FENCES.metadata(expected)!=FENCES.metadata(before):
                    if new_publication:pending('new native publication changed while opening',publication=True)
                    b.check(False,'private named/opened record identity differs')
                chunks=[];total=0
                while True:
                    self.check_slot();chunk=os.read(fd,min(65536,bound+1-total))
                    if not chunk:break
                    chunks.append(chunk);total+=len(chunk);b.check(total<=bound,'private record exceeds bound')
                raw=b''.join(chunks);after=os.fstat(fd);named=path.lstat()
                b.check(len(raw)<=bound,'private record exceeds bound')
                b.check(all(FENCES.metadata(before)[k]==FENCES.metadata(after)[k]==FENCES.metadata(named)[k]for k in core),'private record identity changed during read')
                is_audit=key.startswith('audit/')or key.startswith('packet/')
                if new_publication and (FENCES.metadata(before)!=FENCES.metadata(after) or FENCES.metadata(after)!=FENCES.metadata(named) or not is_audit and not raw.endswith(b'\n')):
                    pending('known native publication is incomplete',publication=True)
                b.check(FENCES.metadata(before)==FENCES.metadata(after)==FENCES.metadata(named),'private record changed during bounded read')
                item={'sha256':sha(raw),'metadata':FENCES.metadata(after)}
                if is_audit:
                    relative=key.split('/',1)[1];expected_sha=self.grant['build'][audit_members[relative]]
                    if item['sha256']!=expected_sha:
                        prefix=packet_bytes.get(relative)
                        if key.startswith('audit/') and new_publication and prefix is not None and len(raw)<len(prefix) and prefix.startswith(raw):pending('known retained audit prefix publication is incomplete',publication=True)
                        b.check(False,'retained original audit byte integrity failed')
                    if key.startswith('packet/'):packet_bytes[relative]=raw
                b.check(key not in self.private_seen or self.private_seen[key]==item,'immutable original/native cleanup record changed')
                try:value=json.loads(raw)
                except json.JSONDecodeError:
                    raise ValueError('invalid closed native JSON record') from None
                self.private_seen[key]=item;records[key]=item
                return value
            finally:os.close(fd)
        def pending(reason,*,publication=False,removal=False):
            # Typed metadata retry only. Fresh immutable originals, same-install
            # lease and strict native O precede it; no native byte error enters here.
            for name in original:read(self.directory/name)
            self.check_authority();stage,_=self.snapshot();b.check(stage=='O','native metadata transition requires fresh strict O')
            current=set(os.listdir(self.directory))
            b.check(original<=current and current<=original|allowed|{'packet','next'},'unknown/missing private installation member')
            additions=current-names;removals=names-current
            b.check(additions<=allowed,'unexpected private installation addition')
            permitted_removals={'packet','next'}if intent_valid else set()
            if intent_valid and {'cleanup-result.json','normal-cleanup-owned-cleanup.json'}.intersection(current):permitted_removals.add('normal-cleanup.lock')
            b.check(removals<=permitted_removals and (not removal or intent_valid),'native removal lacks validated same-install intent')
            for name in additions:private_install(b,self.directory/name,uid,name=='audit')
            current_root=FENCES.metadata(private_install(b,self.directory,uid,True))
            b.check(all(current_root[k]==initial_root[k]for k in ('device','inode','mode','uid','gid')),'native private directory identity/mode changed')
            b.check(bool(additions or removals or publication or removal),'unclassified private metadata drift')
            raise NativePublicationPending(reason)
        for name in original:read(self.directory/name)
        store=json.loads(b.read_bounded(self.directory/'store.json',4096));activated=json.loads(b.read_bounded(self.directory/'activated.json',1024**2))
        intent=read(self.directory/'activate-intent.json',65536)
        exchange=read(self.directory/'activate-result.json',65536)
        # These immutable records are produced by the native renameat2 owner.
        # They are required originals, never optional cleanup publications.
        common={'format':1,'action':'activate','source':str(SOURCE),'staged':str(self.directory/'next'),'releaseAuthorized':False}
        result={**common,'kind':'BUILD_DIRECTORIES_EXCHANGED_NOT_SERVICE_OR_RELEASE',
                'activeBuildId':self.args.build_id,'retainedBuildId':self.args.previous_web_build,
                'activeDirectory':activated['activation']['activeDirectory'],
                'retainedDirectory':activated['activation']['retainedDirectory'],
                'serviceRestarted':False,'activeServiceVerified':False}
        b.check(exchange==result and activated['activation']==result,'native activation result differs from pinned activated record')
        expected_intent={**common,'kind':'BUILD_DIRECTORY_EXCHANGE_INTENT_NOT_RELEASE',
                         'expectedNewBuildId':self.args.build_id,'expectedOldBuildId':self.args.previous_web_build,
                         'newDirectory':result['activeDirectory'],'oldDirectory':result['retainedDirectory'],
                         'createdUnixNs':intent.get('createdUnixNs')}
        b.check(intent==expected_intent and type(intent['createdUnixNs'])is int and
                epoch(self.grant['issuedAt'])*10**9<=intent['createdUnixNs']<=epoch(self.grant['expiresAt'])*10**9,
                'native activation intent differs from original grant/result')
        for identity in (result['activeDirectory'],result['retainedDirectory']):
            b.check(set(identity)=={'device','inode'} and all(type(v)is int and v>0 for v in identity.values()),'native activation directory identity shape differs')
        b.check(result['activeDirectory']!=result['retainedDirectory'],'native activation directories must be distinct')
        active=private_install(b,SOURCE/'.next',uid,True,build=True)
        b.check(stat.S_IMODE(active.st_mode)==0o755,'native active directory mode differs')
        b.check({'device':active.st_dev,'inode':active.st_ino}==result['activeDirectory'] and
                b.read_bounded(SOURCE/'.next/BUILD_ID',1024).decode().strip()==self.args.build_id,'native active directory/build identity differs')
        if self.prepared is not None:
            pins=self.auth['nativeActivation']
            b.check(set(pins)=={'activate-intent.json','activate-result.json'} and
                    all(re.fullmatch('[a-f0-9]{64}',value)for value in pins.values()) and
                    all(records[name]['sha256']==value for name,value in pins.items()),'administrator-pinned native activation bytes differ')
        missing_cleanup_lock=False
        for name in allowed-{'audit'}:
            if name in names:
                try:read(self.directory/name)
                except FileNotFoundError:
                    if name!='normal-cleanup.lock':raise
                    missing_cleanup_lock=True
        if allowed.intersection(names):
            stage,_=self.snapshot();b.check(stage=='O','normal cleanup only follows genuine successful native finish')
        if 'normal-cleanup.lock'in names and not missing_cleanup_lock:
            lock=json.loads(b.read_bounded(self.directory/'normal-cleanup.lock',4096))
            b.check(set(lock)=={'source','installId','pid'} and lock['source']==self.args.source and lock['installId']==self.grant['installId'] and type(lock['pid'])is int and lock['pid']>0,'unknown native cleanup lock shape')
        if 'normal-cleanup-ready.json'in names:
            ready=json.loads(b.read_bounded(self.directory/'normal-cleanup-ready.json',65536))
            selection={'source':self.args.source,'installId':self.grant['installId'],'buildRecordId':self.auth['install']['buildRecordId'],'nextBuildId':self.args.build_id,'authorizationSha256':self.auth['grantSha256']}
            b.check(set(ready)=={'format','kind','selection','nonce','fencesSha256','readyAt'} and ready['format']==1 and ready['kind']=='NORMAL_VALID_GRANT_CLEANUP_READY' and ready['selection']==selection and all(re.fullmatch('[a-f0-9]{64}',ready[k])for k in ('nonce','fencesSha256')),'exact native cleanup READY required')
            native_timestamp(b,ready['readyAt'],epoch(self.grant['issuedAt']),time.time())
        if 'normal-cleanup-commit.json'in names:
            b.check('normal-cleanup-ready.json'in names,'cleanup commit precedes READY')
            commit=json.loads(b.read_bounded(self.directory/'normal-cleanup-commit.json',65536))
            b.check(set(commit)=={'format','kind','readySha256','nonce','proof'} and commit['format']==1 and commit['kind']=='NORMAL_VALID_GRANT_CLEANUP_COMMIT' and commit['readySha256']==sha(canonical(ready)) and commit['nonce']==ready['nonce'],'exact native cleanup commit required')
            self.validate_cleanup_proof(commit['proof'])
            b.check(epoch(ready['readyAt'])<=epoch(commit['proof']['checkedAt'])<=epoch(ready['readyAt'])+180,'native cleanup READY was stale at commit')
        if 'cleanup-authorized.json'in names:
            b.check('normal-cleanup-commit.json'in names,'cleanup authorization precedes commit')
            self.cleanup_authority()
            authority=json.loads(b.read_bounded(self.directory/'cleanup-authorized.json',65536))
            b.check(authority['sourceProof']==commit['proof'],'native cleanup checksum commit differs')
        if 'normal-cleanup-consumed.json'in names:
            b.check('cleanup-authorized.json'in names,'cleanup consumption precedes authority')
            consumed=json.loads(b.read_bounded(self.directory/'normal-cleanup-consumed.json',65536))
            b.check(consumed=={'kind':'NORMAL_CLEANUP_NONCE_CONSUMED','readySha256':sha(canonical(ready))},'native cleanup nonce differs')
        intent_valid=False
        if 'cleanup-intent.json'in names:
            intent=read(self.directory/'cleanup-intent.json',65536)
            b.check({'cleanup-authorized.json','normal-cleanup-consumed.json'}<=names,'native cleanup intent precedes authority/consumption')
            self.cleanup_authority()
            expected={'format':1,'kind':'OWNED_INSTALL_CLEANUP_INTENT','authoritySha256':sha(b.read_bounded(self.directory/'cleanup-authorized.json',65536)),'directory':store['directory'],'children':['next','packet']}
            b.check(intent==expected,'native cleanup intent differs');intent_valid=True
        if missing_cleanup_lock:pending('validated native cleanup lock release is in progress')
        for folder in ('packet','audit'):
            if folder not in names:continue
            try:
                st=private_install(b,self.directory/folder,uid,True)
            except FileNotFoundError:
                if folder=='packet' and intent_valid:pending('validated native packet directory removal is in progress',removal=True)
                raise
            if folder=='packet':
                b.check({'device':st.st_dev,'inode':st.st_ino}==store['packetDirectory'],'native packet directory changed')
            else:
                audit_names=audit_directory(self.directory/folder);b.check(audit_names<=set(k for k in audit_members if '/'not in k)|{'bytes'},'unknown retained audit member')
                if 'bytes'in audit_names:
                    b.check(audit_directory(self.directory/folder/'bytes')<={'build-bundle-files.json'},'unknown retained audit bytes')
            for name,key in audit_members.items():
                path=self.directory/folder/name
                if folder=='audit' and not path.exists():continue
                try:read(path)
                except FileNotFoundError:
                    if folder=='packet' and intent_valid:pending('native owned packet removal is in progress',removal=True)
                    raise
                b.check(records[folder+'/'+name]['sha256']==self.grant['build'][key],'retained original audit byte integrity failed')
        if 'next'in names:
            try:st=private_install(b,self.directory/'next',uid,True,build=True)
            except FileNotFoundError:
                if intent_valid:pending('validated native retained directory removal is in progress',removal=True)
                raise
            b.check({'device':st.st_dev,'inode':st.st_ino}==activated['activation']['retainedDirectory'],'retained previous build directory changed')
            b.check(b.read_bounded(self.directory/'next/BUILD_ID',1024).decode().strip()==self.args.previous_web_build,'native retained build identity differs')
        if 'cleanup-authorized.json'in names:
            for name in audit_members:b.check('audit/'+name in records,'native cleanup lost retained original audit')
        # FIRST establish a stable final namespace/root observation. Applying old
        # snapshot nlink or monotonic rules before this point races legal cleanup.
        before_final=FENCES.metadata(private_install(b,self.directory,uid,True))
        final_names=set(os.listdir(self.directory))
        root_metadata=FENCES.metadata(private_install(b,self.directory,uid,True))
        final_names_again=set(os.listdir(self.directory))
        final_root=FENCES.metadata(private_install(b,self.directory,uid,True))
        b.check(original<=final_names and final_names<=original|allowed|{'packet','next'} and original<=final_names_again and final_names_again<=original|allowed|{'packet','next'},'unknown/missing private installation member')
        b.check(all(initial_root[k]==before_final[k]==root_metadata[k]==final_root[k]for k in ('device','inode','mode','uid','gid')),'native private directory identity/mode changed')
        if names!=final_names or final_names!=final_names_again or before_final!=root_metadata or root_metadata!=final_root:
            pending('known native membership/root publication changed during fence',publication=bool((final_names_again-(previous or names))&allowed),removal=bool((names-final_names_again)&{'packet','next'}))
        for key,value in audit_directories.items():
            final_members=set(os.listdir(self.directory/key));final_metadata=FENCES.metadata((self.directory/key).lstat())
            b.check(all(value['metadata'][k]==final_metadata[k]for k in ('device','inode','mode','uid','gid')),'retained audit directory identity/mode changed')
            permitted={'bytes','system-testing.json','successful-build.json','build-provenance.json'}if key=='audit' else {'build-bundle-files.json'}
            b.check(final_members<=permitted and set(value['members'])<=final_members,'unknown/backsliding retained audit member')
            if final_members!=set(value['members']) or final_metadata!=value['metadata']:pending('known retained audit publication changed during fence',publication=True)
        absent={'packet','next'}-names
        b.check(not absent or intent_valid,'native owned bytes removed without exact cleanup intent/commit')
        if 'cleanup-result.json'in names or 'normal-cleanup-owned-cleanup.json'in names:
            b.check(absent=={'packet','next'},'native cleanup result precedes complete owned deletion')
            result=json.loads(b.read_bounded(self.directory/('cleanup-result.json'if 'cleanup-result.json'in names else 'normal-cleanup-owned-cleanup.json'),65536))
            expected={'format':1,'kind':'OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED','installId':self.grant['installId'],'authorizationSha256':self.auth['grantSha256'],'authoritySha256':records['cleanup-authorized.json']['sha256'],'source':self.args.source,'nextBuildId':self.args.build_id,'activeDirectory':activated['activation']['activeDirectory'],'verifiedAbsent':['next','packet'],'auditEvidenceRetained':True,'releaseHandbackVerified':False}
            b.check(result==expected,'native owned cleanup result differs')
            if 'normal-cleanup-owned-cleanup.json'in names:b.check(json.loads(b.read_bounded(self.directory/'normal-cleanup-owned-cleanup.json',65536))==expected,'native session cleanup result differs')
        # Snapshot-relative semantics are safe only after all final stability checks.
        if previous is not None:
            b.check(previous-names<=({'packet','next','normal-cleanup.lock'}),'native private publications backslid')
            b.check(not self.cleaned.intersection(names),'removed native owned member reappeared')
            prior_root=self.private_root
            b.check(all(prior_root[k]==root_metadata[k]for k in ('device','inode','mode','uid','gid')),'native private directory identity/mode changed')
            expected_nlink=int(prior_root['nlink'])+int('audit'in names and 'audit'not in previous)-sum(int(x in previous and x not in names)for x in ('next','packet'))
            b.check(int(root_metadata['nlink'])==expected_nlink,'unexpected native private directory membership')
            b.check(previous!=names or root_metadata==prior_root,'native private root metadata changed without legal membership publication')
        for key,value in audit_directories.items():
            prior=getattr(self,'private_audit_directories',{}).get(key)
            if prior is not None:
                b.check(set(prior['members'])<=set(value['members']),'retained audit publication backslid')
                b.check(prior['members']!=value['members'] or prior['metadata']==value['metadata'],'retained audit metadata changed without publication')
        self.cleaned|=absent
        if previous is not None and 'normal-cleanup.lock'in previous and 'normal-cleanup.lock'not in names:self.cleaned.add('normal-cleanup.lock')
        self.private_root=root_metadata
        self.private_names=names
        self.private_audit_directories=audit_directories
        return {'records':records,'members':sorted(names),'removed':sorted(self.cleaned)}

    def snapshot(self):
        if self.recovery is not None:return RECOVERY.failed_snapshot(self)
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

    def start_requested(self):
        self.guard.verify_install()
        self.start_intent={'source':self.args.source,'unitSha256':sha(self.base.service_unit(self.args.source).encode()),
                           'bootIdSha256':self.auth['bootIdSha256'],'notBeforeTicks':int(time.monotonic()*os.sysconf('SC_CLK_TCK'))}
        self.guard.file_mutation()
        self.base.write_new(self.operation/'ci-worker-start-request.json',self.fmt.canonical(self.start_intent),0o400)

    def record_started(self,report):
        self.guard.verify_install()
        self.base.check(self.guard.start_sent and self.start_intent is not None,'owned start command was not sent')
        found=worker_identity(self.base,report,self.args.source)
        self.base.check(int(found['startTicks'])>=self.start_intent['notBeforeTicks'],'worker predates this protected start operation')
        self.started_identity=found
        raw=self.fmt.canonical({'intent':self.start_intent,'process':found,'journeyVerified':False})
        # Capturing the exact process we just started must survive a lost success
        # lease. This narrow state permits only this immutable evidence write.
        self.start_capture_pending=True
        try:
            self.guard.file_mutation(failure_only=True)
            self.base.write_new(self.operation/'ci-worker-started.json',raw,0o400);self.started_sha=sha(raw)
        finally:self.start_capture_pending=False

    def assert_owned_worker(self,report):
        self.base.check(self.started_identity is not None and worker_identity(self.base,report,self.args.source)==self.started_identity,'started worker PID/source/UID/cgroup identity changed')

    def quarantine_evidence(self,observe=None):
        # Failure-only authority: no fresh lease PASS is inferred. Continuous SH+install EX and exact OWN process are mandatory.
        self.guard.verify_install()
        self.base.check(self.started_identity is not None and (self.started_sha is not None or self.start_capture_pending and self.guard.start_sent),'no protected owned-start evidence; do not touch an uncertain process')
        self.base.root_protected(self.operation/'ci-worker-start-request.json',regular=True)
        self.base.check(sha(self.base.read_bounded(self.operation/'ci-worker-start-request.json',65536))==sha(self.fmt.canonical(self.start_intent)), 'protected start intent changed')
        if not self.start_capture_pending:
            self.base.root_protected(self.operation/'ci-worker-started.json',regular=True)
            self.base.check(sha(self.base.read_bounded(self.operation/'ci-worker-started.json',65536))==self.started_sha,'protected owned-start evidence changed')
        candidate=self.base.service_unit(self.args.source)
        quarantine=candidate.replace('Restart=on-failure\n','Restart=no\nSendSIGKILL=no\n')
        self.base.check(sha(self.base.read_bounded(self.base.UNIT,65536))in(sha(candidate.encode()),sha(quarantine.encode())),'foreign unit; no quarantine permission')
        report=self.base.service_properties()if observe is None else observe(self.base)
        self.base.validate_service(report,self.base.ROOT/'releases'/self.args.source)
        self.base.check(sha(self.base.read_bounded(BOOT_ID,4096))==self.start_intent['bootIdSha256'],'boot changed; no quarantine permission')
        return report

    def quarantine_fence(self):
        report=self.quarantine_evidence()
        self.base.check(worker_identity(self.base,report,self.args.source)==self.started_identity,'foreign/reused/restarted worker; no quarantine permission')

    def publish_stopped_failure_observation(self,result,observe):
        """Only an immutable failure observation, never unit mutation or acceptance authority."""
        b=self.base
        b.check(self.guard.quarantine and self.started_sha is not None and
                getattr(self,'quarantine_authority_sha',None)is not None,'owned quarantine authority required')
        report=self.quarantine_evidence(observe=observe)
        authority=self.operation/'ci-worker-quarantine-authority.json'
        b.root_protected(authority,regular=True)
        b.check(sha(b.read_bounded(authority,65536))==self.quarantine_authority_sha,'protected quarantine authority changed')
        quarantine=b.service_unit(self.args.source).replace('Restart=on-failure\n','Restart=no\nSendSIGKILL=no\n').encode()
        b.check(sha(b.read_bounded(b.UNIT,65536))==sha(quarantine),'exact quarantine unit required for stopped observation')
        b.check(report.get('MainPID')=='0' and report.get('ActiveState')in('inactive','failed') and
                report.get('SubState')in('dead','failed') and
                report.get('NRestarts')=='0' and report.get('NeedDaemonReload')=='no' and
                report.get('Restart')=='no' and report.get('SendSIGKILL')=='no' and report.get('UnitFileState')=='disabled',
                'exact stopped disabled quarantine required for failure observation')
        b.check(sha(b.read_bounded(b.ENV,1024**2))==self.args.worker_env_sha256,'worker environment changed before failure observation')
        b.check(not (PROCESS_ROOT/str(self.started_identity['pid'])).exists(),'owned process still exists or PID was reused')
        b.check(result.get('source')==self.args.source and result.get('accepted')is False and
                result.get('stopped')is True and result.get('disabled')is True and result.get('forcedKill')is False,
                'stopped failure observation cannot authorize success')
        # The active-process fence intentionally remains mandatory for every other failure-only write/command.
        b.write_new(self.operation/'activation-failure-observation.json',self.fmt.canonical(result),0o400)

    def authorize_quarantine(self):
        self.quarantine_fence()
        lease_failed=False
        try:self.guard.native_lease()
        except Exception:lease_failed=True
        self.quarantine_fence()
        self.guard.file_mutation(failure_only=True)
        raw=self.fmt.canonical({'ownedStartedProcess':self.started_identity,'freshLeaseAssertFailed':lease_failed,'failureOnly':True,'successAuthorized':False,'journeyVerified':False})
        self.base.write_new(self.operation/'ci-worker-quarantine-authority.json',raw,0o400)
        self.quarantine_authority_sha=sha(raw)
        self.guard.quarantine=True

    def validate_cleanup_proof(self,proof):
        b=self.base
        fields={'format','kind','source','installId','buildRecordId','nextBuildId','authorizationSha256','witnessFingerprint','outputSha256','checkedAt'}
        b.check(set(proof)==fields and proof['format']==1 and proof['kind']=='OPERATOR_OBSERVED_SOURCE_CHECKSUM_FOR_OWNED_CLEANUP' and proof['source']==self.args.source and proof['installId']==self.grant['installId'] and proof['buildRecordId']==self.auth['install']['buildRecordId'] and proof['nextBuildId']==self.args.build_id and proof['authorizationSha256']==self.auth['grantSha256'] and proof['witnessFingerprint']==self.grant['witnessFingerprint'] and proof['outputSha256']==sha(b''),'exact original native zero-difference source checksum request required')
        return native_timestamp(b,proof['checkedAt'],epoch(self.grant['issuedAt']),time.time())

    def cleanup_authority(self):
        """Validate one immutable normal cleanup authorization. Never retry a native byte failure."""
        b,a=self.base,self.auth
        stage,_=self.snapshot()
        b.check(stage=='O','only strict successful deployment permits normal cleanup')
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
        checked=self.validate_cleanup_proof(proof)
        b.check(checked<=approved<=checked+60,'native cleanup checksum was not fresh when authorized')
        return sha(raw)

    def full_audit(self):
        """Exactly two genuine, fatal-on-error native byte proofs; no metadata fallback/retry."""
        b,a=self.base,self.auth
        b.check(len(self.audits)<2,'only two native audit slots permitted')
        self.slot('A'+str(len(self.audits)),180)
        self.check_authority();before,_=self.snapshot();i=a['install']
        native=child([str(b.NODE),'--env-file=.env.production','--import','tsx','.github/ci/staging-build-install.mjs','resume-status' if self.recovery is not None else 'status',self.args.source,i['id'],i['buildRecordId']],self.owner,self.environment,timeout=180)
        self.check_authority();stage,raw=self.snapshot()
        b.check(self.stage_ranks()[stage]>=self.stage_ranks()[before],'native finish backslid during full audit')
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
        b.check(native['activated']==json.loads(b.read_bounded(self.directory/'activated.json',1024**2)),'native activation evidence differs')
        b.check(native['verified']==json.loads(b.read_bounded(self.directory/'verified.json',1024**2)),'native staged verification evidence differs')
        self.check_slot();self.guard.file_mutation()
        b.write_new(self.operation/('ci-runtime-full-audit-%d.json'%len(self.audits)),self.fmt.canonical(native),0o400)
        self.audits.append(native)
        return native

    def complete_fence(self,*,shared_stability_deadline=False):
        b,a=self.base,self.auth;started=time.monotonic()
        b.check(self.fence_count<10 and FENCES is not None,'reviewed complete metadata primitive and exactly ten fences required')
        if shared_stability_deadline:
            self.check_slot();self.slot_name='F'+str(self.fence_count)
        else:self.slot('F'+str(self.fence_count),20)
        self.check_authority();before,_=self.snapshot()
        for attempt in range(16):
            try:
                private=self.private_fence();break
            except NativePublicationPending:
                self.check_slot();self.check_authority();stage,_=self.snapshot()
                b.check(stage=='O' and attempt<15,'bounded native metadata publication did not complete under strict O')
                time.sleep(.02)
        filters=canonical_filters(b,SOURCE)
        exclude_source=source_excluder(filters)
        roots=[SOURCE,SOURCE/'.next',SOURCE/'node_modules',RUNTIME_ROOT]
        metadata={}
        cache=SOURCE/'.next/cache'
        cache_state={'present':cache.exists() or cache.is_symlink()}
        if cache_state['present']:
            st=cache.lstat()
            b.check(stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode) and not st.st_mode&0o022 and st.st_uid==self.owner.pw_uid,'unsafe compiled runtime cache')
            cache_state['metadata']={k:v for k,v in FENCES.metadata(st).items()if k in {'device','inode','mode','uid','gid'}}
        for name,root,exclude in [('source',roots[0],exclude_source),('compiled',roots[1],lambda rel:rel=='cache'),('dependencies',roots[2],lambda rel:False),('runtime',roots[3],lambda rel:False)]:
            metadata[name]=FENCES.capture_tree(str(root),exclude,[str(x)for x in roots],SLOT_DEADLINE)
        covered={str(root)+('/'+row['path']if row['path']else'')for name,root in zip(('source','compiled','dependencies','runtime'),roots)for row in metadata[name]['entries']}
        for name in ('source','compiled','dependencies','runtime'):
            for row in metadata[name]['entries']:
                if row['kind']=='link':b.check(row['resolvedTarget']['path']in covered,'link target is inside an excluded/unobserved subtree')
        # Cache contents alone are excluded by the native policy. Membership and the
        # cache directory identity/mode stay pinned; compiled ROOT metadata is never waived.
        metadata['cache']=cache_state
        # Every entry and resolved target has already been covered by TWO complete
        # native walks and its canonical per-root digest. Retain those exact root
        # commitments across A0/A1, rather than keeping 100k entry objects resident
        # while the independent Node byte verifier needs the same server memory.
        # Keep the original complete receipt hash unchanged; no observation drops.
        metadata_sha256=sha(canonical(metadata))
        commitments={}
        for name in ('source','compiled','dependencies','runtime'):
            tree=metadata[name]
            b.check(set(tree)=={'format','root','nodes','links','metadataSha256','entries'} and tree['format']==1 and
                    set(tree['root'])=={'canonicalpath','device','inode'} and tree['nodes']==len(tree['entries']) and
                    re.fullmatch('[a-f0-9]{64}',tree['metadataSha256']),'closed complete root metadata commitment required')
            commitments[name]={key:value for key,value in tree.items()if key!='entries'}
        commitments['cache']=cache_state
        b.check(self.metadata is None or commitments==self.metadata,'complete source/compiled/dependency/runtime metadata changed')
        metadata=commitments
        del covered,tree
        if self.recovery is not None:b.check(FAST_PROBE.count('validateInstallGrant(grant);')==1,'closed read-only grant probe owner changed')
        observed=child([str(b.NODE),'--env-file=.env.production','--input-type=module','-e',FAST_PROBE if self.recovery is None else FAST_PROBE.replace('validateInstallGrant(grant);','validateInstallGrant(grant,{allowExpired:true});',1),str(self.directory)],self.owner,self.environment,timeout=20)
        fields={'kind','pid','startedMonotonicUs','bootId','build','environmentSha256','migrationLedger','healthStatus','readiness'}
        b.check(set(observed)==fields and observed['kind']=='CI_WORKER_COMPLETE_FENCE_V2' and observed['pid']==a['webPid'] and observed['startedMonotonicUs']==a['webStartedMonotonicUs'] and sha(observed['bootId'].encode())==a['bootIdSha256'] and observed['build']==self.args.build_id and observed['environmentSha256']==a['environmentSha256'] and observed['healthStatus']==200 and observed['readiness']==a['readiness'],'fresh complete native identity/environment/health differs')
        ledger=observed['migrationLedger'];b.check(set(ledger)==LEDGER_FIELDS|{'verifiedAt'},'exact fresh full ordered ledger schema required')
        native_timestamp(b,ledger['verifiedAt'],epoch(self.grant['issuedAt']),time.time(),fresh=True)
        b.check({k:v for k,v in ledger.items()if k!='verifiedAt'}==a['ledger'],'fresh full ordered ledger differs')
        self.check_authority();stage,raw=self.snapshot()
        b.check(self.stage_ranks()[stage]>=self.stage_ranks()[before] and (self.last is None or self.stage_ranks()[stage]>=self.stage_ranks()[self.last]),'native finish publication backslid')
        self.check_slot();self.metadata=metadata;self.last=stage
        observation={'policy':POLICY,'slot':self.slot_name,'stage':stage,'leasePhase':self.last_lease_phase,'metadataSha256':metadata_sha256,'private':private,'freshNativeIdentity':observed,'currentSha256':sha(raw[0]),'lastOkSha256':sha(raw[1]),'elapsedSeconds':time.monotonic()-started,'byteProof':False,'journeyVerified':False,'releaseAuthorized':False}
        self.guard.file_mutation();self.check_slot()
        b.write_new(self.operation/('ci-runtime-fence-%02d.json'%self.fence_count),self.fmt.canonical(observation),0o400)
        self.transitions.append(observation);self.fence_count+=1
        return observation

    def stage_ranks(self):
        return {'R0':0,'R1':1,'O':2} if self.recovery is None else {'F':0}

    def admit_mutation(self):
        if self.recovery is not None:return RECOVERY.admit_mutation(self)
        b=self.base;now=time.time()
        original=json.loads(b.read_bounded(self.directory/'runtime.json',1024**2))
        c=epoch(original['verifiedAt'])+600
        remaining=min(epoch(self.auth['expiresAt']),epoch(self.grant['expiresAt']))-now
        b.check(self.fence_count==3 and len(self.audits)==1 and len(self.content_proofs)==1,'pre-mutation proof graph incomplete')
        b.check(self.overall_deadline is None or self.overall_deadline-time.monotonic()>=497,'insufficient fixed live global opportunity before first mutation')
        b.check(remaining>=527 and c-now>=155,'insufficient mandatory helper/readiness opportunity before first mutation')
        # The unchanged normal operator has its own larger per-command timeouts.
        # 830s is explicitly a planning reservation, NOT an enforced branch cap.
        estimated_normal=830
        b.check(epoch(self.grant['expiresAt'])-now>=max(497,max(0,c+15-now)+estimated_normal)+30,'insufficient estimated global fork reservation; no mutation')
        return {'helperRemainingRequiredSeconds':527,'readinessOpportunitySeconds':155,'estimatedNormalBranchSeconds':estimated_normal,'normalBranchHardCap':False}

    def receipt(self):
        self.check_slot();self.check_authority()
        self.base.check(self.fence_count==10 and len(self.audits)==2 and len(self.content_proofs)==2,'complete two-audit graph required before receipt')
        return {'mode':'activate-ci-runtime' if self.recovery is None else 'recover-ci-runtime','policy':POLICY if self.recovery is None else RECOVERY.POLICY,'authorizationSha256':sha(self.bytes),
                'installationAuthorizationSha256':self.auth['grantSha256'],'firstStageApprovalSha256':self.auth['firstStageApprovalSha256'],'installId':self.auth['install']['id'],
                'transitionStages':[row['stage'] for row in self.transitions],
                'leasePhases':[row['leasePhase'] for row in self.transitions],
                'transitionSha256':sha(self.fmt.canonical(self.transitions)), 'nativeRuntimeVerified':True,
                'fullSourceContentInventoryVerified':True,'fullNativeAudits':2,'completeMetadataFences':10,'normalBranchReserveIsEstimate':True,'journeyVerified':False}
