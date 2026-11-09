"""Pre-package disposable CI owner protection; no application import/root Git/Node.

Preparation runs as the original runner before any package hook. It captures
this exact committed stdlib receiver and a bounded controller snapshot, then
passes expected bytes directly to sudo over stdin. The receiver copies only
that snapshot into an exclusive fixed root prefix; validation Git is nonroot.
"""
import contextlib
import hashlib
import json
import os
import pathlib
import pwd
import re
import shutil
import stat
import subprocess
import sys

BASE = pathlib.Path('/var/lib/aihr-native-controller')
SCRIPT = '.github/ci/native-controller-bootstrap.py'
MAX_FILE = 256 * 1024**2
MAX_TOTAL = 4 * 1024**3
MAX_ROWS = 200000
MAX_REQUEST = 64 * 1024**2
ENVIRONMENT = ('GITHUB_ACTIONS', 'GITHUB_JOB', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_WORKFLOW',
 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_NUMBER',
 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_REF_NAME', 'GITHUB_REF_TYPE', 'GITHUB_HEAD_REF', 'GITHUB_BASE_REF',
 'GITHUB_EVENT_NAME', 'GITHUB_WORKSPACE', 'GITHUB_SERVER_URL', 'GITHUB_API_URL', 'GITHUB_GRAPHQL_URL',
 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_TEMP', 'RUNNER_TOOL_CACHE', 'RUNNER_NAME',
 'CI', 'AIHR_CI_HEAD', 'AIHR_CI_CONTROL_HEAD', 'AIHR_CI_MIGRATION_BASE', 'AIHR_CI_PG_PROFILE',
 'AIHR_CI_PG_CONFIGURED_CAP_BYTES', 'AIHR_CI_PG_PEAK_BUDGET_BYTES', 'AIHR_CI_PG_JIT')
SAFE = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/nonexistent', 'LANG': 'C', 'LC_ALL': 'C',
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_REPLACE_OBJECTS': '1'}


def need(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False) + '\n').encode()


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def name(value):
    need(isinstance(value, str) and 0 < len(value.encode()) <= 4096 and '\\' not in value
         and len(value.split('/')) <= 128 and all(part not in ('', '.', '..') for part in value.split('/'))
         and not re.search(r'[\x00-\x1f\x7f]', value), 'Unsafe controller snapshot member')
    return value


@contextlib.contextmanager
def directory(path, root_owned=False):
    path = pathlib.Path(path)
    need(path.is_absolute() and str(path) == os.path.normpath(path) and '..' not in path.parts, 'Canonical owner directory required')
    fd, pins = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW), []
    try:
        for part in path.parts[1:]:
            before = os.stat(part, dir_fd=fd, follow_symlinks=False)
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            need(stat.S_ISDIR(before.st_mode) and identity(before) == identity(os.fstat(child)), 'Controller ancestor changed')
            if root_owned:
                need(before.st_uid == 0 and not before.st_mode & 0o022, 'Owner prefix ancestor is writable')
            pins.append((fd, part, child, before.st_dev, before.st_ino))
            fd = child
        yield fd
        for parent, part, held, device, inode in pins:
            actual = os.stat(part, dir_fd=parent, follow_symlinks=False)
            need((actual.st_dev, actual.st_ino) == (device, inode)
                 == (os.fstat(held).st_dev, os.fstat(held).st_ino), 'Owner directory identity changed')
    finally:
        for parent, *_ in pins:
            os.close(parent)
        os.close(fd)


@contextlib.contextmanager
def parent(root, relative):
    parts = name(relative).split('/')
    fd = os.dup(root)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd, parts[-1]
    finally:
        os.close(fd)


def read(root, relative, maximum, expected=None):
    with parent(root, relative) as (folder, leaf):
        before = os.stat(leaf, dir_fd=folder, follow_symlinks=False)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= maximum
             and not before.st_mode & 0o022, 'Unsafe controller input file')
        fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
        try:
            need(identity(before) == identity(os.fstat(fd)), 'Controller input changed before read')
            with os.fdopen(os.dup(fd), 'rb') as stream:
                raw = stream.read(maximum + 1)
            need(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd))
                 == identity(os.stat(leaf, dir_fd=folder, follow_symlinks=False)), 'Controller input changed during read')
            need(expected is None or len(raw) == expected['size'] and hashlib.sha256(raw).hexdigest() == expected['sha256'],
                 'Controller snapshot bytes changed')
            return raw, before
        finally:
            os.close(fd)


def git(folder, args, *, runner=None):
    command = ['/usr/bin/git', '-c', 'safe.directory=' + str(folder), '-c', 'core.fsmonitor=false',
               '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-C', str(folder), *args]
    if runner:
        command = ['/usr/sbin/runuser', '-u', runner, '--', *command]
    result = subprocess.run(command, env=SAFE, capture_output=True, timeout=120, check=True)
    need(len(result.stdout) <= MAX_REQUEST and len(result.stderr) <= MAX_REQUEST, 'Bounded pre-package Git required')
    return result.stdout


def context(environment):
    need(isinstance(environment, dict) and set(environment) <= set(ENVIRONMENT)
         and all(isinstance(value, str) and len(value.encode()) <= 8192 and '\0' not in value for value in environment.values()),
         'Closed bootstrap environment required')
    for key, value in {'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux',
         'GITHUB_REPOSITORY': 'StradaverseHub/ai-hr', 'GITHUB_REPOSITORY_ID': '1333414856', 'GITHUB_RUN_ATTEMPT': '1',
         'GITHUB_WORKFLOW': 'alpha-staging-ci', 'GITHUB_JOB': 'native-test'}.items():
        need(environment.get(key) == value, 'Actual first-attempt native CI context required')
    run = environment.get('GITHUB_RUN_ID', '')
    need(re.fullmatch(r'[1-9][0-9]{0,19}', run) and int(run) <= 9007199254740991, 'Exact bootstrap run required')
    for key in ('AIHR_CI_HEAD', 'AIHR_CI_CONTROL_HEAD'):
        need(re.fullmatch(r'[a-f0-9]{40}', environment.get(key, '')), 'Exact bootstrap source/controller required')
    need(environment.get('GITHUB_SHA') == environment['AIHR_CI_CONTROL_HEAD']
         and environment.get('GITHUB_WORKFLOW_REF', '').startswith('StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/')
         and environment.get('GITHUB_EVENT_NAME') in ('push', 'pull_request', 'workflow_dispatch'), 'Actual bootstrap workflow differs')
    workspace = pathlib.Path(environment['GITHUB_WORKSPACE'])
    need(str(workspace.resolve()) == str(workspace) and str(workspace).startswith('/home/runner/work/')
         and environment['RUNNER_TEMP'] == '/home/runner/work/_temp'
         and environment['RUNNER_TOOL_CACHE'] == '/opt/hostedtoolcache', 'Standard hosted bootstrap layout required')
    return run, workspace


