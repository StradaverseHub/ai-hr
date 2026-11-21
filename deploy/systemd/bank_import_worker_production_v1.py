"""Production activation, update and rollback of the protected import worker (deploy/systemd/BANK-IMPORT.md).
No entry point or source imports: scripts/bank-import-worker-production-bundle.py supplies the reviewed
format, first-install and update modules. This file grants no release or production authority; running
it on production needs the owner's separate, explicit go-ahead.

production-first-install adopts, and never rewrites, the existing `aihr-import` identity and the protected
/etc/aihr/import-worker.env (pinned by sha256, reviewed keys only, a remote database only over
sslmode=verify-full). The web must be the exact pinned source and build. Any aihr-bank-import unit,
drop-in, link or worker-identity process refuses. Prior releases, environment and identity are kept.
After the unit exists, any failure enters the same SIGKILL-free quarantine as the staging update.

production-drain / production-activate update an exact managed production release in place of the staging
drain/activate (which needs staging deployment records): the web identity is the customer web check below.
production-rollback re-activates the pinned previous release of a production update attempt.
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
DRAIN = 'production-drain'
ACTIVATE = 'production-activate'
ROLLBACK = 'production-rollback'
PHASES = (MODE, DRAIN, ACTIVATE, ROLLBACK)
# Receipts a production phase may build on: written by production-first-install or production-activate only.
PRODUCTION_RECEIPTS = ('production-first-install', 'production-update')
DRAIN_SECONDS = 330
UPDATE_ARGS = ('previous-worker-source', 'unit-sha256', 'previous-web-source', 'previous-web-build', 'source', 'build-id', 'web-port',
               'release-manifest', 'release-manifest-sha256', 'archive', 'archive-sha256', 'lock-sha256', 'package-sha256',
               'worker-env-sha256', 'existing-uid')
ROLLBACK_ARGS = ('from-source', 'to-source', 'unit-sha256', 'to-unit-sha256', 'web-source', 'web-build', 'web-port',
                 'worker-env-sha256', 'existing-uid')
# Optional for production-drain, production-activate and production-rollback: the environment sha recorded in the previous
# release's receipt, when an operator added a reviewed key after that activation. Omitted, the receipt must record
# --worker-env-sha256. The current file always equals --worker-env-sha256.
PREVIOUS_ENV_ARG = 'previous-worker-env-sha256'
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
    return {'manifestRaw': manifest_raw, 'web': web, 'identity': identity, **worker_environment(base, identity, args.worker_env_sha256)}


def worker_environment(base, identity, pinned):
    """Pinned protected environment, its closed syntax, both database URLs on one endpoint, and the TLS files."""
    raw = protected_environment(base, identity, pinned)
    environment = parse_environment(base, raw)
    app, app_remote = database_config(base, environment['DATABASE_URL'], 'ai_hr_app')
    owner, owner_remote = database_config(base, environment['MIGRATION_DATABASE_URL'], 'ai_hr_owner')
    base.check((app['PGHOST'], app['PGPORT'], app['PGDATABASE']) == (owner['PGHOST'], owner['PGPORT'], owner['PGDATABASE']) and
               app_remote == owner_remote, 'app and owner URLs must target the same database endpoint')
    files = tls_files(base, environment, (app, owner), app_remote)
    return {'environment': environment, 'app': app, 'owner': owner, 'remote': app_remote, 'tlsFiles': files}


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
    return worker_process(base, pid, release, identity, environment)


def worker_process(base, pid, release, identity, environment):
    """procfs proof for one main PID; shared by activation and by the drain of an already-running managed worker."""
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


# Production update and rollback. The staging drain/activate needs /var/tmp/aihr-deploy records and the v2 environment
# format; production has neither, so these phases use the customer web check and the adopted environment parser above
# and reuse the staging update's reviewed unit, release, process-scan and quarantine internals.

def quarantine_unit(base, source):
    """The exact unit bytes update.quiesce_failed_activation writes for this source."""
    return base.service_unit(source).replace('Restart=on-failure\n', 'Restart=no\nSendSIGKILL=no\n').encode()


def validated_arguments(base, args, sources, builds, digests):
    base.check(os.geteuid() == 0, 'root must run the independently hash-pinned self-contained bundle with Python -I')
    if args.previous_worker_env_sha256 is not None:
        digests = (*digests, args.previous_worker_env_sha256)
        base.check(args.previous_worker_env_sha256 != args.worker_env_sha256, 'omit --previous-worker-env-sha256 when the environment is unchanged')
    for value in sources:
        base.check(re.fullmatch('[a-f0-9]{40}', value) is not None, 'exact sources required')
    for value in builds:
        base.check(re.fullmatch('[A-Za-z0-9_-]{1,160}', value) is not None, 'exact builds required')
    for value in digests:
        base.check(re.fullmatch('[a-f0-9]{64}', value) is not None, 'independently authenticated digests required')
    base.check(re.fullmatch('[1-9][0-9]{0,4}', args.web_port) is not None and int(args.web_port) <= 65535, 'exact loopback web port required')
    base.check(re.fullmatch('[1-9][0-9]{0,9}', args.existing_uid) is not None, 'pinned existing worker uid required')
    args.web_port = int(args.web_port)
    args.existing_uid = int(args.existing_uid)
    base.root_protected(base.NODE, regular=True)
    base.check(base.command([str(base.NODE), '--version']).stdout.strip() == 'v22.23.3', 'reviewed worker runtime required')


def administrator_lock(base):
    """The private flock shared with first-install, the staging update and the v2 installer."""
    fd = os.open(base.install_lock_directory() / 'install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        base.check(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o077,
                   'private administrator lock required')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(fd)
        raise
    return fd


def absent(base, path, message):
    base.check(not path.exists() and not path.is_symlink(), message)


def fsync_directory(path):
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def cleanly_exited(report):
    return (report.get('MainPID') == '0' and report.get('ActiveState') == 'inactive' and report.get('SubState') == 'dead' and
            report.get('Result') == 'success' and report.get('ExecMainStatus') == '0')


def quiet(base, update, identity):
    """systemd tracks no control group and no live process runs as the worker identity or inside the unit cgroup."""
    return update.stopped_runtime(base).get('ControlGroup', '') == '' and not update.unit_or_identity_processes(identity.pw_uid)


def running_worker(base, report, release, identity, environment):
    """An already-running managed worker; an earlier automatic restart is allowed here, a restart during the drain is not."""
    pid = int(report.get('MainPID', '0') or '0')
    base.check(pid > 0 and report.get('ActiveState') == 'active' and report.get('SubState') == 'running' and
               report.get('NeedDaemonReload') == 'no', 'previous worker is neither running nor cleanly stopped')
    return worker_process(base, pid, release, identity, environment)


def drain_worker(base, update, initial, release, identity, environment, progress):
    """SIGTERM to the main process only: the runner finishes its current tick and exits 0. A bounded observation that never
    sends SIGKILL, arms systemd's timed stop, disables the unit or replays a job. A restart, PID change or unclean exit refuses."""
    pid = running_worker(base, initial, release, identity, environment)
    base.check(update.properties(base) == initial, 'service changed before managed drain')
    base.command(['/usr/bin/systemctl', 'kill', '--kill-whom=main', '--signal=SIGTERM', UNIT_PREFIX + '.service'])
    progress['signalled'] = True
    deadline = time.monotonic() + DRAIN_SECONDS
    while time.monotonic() < deadline:
        report = update.properties(base)
        base.validate_service(report, release)
        base.check(report.get('NRestarts') == initial.get('NRestarts'), 'worker restarted during drain')
        current = int(report.get('MainPID', '0') or '0')
        base.check(current in (0, pid), 'worker PID changed during drain')
        if current == 0 and report.get('ActiveState') == 'inactive' and report.get('SubState') == 'dead':
            base.check(report.get('Result') == 'success' and report.get('ExecMainStatus') == '0', 'worker did not exit successfully')
            time.sleep(2)
            base.check(update.properties(base) == report and quiet(base, update, identity), 'worker did not remain drained')
            return {'pid': pid, 'state': 'drained', 'alreadyStopped': False, 'forcedKill': False}
        base.check(report.get('ActiveState') in ('active', 'activating', 'deactivating'), 'worker drain entered an unexpected state')
        time.sleep(2)
    raise RuntimeError('Worker drain deadline reached; nothing was killed and the prior unit is unchanged. Let the runner finish '
                       'its tick, confirm a clean exit, then run production-drain again')


