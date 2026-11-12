"""Production first activation of the protected import worker (production runbook section 6).
No entry point or source imports: scripts/bank-import-worker-production-bundle.py supplies the reviewed
format, first-install and update modules. This file grants no release or production authority; running
it on production needs the owner's separate, explicit go-ahead.

It adopts, and never rewrites, the existing `aihr-import` identity and the protected
/etc/aihr/import-worker.env (pinned by sha256, reviewed keys only, a remote database only over
sslmode=verify-full). The web must be the exact pinned source and build. Any aihr-bank-import unit,
drop-in, link or worker-identity process refuses. Prior releases, environment and identity are kept.
After the unit exists, any failure enters the same SIGKILL-free quarantine as the staging update.
"""
import argparse
import fcntl
import grp
import hashlib
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys
import tempfile
import time
from urllib.parse import parse_qsl, unquote, urlsplit

MODE = 'production-first-install'
WEB_SOURCE = Path('/opt/ai-hr')
WEB_USER = 'aihr'
PROC = Path('/proc')
PSQL = '/usr/bin/psql'
UNIT_PREFIX = 'aihr-bank-import'
UNIT_DIRECTORIES = ('/etc/systemd/system', '/etc/systemd/system.control', '/run/systemd/system', '/run/systemd/system.control',
                    '/run/systemd/transient', '/run/systemd/generator', '/run/systemd/generator.early', '/run/systemd/generator.late',
                    '/usr/local/lib/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system')
LINK_DIRECTORY_SUFFIXES = ('.wants', '.requires', '.upholds')
NOLOGIN_SHELLS = ('/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false')
REQUIRED_KEYS = ('DATABASE_URL', 'MIGRATION_DATABASE_URL')
TLS_FILE_KEYS = ('NODE_EXTRA_CA_CERTS', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY')
URI_OPTIONS = {'sslmode', 'sslrootcert', 'sslcert', 'sslkey'}
LOOPBACK = ('localhost', '127.0.0.1', '::1')
LOADER_KEYS = ('NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH')
UNIT_ENVIRONMENT = {'NODE_ENV': 'production', 'AIHR_DB_PROCESS_ROLE': 'worker', 'AIHR_DB_POOL_MAX': '2'}
ENV_LINE = re.compile(r'([A-Z_][A-Z0-9_]*)=(.*)')
# Only characters that systemd's EnvironmentFile= parser passes through literally when unquoted.
UNQUOTED_VALUE = re.compile(r"[A-Za-z0-9._~%:/?@=&+,!*()\[\]_-]+")
QUOTED_FORBIDDEN = set('"\'\\$`')
WORKER_FIELDS = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'DropInPaths', 'UnitFileState', 'ControlGroup']
WEB_FIELDS = ['ActiveState', 'SubState', 'MainPID', 'User', 'WorkingDirectory']
ROLE_PROOF_SQL = ("SELECT json_build_object('role',current_user,'database',current_database(),'super',r.rolsuper,'bypass',r.rolbypassrls,"
                  "'owner',c.relowner=r.oid)::text FROM pg_roles r JOIN pg_class c ON c.oid='public.bank_import_job'::regclass "
                  "WHERE r.rolname=current_user;")


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def show(base, unit, fields):
    raw = base.command(['/usr/bin/systemctl', 'show', unit, '--no-pager', *['--property=' + field for field in fields]]).stdout
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def release_manifest(base, args):
    """The private package's release-manifest.json, authenticated by its pinned sha256 (from SHA256SUMS)."""
    path = Path(args.release_manifest)
    base.check(path.is_absolute(), 'absolute release manifest path required')
    raw = base.read_bounded(path, 1024**2)
    base.check(digest(raw) == args.release_manifest_sha256, 'release manifest differs from the pinned sha256')
    try:
        manifest = json.loads(raw)
    except ValueError:
        manifest = None
    base.check(isinstance(manifest, dict) and manifest.get('schemaVersion') == 1 and manifest.get('commit') == args.source and
               manifest.get('buildId') == args.build_id and manifest.get('platform') == 'linux' and manifest.get('architecture') == 'x86_64',
               'pinned release manifest does not name this exact source and build')
    return raw