def snapshot(controller, tracked):
    rows, total = [], 0
    with directory(controller) as root:
        wanted = set(tracked)
        # Full .git preserves native Git identity/status/show. Untracked/ignored
        # checkout files are excluded; no package/runtime dependency is copied.
        stack = ['.git']
        while stack:
            current = stack.pop()
            with parent(root, current) as (folder, leaf):
                info = os.stat(leaf, dir_fd=folder, follow_symlinks=False)
            need(stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o022, 'Actual bounded Git directory required')
            wanted.add(current)
            with parent(root, current + '/entry') as (folder, _):
                for entry in os.scandir(folder):
                    relative = name(current + '/' + entry.name)
                    need(not relative.endswith('.lock') and relative not in ('.git/info/grafts', '.git/refs/replace'), 'Unexpected Git mutation state')
                    info = entry.stat(follow_symlinks=False)
                    need(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'Git links/special members refuse')
                    if stat.S_ISDIR(info.st_mode):
                        stack.append(relative)
                    else:
                        wanted.add(relative)
                    need(len(wanted) + len(stack) <= MAX_ROWS, 'Git snapshot count exceeds bound')
        for relative in list(wanted):
            parts = relative.split('/')
            wanted.update('/'.join(parts[:count]) for count in range(1, len(parts)))
        need(len(wanted) <= MAX_ROWS, 'Controller snapshot count exceeds bound')
        for relative in sorted(wanted):
            with parent(root, relative) as (folder, leaf):
                info = os.stat(leaf, dir_fd=folder, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                row = {'path': relative, 'kind': 'directory', 'mode': 0o755}
            else:
                raw, info = read(root, relative, MAX_FILE)
                total += len(raw)
                need(total <= MAX_TOTAL, 'Controller snapshot bytes exceed bound')
                row = {'path': relative, 'kind': 'file', 'mode': 0o755 if info.st_mode & 0o111 else 0o644,
                       'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            rows.append(row)
    need(len(canonical(rows)) <= MAX_REQUEST, 'Controller snapshot metadata exceeds bound')
    return rows, total


def write(folder, relative, data, mode):
    with parent(folder, relative) as (owner, leaf):
        fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=owner)
        try:
            with os.fdopen(os.dup(fd), 'wb') as stream:
                stream.write(data)
                stream.flush()
            os.fchmod(fd, mode)
            os.fsync(fd)
        finally:
            os.close(fd)


def seal(request):
    need(sys.platform == 'linux' and os.geteuid() == 0, 'Root Linux receiver required')
    need(isinstance(request, dict) and set(request) == {'environment', 'runnerUid', 'runnerGid', 'rows', 'node', 'toolBins', 'event'}, 'Closed bootstrap request required')
    environment, uid, gid = request['environment'], request['runnerUid'], request['runnerGid']
    run, workspace = context(environment)
    need(os.environ.get('SUDO_UID') == str(uid) and os.environ.get('SUDO_GID') == str(gid)
         and type(uid) is int and uid > 0 and type(gid) is int and gid > 0, 'Actual bootstrap issuer required')
    runner = pwd.getpwuid(uid)
    need(runner.pw_gid == gid, 'Bootstrap primary group differs')
    rows = request['rows']
    need(isinstance(rows, list) and 0 < len(rows) <= MAX_ROWS and len(canonical(rows)) <= MAX_REQUEST, 'Bounded controller snapshot required')
    seen, total = set(), 0
    for row in rows:
        need(isinstance(row, dict) and row.get('kind') in ('file', 'directory'), 'Closed controller row required')
        need(set(row) == {'path', 'kind', 'mode'} | ({'size', 'sha256'} if row['kind'] == 'file' else set()), 'Closed controller row fields required')
        relative = name(row['path'])
        need(relative not in seen and all('/'.join(relative.split('/')[:i]) in seen for i in range(1, len(relative.split('/')))), 'Controller row order/parents differ')
        seen.add(relative)
        need(row['mode'] in ((0o644, 0o755) if row['kind'] == 'file' else (0o755,)), 'Closed controller mode required')
        if row['kind'] == 'file':
            need(type(row['size']) is int and 0 <= row['size'] <= MAX_FILE and re.fullmatch(r'[a-f0-9]{64}', row.get('sha256', '')), 'Controller file facts differ')
            total += row['size']
    need([row['path'] for row in rows] == sorted(seen) and total <= MAX_TOTAL, 'Controller coverage/bytes differ')
    node = request['node']
    need(isinstance(node, dict) and set(node) == {'path', 'sha256', 'bytes'} and type(node['bytes']) is int
         and 0 < node['bytes'] <= MAX_FILE and re.fullmatch(r'[a-f0-9]{64}', node['sha256']), 'Exact pinned Node facts required')
    node_path = pathlib.Path(node['path'])
    need(str(node_path.resolve()) == str(node_path)
         and str(node_path) == '/opt/hostedtoolcache/node/22.23.3/x64/bin/node', 'Exact pinned setup-node executable required')
    bins = request['toolBins']
    need(isinstance(bins, list) and 0 < len(bins) <= 2 and bins == sorted(set(bins))
         and all(isinstance(value, str) and value.startswith('/home/runner/') or isinstance(value, str) and value.startswith('/opt/hostedtoolcache/') for value in bins), 'Closed initial toolchain directories required')
    event_path = pathlib.Path(request['event']['path'])
    need(str(event_path.resolve()) == str(event_path) and str(event_path).startswith(environment['RUNNER_TEMP'] + '/'), 'Original event input differs')
    for root in (BASE,):
        try:
            root.mkdir(mode=0o755)
            root.chmod(0o755)
        except FileExistsError:
            pass
        with directory(root, True):
            need(stat.S_IMODE(root.stat().st_mode) == 0o755, 'Existing owner prefix mode differs')
    destination = BASE / run
    destination.mkdir(mode=0o700)  # Existing/foreign runs are never overwritten.
    destination.chmod(0o700)
    mounted = False
    try:
        (destination / 'automation').mkdir(mode=0o755)
        (destination / 'automation').chmod(0o755)
        with directory(workspace / 'automation') as source, directory(destination / 'automation', True) as output:
            for row in rows:
                if row['kind'] == 'directory':
                    with parent(output, row['path']) as (folder, leaf):
                        os.mkdir(leaf, 0o755, dir_fd=folder)
                        os.chmod(leaf, 0o755, dir_fd=folder, follow_symlinks=False)
                else:
                    raw, _ = read(source, row['path'], MAX_FILE, row)
                    write(output, row['path'], raw, row['mode'])
        with directory(node_path.parent) as source:
            raw, info = read(source, node_path.name, MAX_FILE, {'size': node['bytes'], 'sha256': node['sha256']})
            need(info.st_uid in (0, uid) and raw.startswith(b'\x7fELF'), 'Actual installed Node ELF required')
        with directory(destination, True) as output:
            write(output, 'node', raw, 0o555)
            with directory(event_path.parent) as source:
                raw, info = read(source, event_path.name, 1024**2, request['event'])
                need(info.st_uid == uid, 'Original runner event owner differs')
            write(output, 'event.json', raw, 0o444)
        (destination / 'gh-empty').mkdir(mode=0o755)
        (destination / 'gh-empty').chmod(0o755)
        # Parent is exposed only after all root files are complete. No root Git
        # or Node is run; original UID performs strict read-only Git validation.
        destination.chmod(0o755)
        controller = destination / 'automation'
        need(git(controller, ['rev-parse', 'HEAD'], runner=runner.pw_name).decode().strip() == environment['AIHR_CI_CONTROL_HEAD'], 'Copied Git controller differs')
        need(git(controller, ['status', '--porcelain'], runner=runner.pw_name) == b'', 'Copied controller is not clean')
        git(controller, ['fsck', '--strict', '--full', '--no-reflogs'], runner=runner.pw_name)
        # Real immutable mount, beneath fixed root-owned ancestors. Mutable
        # workspace aliases cannot replace the actual owner import namespace.
        subprocess.run(['/usr/bin/mount', '--bind', str(controller), str(controller)], env=SAFE, timeout=15, check=True)
        mounted = True
        subprocess.run(['/usr/bin/mount', '-o', 'remount,bind,ro,nosuid,nodev', str(controller)], env=SAFE, timeout=15, check=True)
        need(os.statvfs(controller).f_flag & os.ST_RDONLY, 'Controller kernel mount is not read-only')
        receipt = {'version': 1, 'kind': 'PROTECTED_NATIVE_CONTROLLER_BEFORE_PACKAGE_INVOCATION',
            'candidate': environment['AIHR_CI_HEAD'], 'controller': environment['AIHR_CI_CONTROL_HEAD'], 'runId': run,
            'workspace': str(workspace), 'automation': str(controller), 'protectedNodePath': str(destination / 'node'),
            'node': node, 'controllerTreeSha256': hashlib.sha256(canonical(rows)).hexdigest(),
            'controllerEntries': len(rows), 'controllerBytes': total, 'runnerUid': uid, 'runnerGid': gid,
            'toolBins': bins, 'context': environment, 'eventSha256': request['event']['sha256']}
        need(len(canonical(receipt)) <= 128 * 1024, 'Public bootstrap receipt exceeds bound')
        with directory(destination, True) as output:
            write(output, 'bootstrap.json', canonical(receipt), 0o444)
        return {'bootstrapPath': str(destination / 'bootstrap.json'), 'protectedNodePath': receipt['protectedNodePath'], 'automation': str(controller)}
    except BaseException:
        if mounted:
            subprocess.run(['/usr/bin/umount', str(destination / 'automation')], env=SAFE, timeout=15, check=True)
        shutil.rmtree(destination)
        raise


def prepare():
    need(sys.platform == 'linux' and os.geteuid() > 0, 'Original nonroot bootstrap required')
    environment = {key: os.environ[key] for key in ENVIRONMENT if key in os.environ}
    need(os.environ.get('GITHUB_JOB') == 'native-test', 'Bootstrap is native-job only')
    run, workspace = context(environment)
    controller = workspace / 'automation'
    need(pathlib.Path(__file__).absolute() == controller / SCRIPT, 'Original fixed controller bootstrap required')
    # FIRST cache this exact receiver, before even metadata Git can execute.
    # Source Git filters are candidate code: source status belongs exclusively
    # to the later protected owner with a credential-free metadata environment.
    with directory(controller) as root:
        receiver, _ = read(root, SCRIPT, 1024**2)
    config = git(controller, ['config', '--local', '--null', '--list']).decode().split('\0')
    for entry in filter(None, config):
        key, _, value = entry.partition('\n')
        need(not re.search(r'(^credential\.|^include\.|^includeif\.|^filter\.|extraheader$|askpass$|sshcommand$|^core\.fsmonitor$)', key, re.I),
             'Controller configuration contains an unowned credential/command source')
        if key == 'remote.origin.url':
            need(value in ('https://github.com/StradaverseHub/ai-hr', 'https://github.com/StradaverseHub/ai-hr.git'), 'Controller remote differs')
    need(git(controller, ['rev-parse', 'HEAD']).decode().strip() == environment['AIHR_CI_CONTROL_HEAD']
         and git(controller, ['status', '--porcelain']) == b'', 'Original trusted controller checkout differs')
    need(receiver == git(controller, ['show', environment['AIHR_CI_CONTROL_HEAD'] + ':' + SCRIPT]), 'Bootstrap differs from committed controller')
    tracked = []
    records = git(controller, ['ls-files', '--stage', '-z']).split(b'\0')
    need(records[-1] == b'', 'Complete tracked controller inventory required')
    for record in records[:-1]:
        header, relative = record.split(b'\t', 1)
        need(re.fullmatch(rb'100(?:644|755) [a-f0-9]{40} 0', header), 'Tracked controller links/submodules refuse')
        tracked.append(name(relative.decode()))
    rows, _ = snapshot(controller, [name(value) for value in tracked])
    original_node = pathlib.Path(shutil.which('node')).resolve()
    with directory(original_node.parent) as root:
        raw, _ = read(root, original_node.name, MAX_FILE)
    facts = subprocess.run([str(original_node), '-p', 'JSON.stringify({node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime})'],
                           env=SAFE, timeout=10, capture_output=True, check=True)
    need(json.loads(facts.stdout) == {'node': '22.23.3', 'abi': '127', 'platform': 'linux', 'arch': 'x64', 'glibc': '2.39'}, 'Exact pinned setup-node runtime required')
    pnpm = shutil.which('pnpm')
    need(pnpm, 'Pinned pnpm setup must precede protection')
    bins = sorted({str(pathlib.Path(pnpm).parent.resolve()), str(original_node.parent)})
    event_path = pathlib.Path(os.environ['GITHUB_EVENT_PATH']).resolve()
    with directory(event_path.parent) as root:
        event, _ = read(root, event_path.name, 1024**2)
    request = {'environment': environment, 'runnerUid': os.getuid(), 'runnerGid': os.getgid(), 'rows': rows,
        'node': {'path': str(original_node), 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}, 'toolBins': bins,
        'event': {'path': str(event_path), 'size': len(event), 'sha256': hashlib.sha256(event).hexdigest()}}
    encoded = canonical(request)
    need(len(encoded) <= MAX_REQUEST, 'Bootstrap transport exceeds bound')
    result = subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/python3', '-I', '-B', '-c', receiver.decode(), '--seal'],
                            input=encoded, capture_output=True, timeout=240, check=True)
    need(len(result.stdout) <= 65536, 'Bootstrap response exceeds bound')
    value = json.loads(result.stdout)
    need(value == {'bootstrapPath': str(BASE / run / 'bootstrap.json'), 'protectedNodePath': str(BASE / run / 'node'),
                   'automation': str(BASE / run / 'automation')}, 'Bootstrap fixed paths differ')
    print(json.dumps(value))


