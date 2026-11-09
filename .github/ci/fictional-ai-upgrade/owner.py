"""Development-only owner for the exact fictional b698 to 145e witness."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

BASE = 'b698f5d35b0cca12e2c1268f3bea08d0aa1d070e'
CANDIDATE = '145e527f45be53fd6b587691d7a82a9240a0e456'
BRANCH = 'codex/architecture-ai-source-upgrade-witness-20261109'
REPO = 'StradaverseHub/ai-hr'
IMAGE = 'postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97'
APP = 'postgres://ai_hr_app@127.0.0.1:5433/'
ADMIN = 'postgres://postgres@127.0.0.1:5433/'
ROLE = 'personnel-draft-discard-premigration-role-prerequisites.json'
UID = 47106
SELECTED = '["test/module-specialist-release-lifecycle.test.ts"]'
OWNER_ROOT = Path('/var/lib/aihr-fictional-upgrade')
FIXTURE_RUNTIME_ROOT = Path('/var/tmp')
SYSTEM_ENV = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'}
PINS = {
    'package.json': '7f67e35d869a29d2cb58d65c6f63413afc63db2cc6c6cf9dacb5086bce70ec2c',
    'pnpm-lock.yaml': '0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd',
    'pnpm-workspace.yaml': '68505b5f88e6fbd9ef4a309ca131de8e64f1749939d846da2d81e88db14c9369',
    'patches/fontkit@1.9.0.patch': 'b208b0e233a985efb2decb13e5043f8c26955724f0df805849ef7b305773642a',
}
ROLE_SOURCES = {'helperSha256':'test/helpers/personnel-draft-discard-ci-role-fixture.ts',
                'wrapperSha256':'scripts/migrate-with-focused-prerequisites.ts',
                'orchestrationSha256':'scripts/lib/discard-premigration.ts'}
WITNESS_STEPS = frozenset('''
environment private-scratch source-checkout controller-custody source-manifests ledger-sources ledger-native
database-identity baseline-receipt pristine-baseline receipt-key app-imports fixture-tenant fixture-actors
fixture-reporting baseline-candidate baseline-evaluations baseline-promotion baseline-job baseline-feedback
baseline-replay baseline-row-hashes baseline-reporting-facts baseline-receipt-write candidate-actors retained-facts
stale-review stale-actions fallback-job fallback-replay fallback-retirement current-candidate
current-unauthorized-actions current-evaluations current-promotion-separation current-promotion current-promoted-job
current-replay current-row-hashes result-write
'''.split())


def need(ok):
    if not ok:
        raise ValueError('Closed fictional upgrade owner refused')


def plain(path, limit=65536):
    info = path.lstat()
    need(path.resolve(strict=True) == path and stat.S_ISREG(info.st_mode)
         and info.st_nlink == 1 and 0 < info.st_size <= limit)
    return path.read_bytes()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)


def capture(argv, *, cwd=None, data=None, env=None, timeout=25):
    result = subprocess.run(argv, cwd=cwd, input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env=env, timeout=timeout)
    need(result.returncode == 0 and len(result.stdout) <= 4 * 1024**2)
    return result.stdout


def docker(*args):
    return capture(['/usr/bin/docker',*args],env=SYSTEM_ENV)


def listener(prefix=()):
    return capture([*prefix,'/usr/bin/ss','-H','-ltn','sport = :5433'],env=SYSTEM_ENV).strip()


def container_name(run):
    return 'aihr-ci-'+run+'-1-db-1'


def owned_container(name, nonce):
    ids = docker('container','ls','-aq','--no-trunc','--filter','name=^/'+name+'$').decode().split()
    if not ids:
        return None
    need(len(ids) == 1 and re.fullmatch(r'[a-f0-9]{64}',ids[0]))
    row, = json.loads(docker('container','inspect',ids[0]))
    labels = row['Config']['Labels']
    host = row['HostConfig']
    need(row['Id'] == ids[0] and row['Name'] == '/'+name and row['Config']['Image'] == IMAGE
         and labels.get('aihr-owner') == name and labels.get('aihr-fictional-upgrade') == nonce
         and host['NetworkMode'] == 'none' and host['Privileged'] is False
         and not host.get('Binds') and not host.get('PortBindings') and not host.get('CapAdd')
         and any(option in ('no-new-privileges','no-new-privileges=true') for option in host.get('SecurityOpt',[]))
         and host.get('PublishAllPorts') is False and set(row['NetworkSettings']['Networks']) <= {'none'}
         and all(m['Type'] == 'volume' and m['Destination'] == '/var/lib/postgresql/data' for m in row['Mounts'])
         and host['RestartPolicy']['Name'] in ('','no'))
    return row


def start_argv(name,nonce):
    return ['/usr/bin/docker','run','-d','--pull=never','--name',name,
            '--label','aihr-owner='+name,'--label','aihr-fictional-upgrade='+nonce,
            '--network','none','--security-opt','no-new-privileges',
            '--memory','2113929216','--memory-swap','2113929216','--shm-size','128m',
            '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','TZ=Asia/Kuala_Lumpur',IMAGE,
            '-c','listen_addresses=127.0.0.1','-c','port=5433','-c','max_wal_senders=0',
            '-c','fsync=off','-c','synchronous_commit=off','-c','full_page_writes=off','-c','wal_level=minimal',
            '-c','jit=on','-c','shared_buffers=128MB','-c','max_connections=100','-c','max_locks_per_transaction=256']


def copy_program_canary():
    # Empty input, no shell interpolation from callers, and reserved TEST-NET destinations only.
    program = ('/bin/bash -c \'exec 3<>/dev/tcp/127.0.0.1/5433 || exit 72; '
               'if { exec 4<>/dev/tcp/192.0.2.1/443; } 2>/dev/null; then exit 73; fi; '
               'if { exec 5<>/dev/tcp/2001:db8::1/443; } 2>/dev/null; then exit 74; fi\'')
    return ("COPY (SELECT NULL::text WHERE FALSE) TO PROGRAM '"+program.replace("'","''")+"';").encode()


def root_file(path):
    need(path.lstat().st_uid == 0 and path.lstat().st_mode & 0o022 == 0)
    return plain(path)


def failure_excerpt(path):
    if not path.exists():
        return b''
    fd = os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as source:
        info = os.fstat(source.fileno())
        need(info.st_uid == 0 and info.st_nlink == 1 and stat.S_ISREG(info.st_mode) and info.st_mode & 0o077 == 0)
        front = source.read(8192)
        if info.st_size <= 8192:
            return front
        source.seek(max(8192,info.st_size-8192))
        return front+b'\n'+source.read(8192)


def migration_failure_category(excerpt, role_recorded):
    """Publish a fixed label only. The underlying process output always remains private."""
    for label in ('node','pnpm','git','checkout','checkout-cwd','tsx','fixture-temp','role-evidence'):
        if re.search(rb'(?m)^fictional-upgrade-path-refused:'+label.encode()+rb'$',excerpt):
            return label+'-path-refused'
    for category,pattern in (
        ('namespace-entry-refused',rb'(?m)^nsenter: '),
        ('child-identity-refused',rb'(?m)^setpriv: '),
        ('toolchain-access-refused',rb"(?m)^(?:/usr/bin/)?env: [^\r\n]{1,512}: (?:Permission denied|No such file or directory)$"),
        ('checkout-access-refused',rb'(?m)^fatal: (?:detected dubious ownership|not a git repository)'),
        ('dependency-unavailable',rb"(?m)^(?:Error \[ERR_MODULE_NOT_FOUND\]: Cannot find package ['\"](?:tsx|postgres|esbuild|drizzle-kit)['\"]|Error: The package \"@esbuild/linux-x64\")"),
        ('focused-role-refused',rb'(?m)^Disposable focused role fixture prerequisites are not satisfied\.$'),
        ('focused-target-refused',rb'(?m)^Focused (?:migration target is not the canonical disposable development database|test migration target is (?:not canonical|unavailable)|migration and test clusters differ)\.$'),
        ('receipt-write-refused',rb"(?m)^(?:EACCES|EPERM|EEXIST): [^\r\n]{0,1024}personnel-draft-discard-premigration-role-prerequisites\.json"),
        ('postgres-connectivity-refused',rb'(?m)^(?:Error: connect (?:ECONNREFUSED|ETIMEDOUT) 127\.0\.0\.1:5433|PostgresError: the database system is starting up)'),
        ('migration-engine-launch-refused',rb'(?m)^Existing migration engine did not complete normally\.$'),
    ):
        if re.search(pattern,excerpt):
            return category
    return 'migration-engine-failed' if role_recorded else 'unclassified-stage-failure'


def witness_failure_category(excerpt):
    markers = re.findall(rb'(?m)^fictional-upgrade-witness-failed:([^\r\n]*)$',excerpt)
    if len(markers) == 1 and re.fullmatch(rb'[a-z-]{1,40}',markers[0]):
        step = markers[0].decode()
        if step in WITNESS_STEPS:
            return 'witness-'+step
    return migration_failure_category(excerpt,False)


def phase_role_bytes(path,source,sha,controller,run):
    info = path.lstat()
    need(info.st_uid == UID)
    data = plain(path)
    row = json.loads(data)
    need(row.get('kind') == 'PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES'
         and row.get('phase') == 'before_initial_candidate_migration'
         and row.get('candidate') == sha and row.get('controller') == controller
         and row.get('runId') == run and row.get('attempt') == '1'
         and row.get('fixture',{}).get('mode') == 'focused_disposable')
    need(all(row.get(key) == digest(plain(source/file)) for key,file in ROLE_SOURCES.items()))
    return data


def stop_owned(name, nonce):
    row = owned_container(name,nonce)
    if row:
        docker('container','rm','-fv',row['Id'])
    # A missing container never waives the native listener check.
    need(owned_container(name,nonce) is None and not listener())


def current_process(pid):
    try:
        raw = Path(f'/proc/{pid}/stat').read_text()
        fields = raw[raw.rindex(')')+2:].split()
        return {'pid':pid,'session':int(fields[3]),'start':int(fields[19]),'state':fields[0]}
    except (FileNotFoundError,ProcessLookupError):
        return None


def settle_interrupted(custody):
    active = custody/'active-session.json'
    if not active.exists():
        return
    recorded = json.loads(root_file(active))
    need(set(recorded) == {'kind','pid','start'} and recorded['kind'] == 'session-admitted'
         and all(type(recorded[key]) is int and recorded[key] > 0 for key in ('pid','start')))
    anchor = current_process(recorded['pid'])
    need(anchor is None or (anchor['session'] == recorded['pid'] and anchor['start'] == recorded['start']))
    deadline = time.monotonic()+10
    while time.monotonic() < deadline:
        members = [row for pid in Path('/proc').iterdir() if pid.name.isdecimal()
                   if (row := current_process(int(pid.name))) and row['session'] == recorded['pid']
                   and row['state'] not in ('Z','X')]
        if not members:
            active.unlink()
            return
        anchor = current_process(recorded['pid'])
        need(anchor and anchor['session'] == recorded['pid'] and anchor['start'] == recorded['start'])
        for row in [member for member in members if member['pid'] != recorded['pid']] or members:
            need(row['start'] >= recorded['start'])
            try:
                fd = os.pidfd_open(row['pid'])
            except ProcessLookupError:
                continue
            try:
                now = current_process(row['pid'])
                if now and now['session'] == row['session'] and now['start'] == row['start']:
                    signal.pidfd_send_signal(fd,signal.SIGKILL)
            except ProcessLookupError:
                pass
            finally:
                os.close(fd)
        time.sleep(.03)
    need(False)


def namespace_child(pid, namespace):
    try:
        directory = Path(f'/proc/{pid}')
        if not re.search(r'^Uid:\s+'+str(UID)+r'\s+'+str(UID)+r'\b',(directory/'status').read_text(),re.M):
            return None
        if os.readlink(directory/'ns/net') != namespace:
            return None
        row = current_process(pid)
        return row if row and row['state'] not in ('Z','X') else None
    except (FileNotFoundError,ProcessLookupError):
        return None


def settle_namespace_children(custody):
    receipt = custody/'network-id'
    if not receipt.exists():
        return
    namespace = root_file(receipt).decode()
    need(re.fullmatch(r'net:\[[1-9][0-9]{0,19}\]',namespace) and namespace != os.readlink('/proc/self/ns/net'))
    deadline = time.monotonic()+8
    while time.monotonic() < deadline:
        rows = [row for path in Path('/proc').iterdir() if path.name.isdecimal()
                if (row := namespace_child(int(path.name),namespace))]
        if not rows:
            return
        for row in rows:
            try:
                fd = os.pidfd_open(row['pid'])
            except ProcessLookupError:
                continue
            try:
                current = namespace_child(row['pid'],namespace)
                if current and current['start'] == row['start']:
                    signal.pidfd_send_signal(fd,signal.SIGKILL)
            except ProcessLookupError:
                pass
            finally:
                os.close(fd)
        time.sleep(.03)
    need(False)


def recover():
    need(os.getuid() == 0 and sys.platform == 'linux')
    run,controller,_ = admit(os.environ)
    custody = OWNER_ROOT/run
    name = container_name(run)
    intent = custody/'launch.json'
    if not intent.exists():
        # Early owner failure may have admitted nothing. Do not claim a foreign named container.
        need(not docker('container','ls','-aq','--filter','name=^/'+name+'$').strip() and not listener())
        return
    need(custody.resolve(strict=True) == custody and custody.stat().st_uid == 0 and custody.stat().st_mode & 0o022 == 0)
    launch = json.loads(root_file(intent))
    need(launch == {'controller':controller,'runId':run,'name':name,'nonce':launch.get('nonce'),
                    'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
         and re.fullmatch(r'[a-f0-9]{32}',launch['nonce']))
    lease = custody/'owner.lock'
    need(lease.lstat().st_uid == 0 and stat.S_ISREG(lease.lstat().st_mode) and lease.lstat().st_nlink == 1)
    fd = os.open(lease,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        settle_interrupted(custody)
        settle_namespace_children(custody)
        stop_owned(name,launch['nonce'])
        temp = Path(os.environ['RUNNER_TEMP'])
        need(temp.resolve(strict=True) == temp and str(temp.stat().st_uid) == os.environ.get('SUDO_UID'))
        summary = temp/'aihr-fictional-ai-upgrade-summary.json'
        if not summary.exists():
            output = {'status':'FAIL','baseline':BASE,'candidate':CANDIDATE,'controller':controller,'runId':run,
                      'attempt':1,'firstFailedStage':'owner-interrupted','failureCategory':'controller-interrupted',
                      'settled':True,'releaseAuthorized':False}
            write(summary,(json.dumps(output,separators=(',',':'))+'\n').encode(),0o644)
        else:
            root_file(summary)
    finally:
        os.close(fd)


def admit(e, job='selected-tests'):
    run, controller = e['GITHUB_RUN_ID'], e['GITHUB_WORKFLOW_SHA']
    need(re.fullmatch(r'[1-9][0-9]{0,19}', run) and re.fullmatch(r'[a-f0-9]{40}', controller))
    expected = {
        'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
        'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_REPOSITORY': REPO,
        'GITHUB_REPOSITORY_ID': '1333414856', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
        'GITHUB_WORKFLOW': 'alpha-focused-checks', 'GITHUB_JOB': job, 'GITHUB_RUN_ATTEMPT': '1',
        'GITHUB_REF': 'refs/heads/' + BRANCH,
        'GITHUB_WORKFLOW_REF': REPO + '/.github/workflows/alpha-focused-checks.yml@refs/heads/' + BRANCH,
        'GITHUB_SHA': controller, 'GITHUB_WORKFLOW_SHA': controller,
        'AIHR_CI_CONTROL_HEAD': controller, 'AIHR_CI_HEAD': CANDIDATE,
        'AIHR_AI_UPGRADE_STAGING_ENABLED': 'false', 'AIHR_AI_UPGRADE_PRODUCTION_ENABLED': 'false',
    }
    need(all(e.get(k) == v for k, v in expected.items()))
    event = json.loads(plain(Path(e['GITHUB_EVENT_PATH'])))
    inputs = event.get('inputs', {})
    repo = event.get('repository', {})
    need(repo.get('full_name') == REPO and repo.get('id') == 1333414856 and repo.get('private') is False
         and event.get('ref') in (BRANCH, 'refs/heads/' + BRANCH))
    required = {'expected_sha': CANDIDATE, 'selected_tests': SELECTED}
    off = {key: 'false' for key in ('architecture_browser_development_preflight', 'qualify_restricted_port_prerequisites',
           'profile_database','duration_order','run_typecheck','run_native_typecheck','run_native_swift_models','run_native_bundle','run_build')}
    off.update({'measured_browser_course':'off','employee_ascii_qualification':'off','model_eval':'',
                'measured_browser_preflight_run':'','eval_allowed_providers':'','eval_budget_usd':'20'})
    need(all(inputs.get(k) == v for k, v in required.items()) and
         all(inputs.get(k,v) == v for k,v in off.items()) and
         set(inputs) <= set(required) | set(off) | {'candidate_ref'} and
         re.fullmatch(r'codex/[a-zA-Z0-9._/-]+', inputs.get('candidate_ref','')))
    return run, controller, expected


def verify_dependency_pins(workspace):
    for member in ('baseline','source'):
        path = workspace/member
        need(path.resolve(strict=True) == path)
        for name, wanted in PINS.items():
            need(digest(plain(path/name,4*1024**2)) == wanted)


def fixture_runtime_path(raw,run,runner):
    path = Path(raw)
    need(path.parent == FIXTURE_RUNTIME_ROOT and re.fullmatch(
         r'aihr-fictional-upgrade\.'+re.escape(run)+r'\.[a-zA-Z0-9]{8}',path.name))
    info = path.lstat()
    need(path.resolve(strict=True) == path and stat.S_ISDIR(info.st_mode)
         and info.st_uid == runner and info.st_mode & 0o777 == 0o755)
    return path


FIXTURE_PATH_PROBE = '''
import os
import sys

try:
    cwd = os.getcwd()
except OSError:
    cwd = None
if len(sys.argv) != 9 or cwd != sys.argv[1]:
    sys.stderr.write('fictional-upgrade-path-refused:checkout-cwd\\n')
    sys.exit(2)
for label, path, mode in zip(
    ('node','pnpm','git','checkout','tsx','fixture-temp','role-evidence'),
    sys.argv[2:],
    (os.X_OK,os.X_OK,os.X_OK,os.R_OK,os.R_OK,os.W_OK|os.X_OK,os.W_OK|os.X_OK),
):
    if not os.access(path,mode):
        sys.stderr.write('fictional-upgrade-path-refused:'+label+'\\n')
        sys.exit(2)
'''


def main():
    stage = 'admission'
    need(os.getuid() == 0 and sys.platform == 'linux' and len(sys.argv) == 4)
    run, controller, job = admit(os.environ)
    ws, temp = (Path(os.environ[key]).resolve(strict=True) for key in ('GITHUB_WORKSPACE','RUNNER_TEMP'))
    need(ws == Path(os.environ['GITHUB_WORKSPACE']) and temp == Path(os.environ['RUNNER_TEMP']))
    runner = ws.stat().st_uid
    need(runner > 0 and temp.stat().st_uid == runner and runner != UID and os.environ.get('SUDO_UID') == str(runner))
    runtime = fixture_runtime_path(sys.argv[1],run,runner)
    node, pnpm = (Path(value) for value in sys.argv[2:])
    need(node == runtime/'bin'/'node' and pnpm == runtime/'pnpm'/'node_modules'/'.bin'/'pnpm')
    for program in (node,pnpm):
        need(program.resolve(strict=True).is_relative_to(runtime) and program.is_file() and os.access(program,os.X_OK))
    base_env = {'PATH': str(node.parent)+':'+str(pnpm.parent)+':/usr/bin:/bin','LANG':'C.UTF-8','TZ':'Asia/Kuala_Lumpur'}
    need(capture([str(node),'--version'],env=base_env).strip() == b'v22.23.3')
    need(capture([str(pnpm),'--version'],env=base_env).strip() == b'10.33.2')
    git = lambda source, *args: capture(['/usr/bin/git','--no-optional-locks','-c','safe.directory='+str(source),
        '-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',*args],cwd=source,env=base_env).decode().strip()
    sources = {'prepare':runtime/'baseline','compare':runtime/'source'}
    control = ws/'automation'
    for path, wanted in ((control,controller),(ws/'baseline',BASE),(ws/'source',CANDIDATE),
                         (sources['prepare'],BASE),(sources['compare'],CANDIDATE)):
        need(path.resolve(strict=True) == path and git(path,'rev-parse','HEAD') == wanted
             and not git(path,'status','--porcelain','--untracked-files=no')
             and git(path,'remote','get-url','origin') in ('https://github.com/'+REPO,'https://github.com/'+REPO+'.git'))
    capture(['/usr/bin/git','-c','safe.directory='+str(ws/'source'),'merge-base','--is-ancestor',BASE,CANDIDATE],
            cwd=ws/'source',env=base_env)
    verify_dependency_pins(runtime)
    for path in sources.values():
        need(not (path/'.env.local').exists() and (path/'node_modules').is_dir())
        for parent, dirs, files in os.walk(path):
            for entry in (*dirs,*files):
                info = (Path(parent)/entry).lstat()
                need(stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022 == 0)
    controlled = control/'.github/ci/fictional-ai-upgrade'
    need(Path(__file__).resolve() == controlled/'owner.py')
    module = importlib.util.spec_from_file_location('owned_process',control/'.github/ci/owned-process.py')
    supervisor = importlib.util.module_from_spec(module)
    module.loader.exec_module(supervisor)
    for path in Path('/proc').iterdir():
        if path.name.isdecimal():
            try:
                status = (path/'status').read_text()
            except (FileNotFoundError,ProcessLookupError):
                continue
            need(not re.search(r'^Uid:\s+'+str(UID)+r'\b',status,re.M))
    for args in (['passwd',str(UID)],['group',str(UID)]):
        need(subprocess.run(['/usr/bin/getent',*args],stdout=subprocess.DEVNULL,check=False).returncode == 2)

    fixture_temp = runtime/'fixture-temp'
    need(fixture_temp.resolve(strict=True) == fixture_temp and fixture_temp.is_dir()
         and fixture_temp.stat().st_uid == runner and fixture_temp.stat().st_mode & 0o022 == 0)
    witness_dir, focus = fixture_temp/'aihr-fictional-ai-upgrade-private', fixture_temp/'aihr-focused'
    public = temp/'aihr-fictional-ai-upgrade-summary.json'
    root = OWNER_ROOT
    if not root.exists():
        root.mkdir(mode=0o755)
    need(root.resolve(strict=True) == root and root.stat().st_uid == 0 and root.stat().st_mode & 0o022 == 0)
    custody = root/run
    custody.mkdir(mode=0o755)
    for path in (witness_dir,focus):
        path.mkdir(mode=0o700)
        os.chown(path,UID,UID)
    for filename in ('fictional-ai-source-upgrade.mts','fictional-ai-upgrade-canonical-admission.mjs'):
        source_bytes = plain(controlled/filename)
        for path in sources.values():
            write(path/'scripts'/filename,source_bytes,0o444)
    common = {**base_env,**job,'GITHUB_RUN_ID':run,'RUNNER_TEMP':str(fixture_temp),'NODE_ENV':'test',
              'HOME':str(witness_dir),'TSX_DISABLE_CACHE':'1','GIT_CONFIG_NOSYSTEM':'1'}
    name, nonce = container_name(run), os.urandom(16).hex()
    lease = os.open(custody/'owner.lock',os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_RDWR,0o600)
    fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
    # The lease belongs to the controller alone. Forked supervisors must not retain it after owner death.
    inherited_lease = [lease]
    def close_forked_lease():
        if inherited_lease:
            os.close(inherited_lease.pop())
    os.register_at_fork(after_in_child=close_forked_lease)
    launch = {'controller':controller,'runId':run,'name':name,'nonce':nonce,
              'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    write(custody/'launch.json',json.dumps(launch).encode())
    session_receipt = custody/'active-session.json'
    namespace_fd = None
    namespace_prefix = []
    uncertain = False
    failed = None
    failure_category = 'unclassified-stage-failure'
    active_log = None
    active_reason = None
    output = None

    def owned(label, cwd, argv, env, seconds, *, unpriv=True):
        nonlocal uncertain,active_log,active_reason
        active_log = custody/(label+'.log')
        active_reason = None
        env = {**env,'PWD':str(cwd),'GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'safe.directory','GIT_CONFIG_VALUE_0':str(cwd)}
        if unpriv:
            need(namespace_fd is not None)
        prefix = [*namespace_prefix,'/usr/bin/setpriv','--reuid='+str(UID),'--regid='+str(UID),
                  '--clear-groups','--no-new-privs'] if unpriv else []
        cmd = [*prefix,'/usr/bin/env','-i',*(f'{key}={value}' for key,value in env.items()),*map(str,argv)]
        fds = [os.dup(1),os.dup(2)]
        prev = Path.cwd()
        log = os.open(active_log,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            os.dup2(log,1); os.dup2(log,2); os.chdir(cwd)
            def record(event):
                if event['kind'] == 'session-admitted':
                    write(session_receipt,json.dumps(event).encode())
            result = supervisor.supervise(cmd,seconds,record)
        except BaseException:
            uncertain = True
            raise
        finally:
            os.chdir(prev); os.close(log)
            for fd, target in zip(fds,(1,2)):
                os.dup2(fd,target); os.close(fd)
        uncertain = not result['groupQuiescent']
        active_reason = result['reason']
        if not uncertain and session_receipt.exists():
            session_receipt.unlink()
        need(not uncertain and result['reason'] == 'complete' and result['commandExit'] == 0)
        active_log = None
        active_reason = None

    def database():
        row = owned_container(name,nonce)
        need(row and row['State']['Running'] is True and type(row['State']['Pid']) is int and row['State']['Pid'] > 0)
        return row

    def socket_psql(container_id,database,sql):
        return capture(['/usr/bin/docker','exec','-i',container_id,'psql','-X','-Atq','-U','postgres','-p','5433','-d',database,
                        '-v','ON_ERROR_STOP=1'],data=sql,env=SYSTEM_ENV,timeout=20)

    def db_identity():
        row = database()
        ns = os.readlink(f"/proc/{row['State']['Pid']}/ns/net")
        need(ns != os.readlink('/proc/self/ns/net') and re.fullmatch(r'net:\[[1-9][0-9]+\]',ns))
        need(namespace_fd is not None and ns == os.readlink(f'/proc/self/fd/{namespace_fd}'))
        links = json.loads(capture([*namespace_prefix,'/usr/sbin/ip','-j','link','show'],env=SYSTEM_ENV))
        need(len(links) == 1 and links[0]['ifname'] == 'lo' and 'LOOPBACK' in links[0]['flags'] and 'UP' in links[0]['flags'])
        for family in ('-4','-6'):
            routes = json.loads(capture([*namespace_prefix,'/usr/sbin/ip','-j',family,'route','show','table','all'],env=SYSTEM_ENV))
            need(all(route.get('dev') == 'lo' and route.get('type','unicast') in ('local','broadcast','unicast')
                     and route.get('dst') not in ('default','0.0.0.0/0','::/0') for route in routes))
        fields = socket_psql(row['Id'],'ai_hr_dev',
            b"select system_identifier::text,extract(epoch from pg_postmaster_start_time())::text,"
            b"current_setting('listen_addresses'),current_setting('port') from pg_control_system();").decode().strip().split('|')
        need(len(fields) == 4 and fields[2:] == ['127.0.0.1','5433'] and fields[0].isdigit()
             and b'127.0.0.1:5433' in listener(namespace_prefix) and not listener())
        return {'containerId':row['Id'],'containerName':name,'image':IMAGE,'uid':UID,'netNamespace':ns,
                'postgresSystemId':fields[0],'postmasterEpoch':fields[1],'networkPolicy':'docker-none-loopback-v1'}

    def interrupt(_signum,_frame):
        raise InterruptedError('Owned fictional run interrupted')

    for sig in (signal.SIGINT,signal.SIGTERM):
        signal.signal(sig,interrupt)
    try:
        stage = 'postgres'
        need(not listener() and owned_container(name,nonce) is None)
        owned('postgres-start',control,start_argv(name,nonce),common,90,unpriv=False)
        row = database()
        for _ in range(60):
            ready = subprocess.run(['/usr/bin/docker','exec',row['Id'],'pg_isready','-h','127.0.0.1','-U','postgres','-p','5433'],
                env=SYSTEM_ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            need(False)
        socket_psql(row['Id'],'postgres',
            b'CREATE ROLE ai_hr_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\n'
            b'CREATE DATABASE ai_hr_dev OWNER ai_hr_app;\nCREATE DATABASE ai_hr_test OWNER ai_hr_app;\n')
        namespace_fd = os.open(f"/proc/{row['State']['Pid']}/ns/net",os.O_RDONLY|os.O_CLOEXEC)
        namespace_prefix = ['/usr/bin/nsenter',f'--net=/proc/{os.getpid()}/fd/{namespace_fd}','--']
        stage = 'network'
        born = db_identity()
        write(custody/'network-id',born['netNamespace'].encode())
        # Verify the privileged SQL program path as well as the app-side namespace.
        socket_psql(row['Id'],'ai_hr_dev',copy_program_canary())
        canary = 'import socket; c=socket.create_connection(("127.0.0.1",5433),2); c.close()'
        owned('network-canary',runtime,['/usr/bin/python3','-I','-B','-c',canary],common,12)
        for phase, source in sources.items():
            stage = phase+'-migration-custody'
            sha = BASE if phase == 'prepare' else CANDIDATE
            role_path = focus/ROLE
            env = {**common,'AIHR_CI_HEAD':sha,'TEST_DB_NAMESPACE':'aifocus','AIHR_FOCUSED_SUITE_CAPACITY':'true',
                   'AIHR_FOCUSED_EVIDENCE_DIR':str(focus),'DATABASE_URL':APP+'ai_hr_dev','MIGRATION_DATABASE_URL':ADMIN+'ai_hr_dev',
                   'TEST_DATABASE_URL':APP+'ai_hr_test','TEST_MIGRATION_DATABASE_URL':ADMIN+'ai_hr_test'}
            need(db_identity() == born and not role_path.exists())
            stage = phase+'-migration-paths'
            owned(stage,source,['/usr/bin/python3','-I','-B','-c',FIXTURE_PATH_PROBE,
                  source,node,pnpm,'/usr/bin/git',source/'.git'/'HEAD',source/'node_modules'/'tsx'/'package.json',witness_dir,focus],env,20)
            stage = phase+'-migration-node'
            owned(stage,source,[node,'--version'],env,20)
            stage = phase+'-migration-pnpm'
            owned(stage,source,[pnpm,'--version'],env,20)
            stage = phase+'-migration-toolchain'
            probe = ('import {execFileSync} from "node:child_process";'
                     'if(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()!==process.env.AIHR_CI_HEAD)process.exit(2);'
                     'for(const packageName of ["tsx","postgres","drizzle-kit"])import.meta.resolve(packageName);')
            owned(stage,source,[node,'--import','tsx','--input-type=module','--eval',probe],env,25)
            stage = phase+'-migration-wrapper'
            owned(stage,source,[pnpm,'db:migrate'],env,360)
            stage = phase+'-migration-role-receipt'
            role = phase_role_bytes(role_path,source,sha,controller,run)
            write(custody/(phase+'-roles.json'),role,0o444)
            role_path.unlink()
            if phase == 'prepare':
                stage = 'prepare-catalogs'
                owned(stage,source,[pnpm,'exec','tsx','scripts/seed-catalogs.ts'],env,80)
            stage = phase+'-witness-receipt'
            packet = {'kind':'AIHR_FICTIONAL_AI_UPGRADE_DISPOSABLE_CUSTODY','version':1,'releaseAuthorized':False,
                'phase':phase,'baseline':BASE,'candidate':CANDIDATE,'controller':controller,'runId':run,'attempt':1,
                'source':sha,'host':born,'prerequisiteSha256':digest(role),
                'witnessSha256':digest(plain(controlled/'fictional-ai-source-upgrade.mts')),
                'admissionSha256':digest(plain(controlled/'fictional-ai-upgrade-canonical-admission.mjs'))}
            write(custody/(phase+'-custody.json'),json.dumps(packet).encode(),0o444)
            stage = phase+'-witness'
            need(db_identity() == born)
            owned(stage,source,[node,'--import','tsx','scripts/fictional-ai-source-upgrade.mts',phase],
                  {**common,'AIHR_CI_HEAD':sha,'AIHR_AI_UPGRADE_ARTIFACT_DIR':str(witness_dir),
                   'TEST_DATABASE_URL':APP+'ai_hr_dev','TEST_MIGRATION_DATABASE_URL':ADMIN+'ai_hr_dev'},120)
            need(db_identity() == born)
        stage = 'result'
        output = json.loads(plain(witness_dir/'after.json'))
        need(output == {'status':'PASS','baseline':BASE,'candidate':CANDIDATE,'controller':controller,'runId':run,
            'attempt':1,'retainedTables':14,'ledgerBefore':723,'ledgerAfter':764,'oldReplay':'unavailable',
            'fallbackReplay':'baseline','currentReplay':'promoted','oldPermitsUsed':1,'currentPermitsUsed':1,
            'sourceChangedRollbacks':1,'releaseAuthorized':False})
    except BaseException:
        failed = stage
        if stage.endswith('-migration-wrapper'):
            try:
                phase_role_bytes(role_path,source,sha,controller,run)
                failed = phase+'-migration-engine'
            except (OSError,ValueError,TypeError,AttributeError):
                pass
        if uncertain:
            failure_category = 'child-settlement-unverified'
        elif active_reason == 'deadline':
            failure_category = 'child-deadline'
        elif active_log is not None:
            try:
                excerpt = failure_excerpt(active_log)
                failure_category = (witness_failure_category(excerpt) if failed.endswith('-witness') else
                                    migration_failure_category(excerpt,failed.endswith('-migration-engine')))
            except (OSError,ValueError):
                failure_category = 'private-log-unavailable'
    finally:
        try:
            need(not uncertain)
            stop_owned(name,nonce)
            if namespace_fd is not None:
                need(not listener(namespace_prefix))
        except BaseException:
            failed = failed or 'settlement'
            uncertain = True
    if failed:
        output = {'status':'FAIL','baseline':BASE,'candidate':CANDIDATE,'controller':controller,'runId':run,
                  'attempt':1,'firstFailedStage':failed,'failureCategory':failure_category,
                  'settled':not uncertain,'releaseAuthorized':False}
    else:
        output['settled'] = True
    write(public,(json.dumps(output,separators=(',',':'))+'\n').encode(),0o644)
    if namespace_fd is not None:
        os.close(namespace_fd)
    os.close(lease)
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        if sys.argv[1:] in (['--admit-event'],['--admit-only']):
            admit(os.environ,'resolve' if sys.argv[1] == '--admit-event' else 'selected-tests')
            if sys.argv[1] == '--admit-only':
                verify_dependency_pins(Path(os.environ['GITHUB_WORKSPACE']))
        elif sys.argv[1:] == ['--recover']:
            recover()
        else:
            raise SystemExit(main())
    except Exception:
        print('Fictional upgrade owner failed before a bounded result was available.',file=sys.stderr)
        raise SystemExit(1)
