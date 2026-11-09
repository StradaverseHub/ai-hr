"""Development-only owner for the exact fictional b698 to 98ae witness."""
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

BASE = 'b698f5d35b0cca12e2c1268f3bea08d0aa1d070e'
CANDIDATE = '98ae49152781815433c604aac1758fb1841716b7'
BRANCH = 'codex/architecture-ai-source-upgrade-witness-20261109'
REPO = 'StradaverseHub/ai-hr'
IMAGE = 'postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97'
APP = 'postgres://ai_hr_app@127.0.0.1:5433/'
ADMIN = 'postgres://postgres@127.0.0.1:5433/'
ROLE = 'personnel-draft-discard-premigration-role-prerequisites.json'
UID = 47106
SELECTED = '["test/module-specialist-release-lifecycle.test.ts"]'
PINS = {
    'package.json': '7f67e35d869a29d2cb58d65c6f63413afc63db2cc6c6cf9dacb5086bce70ec2c',
    'pnpm-lock.yaml': '0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd',
    'pnpm-workspace.yaml': '68505b5f88e6fbd9ef4a309ca131de8e64f1749939d846da2d81e88db14c9369',
    'patches/fontkit@1.9.0.patch': 'b208b0e233a985efb2decb13e5043f8c26955724f0df805849ef7b305773642a',
}


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
        'GITHUB_SHA': controller, 'AIHR_CI_CONTROL_HEAD': controller, 'AIHR_CI_HEAD': CANDIDATE,
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


