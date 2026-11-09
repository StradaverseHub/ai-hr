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


_PINNED_NODE_PATH = pathlib.Path('/opt/hostedtoolcache/node/22.23.3/x64/bin/node')


def _capture_pinned_node(*, exact_path=False):
    original_node = pathlib.Path(shutil.which('node')).resolve()
    if exact_path:
        need(original_node == _PINNED_NODE_PATH, 'Exact pinned setup-node executable required')
    with directory(original_node.parent) as root:
        raw, _ = read(root, original_node.name, MAX_FILE)
    facts = subprocess.run([str(original_node), '-p', 'JSON.stringify({node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime})'],
                           env=SAFE, timeout=10, capture_output=True, check=True)
    need(json.loads(facts.stdout) == {'node': '22.23.3', 'abi': '127', 'platform': 'linux', 'arch': 'x64', 'glibc': '2.39'}, 'Exact pinned setup-node runtime required')
    return original_node, raw


def _require_pinned_node_row(node):
    need(isinstance(node, dict) and set(node) == {'path', 'sha256', 'bytes'} and type(node['bytes']) is int
         and 0 < node['bytes'] <= MAX_FILE and re.fullmatch(r'[a-f0-9]{64}', node['sha256']), 'Exact pinned Node facts required')
    node_path = pathlib.Path(node['path'])
    need(str(node_path.resolve()) == str(node_path)
         and str(node_path) == str(_PINNED_NODE_PATH), 'Exact pinned setup-node executable required')


def _read_pinned_node(node, uid):
    with directory(_PINNED_NODE_PATH.parent) as source:
        raw, info = read(source, _PINNED_NODE_PATH.name, MAX_FILE, {'size': node['bytes'], 'sha256': node['sha256']})
        need(info.st_uid in (0, uid) and raw.startswith(b'\x7fELF'), 'Actual installed Node ELF required')
    return raw


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
    _require_pinned_node_row(node)
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
        raw = _read_pinned_node(node, uid)
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
    original_node, raw = _capture_pinned_node()
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
BROWSER_STAGE_BRANCH = 'codex/native-synthetic-browser-stage-course-20261109'
BROWSER_STAGE_SOURCE = '.github/ci/native-workload-browser-synthetic-stage-course.py'
BROWSER_STAGE_ROLES = ('.github/ci/native-workload-browser-host.py',
                       'test/performance/native-workload-browser-driver.mjs',
                       'test/performance/native-workload-browser-server.mjs')
BROWSER_STAGE_MEMBERS = tuple(sorted((
    *TOOL_MEMBERS, BROWSER_STAGE_SOURCE, *BROWSER_STAGE_ROLES,
    '.github/ci/native-workload-browser-launch-view.py', '.github/ci/native-workload-browser-synthetic-stage.py',
    '.github/ci/native-workload-browser-synthetic-stage-cleanup.py',
    '.github/ci/native-workload-browser-synthetic-stage-owner.py',
)))
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


def browser_stage_intent(environment, event):
    """Bind the one isolated staging component before acquiring root authority."""
    run, workspace = context(environment)
    ref = 'refs/heads/' + BROWSER_STAGE_BRANCH
    sha = environment['GITHUB_SHA']
    need(environment.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
         and environment.get('GITHUB_REF') == ref and environment.get('GITHUB_REF_NAME') == BROWSER_STAGE_BRANCH
         and environment.get('GITHUB_REF_TYPE') == 'branch'
         and environment['GITHUB_WORKFLOW_SHA'] == environment['AIHR_CI_HEAD'] == sha
         and environment.get('GITHUB_WORKFLOW_REF') == 'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@' + ref,
         'Exact browser stage self-source workflow required')
    need(type(event) is dict and type(event.get('repository')) is dict
         and event['repository'].get('id') == 1333414856
         and event['repository'].get('full_name') == 'StradaverseHub/ai-hr'
         and event.get('ref') in (ref, BROWSER_STAGE_BRANCH), 'Original browser stage event differs')
    expected = {'candidate_ref': BROWSER_STAGE_BRANCH, 'expected_sha': sha, 'test_parallelism': '4',
                'commission_singleton_units': '', 'build_only': 'false', 'diagnostics_only': 'true',
                'controller_only': 'false', 'native_tool_only': 'false', 'native_browser_stage_only': 'true'}
    inputs = event.get('inputs')
    need(type(inputs) is dict and {'commission_singleton_units': '', **inputs} == expected,
         'Exclusive fixed browser stage dispatch inputs required')
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