def production_web_state(base, args):
    """Customer web identity without staging deployment receipts: the running aihr service from /opt/ai-hr,
    the installed BUILD_ID equal to the pinned build, and loopback health, bracketed by an unchanged service PID."""
    def identity():
        report = show(base, 'aihr.service', WEB_FIELDS)
        base.check(report.get('ActiveState') == 'active' and report.get('SubState') == 'running' and
                   report.get('MainPID', '0').isdigit() and int(report.get('MainPID', '0')) > 0 and
                   report.get('User') == WEB_USER and report.get('WorkingDirectory') == str(WEB_SOURCE),
                   'web is not the running customer aihr service')
        build = base.read_bounded(WEB_SOURCE / '.next' / 'BUILD_ID', 1024).decode('ascii', 'replace').strip()
        base.check(build == args.build_id, 'installed web build differs from the pinned build')
        return {'webMainPid': report['MainPID'], 'webBuildId': build}
    before = identity()
    connection = HTTPConnection('127.0.0.1', args.web_port, timeout=8)
    try:
        connection.request('GET', '/health', headers={'Connection': 'close'})
        response = connection.getresponse()
        raw = response.read(4097)
        try:
            body = json.loads(raw) if len(raw) <= 4096 else None
        except ValueError:
            body = None
        base.check(response.status == 200 and body == {'status': 'ok'}, 'current web health is not confirmed')
    finally:
        connection.close()
    base.check(identity() == before, 'web identity changed during health verification')
    return before


def unit_names(directory):
    names = []
    for entry in directory.iterdir():
        names.append(entry.name)
        if entry.name.endswith(LINK_DIRECTORY_SUFFIXES) and entry.is_dir():
            names.extend(child.name for child in entry.iterdir())
    return names


def no_worker_unit(base):
    """First activation only: no unit file, template, drop-in or enablement link anywhere, and nothing loaded."""
    for folder in UNIT_DIRECTORIES:
        directory = Path(folder)
        if directory.is_dir():
            base.check(not any(name.startswith(UNIT_PREFIX) for name in unit_names(directory)),
                       'an aihr-bank-import unit, drop-in or link already exists; this route is for a first activation only')
    report = show(base, UNIT_PREFIX + '.service', WORKER_FIELDS)
    # systemd 255 omits unset properties from `systemctl show --property=`; absent means unset.
    base.check(report.get('LoadState') == 'not-found' and report.get('ActiveState', 'inactive') == 'inactive' and
               report.get('MainPID', '0') == '0' and
               all(report.get(key, '') == '' for key in ('FragmentPath', 'DropInPaths', 'UnitFileState', 'ControlGroup')),
               'systemd already knows an aihr-bank-import unit; this route is for a first activation only')


def existing_identity(base, uid):
    """Adopt the existing dedicated system identity exactly as pinned; never create or modify it."""
    try:
        identity = pwd.getpwnam(base.USER)
    except KeyError:
        identity = None
    base.check(identity is not None, 'existing worker identity aihr-import is required')
    base.check(identity.pw_uid == uid and 0 < uid < 1000, 'worker identity is not the pinned system uid')
    base.check(sum(1 for entry in pwd.getpwall() if entry.pw_uid == uid) == 1, 'worker uid is shared with another account')
    try:
        primary = grp.getgrgid(identity.pw_gid)
    except KeyError:
        primary = None
    groups = grp.getgrall()
    base.check(identity.pw_gid > 0 and primary is not None and primary.gr_name == base.USER and
               sum(1 for group in groups if group.gr_gid == identity.pw_gid) == 1, 'worker identity must have its own primary group')
    base.check(not any(base.USER in group.gr_mem for group in groups), 'worker identity must have no supplementary groups')
    base.check(identity.pw_shell in NOLOGIN_SHELLS, 'worker identity must not have a login shell')
    home = Path(identity.pw_dir)
    if home.exists() or home.is_symlink():
        info = home.lstat()
        base.check(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                   'worker home must be absent or root-owned and not writable')
    return identity