def main():
    stage = 'admission'
    need(os.getuid() == 0 and sys.platform == 'linux' and len(sys.argv) == 3)
    run, controller, job = admit(os.environ)
    ws, temp = (Path(os.environ[key]).resolve(strict=True) for key in ('GITHUB_WORKSPACE','RUNNER_TEMP'))
    need(ws == Path(os.environ['GITHUB_WORKSPACE']) and temp == Path(os.environ['RUNNER_TEMP']))
    runner = ws.stat().st_uid
    need(runner > 0 and temp.stat().st_uid == runner and runner != UID and os.environ.get('SUDO_UID') == str(runner))
    node, pnpm = (Path(value) for value in sys.argv[1:])
    for program in (node,pnpm):
        need(program.is_absolute() and program.is_file() and os.access(program,os.X_OK))
    base_env = {'PATH': str(node.parent)+':'+str(pnpm.parent)+':/usr/bin:/bin','LANG':'C.UTF-8','TZ':'Asia/Kuala_Lumpur'}
    need(capture([str(node),'--version'],env=base_env).strip() == b'v22.23.3')
    need(capture([str(pnpm),'--version'],env=base_env).strip() == b'10.33.2')
    git = lambda source, *args: capture(['/usr/bin/git','--no-optional-locks','-c','safe.directory='+str(source),
        '-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',*args],cwd=source,env=base_env).decode().strip()
    sources = {'prepare':ws/'baseline','compare':ws/'source'}
    control = ws/'automation'
    for path, wanted in ((control,controller),(sources['prepare'],BASE),(sources['compare'],CANDIDATE)):
        need(path.resolve(strict=True) == path and git(path,'rev-parse','HEAD') == wanted
             and not git(path,'status','--porcelain','--untracked-files=no')
             and git(path,'remote','get-url','origin') in ('https://github.com/'+REPO,'https://github.com/'+REPO+'.git'))
    capture(['/usr/bin/git','-c','safe.directory='+str(sources['compare']),'merge-base','--is-ancestor',BASE,CANDIDATE],
            cwd=sources['compare'],env=base_env)
    verify_dependency_pins(ws)
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

    witness_dir, focus = temp/'aihr-fictional-ai-upgrade-private', temp/'aihr-focused'
    public = temp/'aihr-fictional-ai-upgrade-summary.json'
    root = Path('/var/lib/aihr-fictional-upgrade')
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
    common = {**base_env,**job,'GITHUB_RUN_ID':run,'RUNNER_TEMP':str(temp),'NODE_ENV':'test',
              'HOME':str(witness_dir),'TSX_DISABLE_CACHE':'1','GIT_CONFIG_NOSYSTEM':'1'}
    pg = {**common,'AIHR_CI_UNIT':'db-1','AIHR_CI_PG_PROFILE':'2','AIHR_CI_PG_JIT':'on',
          'AIHR_CI_PG_CONFIGURED_CAP_BYTES':'2113929216','AIHR_CI_PG_PEAK_BUDGET_BYTES':'2147483648'}
    pg_script = control/'.github/ci/postgres.sh'
    name = 'aihr-ci-'+run+'-1-db-1'
    table = 'aihrup_'+run+'_'+os.urandom(8).hex()
    installed = False
    started = False
    uncertain = False
    failed = None
    output = None

    def owned(label, cwd, argv, env, seconds, *, unpriv=True):
        nonlocal uncertain
        env = {**env,'PWD':str(cwd),'GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'safe.directory','GIT_CONFIG_VALUE_0':str(cwd)}
        prefix = ['/usr/bin/setpriv','--reuid='+str(UID),'--regid='+str(UID),'--clear-groups','--no-new-privs'] if unpriv else []
        cmd = [*prefix,'/usr/bin/env','-i',*(f'{key}={value}' for key,value in env.items()),*map(str,argv)]
        fds = [os.dup(1),os.dup(2)]
        prev = Path.cwd()
        log = os.open(custody/(label+'.log'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            os.dup2(log,1); os.dup2(log,2); os.chdir(cwd)
            result = supervisor.supervise(cmd,seconds,lambda _: None)
        except BaseException:
            uncertain = True
            raise
        finally:
            os.chdir(prev); os.close(log)
            for fd, target in zip(fds,(1,2)):
                os.dup2(fd,target); os.close(fd)
        uncertain = not result['groupQuiescent']
        need(not uncertain and result['reason'] == 'complete' and result['commandExit'] == 0)

    docker = lambda *args: capture(['/usr/bin/docker',*args],env=base_env)
    nft = lambda *args, data=None: capture(['/usr/sbin/nft',*args],data=data,env=base_env)

    def container():
        rows = json.loads(docker('container','inspect',name))
        need(len(rows) == 1)
        row = rows[0]
        need(row['Name'] == '/'+name and row['Config']['Labels'].get('aihr-owner') == name and
             row['Config']['Image'] == IMAGE and re.fullmatch(r'[a-f0-9]{64}',row['Id']))
        return row

    def db_identity():
        row = container()
        need(row['State']['Running'] is True and row['HostConfig']['NetworkMode'] == 'host')
        fields = docker('exec',row['Id'],'psql','-X','-Atq','-U','postgres','-p','5433','-d','ai_hr_dev','-c',
            "select system_identifier::text,extract(epoch from pg_postmaster_start_time())::text,"
            "current_setting('listen_addresses'),current_setting('port') from pg_control_system()").decode().strip().split('|')
        need(len(fields) == 4 and fields[2:] == ['127.0.0.1','5433'] and fields[0].isdigit())
        return {'containerId':row['Id'],'containerName':name,'image':IMAGE,'uid':UID,'nftTable':table,
                'postgresSystemId':fields[0],'postmasterEpoch':fields[1],'networkPolicy':'ipv4-loopback-postgres-only-v1'}

    def rules():
        rows = json.loads(nft('-j','list','table','inet',table))['nftables']
        for entry in rows:
            if 'rule' in entry:
                for expression in entry['rule']['expr']:
                    if 'counter' in expression:
                        expression['counter'] = None
        return rows

    def assert_terminal_hook():
        rows = json.loads(nft('-j','list','chains'))['nftables']
        need(all('chain' not in r or r['chain'].get('hook') != 'output'
                 or r['chain'].get('prio',0) < 2147483646 or r['chain'].get('table') == table for r in rows))

    def postgres_listener():
        return capture(['/usr/bin/ss','-H','-ltn','sport = :5433'],env=base_env).strip()

    def interrupt(_signum,_frame):
        raise InterruptedError('Owned fictional run interrupted')

    for sig in (signal.SIGINT,signal.SIGTERM):
        signal.signal(sig,interrupt)
    try:
        stage = 'network'
        assert_terminal_hook()
        nft('-f','-',data=(f'add table inet {table}\n'
            f'add chain inet {table} output {{ type filter hook output priority 2147483646; policy accept; }}\n'
            f'add rule inet {table} output meta skuid {UID} oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
            'tcp dport 5433 ct original ip daddr 127.0.0.1 ct original proto-dst 5433 counter accept\n'
            f'add rule inet {table} output meta skuid {UID} counter reject with icmpx type admin-prohibited\n').encode())
        installed = True
        fence = rules()
        need(len([row for row in fence if 'rule' in row]) == 2)
        stage = 'postgres'
        need(not postgres_listener() and not docker('container','ls','-a','--filter','name=^/'+name+'$','--format','{{.ID}}').strip())
        started = True
        owned('postgres-start',control,['/usr/bin/bash',pg_script,'reset'],pg,90,unpriv=False)
        born = db_identity()
        # All canaries are fixed and use only loopback or reserved documentation addresses.
        canary = 'import socket\nfor host,port,ok in [("127.0.0.1",5433,True),("127.0.0.1",5432,False),("192.0.2.1",443,False),("2001:db8::1",443,False)]:\n try:\n  with socket.create_connection((host,port),2): actual=True\n except OSError: actual=False\n if actual!=ok: raise SystemExit(1)\n'
        owned('network-canary',control,['/usr/bin/python3','-I','-B','-c',canary],common,12)
        native_rules = [r['rule'] for r in json.loads(nft('-j','list','table','inet',table))['nftables'] if 'rule' in r]
        counters = [next(e['counter']['packets'] for e in rule['expr'] if 'counter' in e) for rule in native_rules]
        need(counters[0] >= 1 and counters[1] >= 2)
        for phase, source in sources.items():
            stage = phase+'-migration'
            sha = BASE if phase == 'prepare' else CANDIDATE
            env = {**common,'AIHR_CI_HEAD':sha,'TEST_DB_NAMESPACE':'aifocus','AIHR_FOCUSED_SUITE_CAPACITY':'true',
                   'AIHR_FOCUSED_EVIDENCE_DIR':str(focus),'DATABASE_URL':APP+'ai_hr_dev','MIGRATION_DATABASE_URL':ADMIN+'ai_hr_dev',
                   'TEST_DATABASE_URL':APP+'ai_hr_test','TEST_MIGRATION_DATABASE_URL':ADMIN+'ai_hr_test'}
            need(rules() == fence and db_identity() == born and not (focus/ROLE).exists())
            assert_terminal_hook()
            owned(stage,source,[pnpm,'db:migrate'],env,360)
            if phase == 'prepare':
                owned('catalogs',source,[pnpm,'exec','tsx','scripts/seed-catalogs.ts'],env,80)
            role_path = focus/ROLE
            need(role_path.lstat().st_uid == UID)
            role = plain(role_path)
            decoded = json.loads(role)
            need(decoded.get('candidate') == sha and decoded.get('controller') == controller
                 and decoded.get('runId') == run and decoded.get('attempt') == '1')
            write(custody/(phase+'-roles.json'),role,0o444)
            role_path.unlink()
            packet = {'kind':'AIHR_FICTIONAL_AI_UPGRADE_DISPOSABLE_CUSTODY','version':1,'releaseAuthorized':False,
                'phase':phase,'baseline':BASE,'candidate':CANDIDATE,'controller':controller,'runId':run,'attempt':1,
                'source':sha,'host':born,'prerequisiteSha256':digest(role),
                'witnessSha256':digest(plain(controlled/'fictional-ai-source-upgrade.mts')),
                'admissionSha256':digest(plain(controlled/'fictional-ai-upgrade-canonical-admission.mjs'))}
            write(custody/(phase+'-custody.json'),json.dumps(packet).encode(),0o444)
            stage = phase+'-witness'
            need(rules() == fence and db_identity() == born)
            owned(stage,source,[node,'--conditions=react-server','--import','tsx','scripts/fictional-ai-source-upgrade.mts',phase],
                  {**common,'AIHR_CI_HEAD':sha,'AIHR_AI_UPGRADE_ARTIFACT_DIR':str(witness_dir),
                   'TEST_DATABASE_URL':APP+'ai_hr_dev','TEST_MIGRATION_DATABASE_URL':ADMIN+'ai_hr_dev'},120)
            need(rules() == fence and db_identity() == born)
        stage = 'result'
        output = json.loads(plain(witness_dir/'after.json'))
        need(output == {'status':'PASS','baseline':BASE,'candidate':CANDIDATE,'controller':controller,'runId':run,
            'attempt':1,'retainedTables':14,'ledgerBefore':723,'ledgerAfter':764,'oldReplay':'unavailable',
            'fallbackReplay':'baseline','currentReplay':'promoted','oldPermitsUsed':1,'currentPermitsUsed':1,
            'sourceChangedRollbacks':1,'releaseAuthorized':False})
    except BaseException:
        failed = stage
    finally:
        try:
            need(not uncertain)
            if started and docker('container','ls','-a','--filter','name=^/'+name+'$','--format','{{.ID}}').strip():
                container()
                owned('postgres-stop',control,['/usr/bin/bash',pg_script,'stop'],pg,30,unpriv=False)
                need(not postgres_listener() and not docker('container','ls','-a','--filter','name=^/'+name+'$','--format','{{.ID}}').strip())
            if installed:
                nft('delete','table','inet',table)
                need(not any(row.get('table',{}).get('name') == table
                             for row in json.loads(nft('-j','list','tables'))['nftables']))
        except BaseException:
            failed = failed or 'settlement'
            uncertain = True
    if failed:
        output = {'status':'FAIL','baseline':BASE,'candidate':CANDIDATE,'controller':controller,'runId':run,
                  'attempt':1,'firstFailedStage':failed,'settled':not uncertain,'releaseAuthorized':False}
    else:
        output['settled'] = True
    write(public,(json.dumps(output,separators=(',',':'))+'\n').encode(),0o644)
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        if sys.argv[1:] in (['--admit-event'],['--admit-only']):
            admit(os.environ,'resolve' if sys.argv[1] == '--admit-event' else 'selected-tests')
            if sys.argv[1] == '--admit-only':
                verify_dependency_pins(Path(os.environ['GITHUB_WORKSPACE']))
        else:
            raise SystemExit(main())
    except Exception:
        print('Fictional upgrade owner failed before a bounded result was available.',file=sys.stderr)
        raise SystemExit(1)