def _tool_handoff(receiver, request, *, browser_stage=False):
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
    selector = '--seal-browser-stage-only' if browser_stage else '--seal-tool-only'
    command = ['/usr/bin/sudo', '-n', '/usr/bin/python3', '-I', '-B', '-c', receiver.decode(), selector]
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


BROWSER_STAGE_INACTIVE = ('rolesStarted', 'browserStarted', 'applicationBuilt', 'databaseStarted',
                          'nativeWorkloadQualified', 'releaseAuthorized')


BROWSER_STAGE_FAILURE_PHASES = (
    'root-parent-acquisition', 'root-acquisition', 'source-capsule', 'private-mount-namespace',
    'fixed-archive-acquisition', 'stage-preparation', 'stage-disposal', 'stage-owner-settlement',
    'archive-disposal', 'owner-settlement',
)

BROWSER_STAGE_FAILURE_REASONS = (
    'command-failed', 'deadline', 'handshake-refused', 'descendants-survived', 'protocol-refused',
    'owner-interrupted', 'group-uncertain', 'session-escaped', 'download-identity', 'download-writer',
    'download-tls-transport', 'download-framing', 'download-deadline', 'download-write',
    'download-identity-original', 'download-identity-dump-policy', 'download-identity-dump-policy-root-only',
    'download-identity-set-dumpable', 'download-identity-drop-groups', 'download-identity-drop-gid',
    'download-identity-drop-uid', 'download-identity-post-dumpable', 'download-identity-set-no-new-privs',
    'download-identity-post-ids', 'download-identity-status', 'download-identity-capabilities',
    'download-identity-observe-no-new-privs', 'host-io', 'contract-refused', 'strict-archive-pin',
    'strict-archive-or-tree', 'namespace-creation-unproved', 'launch-view-ancestry',
    'launch-view-backing-identity', 'launch-view-capacity', 'launch-view-copy-bound', 'launch-view-deadline',
    'launch-view-directory', 'launch-view-empty-parent', 'launch-view-fd-flags', 'launch-view-fd-mount',
    'launch-view-foreign-mount', 'launch-view-fragment', 'launch-view-manager-birth',
    'launch-view-manager-executable', 'launch-view-manager-uid', 'launch-view-mount-changed',
    'launch-view-namespace', 'launch-view-pid-namespace', 'launch-view-proc-bound', 'launch-view-proc-file',
    'launch-view-proc-identity', 'launch-view-root', 'launch-view-root-identity', 'launch-view-run',
    'launch-view-run-mount', 'launch-view-stage-fd', 'launch-view-stage-mount',
)


def _browser_stage_refusal(reason, checkpoint=None):
    report = {'kind': 'NATIVE_BROWSER_SYNTHETIC_STAGE_COMPONENT', 'complete': False,
              'failure': reason, **dict.fromkeys(BROWSER_STAGE_INACTIVE, False)}
    if reason == 'browser-stage-pre-root-refused':
        need(checkpoint in (*TOOL_PRE_ROOT_CHECKPOINTS, 'pinned-node'), 'Unknown browser stage checkpoint')
        report['preRootCheckpoint'] = checkpoint
    return report