def protected_environment(base, identity, pinned):
    """The existing environment file is adopted, never rewritten: root-owned, not world-readable, exact pinned bytes."""
    base.root_protected(base.ENV, regular=True)
    info = base.ENV.lstat()
    mode = stat.S_IMODE(info.st_mode)
    base.check(mode in (0o600, 0o400) or (mode in (0o640, 0o440) and info.st_gid in (0, identity.pw_gid)),
               'protected worker environment must be 0600 root:root or 0640 root:aihr-import')
    raw = base.read_bounded(base.ENV, 1024**2)
    base.check(digest(raw) == pinned, 'protected worker environment differs from the pinned sha256')
    return raw


def parse_environment(base, raw):
    """A closed subset of systemd's EnvironmentFile= syntax. Messages never include keys or values."""
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        text = None
    base.check(text is not None, 'protected worker environment is not UTF-8')
    values = {}
    for line in text.split('\n'):
        if line == '' or line.startswith('#'):
            continue
        match = ENV_LINE.fullmatch(line)
        base.check(match is not None, 'protected worker environment has unreviewed syntax (values withheld)')
        key, value = match.groups()
        base.check(key in base.ENV_KEYS, 'protected worker environment has an unreviewed key (values withheld)')
        base.check(key not in values, 'protected worker environment repeats a key')
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
            base.check(value != '' and not set(value) & QUOTED_FORBIDDEN and not any(ord(c) < 32 or ord(c) == 127 for c in value),
                       'protected worker environment has an unreviewed quoted value (values withheld)')
        else:
            base.check(UNQUOTED_VALUE.fullmatch(value) is not None, 'protected worker environment has an unreviewed value (values withheld)')
        base.check(len(value) <= 65536, 'protected worker environment value exceeds bound')
        values[key] = value
    base.check(all(key in values for key in REQUIRED_KEYS), 'protected worker environment lacks a database URL')
    return values


def database_config(base, value, role):
    """Expected role on database ai_hr. Loopback may omit TLS; any other host needs exactly sslmode=verify-full.
    Parse errors are converted outside the handler so no traceback can carry the URI."""
    parsed = None
    try:
        candidate = urlsplit(value)
        port = candidate.port
        pairs = parse_qsl(candidate.query, keep_blank_values=True, strict_parsing=True) if candidate.query else []
        parsed = candidate
    except ValueError:
        pass
    base.check(parsed is not None and parsed.scheme in ('postgres', 'postgresql') and bool(parsed.hostname) and not parsed.fragment,
               'database URI must name a PostgreSQL host (value withheld)')
    base.check(unquote(parsed.username or '') == role and bool(parsed.password) and unquote(parsed.path) == '/ai_hr',
               'database URI does not use the expected role on database ai_hr (value withheld)')
    options = dict(pairs)
    base.check(len(options) == len(pairs) and set(options) <= URI_OPTIONS, 'database URI has unexpected connection options (value withheld)')
    remote = parsed.hostname not in LOOPBACK
    base.check(not remote or options.get('sslmode') == 'verify-full', 'a non-loopback database requires sslmode=verify-full (value withheld)')
    config = {'PGHOST': parsed.hostname, 'PGPORT': str(port or 5432), 'PGUSER': role, 'PGPASSWORD': unquote(parsed.password),
              'PGDATABASE': 'ai_hr', **{'PG' + key.upper(): item for key, item in options.items()}}
    return config, remote