def pinned_web(base, source, build, port):
    """production_web_state for one pinned build, labelled with the source that pin names."""
    return {**production_web_state(base, argparse.Namespace(build_id=build, web_port=port)), 'webSource': source}


def window_web(base, args, phase):
    """Activation needs the exact new web. While draining, the web may still be the exact previous one."""
    live = base.read_bounded(WEB_SOURCE / '.next' / 'BUILD_ID', 1024).decode('ascii', 'replace').strip()
    pins = [(args.source, args.build_id)] + ([(args.previous_web_source, args.previous_web_build)] if phase == DRAIN else [])
    match = next((pin for pin in pins if pin[1] == live), None)
    base.check(match is not None, 'installed web build is not a pinned build for ' + phase)
    return pinned_web(base, match[0], match[1], args.web_port)


def managed_release(base, update, source, unit_sha256, env_sha256, receipt_env_sha256=None):
    """The exact pinned managed production release: receipt, template unit, loaded service and environment pin."""
    report = update.validate_existing(base, source, unit_sha256, env_sha256, receipt_env_sha256)
    receipt = json.loads(base.read_bounded(base.ROOT / 'releases' / source / 'worker-install-v2.json', 65536))
    base.check(receipt.get('mode') in PRODUCTION_RECEIPTS and isinstance(receipt.get('webBuildId'), str),
               'previous worker receipt is not a managed production installation')
    base.check(report.get('UnitFileState') == 'enabled', 'previous worker is not enabled for boot')
    return report, receipt