def _validate_browser_stage_capture(raw, status, environment):
    need(status in ('0', '1') and 0 < len(raw) <= 65536, 'Returned browser stage capture required')
    report = json.loads(raw)
    need(type(report) is dict and canonical(report) == raw
         and report.get('kind') == 'NATIVE_BROWSER_SYNTHETIC_STAGE_COMPONENT'
         and report.get('complete') is (status == '0')
         and all(report.get(key) is False for key in BROWSER_STAGE_INACTIVE), 'Returned browser stage capture differs')
    failure = report.get('failure')
    if failure in ('browser-stage-pre-root-refused', 'browser-stage-bootstrap-refused'):
        need(status == '1' and report == _browser_stage_refusal(failure, report.get('preRootCheckpoint')),
             'Returned browser stage bootstrap refusal differs')
        return
    run, _ = context(environment)
    required = ('kind', 'complete', 'source', 'controller', 'runId', 'attempt', 'job', 'eventSha256',
                'sourceCapsuleSha256', 'elapsedMs', 'ownedProcessesSettled', 'cleanup', *BROWSER_STAGE_INACTIVE)
    _tool_capture_keys(report, required + (() if status == '0' else ('failure',)), ('stage',))
    need(report['source'] == report['controller'] == environment['GITHUB_SHA']
         and report['runId'] == run and report['job'] == 'native-test' and type(report['attempt']) is int
         and report['attempt'] == 1 and _tool_capture_int(report['elapsedMs'], 0, 180000)
         and type(report['ownedProcessesSettled']) is bool
         and all(_tool_capture_hex(report[key], 64) for key in ('eventSha256', 'sourceCapsuleSha256')),
         'Returned browser stage identity differs')
    cleanup = report['cleanup']
    _tool_capture_keys(cleanup, ('stage', 'archives'))
    need(all(value in ('not-acquired', 'complete', 'refused') for value in cleanup.values()),
         'Returned browser stage cleanup differs')
    if 'stage' in report:
        stage = report['stage']
        _tool_capture_keys(stage, ('treeSha256', 'entries', 'fileBytes', 'currentRootMatched', 'managerRootMatched'))
        need(_tool_capture_hex(stage['treeSha256'], 64) and _tool_capture_int(stage['entries'], 509, 509)
             and _tool_capture_int(stage['fileBytes'], 291895067, 560396058)
             and stage['currentRootMatched'] is True and stage['managerRootMatched'] is True,
             'Returned browser stage readback differs')
    if status == '0':
        need('stage' in report and all(value == 'complete' for value in cleanup.values())
             and report['ownedProcessesSettled'] is True and report['elapsedMs'] < 180000,
             'Returned browser stage success lacks bounded settlement')
    else:
        _tool_capture_keys(failure, ('phase', 'reason'))
        need(failure['phase'] in BROWSER_STAGE_FAILURE_PHASES and failure['reason'] in BROWSER_STAGE_FAILURE_REASONS,
             'Returned browser stage failure differs')