# Separate disposable TOOL course. This capsule has no normal bootstrap or
# installed-controller authority and does not persist the checkout or Node.
TOOL_BRANCH = 'codex/native-workload-tool-only-custody-repair-20261109'
TOOL_SOURCE = '.github/ci/native-workload-browser-tool-course.py'
TOOL_PACKAGE_PINS = {
    'package.json': '7f67e35d869a29d2cb58d65c6f63413afc63db2cc6c6cf9dacb5086bce70ec2c',
    'pnpm-lock.yaml': '0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd',
}
TOOL_MEMBERS = tuple(sorted((
    TOOL_SOURCE, '.github/ci/native-workload-browser-tool-installation.py',
    '.github/ci/native-workload-browser-toolchain.py', '.github/ci/owned-process.py',
    '.github/ci/runtime_inventory.py', 'deploy/admission/next_profile.py', *TOOL_PACKAGE_PINS,
)))
TOOL_MEMBER_MAX = 2 * 1024**2
TOOL_REQUEST_MAX = 16 * 1024
TOOL_EVENT_MAX = 1024**2
TOOL_PRE_ROOT_CHECKPOINTS = (
    'runner-identity', 'runner-context', 'event-file', 'event-json', 'dispatch-contract',
    'controller-location', 'controller-directory', 'controller-script', 'controller-git-config',
    'controller-commit', 'capsule-members', 'controller-stability', 'sealed-handoff', 'unknown',
    'dispatch-runner-context', 'dispatch-runner-ref', 'dispatch-runner-source', 'dispatch-runner-workflow',
    'dispatch-event-repository', 'dispatch-event-ref', 'dispatch-input-map', 'dispatch-input-keys',
    'dispatch-input-types', 'dispatch-input-values', 'dispatch-commission-omitted',
    'dispatch-typed-booleans', 'dispatch-commission-omitted-and-typed-booleans',
)


class _ToolDispatchRefusal(ValueError):
    def __init__(self, checkpoint, message):
        super().__init__(message)
        self.checkpoint = checkpoint


def _tool_dispatch_need(condition, checkpoint, message):
    if not condition:
        raise _ToolDispatchRefusal(checkpoint, message)


def _tool_dispatch_input_checkpoint(inputs, expected):
    # This comparison is reached only after exact input admission has refused.
    if type(inputs) is not dict:
        return 'dispatch-input-map'
    commission = 'commission_singleton_units'
    omitted = commission not in inputs
    keys = expected.keys() - {commission} if omitted else expected.keys()
    if inputs.keys() != keys:
        return 'dispatch-input-keys'
    flags = ('build_only', 'diagnostics_only', 'controller_only', 'native_tool_only')
    typed = [key for key in flags if type(inputs[key]) is bool]
    comparable = {**inputs, **{key: 'true' if inputs[key] else 'false' for key in typed}}
    if omitted:
        comparable[commission] = ''
    if comparable == expected:
        if omitted and typed:
            return 'dispatch-commission-omitted-and-typed-booleans'
        if omitted:
            return 'dispatch-commission-omitted'
        if typed:
            return 'dispatch-typed-booleans'
    if any(type(value) is not str for value in inputs.values()):
        return 'dispatch-input-types'
    return 'dispatch-input-values'


def tool_intent(environment, event):
    try:
        run, workspace = context(environment)
    except Exception as error:
        raise _ToolDispatchRefusal('dispatch-runner-context', 'Actual bootstrap context required') from error
    ref = 'refs/heads/' + TOOL_BRANCH
    sha = environment['GITHUB_SHA']
    self_source = 'Exact prehook TOOL self-source workflow required'
    _tool_dispatch_need(environment.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
                        and environment.get('GITHUB_REF') == ref and environment.get('GITHUB_REF_NAME') == TOOL_BRANCH
                        and environment.get('GITHUB_REF_TYPE') == 'branch', 'dispatch-runner-ref', self_source)
    _tool_dispatch_need(environment.get('GITHUB_WORKFLOW_SHA') == environment['AIHR_CI_HEAD'] == sha,
                        'dispatch-runner-source', self_source)
    _tool_dispatch_need(environment.get('GITHUB_WORKFLOW_REF') == 'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@' + ref,
                        'dispatch-runner-workflow', self_source)
    event_identity = 'Original TOOL dispatch event differs'
    _tool_dispatch_need(type(event) is dict and type(event.get('repository')) is dict
                        and event['repository'].get('id') == 1333414856
                        and event['repository'].get('full_name') == 'StradaverseHub/ai-hr',
                        'dispatch-event-repository', event_identity)
    _tool_dispatch_need(event.get('ref') in (ref, TOOL_BRANCH), 'dispatch-event-ref', event_identity)
    expected = {'candidate_ref': TOOL_BRANCH, 'expected_sha': sha, 'test_parallelism': '4',
                'commission_singleton_units': '', 'build_only': 'false', 'diagnostics_only': 'true',
                'controller_only': 'false', 'native_tool_only': 'true'}
    inputs = event.get('inputs')
    # The runner may omit the optional empty commission input from event.json.
    if not (type(inputs) is dict and {'commission_singleton_units': '', **inputs} == expected):
        raise _ToolDispatchRefusal(_tool_dispatch_input_checkpoint(inputs, expected),
                                   'Exclusive fixed TOOL dispatch inputs required')
    return run, workspace


def _tool_event(environment, path, uid, expected=None):
    path = pathlib.Path(path)
    runner_temp = pathlib.Path(environment['RUNNER_TEMP'])
    need(str(path) == str(path.resolve()) and runner_temp in path.parents
         and path.name == 'event.json', 'Original TOOL event path differs')
    with directory(path.parent) as folder:
        raw, info = read(folder, path.name, TOOL_EVENT_MAX, expected)
    need(info.st_uid == uid, 'Original TOOL event owner differs')
    return raw


def _tool_blob(raw):
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw, usedforsecurity=False).hexdigest()


def _tool_row(path, raw, info):
    need(stat.S_IMODE(info.st_mode) == 0o644 and 0 < len(raw) <= TOOL_MEMBER_MAX, 'Fixed TOOL source mode or length differs')
    digest = hashlib.sha256(raw).hexdigest()
    need(path not in TOOL_PACKAGE_PINS or digest == TOOL_PACKAGE_PINS[path], 'Pinned TOOL package metadata differs')
    return {'path': path, 'mode': '100644', 'size': len(raw), 'gitBlob': _tool_blob(raw), 'sha256': digest}


def _tool_handoff(receiver, request):
    import fcntl

    encoded = canonical(request)
    need(len(encoded) <= TOOL_REQUEST_MAX, 'Fixed TOOL bootstrap request exceeds bound')
    fd = os.memfd_create('aihr-tool-bootstrap', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as output:
            output.write(encoded)
        seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seals)
        need(fcntl.fcntl(fd, fcntl.F_GET_SEALS) == seals, 'TOOL bootstrap transport did not seal')
        os.lseek(fd, 0, os.SEEK_SET)
        os.dup2(fd, 0, inheritable=True)
        os.set_inheritable(0, True)
    finally:
        if fd != 0:
            os.close(fd)
    command = ['/usr/bin/sudo', '-n', '/usr/bin/python3', '-I', '-B', '-c', receiver.decode(), '--seal-tool-only']
    os.execve(command[0], command, SAFE)


def _tool_request(fd):
    import fcntl

    seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
    before = os.fstat(fd)
    need(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= TOOL_REQUEST_MAX
         and fcntl.fcntl(fd, fcntl.F_GET_SEALS) == seals and os.lseek(fd, 0, os.SEEK_CUR) == 0,
         'Seekable sealed TOOL bootstrap request required')
    with os.fdopen(os.dup(fd), 'rb') as stream:
        raw = stream.read(TOOL_REQUEST_MAX + 1)
    need(len(raw) == before.st_size and identity(os.fstat(fd)) == identity(before),
         'Sealed TOOL bootstrap extent differs')
    return json.loads(raw)


def _tool_refusal(reason):
    return {'kind': 'NATIVE_TOOL_ONLY_COMPONENT', 'complete': False, 'failure': reason,
            'cleanup': 'not-observed', 'releaseAuthorized': False}


def _tool_pre_root_refusal(checkpoint):
    need(type(checkpoint) is str and checkpoint in TOOL_PRE_ROOT_CHECKPOINTS, 'Unknown TOOL pre-root checkpoint')
    return {**_tool_refusal('tool-pre-root-refused'), 'preRootCheckpoint': checkpoint}


def _write_tool_receipt(report):
    encoded = canonical(report)
    need(len(encoded) <= 65536, 'TOOL receipt exceeds bound')
    sys.stdout.buffer.write(encoded)


def _tool_capture_keys(value, required, optional=()):
    need(type(value) is dict and set(required) <= value.keys() <= set(required) | set(optional),
         'Returned TOOL capture fields differ')