COMPARED = ('manifestRaw', 'web', 'report', 'receipt', 'uid', 'environment', 'tlsFiles', 'workerState')


def update_facts(base, update, args, phase):
    """Read-only. Evaluated before preparation and again immediately before the signal (drain) or unit replacement (activate)."""
    manifest_raw = release_manifest(base, args)
    web = window_web(base, args, phase)
    report, receipt = managed_release(base, update, args.previous_worker_source, args.unit_sha256, args.worker_env_sha256,
                                      args.previous_worker_env_sha256)
    if args.previous_web_source == args.previous_worker_source:
        base.check(receipt.get('webBuildId') == args.previous_web_build, 'previous web build differs from the previous worker receipt')
    identity = existing_identity(base, args.existing_uid)
    facts = {'manifestRaw': manifest_raw, 'web': web, 'report': report, 'receipt': receipt, 'uid': identity.pw_uid,
             **worker_environment(base, identity, args.worker_env_sha256)}
    if report.get('MainPID', '0') != '0':
        base.check(phase == DRAIN, 'previous worker is not drained')
        running_worker(base, report, base.ROOT / 'releases' / args.previous_worker_source, identity, facts['environment'])
        facts['workerState'] = 'running'
    else:
        base.check(cleanly_exited(report) and quiet(base, update, identity), 'previous worker is neither running nor cleanly stopped')
        facts['workerState'] = 'stopped'
    return facts, identity