def prepare_tool(*, browser_stage=False):
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
            if browser_stage:
                browser_stage_intent(environment, event_payload)
            else:
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
            paths = BROWSER_STAGE_MEMBERS if browser_stage else TOOL_MEMBERS
            records = git(controller, ['ls-tree', '-rz', sha, '--', *paths]).split(b'\0')
            need(records[-1] == b'' and len(records) == len(paths) + 1, 'Fixed TOOL Git inventory differs')
            rows = []
            for path, record in zip(paths, records[:-1], strict=True):
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
        if browser_stage:
            checkpoint = 'pinned-node'
            path, raw = _capture_pinned_node(exact_path=True)
            node = {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            _require_pinned_node_row(node)
            request['node'] = node
            checkpoint = 'sealed-handoff'
            _tool_handoff(receiver, request, browser_stage=True)
        else:
            _tool_handoff(receiver, request)
    except Exception:
        if browser_stage:
            return _browser_stage_refusal('browser-stage-pre-root-refused', checkpoint)
        return _tool_pre_root_refusal(checkpoint)
    # A successful handoff replaces this process. Fallthrough is a refusal.
    if browser_stage:
        return _browser_stage_refusal('browser-stage-pre-root-refused', 'unknown')
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


def seal_browser_stage(request):
    from types import ModuleType

    need(sys.platform == 'linux' and os.geteuid() == 0, 'Root Linux browser stage receiver required')
    need(type(request) is dict and set(request) == {'environment', 'runnerUid', 'runnerGid', 'rows', 'event', 'node'},
         'Closed browser stage bootstrap request required')
    environment, uid, gid = request['environment'], request['runnerUid'], request['runnerGid']
    _, workspace = context(environment)
    need(type(uid) is int and type(gid) is int and uid > 0 and gid > 0
         and os.environ.get('SUDO_UID') == str(uid) and os.environ.get('SUDO_GID') == str(gid)
         and pwd.getpwuid(uid).pw_gid == gid, 'Actual browser stage issuer required')
    event_row = request['event']
    need(type(event_row) is dict and set(event_row) == {'path', 'size', 'sha256'}, 'Closed browser stage event required')
    event = _tool_event(environment, event_row['path'], uid, event_row)
    run, _ = browser_stage_intent(environment, json.loads(event))
    node = request['node']
    _require_pinned_node_row(node)
    node_raw = _read_pinned_node(node, uid)
    rows = request['rows']
    need(type(rows) is list and len(rows) == len(BROWSER_STAGE_MEMBERS), 'Fixed browser stage capsule census required')
    members = {}
    with directory(workspace / 'automation') as root:
        for path, row in zip(BROWSER_STAGE_MEMBERS, rows, strict=True):
            raw, info = read(root, path, TOOL_MEMBER_MAX)
            need(row == _tool_row(path, raw, info), 'Browser stage capsule source bytes differ')
            members[path] = raw
    os.environ.clear()
    os.environ.update(SAFE)
    tool = ModuleType('aihr_fixed_stage_tool_course')
    tool.__file__ = TOOL_SOURCE
    exec(compile(members[TOOL_SOURCE], TOOL_SOURCE, 'exec', dont_inherit=True), tool.__dict__)
    owner = tool.source_module('aihr_fixed_browser_stage_course', BROWSER_STAGE_SOURCE, members[BROWSER_STAGE_SOURCE])
    report = owner.run_stage(tool, run, environment['GITHUB_SHA'], uid, gid, members, rows, event_row['sha256'],
                             node_bytes=node_raw, node_sha256=node['sha256'])
    need(report.get('sourceCapsuleSha256') == hashlib.sha256(canonical(rows)).hexdigest(),
         'Returned browser stage source capsule differs')
    if 'stage' in report:
        expected_bytes = 291895066 + len(node_raw) + sum(len(members[path]) for path in BROWSER_STAGE_ROLES)
        need(report['stage'].get('entries') == 509 and report['stage'].get('fileBytes') == expected_bytes,
             'Returned browser stage extent differs from its held input')
    return report


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--seal']:
            raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
            need(0 < len(raw) <= MAX_REQUEST, 'Bounded bootstrap request required')
            print(json.dumps(seal(json.loads(raw))))
        elif sys.argv[1:] == ['--tool-only']:
            _write_tool_receipt(prepare_tool())
            sys.exit(1)
        elif sys.argv[1:] == ['--browser-stage-only']:
            _write_tool_receipt(prepare_tool(browser_stage=True))
            sys.exit(1)
        elif len(sys.argv) == 3 and sys.argv[1] == '--check-tool-capture':
            with directory(pathlib.Path(os.environ['RUNNER_TEMP']) / 'aihr-native-tool-only') as folder:
                raw, info = read(folder, 'native-workload-tool-only.json', 65536)
            need(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, 'TOOL capture owner differs')
            _validate_tool_capture(raw, sys.argv[2], live=True)
        elif len(sys.argv) == 3 and sys.argv[1] == '--check-browser-stage-capture':
            with directory(pathlib.Path(os.environ['RUNNER_TEMP']) / 'aihr-native-browser-stage') as folder:
                raw, info = read(folder, 'native-workload-browser-stage.json', 65536)
            need(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, 'Browser stage capture owner differs')
            _validate_browser_stage_capture(raw, sys.argv[2], dict(os.environ))
        elif sys.argv[1:] == ['--seal-tool-only']:
            try:
                report = seal_tool(_tool_request(0))
            except BaseException:
                report = _tool_refusal('tool-bootstrap-refused')
            _write_tool_receipt(report)
            sys.exit(0 if report['complete'] else 1)
        elif sys.argv[1:] == ['--seal-browser-stage-only']:
            try:
                report = seal_browser_stage(_tool_request(0))
            except BaseException:
                report = _browser_stage_refusal('browser-stage-bootstrap-refused')
            _write_tool_receipt(report)
            sys.exit(0 if report['complete'] else 1)
        else:
            need(sys.argv[1:] == [], 'No caller-selected bootstrap operation')
            prepare()
    except Exception:
        sys.stderr.write('Protected native CI owner bootstrap refused\n')
        sys.exit(1)