def _tool_capture_int(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def _tool_capture_hex(value, length):
    return type(value) is str and len(value) == length and re.fullmatch(r'[0-9a-f]+', value) is not None


def _validate_tool_owner_capture(report, *, live=False):
    base = ('kind', 'complete', 'cleanup', 'source', 'controller', 'runId', 'attempt', 'job', 'eventSha256',
            'sourceMembers', 'sourceCapsuleSha256', 'platform', 'elapsedMs', 'ownedProcessesSettled')
    negative = ('browserStarted', 'applicationBuilt', 'databaseStarted', 'nativeWorkloadQualified', 'releaseAuthorized')
    closure = ('mountsAbsent', 'namespaceAbsent')
    observed = ('processOutcomes', 'transfer', 'materialized')
    complete = report['complete']
    _tool_capture_keys(report, base + negative + (closure + observed if complete else ('failure',)),
                       () if complete else closure + observed + ('failureReason', 'cleanupReason'))
    need(all(report[key] is False for key in negative) and report['job'] == 'native-test'
         and _tool_capture_int(report['attempt'], 1, 1) and _tool_capture_hex(report['source'], 40)
         and report['controller'] == report['source'] and type(report['runId']) is str
         and re.fullmatch(r'[1-9][0-9]{0,15}', report['runId']) is not None
         and _tool_capture_hex(report['eventSha256'], 64) and _tool_capture_hex(report['sourceCapsuleSha256'], 64)
         and _tool_capture_int(report['elapsedMs'], 0, 600000)
         and type(report['ownedProcessesSettled']) is bool, 'Returned TOOL owner identity differs')

    platform = report['platform']
    _tool_capture_keys(platform, ('system', 'machine', 'python', 'ubuntu'))
    python = platform['python']
    need(platform['system'] == 'linux' and platform['machine'] == 'x86_64' and platform['ubuntu'] == '24.04'
         and type(python) is list and len(python) == 3 and python[0] == 3
         and all(_tool_capture_int(part, 0, 255) for part in python), 'Returned TOOL platform differs')

    rows = report['sourceMembers']
    need(type(rows) is list and len(rows) == len(TOOL_MEMBERS), 'Returned TOOL source member census differs')
    for path, row in zip(TOOL_MEMBERS, rows, strict=True):
        _tool_capture_keys(row, ('path', 'mode', 'size', 'gitBlob', 'sha256'))
        need(row['path'] == path and row['mode'] == '100644' and _tool_capture_int(row['size'], 1, TOOL_MEMBER_MAX)
             and _tool_capture_hex(row['gitBlob'], 40) and _tool_capture_hex(row['sha256'], 64)
             and (path not in TOOL_PACKAGE_PINS or row['sha256'] == TOOL_PACKAGE_PINS[path]),
             'Returned TOOL source member differs')
    need(hashlib.sha256(canonical(rows)).hexdigest() == report['sourceCapsuleSha256'], 'Returned TOOL capsule differs')

    packages = ('playwright', 'playwright-core', 'postgres')
    if 'transfer' in report:
        transfer = report['transfer']
        _tool_capture_keys(transfer, ('generation', 'lengths', 'privateWriters'), ('writerHandoff',))
        if live or 'writerHandoff' in transfer:
            need(transfer.get('writerHandoff') in ('post-drop-nondumpable-policy-zero', 'post-drop-nondumpable-policy-root-only'),
                 'Returned TOOL writer handoff differs')
        lengths = transfer['lengths']
        _tool_capture_keys(lengths, ('chromium.zip',) + tuple(name + '.tgz' for name in packages))
        need(transfer['generation'] == '1784092784777971' and transfer['privateWriters'] is True
             and _tool_capture_int(lengths['chromium.zip'], 120231126, 120231126)
             and all(_tool_capture_int(lengths[name + '.tgz'], 1, 16 * 1024**2) for name in packages),
             'Returned TOOL transfer differs')
    if 'materialized' in report:
        materialized = report['materialized']
        digests = ('treeSha256', 'browserSha256', 'browserTreeSha256')
        flags = ('readOnly', 'noSuid', 'noDev', 'noExec')
        _tool_capture_keys(materialized, digests + flags + ('entries', 'fileBytes', 'mountId', 'packageLockSRI'))
        sri = materialized['packageLockSRI']
        _tool_capture_keys(sri, packages)
        need('transfer' in report and all(_tool_capture_hex(materialized[key], 64) for key in digests)
             and all(materialized[key] is True for key in flags) and _tool_capture_int(materialized['entries'], 1, 5122)
             and _tool_capture_int(materialized['fileBytes'], 1, 273378828 + 3 * 64 * 1024**2)
             and _tool_capture_int(materialized['mountId'], 1, 2**31 - 1)
             and all(type(value) is str and re.fullmatch(r'sha512-[A-Za-z0-9+/]{85}[AQgw]==', value)
                     for value in sri.values()), 'Returned TOOL installation differs')

    operations = ('namespace-private', 'archive-downloader', 'payload-bind', 'payload-remount', 'payload-unmount')
    reasons = ('complete', 'command-failed', 'deadline', 'handshake-refused', 'descendants-survived',
               'protocol-refused', 'owner-interrupted', 'group-uncertain', 'session-escaped')
    successful_operations = set()
    all_reported_processes_quiescent = True
    outcomes = report.get('processOutcomes', {})
    if 'processOutcomes' in report:
        _tool_capture_keys(outcomes, operations if complete else (), () if complete else operations)
        need(bool(outcomes), 'Returned TOOL process census empty')
        for operation, row in outcomes.items():
            flags = ('admitted', 'reaped', 'quiescent', 'escapedSession')
            _tool_capture_keys(row, ('reason', 'exit') + flags, ('settlementReason',))
            need(row['reason'] in reasons and all(type(row[key]) is bool for key in flags)
                 and (row['exit'] is None or row['admitted'] and _tool_capture_int(row['exit'], -64, 255))
                 and (not row['escapedSession'] or row['reaped'])
                 and (row['quiescent'] and row['reaped'] and 'settlementReason' not in row
                      or not row['quiescent'] and row.get('settlementReason') == 'group-uncertain'),
                 'Returned TOOL process outcome differs')
            all_reported_processes_quiescent = all_reported_processes_quiescent and row['quiescent']
            if (row['reason'] == 'complete' and row['exit'] == 0 and row['admitted']
                    and row['quiescent'] and not row['escapedSession']):
                successful_operations.add(operation)
    if 'transfer' in report:
        need(set(operations[:2]) <= successful_operations, 'Returned TOOL transfer lacks process outcomes')
    if 'materialized' in report:
        need(set(operations[:4]) <= successful_operations, 'Returned TOOL installation lacks process outcomes')

    cleanup = report['cleanup']
    need(cleanup in ('complete', 'refused', 'not-acquired') and all(report[key] is True for key in closure if key in report)
         and ('namespaceAbsent' not in report or 'mountsAbsent' in report)
         and ('mountsAbsent' not in report or report['ownedProcessesSettled'])
         and (not report['ownedProcessesSettled'] or all_reported_processes_quiescent),
         'Returned TOOL cleanup fields differ')
    # The producer attempts remount or unmount only after observing the owned mount ID.
    if 'mountsAbsent' in report and ('payload-remount' in outcomes or 'payload-unmount' in outcomes):
        need('payload-unmount' in successful_operations, 'Returned TOOL mount absence lacks successful owned unmount')
    if cleanup == 'complete':
        need(all(report.get(key) is True for key in closure) and 'cleanupReason' not in report
             and report['elapsedMs'] < 180000,
             'Returned TOOL cleanup lacks bounded positive closure')
    elif cleanup == 'not-acquired':
        need(report['ownedProcessesSettled'] and report.get('failure') in ('root-parent-acquisition', 'root-acquisition')
             and not any(key in report for key in closure + observed + ('cleanupReason',)),
             'Returned TOOL unacquired state differs')
    if complete:
        need(cleanup == 'complete' and successful_operations == set(operations),
             'Returned TOOL success lacks bounded cleanup and process completion')
    else:
        stages = ('root-parent-acquisition', 'root-acquisition', 'source-capsule', 'private-mount-namespace',
                  'fixed-archive-acquisition', 'strict-materialization', 'readonly-installation-readback',
                  'owner-finalization', 'owned-settlement')
        identity_reasons = ('download-identity-original', 'download-identity-dump-policy',
            'download-identity-dump-policy-root-only', 'download-identity-set-dumpable',
            'download-identity-drop-groups', 'download-identity-drop-gid', 'download-identity-drop-uid',
            'download-identity-post-dumpable', 'download-identity-set-no-new-privs', 'download-identity-post-ids',
            'download-identity-status', 'download-identity-capabilities', 'download-identity-observe-no-new-privs')
        failure_reasons = reasons[1:] + ('host-io', 'contract-refused', 'download-identity', 'download-writer',
            'download-tls-transport', 'download-framing', 'download-deadline', 'download-write',
            'strict-archive-pin', 'strict-archive-or-tree') + identity_reasons
        need(report['failure'] in stages and (report.get('failureReason') in failure_reasons
             or report['failure'] == 'owned-settlement' and 'failureReason' not in report)
             and ('cleanupReason' not in report or cleanup == 'refused' and report['cleanupReason'] in
                  ('namespace-creation-unproved', 'host-io', 'contract-refused', 'deadline', 'owner-interrupted',
                   'handshake-refused', 'protocol-refused', 'command-failed', 'group-uncertain',
                   'descendants-survived', 'session-escaped')),
             'Returned TOOL failure reasons differ')
        failure_reason = report.get('failureReason')
        downloader = outcomes.get('archive-downloader', {})
        code = downloader.get('exit')
        identity_exit = downloader.get('reason') == 'command-failed' and _tool_capture_int(code, 8, 20)
        if identity_exit or failure_reason in identity_reasons:
            need(identity_exit and failure_reason == identity_reasons[code - 8]
                 and report['failure'] == 'fixed-archive-acquisition' and set(outcomes) == set(operations[:2])
                 and 'namespace-private' in successful_operations
                 and downloader['reaped'] and not downloader['escapedSession']
                 and not any(key in report for key in ('transfer', 'materialized')),
                 'Returned TOOL identity reason lacks its exact child exit')


def _validate_tool_capture(raw, status, *, live=False):
    need(status in ('0', '1') and 0 < len(raw) <= 65536, 'Returned TOOL capture required')
    report = json.loads(raw)
    need(type(report) is dict and canonical(report) == raw
         and report.get('kind') == 'NATIVE_TOOL_ONLY_COMPONENT'
         and report.get('complete') is (status == '0') and report.get('releaseAuthorized') is False,
         'Returned TOOL capture differs')
    if report.get('failure') == 'tool-pre-root-refused':
        need(report == _tool_pre_root_refusal(report.get('preRootCheckpoint')), 'Returned TOOL pre-root refusal differs')
    elif report.get('failure') == 'tool-bootstrap-refused':
        need(report == _tool_refusal('tool-bootstrap-refused'), 'Returned TOOL bootstrap refusal differs')
    else:
        _validate_tool_owner_capture(report, live=live)


def prepare_tool():
    checkpoint = 'runner-identity'
    try:
        uid, gid = os.geteuid(), os.getegid()
        need(sys.platform == 'linux' and uid == os.getuid() and gid == os.getgid() and uid > 0 and gid > 0,
             'Original nonroot TOOL bootstrap required')
        checkpoint = 'runner-context'
        environment = {key: os.environ[key] for key in ENVIRONMENT if key in os.environ}
        _, workspace = context(environment)
        checkpoint = 'event-file'
        event_path = os.environ['GITHUB_EVENT_PATH']
        event = _tool_event(environment, event_path, uid)
        checkpoint = 'event-json'
        event_payload = json.loads(event)
        checkpoint = 'dispatch-contract'
        try:
            tool_intent(environment, event_payload)
        except _ToolDispatchRefusal as error:
            checkpoint = error.checkpoint
            raise
        checkpoint = 'controller-location'
        controller = workspace / 'automation'
        need(pathlib.Path(__file__).absolute() == controller / SCRIPT and pathlib.Path.cwd() == controller,
             'Original fixed TOOL controller checkout required')
        checkpoint = 'controller-directory'
        with directory(controller) as root:
            checkpoint = 'controller-script'
            receiver, _ = read(root, SCRIPT, TOOL_MEMBER_MAX)
            checkpoint = 'controller-git-config'
            config = git(controller, ['config', '--local', '--null', '--list']).decode().split('\0')
            for entry in filter(None, config):
                key, _, value = entry.partition('\n')
                need(not re.search(r'(^credential\.|^include\.|^includeif\.|^filter\.|extraheader$|askpass$|sshcommand$|^core\.(?:fsmonitor|worktree)$)', key, re.I),
                     'TOOL controller configuration contains an unowned command source')
                if key == 'remote.origin.url':
                    need(value in ('https://github.com/StradaverseHub/ai-hr', 'https://github.com/StradaverseHub/ai-hr.git'), 'TOOL controller remote differs')
            checkpoint = 'controller-commit'
            sha = environment['GITHUB_SHA']
            need(git(controller, ['rev-parse', 'HEAD']).decode().strip() == sha
                 and git(controller, ['status', '--porcelain']) == b''
                 and git(controller, ['show', sha + ':' + SCRIPT]) == receiver,
                 'Exact committed TOOL bootstrap required')
            checkpoint = 'capsule-members'
            records = git(controller, ['ls-tree', '-rz', sha, '--', *TOOL_MEMBERS]).split(b'\0')
            need(records[-1] == b'' and len(records) == len(TOOL_MEMBERS) + 1, 'Fixed TOOL Git inventory differs')
            rows = []
            for path, record in zip(TOOL_MEMBERS, records[:-1], strict=True):
                raw, info = read(root, path, TOOL_MEMBER_MAX)
                row = _tool_row(path, raw, info)
                need(record == f"100644 blob {row['gitBlob']}\t{path}".encode(), 'TOOL checkout differs from fixed committed Git bytes')
                rows.append(row)
            checkpoint = 'controller-stability'
            need(git(controller, ['rev-parse', 'HEAD']).decode().strip() == sha
                 and git(controller, ['status', '--porcelain']) == b'', 'TOOL controller changed during capture')
            checkpoint = 'controller-directory'
        checkpoint = 'sealed-handoff'
        request = {'environment': environment, 'runnerUid': uid, 'runnerGid': gid, 'rows': rows,
                   'event': {'path': event_path, 'size': len(event), 'sha256': hashlib.sha256(event).hexdigest()}}
        _tool_handoff(receiver, request)
    except Exception:
        return _tool_pre_root_refusal(checkpoint)
    # A successful handoff replaces this process. Fallthrough is a refusal.
    return _tool_pre_root_refusal('unknown')


def seal_tool(request):
    from types import ModuleType

    need(sys.platform == 'linux' and os.geteuid() == 0, 'Root Linux TOOL receiver required')
    need(type(request) is dict and set(request) == {'environment', 'runnerUid', 'runnerGid', 'rows', 'event'},
         'Closed TOOL bootstrap request required')
    environment, uid, gid = request['environment'], request['runnerUid'], request['runnerGid']
    _, workspace = context(environment)
    need(type(uid) is int and type(gid) is int and uid > 0 and gid > 0
         and os.environ.get('SUDO_UID') == str(uid) and os.environ.get('SUDO_GID') == str(gid)
         and pwd.getpwuid(uid).pw_gid == gid, 'Actual TOOL issuer required')
    event_row = request['event']
    need(type(event_row) is dict and set(event_row) == {'path', 'size', 'sha256'}, 'Closed TOOL event row required')
    event = _tool_event(environment, event_row['path'], uid, event_row)
    run, _ = tool_intent(environment, json.loads(event))
    rows = request['rows']
    need(type(rows) is list and len(rows) == len(TOOL_MEMBERS), 'Fixed TOOL capsule census required')
    members = {}
    with directory(workspace / 'automation') as root:
        for path, row in zip(TOOL_MEMBERS, rows, strict=True):
            raw, info = read(root, path, TOOL_MEMBER_MAX)
            need(row == _tool_row(path, raw, info), 'TOOL capsule source bytes differ')
            members[path] = raw
    os.environ.clear()
    os.environ.update(SAFE)
    owner = ModuleType('aihr_fixed_tool_course')
    owner.__file__ = TOOL_SOURCE
    exec(compile(members[TOOL_SOURCE], TOOL_SOURCE, 'exec', dont_inherit=True), owner.__dict__)
    return owner.run_course(run, environment['GITHUB_SHA'], uid, gid, members, rows, event_row['sha256'])


# Fixed synthetic physical capability probe. No production source, packages,
# compiler, browser, database, downloader or deployment enters the jail.
VIEW_BRANCH = 'codex/native-next-project-view-probe-20261109'
VIEW_KIND = 'ROOT_PRIVATE_NEXT_PROJECT_VIEW_SYNTHETIC_CAPABILITY'
VIEW_RECEIPT = 'next-project-view-probe.json'
VIEW_TOOL = '.github/ci/native-workload-browser-tool-course.py'
VIEW_KERNEL = '.github/ci/owned-process.py'
VIEW_MOUNTINFO = 'deploy/admission/next_profile.py'
VIEW_MEMBERS = tuple(sorted((SCRIPT, VIEW_TOOL, VIEW_KERNEL, VIEW_MOUNTINFO)))
VIEW_FILE_MAX = 32768
VIEW_RECEIVER_MAX = 96 * 1024
VIEW_PHASES = ('namespace', 'private-propagation', 'read-only-mounts', 'network-route-census',
               'privilege-drop', 'physical-file-controls')
VIEW_DIRS = ('source', 'dependencies', 'jail', 'jail/project', 'jail/project/app',
             'jail/project/node_modules', 'jail/receipt')
VIEW_SEEDS = {'source/seed': b'fictional source\n', 'dependencies/seed': b'fictional dependency\n'}
VIEW_CREATED = ('jail/project/.next', 'jail/project/.next/probe',
                'jail/project/next-env.d.ts', 'jail/receipt/worker.json')
VIEW_WRITTEN = b'fictional writable output\n'
VIEW_NEWNS = 0x00020000
VIEW_NEWNET = 0x40000000
VIEW_BIND = 4096
VIEW_REMOUNT = 32
VIEW_RDONLY_NOSUID_NODEV = 1 | 2 | 4
VIEW_NOEXEC = 8
VIEW_RECURSIVE_PRIVATE = (1 << 14) | (1 << 18)


def view_intent(environment, event):
    ref = 'refs/heads/' + VIEW_BRANCH
    fields = {'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
              'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_REPOSITORY': 'StradaverseHub/ai-hr',
              'GITHUB_REPOSITORY_ID': '1333414856', 'GITHUB_WORKFLOW': 'alpha-staging-ci',
              'GITHUB_WORKFLOW_REF': 'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@' + ref,
              'GITHUB_JOB': 'resolve', 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_RUN_ATTEMPT': '1',
              'GITHUB_REF': ref, 'GITHUB_REF_NAME': VIEW_BRANCH, 'GITHUB_REF_TYPE': 'branch',
              'RUNNER_TEMP': '/home/runner/work/_temp', 'RUNNER_TOOL_CACHE': '/opt/hostedtoolcache',
              'GITHUB_WORKSPACE': '/home/runner/work/ai-hr/ai-hr'}
    need(type(environment) is dict and set(environment) <= set(ENVIRONMENT)
         and all(type(value) is str and '\0' not in value and len(value) <= 8192 for value in environment.values())
         and all(environment.get(key) == value for key, value in fields.items()), 'Fixed view-probe controller required')
    run, sha = environment.get('GITHUB_RUN_ID', ''), environment.get('GITHUB_SHA', '')
    need(re.fullmatch(r'[1-9][0-9]{0,15}', run) and re.fullmatch(r'[a-f0-9]{40}', sha)
         and all(environment.get(key) == sha for key in ('GITHUB_WORKFLOW_SHA', 'AIHR_CI_HEAD', 'AIHR_CI_CONTROL_HEAD')),
         'Fixed view-probe source identity required')
    repository = event.get('repository') if type(event) is dict else None
    need(type(repository) is dict and type(repository.get('id')) is int and repository['id'] == 1333414856
         and repository.get('full_name') == fields['GITHUB_REPOSITORY'] and event.get('ref') in (ref, VIEW_BRANCH),
         'Fixed view-probe provider event required')
    expected = {'candidate_ref': VIEW_BRANCH, 'expected_sha': sha, 'test_parallelism': '4',
                'commission_singleton_units': '', 'build_only': 'false', 'diagnostics_only': 'true',
                'controller_only': 'true', 'native_tool_only': 'false'}
    inputs = event.get('inputs')
    need(type(inputs) is dict and {'commission_singleton_units': '', **inputs} == expected,
         'Exclusive view-probe controller inputs required')
    return run, pathlib.Path(fields['GITHUB_WORKSPACE'])


def view_scope(run):
    need(type(run) is str and re.fullmatch(r'[1-9][0-9]{0,15}', run), 'Fixed view-probe run required')
    return pathlib.Path('/var/lib') / ('aihr-next-view-probe-' + run)


def view_handoff(receiver, request):
    import fcntl
    encoded = canonical(request)
    need(0 < len(receiver) <= VIEW_RECEIVER_MAX and len(encoded) <= TOOL_REQUEST_MAX,
         'Bounded view-probe receiver and request required')
    fd = os.memfd_create('aihr-next-view-probe', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        need(os.write(fd, encoded) == len(encoded), 'View-probe request write refused')
        seals = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, seals)
        need(fcntl.fcntl(fd, fcntl.F_GET_SEALS) == seals, 'View-probe transport seal refused')
        os.lseek(fd, 0, os.SEEK_SET)
        os.dup2(fd, 0, inheritable=True)
    finally:
        if fd != 0:
            os.close(fd)
    argv = ['/usr/bin/sudo', '-n', '/usr/bin/python3', '-I', '-B', '-c', receiver.decode(), '--seal-next-view-probe']
    os.execve(argv[0], argv, SAFE)


def prepare_view_probe():
    uid, gid = os.geteuid(), os.getegid()
    need(sys.platform == 'linux' and uid == os.getuid() and gid == os.getgid() and uid > 0 and gid > 0,
         'Original nonroot view-probe runner required')
    env = {key: os.environ[key] for key in ENVIRONMENT if key in os.environ}
    path = os.environ['GITHUB_EVENT_PATH']
    raw_event = _tool_event(env, path, uid)
    _, workspace = view_intent(env, json.loads(raw_event))
    need(pathlib.Path.cwd() == workspace and pathlib.Path(__file__).absolute() == workspace / SCRIPT,
         'Fixed view-probe controller location required')
    sha = env['GITHUB_SHA']
    with directory(workspace) as root:
        receiver, _ = read(root, SCRIPT, VIEW_RECEIVER_MAX)
        for entry in filter(None, git(workspace, ['config', '--local', '--null', '--list']).decode().split('\0')):
            key, _, value = entry.partition('\n')
            need(not re.search(r'(^credential\.|^include\.|^includeif\.|^filter\.|extraheader$|askpass$|sshcommand$|^core\.(?:fsmonitor|worktree)$)', key, re.I),
                 'View-probe Git configuration contains a command source')
            if key == 'remote.origin.url':
                need(value in ('https://github.com/StradaverseHub/ai-hr', 'https://github.com/StradaverseHub/ai-hr.git'),
                     'View-probe Git remote differs')
        def require_git_head():
            need(git(workspace, ['rev-parse', 'HEAD']).decode().strip() == sha
                 and git(workspace, ['status', '--porcelain']) == b'', 'View-probe controller Git identity differs')
        require_git_head()
        records = git(workspace, ['ls-tree', '-rz', sha, '--', *VIEW_MEMBERS]).split(b'\0')
        need(records[-1] == b'' and len(records) == len(VIEW_MEMBERS) + 1, 'View-probe source census differs')
        rows = []
        for member, record in zip(VIEW_MEMBERS, records[:-1], strict=True):
            raw, info = read(root, member, TOOL_MEMBER_MAX)
            row = _tool_row(member, raw, info)
            need(record == f"100644 blob {row['gitBlob']}\t{member}".encode()
                 and (member != SCRIPT or raw == receiver), 'View-probe committed bytes differ')
            rows.append(row)
        require_git_head()
    view_handoff(receiver, {'environment': env, 'uid': uid, 'gid': gid, 'rows': rows,
                            'event': {'path': path, 'size': len(raw_event), 'sha256': hashlib.sha256(raw_event).hexdigest()}})
    raise ValueError('View-probe receiver not entered')


def view_birth(info):
    return info.st_dev, info.st_ino


def view_namespaces():
    return {key: view_birth(os.stat('/proc/self/ns/' + key)) for key in ('mnt', 'net', 'user')}


def view_enter_namespaces(libc, original):
    need(libc.unshare(VIEW_NEWNS | VIEW_NEWNET) == 0, 'View worker combined unshare refused')
    private = view_namespaces()
    need(private['mnt'] != original['mnt'] and private['net'] != original['net']
         and private['user'] == original['user'], 'View worker namespace identities differ')
    return private


def view_parent_identity(pid):
    need(type(pid) is int and pid == os.getppid() and pid > 1, 'View worker root parent differs')
    prefix = f'/proc/{pid}/'
    fields = view_proc(prefix + 'stat', 65536).rsplit(b')', 1)[-1].split()
    status = view_proc(prefix + 'status', 65536)
    uids = re.findall(rb'^Uid:[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)$', status, re.M)
    need(len(fields) > 19 and fields[19].isdigit()
         and uids == [(b'0',) * 4]
         and pid == os.getppid(), 'View worker root parent birth differs')
    return fields[19].decode()


def view_mount_rows(parser, *, private=False):
    with directory(pathlib.Path('/proc') / str(os.getpid())) as fd:
        raw = parser.read_proc(fd, 'mountinfo', 4 * 1024**2, need)
    rows = parser.parse_mountinfo(raw, need)
    if private:
        need(not any(field.startswith((b'shared:', b'master:', b'propagate_from:'))
                     for line in raw.splitlines() for field in line.split(b' - ', 1)[0].split()[6:]),
             'View-probe propagation is not private')
    return rows


def view_under(rows, root):
    prefix = str(root)
    return [row for row in rows if row['target'] == prefix or row['target'].startswith(prefix + '/')]


def view_mount_check(rows, root):
    targets = {str(root / 'jail/project/app'): True, str(root / 'jail/project/node_modules'): False}
    owned = view_under(rows, root)
    need(len(owned) == 2 and {row['target'] for row in owned} == set(targets)
         and len({row['id'] for row in owned}) == 2, 'View-probe mount membership differs')
    for row in owned:
        opts = row['options']
        need({'ro', 'nosuid', 'nodev'} <= opts and 'rw' not in opts
             and ('noexec' in opts) == targets[row['target']], 'View-probe mount options differ')
    return owned


def view_proc(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        data = bytearray()
        while True:
            block = os.read(fd, min(65536, maximum + 1 - len(data)))
            if not block:
                return bytes(data)
            data.extend(block)
            need(len(data) <= maximum, 'View-probe proc input exceeds bound')
    finally:
        os.close(fd)


def view_routes(interfaces, flags, ipv4, ipv6):
    need(interfaces == [(1, 'lo')] and flags & 0x8 and not flags & 0x1, 'View-probe loopback is not isolated')
    route = ipv4.splitlines()
    need(len(route) == 1 and route[0].split()[:2] == [b'Iface', b'Destination'], 'View-probe IPv4 route exists')
    rows = ipv6.splitlines()
    need(len(rows) <= 8, 'View-probe IPv6 route count differs')
    for line in rows:
        fields = line.split()
        need(len(fields) == 10 and fields[-1] == b'lo'
             and re.fullmatch(rb'[a-f0-9]{8}', fields[8]) and int(fields[8], 16) & 0x200,
             'View-probe usable IPv6 route exists')
    return len(rows)


def view_network():
    import fcntl
    import socket
    import struct
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM | socket.SOCK_CLOEXEC) as handle:
        raw = fcntl.ioctl(handle.fileno(), 0x8913, struct.pack('16sH22x', b'lo', 0))
    return view_routes(socket.if_nameindex(), struct.unpack_from('H', raw, 16)[0],
                       view_proc('/proc/self/net/route', 65536), view_proc('/proc/self/net/ipv6_route', 65536))


def view_drop(libc, uid, gid, cap_last, dump_policy):
    import ctypes
    class Header(ctypes.Structure):
        _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]
    class Caps(ctypes.Structure):
        _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]
    need(libc.prctl(4, 0, 0, 0, 0) == 0, 'View-probe initial dumpability refused')
    os.setgroups([])
    os.setresgid(gid, gid, gid)
    os.setresuid(uid, uid, uid)
    need(libc.prctl(3, 0, 0, 0, 0) == dump_policy and libc.prctl(4, 0, 0, 0, 0) == 0
         and libc.prctl(3, 0, 0, 0, 0) == 0
         and libc.prctl(38, 1, 0, 0, 0) == 0 and libc.prctl(39, 0, 0, 0, 0) == 1,
         'View-probe no-new-privileges/dumpability differs')
    data = (Caps * 2)()
    header = Header(0x20080522, 0)
    need(os.getresuid() == (uid,) * 3 and os.getresgid() == (gid,) * 3 and not os.getgroups()
         and libc.capget(ctypes.byref(header), ctypes.byref(data)) == 0
         and all((row.effective, row.permitted, row.inheritable) == (0, 0, 0) for row in data)
         and all(libc.prctl(47, 1, cap, 0, 0) == 0 for cap in range(cap_last + 1)),
         'View-probe unprivileged identity/capabilities differ')