def production_drain(base, fmt, update, args, operations, pins):
    operation = operations / args.source
    if operations.exists() or operations.is_symlink():
        base.root_protected(operations)
    absent(base, operation, 'existing update attempt needs separate recovery review')
    absent(base, base.ROOT / 'releases' / args.source, 'immutable release already exists')
    facts, identity = update_facts(base, update, args, DRAIN)
    readable_by_worker(base, facts['tlsFiles'], (base.ROOT, base.ROOT / 'releases'))
    # First write. Everything above is read-only apart from the shared administrator lock. The attempt directory is
    # published only after a complete drain, so a refusal or an unfinished drain never blocks a later production-drain.
    if not operations.exists():
        operations.mkdir(mode=0o700)
    base.root_protected(operations)
    prepared = Path(tempfile.mkdtemp(prefix='.production-drain-' + args.source + '-', dir=operations))
    base.write_new(prepared / 'preflight.json', fmt.canonical({'mode': DRAIN, 'identity': pins, 'web': facts['web'],
                   'workerState': facts['workerState'], 'previousReceipt': facts['receipt'],
                   'environmentKeys': sorted(facts['environment'])}), 0o400)
    archive = prepared / 'authenticated-worker.zip'
    base.snapshot_archive(args.archive, archive, args.archive_sha256, fmt.MAX_ARCHIVE)
    staged = prepared / 'release'
    staged.mkdir(mode=0o700)
    manifest = fmt.extract_archive(archive, staged, args.source, args.lock_sha256, args.package_sha256)
    # Re-verify every refusal condition immediately before the signal.
    again, _ = update_facts(base, update, args, DRAIN)
    base.check({key: again[key] for key in COMPARED} == {key: facts[key] for key in COMPARED}, 'web or previous worker changed during preparation')
    if facts['workerState'] == 'running':
        progress = {'signalled': False}
        try:
            result = drain_worker(base, update, facts['report'], base.ROOT / 'releases' / args.previous_worker_source,
                                  identity, facts['environment'], progress)
        except Exception as error:
            try:
                base.write_new(prepared / 'drain-unfinished.json', fmt.canonical({'mode': DRAIN, 'signalled': progress['signalled'],
                               'forcedKill': False, 'refusal': type(error).__name__}), 0o400)
            except Exception:
                pass
            raise
    else:
        # Already cleanly stopped: an earlier drain finished after its deadline, or the runner exited 0 on its own.
        result = {'pid': None, 'state': 'drained', 'alreadyStopped': True, 'forcedKill': False}
    base.check(cleanly_exited(update.properties(base)) and quiet(base, update, identity), 'previous worker did not remain drained')
    record = {'mode': DRAIN, 'identity': pins, 'manifestSha256': fmt.digest(fmt.canonical(manifest)), 'drain': result, 'web': facts['web']}
    base.write_new(prepared / 'drained.json', fmt.canonical(record), 0o400)
    absent(base, operation, 'existing update attempt appeared during the drain')
    os.rename(prepared, operation)
    fsync_directory(operations)
    print(json.dumps({'source': args.source, **result}, sort_keys=True))
    return record


def start_release(base, update, operation, source, release, identity, environment, prior_unit_sha256, recheck, accept):
    """The template unit for this source (atomically replaced unless already exact), reload, start, three stable live
    observations, final rechecks, boot enablement and the caller's receipts. Any failure enters the staging quarantine."""
    unit = base.service_unit(source).encode()
    try:
        if prior_unit_sha256 != digest(unit):
            update.atomic_unit(base, unit, prior_unit_sha256)
            base.command(['/usr/bin/systemctl', 'daemon-reload'])
        report = update.properties(base)
        base.validate_service(report, release)
        base.check(report.get('Restart') == 'on-failure' and report.get('NeedDaemonReload') == 'no', 'worker service is not the reviewed configuration')
        base.command(['/usr/bin/systemctl', 'start', UNIT_PREFIX + '.service'])
        stable_pid = None
        for _ in range(3):
            time.sleep(4)
            report = update.properties(base)
            base.validate_service(report, release)
            pid = validate_worker(base, report, release, identity, environment)
            base.check(stable_pid in (None, pid), 'worker PID changed')
            stable_pid = pid
        recheck()
        if report.get('UnitFileState') != 'enabled':
            base.command(['/usr/bin/systemctl', 'enable', UNIT_PREFIX + '.service'])
        report = update.properties(base)
        base.check(report.get('UnitFileState') == 'enabled', 'worker is not enabled for boot')
        base.check(validate_worker(base, report, release, identity, environment) == stable_pid, 'worker PID changed')
        return accept(stable_pid, digest(unit))
    except Exception:
        # Includes replacement, reload/start, process proof, rechecks and receipt persistence. The quarantine refuses any
        # unit other than this source's exact candidate rather than touching another release.
        observed = update.quiesce_failed_activation(base, operation, source)
        print(json.dumps({'workerActivationFailed': True, **observed}, sort_keys=True), file=sys.stderr)
        raise RuntimeError('Worker activation failed; retained packages and protected failure observations require explicit administrator recovery') from None