def tls_files(base, environment, configs, remote):
    """A remote database needs a root-protected CA for Node (NODE_EXTRA_CA_CERTS) and for libpq (PGSSLROOTCERT)."""
    if remote:
        base.check(bool(environment.get('NODE_EXTRA_CA_CERTS')), 'a non-loopback database requires NODE_EXTRA_CA_CERTS')
        base.check(all(config.get('PGSSLROOTCERT') or environment.get('PGSSLROOTCERT') for config in configs),
                   'a non-loopback database requires PGSSLROOTCERT')
        base.check(environment.get('PGSSLMODE') in (None, 'verify-full'), 'a non-loopback database requires PGSSLMODE to be verify-full when set')
    paths = set()
    for key in TLS_FILE_KEYS:
        paths |= {environment.get(key), *(config.get(key) for config in configs)} - {None, ''}
    for path in sorted(paths):
        base.root_protected(path, regular=True)
    return sorted(paths)


def database_role_proof(base, environment, app, owner):
    """Bounded read-only live proof: app role is neither superuser nor BYPASSRLS; owner owns the queue table."""
    for config, is_owner in [(app, False), (owner, True)]:
        settings = {**base.BASE_ENV, **{k: v for k, v in environment.items() if k.startswith('PGSSL')}, **config, 'PGPASSFILE': '/dev/null',
                    'PGCONNECT_TIMEOUT': '5', 'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000'}
        output = base.command([PSQL, '-X', '-q', '-A', '-t', '--no-password', '-v', 'ON_ERROR_STOP=1'], input=ROLE_PROOF_SQL, env=settings).stdout
        try:
            proof = json.loads(output)
        except ValueError:
            proof = None
        base.check(isinstance(proof, dict) and proof.get('role') == config['PGUSER'] and proof.get('database') == 'ai_hr' and
                   proof.get('owner') is is_owner and (is_owner or (proof.get('super') is False and proof.get('bypass') is False)),
                   'live database role/table-ownership proof differs')


def readable_by_worker(base, paths, directories=()):
    for path in paths:
        base.command(['/usr/sbin/runuser', '--user', base.USER, '--', '/usr/bin/test', '-r', str(path)])
    for path in directories:
        base.command(['/usr/sbin/runuser', '--user', base.USER, '--', '/usr/bin/test', '-x', str(path)])


def preconditions(base, update, args):
    """Read-only. Everything a refusal depends on, evaluated before and again immediately before unit creation."""
    manifest_raw = release_manifest(base, args)
    web = production_web_state(base, args)
    no_worker_unit(base)
    identity = existing_identity(base, args.existing_uid)
    base.check(not update.unit_or_identity_processes(identity.pw_uid), 'a process runs as aihr-import or inside an aihr-bank-import cgroup')
    raw = protected_environment(base, identity, args.worker_env_sha256)
    environment = parse_environment(base, raw)
    app, app_remote = database_config(base, environment['DATABASE_URL'], 'ai_hr_app')
    owner, owner_remote = database_config(base, environment['MIGRATION_DATABASE_URL'], 'ai_hr_owner')
    base.check((app['PGHOST'], app['PGPORT'], app['PGDATABASE']) == (owner['PGHOST'], owner['PGPORT'], owner['PGDATABASE']) and
               app_remote == owner_remote, 'app and owner URLs must target the same database endpoint')
    files = tls_files(base, environment, (app, owner), app_remote)
    return {'manifestRaw': manifest_raw, 'web': web, 'identity': identity, 'environment': environment, 'app': app, 'owner': owner,
            'remote': app_remote, 'tlsFiles': files}