def view_erofs(path):
    import errno
    try:
        fd = os.open(path, os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as error:
        need(error.errno == errno.EROFS, 'View-probe write refusal was not EROFS')
    else:
        os.close(fd)
        raise ValueError('View-probe mounted file was writable')


def view_file_controls(mmap):
    with directory(pathlib.Path('/project')) as project:
        for name, seed in zip(('app/seed', 'node_modules/seed'), VIEW_SEEDS.values(), strict=True):
            raw, info = read(project, name, 64)
            need(raw == seed and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
                 == (os.getuid(), os.getgid(), 0o600), 'View-probe mounted seed differs')
            view_erofs('/project/' + name)
        dep = os.open('node_modules/seed', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=project)
        try:
            with mmap.mmap(dep, 0, flags=mmap.MAP_PRIVATE, prot=mmap.PROT_READ | mmap.PROT_EXEC) as mapped:
                need(mapped[:] == VIEW_SEEDS['dependencies/seed'], 'View-probe executable dependency mapping differs')
        finally:
            os.close(dep)
        write(project, 'next-env.d.ts', VIEW_WRITTEN, 0o600)
        fd = os.open('next-env.d.ts', os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=project)
        os.close(fd)
        os.mkdir('.next', 0o700, dir_fd=project)
        write(project, '.next/probe', VIEW_WRITTEN, 0o600)
        for name in ('next-env.d.ts', '.next/probe'):
            raw, _ = read(project, name, 64)
            need(raw == VIEW_WRITTEN, 'View-probe writable output differs')
    names = set()
    with os.scandir('/') as entries:
        for entry in entries:
            need(entry.name in {'project', 'receipt'} and entry.name not in names
                 and entry.is_dir(follow_symlinks=False), 'View-probe host alias exists')
            names.add(entry.name)
    need(names == {'project', 'receipt'}, 'View-probe jail census differs')


def view_worker():
    import ctypes
    import mmap
    import time

    keys = ('AIHR_VIEW_RUN', 'AIHR_VIEW_UID', 'AIHR_VIEW_GID', 'AIHR_VIEW_STOP', 'AIHR_VIEW_MOUNT_SHA',
            'AIHR_VIEW_PARENT', 'AIHR_VIEW_PARENT_START')
    need(set(os.environ) == set(SAFE) | set(keys) and os.getresuid() == os.getresgid() == (0, 0, 0),
         'Fixed root view worker required')
    run, uid_text, gid_text, clock, wanted, issuer, issuer_start = (os.environ[key] for key in keys)
    root = view_scope(run)
    uid, gid, stop = int(uid_text), int(gid_text), float(clock)
    need(uid > 0 and gid > 0 and 0 < stop - time.monotonic() <= 16
         and re.fullmatch(r'[a-f0-9]{64}', wanted) and os.getpid() == os.getsid(0) == os.getpgrp()
         and view_parent_identity(int(issuer)) == issuer_start,
         'Owned view worker identity/clock required')
    def active():
        need(time.monotonic() < stop, 'View worker work frontier closed')
    sink = os.stat('/dev/null')
    for fd in range(3):
        info = os.fstat(fd)
        need(stat.S_ISCHR(info.st_mode) and info.st_rdev == sink.st_rdev, 'View worker stdio is not inert')
    for fd in os.listdir('/proc/self/fd'):
        if int(fd) > 2:
            try:
                os.fstat(int(fd))
            except OSError as error:
                import errno
                need(error.errno == errno.EBADF, 'View worker inherited an unexpected descriptor')
            else:
                raise ValueError('View worker inherited an unexpected descriptor')
    with directory(root, root_owned=True) as held:
        raw, info = read(held, 'mountinfo.py', TOOL_MEMBER_MAX)
        need(info.st_uid == info.st_gid == 0 and hashlib.sha256(raw).hexdigest() == wanted,
             'View worker parser bytes differ')
        from types import ModuleType
        parser = ModuleType('next_view_mountinfo_worker')
        exec(compile(raw, VIEW_MOUNTINFO, 'exec', dont_inherit=True), parser.__dict__)

    libc = ctypes.CDLL(None, use_errno=True)
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p]
    phase = 0
    try:
        active()
        original = view_namespaces()
        need(not view_under(view_mount_rows(parser), root), 'View worker started with an unexpected mount')
        private = view_enter_namespaces(libc, original)
        phase += 1
        active()
        need(libc.mount(None, b'/', None, VIEW_RECURSIVE_PRIVATE, None) == 0,
             'View worker recursive private propagation refused')
        need(not view_under(view_mount_rows(parser, private=True), root), 'View worker private root already mounted')
        phase += 1
        active()
        for source, target, extra in (('source', 'app', VIEW_NOEXEC), ('dependencies', 'node_modules', 0)):
            old = os.fsencode(root / source)
            new = os.fsencode(root / 'jail/project' / target)
            need(libc.mount(old, new, None, VIEW_BIND, None) == 0
                 and libc.mount(None, new, None, VIEW_BIND | VIEW_REMOUNT | VIEW_RDONLY_NOSUID_NODEV | extra, None) == 0,
                 'View worker bind or readonly remount refused')
            active()
        rows = view_mount_check(view_mount_rows(parser, private=True), root)
        for row in rows:
            target = pathlib.Path(row['target'])
            source = root / ('source' if target.name == 'app' else 'dependencies')
            with directory(target) as held:
                fdinfo = view_proc(f'/proc/self/fdinfo/{held}', 65536)
                need(re.findall(rb'^mnt_id:\s+([0-9]+)$', fdinfo, re.M) == [str(row['id']).encode()]
                     and view_birth(os.fstat(held)) == view_birth(source.lstat())
                     and os.fstatvfs(held).f_flag & os.ST_RDONLY, 'View worker opened mount identity differs')
        phase += 1
        active()
        reject_rows = view_network()
        need(view_namespaces() == private and view_parent_identity(int(issuer)) == issuer_start,
             'View worker namespace or root parent changed during census')
        phase += 1
        active()
        cap_last = int(view_proc('/proc/sys/kernel/cap_last_cap', 16).strip())
        dump_policy = view_proc('/proc/sys/fs/suid_dumpable', 16).strip()
        need(0 <= cap_last <= 63 and dump_policy in (b'0', b'2'), 'View worker credential transition policy differs')
        # Close the final old-root descriptor before dropping real credentials.
        with directory(root / 'jail', root_owned=True) as jail:
            os.fchdir(jail)
            os.chroot('.')
            os.chdir('/')
        view_drop(libc, uid, gid, cap_last, int(dump_policy))
        phase += 1
        active()
        view_file_controls(mmap)
        active()
        with directory(pathlib.Path('/receipt')) as receipt:
            write(receipt, 'worker.json', canonical({'phases': list(VIEW_PHASES), 'ipv6RejectRows': reject_rows}), 0o600)
        active()
        return 0
    except BaseException:
        return 40 + phase