def production_activate(base, fmt, update, args, operations, pins):
    operation = operations / args.source
    base.root_protected(operations)
    base.root_protected(operation)
    base.root_protected(operation / 'drained.json', regular=True)
    record = json.loads(base.read_bounded(operation / 'drained.json', 65536))
    base.check(isinstance(record, dict) and record.get('mode') == DRAIN and record.get('identity') == pins and
               isinstance(record.get('drain'), dict) and record['drain'].get('state') == 'drained', 'exact production drain record required')
    for name in ('activation-release', 'activation-failed.json', 'activated.json'):
        absent(base, operation / name, 'existing activation attempt needs separate recovery review')
    absent(base, base.ROOT / 'releases' / args.source, 'immutable release already exists')
    facts, identity = update_facts(base, update, args, ACTIVATE)
    readable_by_worker(base, facts['tlsFiles'], (base.ROOT, base.ROOT / 'releases'))
    database_role_proof(base, facts['environment'], facts['app'], facts['owner'])
    archive = operation / 'authenticated-worker.zip'
    base.root_protected(archive, regular=True)
    base.check(digest(base.read_bounded(archive, fmt.MAX_ARCHIVE)) == args.archive_sha256, 'prepared package changed')
    manifest = fmt.inspect_archive(archive, args.source, args.lock_sha256, args.package_sha256)
    manifest_sha256 = fmt.digest(fmt.canonical(manifest))
    base.check(manifest_sha256 == record.get('manifestSha256'), 'prepared manifest changed')
    # Re-extract authenticated bytes into the new immutable release instead of trusting the drain's unpacked tree.
    release = update.stage_release(base, fmt, archive, operation, args, manifest)
    try:
        readable_by_worker(base, [release / 'package.json', release / 'scripts' / 'bank-import-runner.ts'], (release,))
        # Re-verify every refusal condition immediately before the unit is replaced.
        again, _ = update_facts(base, update, args, ACTIVATE)
        base.check({key: again[key] for key in COMPARED} == {key: facts[key] for key in COMPARED}, 'web or previous worker changed before unit replacement')
    except Exception:
        # Nothing references the new release yet. Set it aside inside the attempt (never deleted), so that a later
        # production-activate, for example once the web is healthy again, re-extracts the authenticated bytes.
        os.rename(release, Path(tempfile.mkdtemp(prefix='refused-release-', dir=operation)) / 'release')
        raise

    def recheck():
        base.check(pinned_web(base, args.source, args.build_id, args.web_port) == facts['web'], 'web changed before worker acceptance')
        base.check(digest(protected_environment(base, identity, args.worker_env_sha256)) == args.worker_env_sha256,
                   'worker environment changed during activation')

    def accept(pid, unit_sha256):
        accepted = {'mode': 'production-update', 'source': args.source, 'webBuildId': args.build_id, 'archiveSha256': args.archive_sha256,
                    'manifestSha256': manifest_sha256, 'releaseManifestSha256': args.release_manifest_sha256,
                    'selectedEnvironmentSha256': args.worker_env_sha256, 'existingUid': identity.pw_uid, 'unitSha256': unit_sha256,
                    'workerPid': pid, 'serviceStable': True, 'journeyVerified': False, 'previousWorkerSource': args.previous_worker_source,
                    'previousUnitSha256': args.unit_sha256, 'previousWebSource': args.previous_web_source,
                    'previousWebBuildId': args.previous_web_build}
        base.write_new(release / 'worker-install-v2.json', fmt.canonical(accepted), 0o444)
        base.write_new(operation / 'activated.json', fmt.canonical(accepted), 0o400)
        return accepted
    accepted = start_release(base, update, operation, args.source, release, identity, facts['environment'], args.unit_sha256, recheck, accept)
    print(json.dumps(accepted, sort_keys=True))
    return accepted