def create_unit(base, raw, progress):
    """Atomic no-clobber creation: a fully written, fsynced file is hard-linked into place, never replacing anything."""
    base.root_protected(base.UNIT.parent)
    base.check(not base.UNIT.exists() and not base.UNIT.is_symlink(), 'worker unit appeared before creation')
    fd, name = tempfile.mkstemp(prefix='.aihr-worker-install-', dir=base.UNIT.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o644)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(name, base.UNIT)
        progress['unitCreated'] = True
        directory = os.open(base.UNIT.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.lexists(name):
            os.unlink(name)


def validate_worker(base, report, release, identity, environment):
    """Live main process: worker uid (real/effective/saved/fs), release cwd, fixed command, exact selected environment."""
    pid = int(report.get('MainPID', '0') or '0')
    base.check(pid > 0 and report.get('ActiveState') == 'active' and report.get('SubState') == 'running' and
               report.get('NRestarts') == '0' and report.get('NeedDaemonReload') == 'no', 'worker must remain running without restarts')
    process = PROC / str(pid)
    status = base.read_bounded(process / 'status', 65536)
    uids = next((line.split()[1:] for line in status.splitlines() if line.startswith(b'Uid:')), [])
    base.check(len(uids) == 4 and all(item == str(identity.pw_uid).encode() for item in uids), 'live worker identity differs')
    base.check((process / 'cwd').resolve() == release, 'live worker release differs')
    base.check(base.read_bounded(process / 'cmdline', 65536).split(b'\0')[:-1] ==
               [str(base.NODE).encode(), b'--import', b'tsx', b'scripts/bank-import-runner.ts'], 'live worker command differs')
    actual = dict(item.split(b'=', 1) for item in base.read_bounded(process / 'environ', 1024**2).split(b'\0') if b'=' in item)
    expected = {**environment, **UNIT_ENVIRONMENT}
    base.check(all(actual.get(key.encode()) == value.encode() for key, value in expected.items()), 'live worker environment differs (values withheld)')
    base.check(not any(key.encode() in actual for key in LOADER_KEYS), 'unexpected worker loader environment')
    return pid


def first_install(argv, fmt, base, update):
    parser = argparse.ArgumentParser(description='Production first activation of aihr-bank-import.service. Grants no release authority.')
    parser.add_argument('mode', choices=[MODE])
    names = ('source', 'build-id', 'web-port', 'release-manifest', 'release-manifest-sha256', 'archive', 'archive-sha256',
             'lock-sha256', 'package-sha256', 'worker-env-sha256', 'existing-uid')
    for name in names:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args(argv)
    base.check(os.geteuid() == 0, 'root must run the independently hash-pinned self-contained bundle with Python -I')
    base.check(re.fullmatch('[a-f0-9]{40}', args.source) is not None and re.fullmatch('[A-Za-z0-9_-]{1,160}', args.build_id) is not None,
               'exact source and build identity required')
    for value in (args.release_manifest_sha256, args.archive_sha256, args.lock_sha256, args.package_sha256, args.worker_env_sha256):
        base.check(re.fullmatch('[a-f0-9]{64}', value) is not None, 'independently authenticated digests required')
    base.check(re.fullmatch('[1-9][0-9]{0,4}', args.web_port) is not None and int(args.web_port) <= 65535, 'exact loopback web port required')
    base.check(re.fullmatch('[1-9][0-9]{0,9}', args.existing_uid) is not None, 'pinned existing worker uid required')
    args.web_port = int(args.web_port)
    args.existing_uid = int(args.existing_uid)
    base.root_protected(base.NODE, regular=True)
    base.check(base.command([str(base.NODE), '--version']).stdout.strip() == 'v22.23.3', 'reviewed worker runtime required')
    lock = base.install_lock_directory() / 'install.lock'
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    base.check(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o077, 'private administrator lock required')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        releases = base.ROOT / 'releases'
        base.root_protected(base.ROOT)
        base.root_protected(releases)
        facts = preconditions(base, update, args)
        identity, environment = facts['identity'], facts['environment']
        readable_by_worker(base, facts['tlsFiles'], (base.ROOT, releases))
        database_role_proof(base, environment, facts['app'], facts['owner'])
        release = releases / args.source
        operation = base.ROOT / 'installs' / args.source
        base.check(not release.exists() and not release.is_symlink(), 'immutable release already exists')
        base.check(not operation.exists() and not operation.is_symlink(), 'existing installation attempt needs separate recovery review')
        # First write. Everything above is read-only apart from the shared administrator lock.
        if not operation.parent.exists():
            operation.parent.mkdir(mode=0o700)
        base.root_protected(operation.parent)
        operation.mkdir(mode=0o700)
        observation = {'mode': MODE, 'source': args.source, 'webBuildId': args.build_id, 'web': facts['web'],
                       'releaseManifestSha256': args.release_manifest_sha256, 'existingUid': identity.pw_uid,
                       'workerEnvSha256': args.worker_env_sha256, 'environmentKeys': sorted(environment),
                       'remoteDatabaseTls': facts['remote'], 'priorReleases': sorted(p.name for p in releases.iterdir())}
        base.write_new(operation / 'preflight.json', fmt.canonical(observation), 0o400)
        archive = operation / 'authenticated-worker.zip'
        base.snapshot_archive(args.archive, archive, args.archive_sha256, fmt.MAX_ARCHIVE)
        manifest = fmt.inspect_archive(archive, args.source, args.lock_sha256, args.package_sha256)
        manifest_sha256 = fmt.digest(fmt.canonical(manifest))
        release = update.stage_release(base, fmt, archive, operation, args, manifest)
        readable_by_worker(base, [release / 'package.json', release / 'scripts' / 'bank-import-runner.ts'], (release,))
        # Re-verify every refusal condition immediately before the unit exists.
        again = preconditions(base, update, args)
        base.check({key: again[key] for key in ('manifestRaw', 'web', 'environment', 'tlsFiles')} ==
                   {key: facts[key] for key in ('manifestRaw', 'web', 'environment', 'tlsFiles')} and
                   again['identity'].pw_uid == identity.pw_uid, 'installation facts changed during preparation')
        unit = base.service_unit(args.source).encode()
        progress = {'unitCreated': False}
        try:
            create_unit(base, unit, progress)
            base.command(['/usr/bin/systemctl', 'daemon-reload'])
            report = update.properties(base)
            base.validate_service(report, release)
            base.check(report.get('Restart') == 'on-failure' and report.get('NeedDaemonReload') == 'no', 'created service is not the reviewed configuration')
            base.command(['/usr/bin/systemctl', 'start', 'aihr-bank-import.service'])
            stable_pid = None
            for _ in range(3):
                time.sleep(4)
                report = update.properties(base)
                base.validate_service(report, release)
                pid = validate_worker(base, report, release, identity, environment)
                base.check(stable_pid in (None, pid), 'worker PID changed')
                stable_pid = pid
            base.check(production_web_state(base, args) == facts['web'], 'web changed before worker acceptance')
            base.check(digest(protected_environment(base, identity, args.worker_env_sha256)) == args.worker_env_sha256,
                       'worker environment changed during activation')
            base.command(['/usr/bin/systemctl', 'enable', 'aihr-bank-import.service'])
            report = update.properties(base)
            base.check(report.get('UnitFileState') == 'enabled', 'worker is not enabled for boot')
            validate_worker(base, report, release, identity, environment)
            accepted = {'mode': MODE, 'source': args.source, 'webBuildId': args.build_id, 'archiveSha256': args.archive_sha256,
                        'manifestSha256': manifest_sha256, 'releaseManifestSha256': args.release_manifest_sha256,
                        'selectedEnvironmentSha256': args.worker_env_sha256, 'existingUid': identity.pw_uid,
                        'unitSha256': digest(unit), 'workerPid': stable_pid, 'serviceStable': True, 'journeyVerified': False}
            base.write_new(release / 'worker-install-v2.json', fmt.canonical(accepted), 0o444)
            base.write_new(operation / 'activated.json', fmt.canonical(accepted), 0o400)
            print(json.dumps(accepted, sort_keys=True))
            return accepted
        except Exception:
            if not progress['unitCreated']:
                raise
            observed = update.quiesce_failed_activation(base, operation, args.source)
            print(json.dumps({'workerActivationFailed': True, **observed}, sort_keys=True), file=sys.stderr)
            raise RuntimeError('Worker activation failed; retained packages and protected failure observations require explicit administrator recovery') from None
    finally:
        os.close(fd)
