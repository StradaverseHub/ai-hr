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
    controller, source = workspace / 'automation', workspace / 'source'
    need(pathlib.Path(__file__).absolute() == controller / SCRIPT, 'Original fixed controller bootstrap required')
    for folder, expected in ((controller, environment['AIHR_CI_CONTROL_HEAD']), (source, environment['AIHR_CI_HEAD'])):
        need(git(folder, ['rev-parse', 'HEAD']).decode().strip() == expected and git(folder, ['status', '--porcelain']) == b'', 'Original controller/source checkout differs')
    config = git(controller, ['config', '--local', '--null', '--list']).decode().split('\0')
    for entry in filter(None, config):
        key, _, value = entry.partition('\n')
        need(not re.search(r'(^credential\.|^include\.|^includeif\.|^filter\.|extraheader$|askpass$|sshcommand$|^core\.fsmonitor$)', key, re.I),
             'Controller configuration contains an unowned credential/command source')
        if key == 'remote.origin.url':
            need(value in ('https://github.com/StradaverseHub/ai-hr', 'https://github.com/StradaverseHub/ai-hr.git'), 'Controller remote differs')
    with directory(controller) as root:
        receiver, _ = read(root, SCRIPT, 1024**2)
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


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--seal']:
            raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
            need(0 < len(raw) <= MAX_REQUEST, 'Bounded bootstrap request required')
            print(json.dumps(seal(json.loads(raw))))
        else:
            need(sys.argv[1:] == [], 'No caller-selected bootstrap operation')
            prepare()
    except Exception:
        sys.stderr.write('Protected native CI owner bootstrap refused\n')
        sys.exit(1)