def update_main(argv, fmt, base, update):
    parser = argparse.ArgumentParser(description='Production update of aihr-bank-import.service: production-drain before the web stops, '
                                     'production-activate after the exact new web is healthy. Grants no release authority.')
    parser.add_argument('phase', choices=[DRAIN, ACTIVATE])
    for name in UPDATE_ARGS:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--' + PREVIOUS_ENV_ARG)
    args = parser.parse_args(argv)
    # Both phases take the identical pins; the drain record binds them and activation refuses any difference.
    pins = {name.replace('-', '_'): getattr(args, name.replace('-', '_')) for name in UPDATE_ARGS}
    if args.previous_worker_env_sha256 is not None:
        # Bound only when given, so drain records of unchanged-environment updates keep their exact shape.
        pins['previous_worker_env_sha256'] = args.previous_worker_env_sha256
    validated_arguments(base, args, (args.previous_worker_source, args.previous_web_source, args.source), (args.previous_web_build, args.build_id),
                        (args.unit_sha256, args.release_manifest_sha256, args.archive_sha256, args.lock_sha256, args.package_sha256,
                         args.worker_env_sha256))
    base.check(args.previous_worker_source != args.source, 'update requires a different worker source')
    fd = administrator_lock(base)
    try:
        base.root_protected(base.ROOT)
        base.root_protected(base.ROOT / 'releases')
        phase = production_drain if args.phase == DRAIN else production_activate
        return phase(base, fmt, update, args, base.ROOT / 'upgrades', pins)
    finally:
        os.close(fd)


def protected_tree(base, release):
    """Every entry of the immutable release keeps the (root) owner of its root-protected directory and is neither
    group/other-writable nor set-id. Links are not followed."""
    def unreadable(error):
        raise error
    owner = release.lstat().st_uid
    for directory, folders, files in os.walk(release, onerror=unreadable):
        for name in folders + files:
            info = os.lstat(os.path.join(directory, name))
            base.check(info.st_uid == owner and (stat.S_ISLNK(info.st_mode) or not info.st_mode & (0o022 | stat.S_ISUID | stat.S_ISGID)),
                       'previous release tree is not immutable')


STABLE_ROLLBACK = ('drained', 'receipt', 'web', 'uid', 'environment', 'tlsFiles')