def view_cleanup(root, held, births, uid, gid, parser, original, stop, *, require_outputs=False):
    import time
    need(time.monotonic() < stop and view_namespaces() == original
         and not view_under(view_mount_rows(parser), root), 'View-probe host namespace or frontier differs')
    expected_dirs = set(VIEW_DIRS) | {VIEW_CREATED[0]}
    allowed = set(births) | set(VIEW_CREATED)
    visited = {}
    def inspect(folder, prefix=''):
        with os.scandir(folder) as entries:
            for entry in entries:
                need(time.monotonic() < stop and len(visited) < len(allowed), 'View-probe cleanup census exceeds bound')
                path = prefix + entry.name
                need(path in allowed and path not in visited, 'View-probe foreign cleanup entry')
                info = os.stat(entry.name, dir_fd=folder, follow_symlinks=False)
                need(path not in births or births[path] == view_birth(info), 'View-probe cleanup birth changed')
                if path in VIEW_CREATED:
                    mode = 0o700 if path in expected_dirs else 0o600
                    need((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (uid, gid, mode),
                         'View-probe output owner/mode differs')
                visited[path] = view_birth(info)
                if path in expected_dirs:
                    need(stat.S_ISDIR(info.st_mode), 'View-probe cleanup directory differs')
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=folder)
                    try:
                        need(view_birth(os.fstat(child)) == visited[path], 'View-probe cleanup held directory differs')
                        inspect(child, path + '/')
                    finally:
                        os.close(child)
                else:
                    raw, observed = read(held, path, TOOL_MEMBER_MAX)
                    need(view_birth(observed) == visited[path], 'View-probe cleanup held file differs')
                    if path in VIEW_SEEDS:
                        need(raw == VIEW_SEEDS[path] and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
                             == (uid, gid, 0o600), 'View-probe backing seed changed')
                    elif path in VIEW_CREATED[1:3]:
                        need(raw == VIEW_WRITTEN, 'View-probe output bytes differ')
                    elif path == VIEW_CREATED[3]:
                        view_worker_result(raw)
    inspect(held)
    need(set(births) <= set(visited), 'View-probe owned cleanup entry missing')
    need(not require_outputs or set(VIEW_CREATED) <= set(visited), 'View-probe confirmed writable outputs missing')
    for path in sorted(visited, key=lambda value: value.count('/'), reverse=True):
        need(time.monotonic() < stop, 'View-probe cleanup frontier closed')
        with parent(held, path) as (folder, leaf):
            info = os.stat(leaf, dir_fd=folder, follow_symlinks=False)
            need(view_birth(info) == visited[path], 'View-probe cleanup target changed')
            (os.rmdir if path in expected_dirs else os.unlink)(leaf, dir_fd=folder)