def rollback_facts(base, update, args, unit_sha256):
    """Read-only. The update attempt's drain record names the pinned previous release; that release keeps its managed
    receipt and template unit; the web is a recorded build; the current unit is one this update or rollback wrote."""
    attempt = base.ROOT / 'upgrades' / args.from_source
    base.root_protected(attempt)
    base.root_protected(attempt / 'drained.json', regular=True)
    drained = json.loads(base.read_bounded(attempt / 'drained.json', 65536))
    pins = drained.get('identity') if isinstance(drained, dict) else None
    base.check(isinstance(pins, dict) and drained.get('mode') == DRAIN and isinstance(drained.get('drain'), dict) and
               drained['drain'].get('state') == 'drained' and pins.get('source') == args.from_source and
               pins.get('previous_worker_source') == args.to_source and pins.get('unit_sha256') == args.to_unit_sha256 and
               pins.get('worker_env_sha256') == args.worker_env_sha256 and
               pins.get('previous_worker_env_sha256') == args.previous_worker_env_sha256,
               'rollback must name the drained previous release of this production update')
    target = base.ROOT / 'releases' / args.to_source
    base.root_protected(target)
    base.root_protected(target / 'worker-install-v2.json', regular=True)
    receipt = json.loads(base.read_bounded(target / 'worker-install-v2.json', 65536))
    base.check(isinstance(receipt, dict) and receipt.get('source') == args.to_source and receipt.get('mode') in PRODUCTION_RECEIPTS and
               receipt.get('unitSha256') == args.to_unit_sha256 == digest(base.service_unit(args.to_source).encode()) and
               receipt.get('selectedEnvironmentSha256') == (args.worker_env_sha256 if args.previous_worker_env_sha256 is None
                                                            else args.previous_worker_env_sha256) and
               receipt.get('serviceStable') is True,
               'previous release receipt differs from the pinned managed installation')
    protected_tree(base, target)
    recorded = {args.to_source: receipt.get('webBuildId'), args.from_source: pins.get('build_id')}.get(args.web_source)
    base.check(recorded is not None and recorded == args.web_build, "web pin is neither the previous release's nor the update's recorded build")
    web = pinned_web(base, args.web_source, args.web_build, args.web_port)
    identity = existing_identity(base, args.existing_uid)
    facts = {'drained': drained, 'receipt': receipt, 'web': web, 'uid': identity.pw_uid, **worker_environment(base, identity, args.worker_env_sha256)}
    base.root_protected(base.UNIT, regular=True)
    raw = base.read_bounded(base.UNIT, 65536)
    base.check(digest(raw) == unit_sha256, 'current worker unit differs from the pinned sha256')
    states = {base.service_unit(args.to_source).encode(): ('previous', args.to_source),
              quarantine_unit(base, args.to_source): ('previous-quarantined', args.to_source),
              base.service_unit(args.from_source).encode(): ('updated', args.from_source),
              quarantine_unit(base, args.from_source): ('updated-quarantined', args.from_source)}
    base.check(raw in states, 'current worker unit is not a unit of this update; administrator recovery required')
    state, source = states[raw]
    report = update.properties(base)
    base.validate_service(report, base.ROOT / 'releases' / source)
    if state.endswith('quarantined'):
        base.check(report.get('Restart') == 'no' and report.get('SendSIGKILL') == 'no' and report.get('NeedDaemonReload') == 'no',
                   'loaded quarantine is not the reviewed configuration')
        base.check(report.get('MainPID') == '0' and report.get('ActiveState') in ('inactive', 'failed') and quiet(base, update, identity),
                   'quarantined worker is not stopped; administrator recovery required')
    else:
        base.check(report.get('Restart') == 'on-failure' and report.get('NeedDaemonReload') == 'no' and report.get('UnitFileState') == 'enabled',
                   'loaded worker service is not the reviewed configuration')
    if state == 'previous':
        base.check(report.get('MainPID') == '0', 'the previous release is already running; nothing to roll back')
        base.check(cleanly_exited(report) and quiet(base, update, identity), 'previous release is not cleanly stopped')
    return {**facts, 'unitState': state, 'report': report}, identity


def production_rollback(base, fmt, update, args):
    facts, identity = rollback_facts(base, update, args, args.unit_sha256)
    target = base.ROOT / 'releases' / args.to_source
    readable_by_worker(base, facts['tlsFiles'], (base.ROOT, base.ROOT / 'releases'))
    readable_by_worker(base, [target / 'package.json', target / 'scripts' / 'bank-import-runner.ts'], (target,))
    database_role_proof(base, facts['environment'], facts['app'], facts['owner'])
    # First write: a fresh record directory inside the update attempt. Earlier rollback records are kept.
    operation = Path(tempfile.mkdtemp(prefix='rollback-' + args.to_source + '-', dir=base.ROOT / 'upgrades' / args.from_source))
    base.write_new(operation / 'rollback-preflight.json', fmt.canonical({'mode': ROLLBACK, 'fromSource': args.from_source, 'toSource': args.to_source,
                   'unitState': facts['unitState'], 'unitSha256': args.unit_sha256, 'web': facts['web'],
                   'environmentKeys': sorted(facts['environment'])}), 0o400)
    unit_sha256, expected = args.unit_sha256, facts['unitState']
    if facts['unitState'] == 'updated':
        # Stop the updated worker exactly as a failed activation is stopped: Restart=no and SendSIGKILL=no loaded and
        # verified, boot activation disabled, then a bounded graceful stop. Never SIGKILL.
        stop = operation / 'stop-updated'
        stop.mkdir(mode=0o700)
        observed = update.quiesce_failed_activation(base, stop, args.from_source)
        base.check(observed.get('stopped') is True and not observed.get('quiescenceUnconfirmed'),
                   'updated worker stop is unconfirmed (nothing was killed); administrator recovery required')
        unit_sha256, expected = digest(quarantine_unit(base, args.from_source)), 'updated-quarantined'
    # Re-verify every refusal condition immediately before the unit is replaced or started.
    again, _ = rollback_facts(base, update, args, unit_sha256)
    base.check(again['unitState'] == expected and {key: again[key] for key in STABLE_ROLLBACK} == {key: facts[key] for key in STABLE_ROLLBACK},
               'rollback facts changed before unit replacement')

    def recheck():
        base.check(pinned_web(base, args.web_source, args.web_build, args.web_port) == facts['web'], 'web changed before worker acceptance')
        base.check(digest(protected_environment(base, identity, args.worker_env_sha256)) == args.worker_env_sha256,
                   'worker environment changed during rollback')

    def accept(pid, unit_digest):
        record = {'mode': ROLLBACK, 'fromSource': args.from_source, 'toSource': args.to_source, 'fromState': facts['unitState'],
                  'priorUnitSha256': args.unit_sha256, 'unitSha256': unit_digest, 'webSource': args.web_source, 'webBuildId': args.web_build,
                  'selectedEnvironmentSha256': args.worker_env_sha256, 'existingUid': identity.pw_uid, 'workerPid': pid,
                  'serviceStable': True, 'forcedKill': False, 'journeyVerified': False}
        base.write_new(operation / 'rolled-back.json', fmt.canonical(record), 0o400)
        return record
    record = start_release(base, update, operation, args.to_source, target, identity, facts['environment'], unit_sha256, recheck, accept)
    print(json.dumps(record, sort_keys=True))
    return record


def rollback_main(argv, fmt, base, update):
    parser = argparse.ArgumentParser(description='Re-activate the pinned previous release of a production update attempt. Grants no release authority.')
    parser.add_argument('phase', choices=[ROLLBACK])
    for name in ROLLBACK_ARGS:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--' + PREVIOUS_ENV_ARG)
    args = parser.parse_args(argv)
    validated_arguments(base, args, (args.from_source, args.to_source, args.web_source), (args.web_build,),
                        (args.unit_sha256, args.to_unit_sha256, args.worker_env_sha256))
    base.check(args.from_source != args.to_source, 'rollback requires a different previous release')
    fd = administrator_lock(base)
    try:
        base.root_protected(base.ROOT)
        base.root_protected(base.ROOT / 'releases')
        return production_rollback(base, fmt, update, args)
    finally:
        os.close(fd)


def main(argv, fmt, base, update):
    """Bundle entry point: exactly one reviewed production phase per invocation; staging phases are not reachable."""
    phase = argv[0] if argv else None
    if phase == MODE:
        return first_install(argv, fmt, base, update)
    if phase in (DRAIN, ACTIVATE):
        return update_main(argv, fmt, base, update)
    if phase == ROLLBACK:
        return rollback_main(argv, fmt, base, update)
    parser = argparse.ArgumentParser(description='Production worker phases; run `<phase> --help` for its pins. Grants no release or production authority.')
    parser.add_argument('phase', choices=PHASES)
    parser.parse_args(argv[:1])
    parser.error('unknown phase')