def view_worker_result(raw):
    need(type(raw) is bytes and 0 < len(raw) <= 1024, 'View-probe worker receipt bound')
    value = json.loads(raw)
    need(type(value) is dict and set(value) == {'phases', 'ipv6RejectRows'}
         and value['phases'] == list(VIEW_PHASES) and type(value['ipv6RejectRows']) is int
         and 0 <= value['ipv6RejectRows'] <= 8, 'View-probe worker receipt differs')
    return value


def view_report(failure, *, sha=None, run=None, event=None, process=None, worker=None, cleanup=False, elapsed=None):
    if failure in VIEW_PHASES:
        blocked = list(VIEW_PHASES[VIEW_PHASES.index(failure):])
    elif worker is None:
        blocked = list(VIEW_PHASES)
    else:
        blocked = []
    return {'version': 1, 'kind': VIEW_KIND, 'source': sha, 'run': run, 'eventSha256': event,
            'complete': failure is None, 'failure': failure, 'unconfirmedPhases': blocked, 'process': process, 'worker': worker,
            'cleanupComplete': cleanup, 'elapsedMs': elapsed, 'nextTypegenRun': False, 'networkEgressAttempted': False,
            'applicationBuilt': False, 'releaseAuthorized': False}


def view_run(run, sha, uid, gid, members, event_hash):
    import time
    from types import ModuleType
    def module(key):
        value = ModuleType(key)
        value.__file__ = key
        exec(compile(members[key], key, 'exec', dont_inherit=True), value.__dict__)
        return value
    now = time.monotonic()
    stop, active = now + 25, now + 16
    parser, tool, kernel = map(module, (VIEW_MOUNTINFO, VIEW_TOOL, VIEW_KERNEL))
    original = view_namespaces()
    root = view_scope(run)
    failure, process, worker, cleanup = 'root-setup', None, None, False
    attempted = False
    births = {}
    need(os.uname().machine == 'x86_64' and b'VERSION_ID="24.04"' in view_proc('/usr/lib/os-release', 65536).splitlines()
         and b'ID=ubuntu' in view_proc('/usr/lib/os-release', 65536).splitlines(), 'Actual Ubuntu 24.04 view-probe platform required')
    os.umask(0o077)
    try:
        with directory(root.parent, root_owned=True) as prefix:
            need(not view_under(view_mount_rows(parser), root), 'View-probe root has a host mount')
            os.mkdir(root.name, 0o700, dir_fd=prefix)
            birth = view_birth(os.stat(root.name, dir_fd=prefix, follow_symlinks=False))
            with directory(root, root_owned=True) as held:
                need(view_birth(os.fstat(held)) == birth, 'View-probe root changed')
                def remember(path):
                    with parent(held, path) as (folder, leaf):
                        births[path] = view_birth(os.stat(leaf, dir_fd=folder, follow_symlinks=False))
                try:
                    for path in VIEW_DIRS:
                        tool.left(active)
                        with parent(held, path) as (folder, leaf):
                            os.mkdir(leaf, 0o700, dir_fd=folder)
                        remember(path)
                        if path in ('jail/project', 'jail/receipt', 'source', 'dependencies'):
                            with parent(held, path) as (folder, leaf):
                                os.chown(leaf, uid, gid, dir_fd=folder, follow_symlinks=False)
                        if path in ('jail', 'jail/project/app', 'jail/project/node_modules', 'source', 'dependencies'):
                            with parent(held, path) as (folder, leaf):
                                os.chmod(leaf, 0o755, dir_fd=folder)
                    for path, seed in VIEW_SEEDS.items():
                        write(held, path, seed, 0o600)
                        remember(path)
                        with parent(held, path) as (folder, leaf):
                            os.chown(leaf, uid, gid, dir_fd=folder, follow_symlinks=False)
                    write(held, 'mountinfo.py', members[VIEW_MOUNTINFO], 0o600)
                    remember('mountinfo.py')
                    failure = 'owned-worker'
                    argv = ['/usr/bin/python3', '-I', '-B', '-c', members[SCRIPT].decode(), '--run-next-view-probe']
                    os.environ.update({'AIHR_VIEW_RUN': run, 'AIHR_VIEW_UID': str(uid), 'AIHR_VIEW_GID': str(gid),
                                       'AIHR_VIEW_STOP': repr(active),
                                       'AIHR_VIEW_MOUNT_SHA': hashlib.sha256(members[VIEW_MOUNTINFO]).hexdigest(),
                                       'AIHR_VIEW_PARENT': str(os.getpid()),
                                       'AIHR_VIEW_PARENT_START': str(kernel.identity(os.getpid())['start'])})
                    with tool.quiet_command_stdio():
                        tool.left(active)
                        attempted = True
                        process = tool._run_tool_command(kernel, argv, active)
                    need(type(process) is dict and process['reaped'] is True and process['groupQuiescent'] is True
                         and not kernel.own_children(), 'View-probe process settlement refused')
                    code = process['commandExit']
                    if type(code) is int and 40 <= code < 40 + len(VIEW_PHASES):
                        failure = VIEW_PHASES[code - 40]
                    need(process['reason'] == 'complete' and code == 0 and process['admitted'] is True
                         and process['escapedSession'] is False, 'View-probe owned worker refused')
                    failure = 'worker-receipt'
                    raw, info = read(held, VIEW_CREATED[3], 1024)
                    need((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (uid, gid, 0o600),
                         'View-probe worker receipt owner differs')
                    worker = view_worker_result(raw)
                    failure = None
                finally:
                    if not attempted or (process is not None and process['reaped'] is True
                                         and process['groupQuiescent'] is True and not kernel.own_children()):
                        try:
                            view_cleanup(root, held, births, uid, gid, parser, original, stop, require_outputs=worker is not None)
                            need(view_birth(os.stat(root.name, dir_fd=prefix, follow_symlinks=False)) == birth,
                                 'View-probe root cleanup birth changed')
                            # directory() checks the named identity on exit.
                            cleanup = True
                        except BaseException:
                            failure = failure or 'cleanup'
                if cleanup:
                    cleanup = False
                    os.rmdir(root.name, dir_fd=prefix)
                    need(not tool.present(prefix, root.name) and time.monotonic() < stop, 'View-probe root remains')
                    cleanup = True
    except BaseException:
        failure = failure or 'cleanup'
    return view_report(failure or (None if cleanup else 'cleanup'), sha=sha, run=run, event=event_hash,
                       process=process, worker=worker, cleanup=cleanup, elapsed=int((time.monotonic() - now) * 1000))


def seal_view_probe(request):
    need(sys.platform == 'linux' and os.getresuid() == os.getresgid() == (0, 0, 0)
         and type(request) is dict and set(request) == {'environment', 'uid', 'gid', 'rows', 'event'},
         'Fixed root view-probe request required')
    env, uid, gid, event, rows = (request[key] for key in ('environment', 'uid', 'gid', 'event', 'rows'))
    need(type(uid) is int and type(gid) is int and uid > 0 and gid > 0 and pwd.getpwuid(uid).pw_gid == gid
         and os.environ.get('SUDO_UID') == str(uid) and os.environ.get('SUDO_GID') == str(gid),
         'View-probe sudo issuer differs')
    need(type(event) is dict and set(event) == {'path', 'size', 'sha256'}, 'View-probe original event seal required')
    raw = _tool_event(env, event['path'], uid, event)
    run, workspace = view_intent(env, json.loads(raw))
    need(pathlib.Path.cwd() == workspace and type(rows) is list and len(rows) == len(VIEW_MEMBERS),
         'View-probe capsule placement differs')
    members = {}
    with directory(workspace) as root:
        for path, row in zip(VIEW_MEMBERS, rows, strict=True):
            body, info = read(root, path, TOOL_MEMBER_MAX)
            need(row == _tool_row(path, body, info), 'View-probe sealed source bytes differ')
            members[path] = body
    need(0 < len(members[SCRIPT]) <= VIEW_RECEIVER_MAX
         and sys.orig_argv == ['/usr/bin/python3', '-I', '-B', '-c', members[SCRIPT].decode(), '--seal-next-view-probe']
         and pathlib.Path('/proc/self/exe').resolve() == pathlib.Path('/usr/bin/python3').resolve(),
         'View-probe live root receiver bytes differ')
    os.environ.clear()
    os.environ.update(SAFE)
    return view_run(run, env['GITHUB_SHA'], uid, gid, members, event['sha256'])


def validate_view_capture(raw, status):
    need(type(raw) is bytes and 0 < len(raw) <= VIEW_FILE_MAX, 'Bounded view-probe capture required')
    report = json.loads(raw)
    need(type(report) is dict and set(report) == set(view_report('pre-root'))
         and type(report['version']) is int and report['version'] == 1 and report['kind'] == VIEW_KIND
         and all(report[key] is False for key in ('nextTypegenRun', 'networkEgressAttempted', 'applicationBuilt', 'releaseAuthorized'))
         and type(report['cleanupComplete']) is bool and type(report['complete']) is bool
         and ((status == '0') if report['complete'] else status == '1'), 'View-probe capture status differs')
    if report['source'] is None:
        need(all(report[key] is None for key in ('run', 'eventSha256', 'elapsedMs', 'process', 'worker'))
             and report['cleanupComplete'] is False and report['failure'] in ('pre-root', 'root-admission'),
             'View-probe pre-root capture contains physical claims')
    else:
        need(type(report['source']) is str and re.fullmatch(r'[a-f0-9]{40}', report['source'])
             and type(report['eventSha256']) is str and re.fullmatch(r'[a-f0-9]{64}', report['eventSha256'])
             and type(report['run']) is str and re.fullmatch(r'[1-9][0-9]{0,15}', report['run'])
             and type(report['elapsedMs']) is int and 0 <= report['elapsedMs'] < 60000,
             'View-probe physical capture provenance differs')
    process = report['process']
    if process is not None:
        flags = ('admitted', 'reaped', 'groupQuiescent', 'escapedSession')
        need(type(process) is dict and set(process) == {'reason', 'commandExit', *flags}
             and process['reason'] in {'complete', 'command-failed', 'deadline', 'handshake-refused', 'descendants-survived',
                                       'protocol-refused', 'owner-interrupted', 'group-uncertain', 'session-escaped'}
             and (process['commandExit'] is None or type(process['commandExit']) is int and -64 <= process['commandExit'] <= 255)
             and all(type(process[key]) is bool for key in flags), 'View-probe process capture differs')
    if report['worker'] is not None:
        view_worker_result(canonical(report['worker']))
    if report['complete']:
        need(report['failure'] is None and report['cleanupComplete'] is True and report['unconfirmedPhases'] == []
             and type(report['elapsedMs']) is int and 0 <= report['elapsedMs'] < 25000
             and report['process'] == {'reason': 'complete', 'commandExit': 0, 'admitted': True, 'reaped': True,
                                      'groupQuiescent': True, 'escapedSession': False},
             'View-probe success lacks owned settlement')
        need(report['worker'] is not None, 'View-probe physical worker report required')
    else:
        need(report['failure'] in {'pre-root', 'root-admission', 'root-setup', 'owned-worker', 'worker-receipt', 'cleanup', *VIEW_PHASES},
             'View-probe refusal class differs')
        need(report['unconfirmedPhases'] == view_report(report['failure'], worker=report['worker'])['unconfirmedPhases'],
             'View-probe refusal frontier differs')
    return report


def write_view_capture(value):
    raw = canonical(value)
    need(len(raw) <= VIEW_FILE_MAX, 'View-probe receipt bound')
    sys.stdout.buffer.write(raw)
    sys.stdout.flush()


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--next-view-probe']:
            try:
                prepare_view_probe()
            except BaseException:
                write_view_capture(view_report('pre-root'))
            sys.exit(1)
        elif sys.argv[1:] == ['--seal-next-view-probe']:
            try:
                report = seal_view_probe(_tool_request(0))
            except BaseException:
                report = view_report('root-admission')
            write_view_capture(report)
            sys.exit(0 if report['complete'] else 1)
        elif sys.argv[1:] == ['--run-next-view-probe']:
            sys.exit(view_worker())
        elif len(sys.argv) == 3 and sys.argv[1] == '--check-next-view-probe':
            with directory(pathlib.Path(os.environ['RUNNER_TEMP']) / 'aihr-next-view-probe') as folder:
                raw, info = read(folder, VIEW_RECEIPT, VIEW_FILE_MAX)
            need(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, 'View-probe capture owner differs')
            report = validate_view_capture(raw, sys.argv[2])
            if report['source'] is not None:
                event = _tool_event(os.environ, os.environ['GITHUB_EVENT_PATH'], os.getuid())
                need(report['source'] == os.environ['GITHUB_SHA'] and report['run'] == os.environ['GITHUB_RUN_ID']
                     and report['eventSha256'] == hashlib.sha256(event).hexdigest(),
                     'View-probe capture run/source differs')
        elif sys.argv[1:] == ['--seal']:
            raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
            need(0 < len(raw) <= MAX_REQUEST, 'Bounded bootstrap request required')
            print(json.dumps(seal(json.loads(raw))))
        elif sys.argv[1:] == ['--tool-only']:
            _write_tool_receipt(prepare_tool())
            sys.exit(1)
        elif len(sys.argv) == 3 and sys.argv[1] == '--check-tool-capture':
            with directory(pathlib.Path(os.environ['RUNNER_TEMP']) / 'aihr-native-tool-only') as folder:
                raw, info = read(folder, 'native-workload-tool-only.json', 65536)
            need(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, 'TOOL capture owner differs')
            _validate_tool_capture(raw, sys.argv[2], live=True)
        elif sys.argv[1:] == ['--seal-tool-only']:
            try:
                report = seal_tool(_tool_request(0))
            except BaseException:
                report = _tool_refusal('tool-bootstrap-refused')
            _write_tool_receipt(report)
            sys.exit(0 if report['complete'] else 1)
        else:
            need(sys.argv[1:] == [], 'No caller-selected bootstrap operation')
            prepare()
    except Exception:
        sys.stderr.write('Protected native CI owner bootstrap refused\n')
        sys.exit(1)
