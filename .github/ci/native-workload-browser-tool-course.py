"""One protected, disposable tool-only course. No candidate runtime or API."""
from __future__ import annotations

import ctypes
import hashlib
import http.client
import json
import os
import pathlib
import re
import signal
import ssl
import stat
import sys
import time
from contextlib import ExitStack, contextmanager
from types import ModuleType


ROOT_PARENT = pathlib.Path('/var/lib')
ROOT_PREFIX = 'aihr-native-tool-only-'
SOURCE = '.github/ci/native-workload-browser-tool-course.py'
GENERATION = '1784092784777971'
BROWSER_BYTES = 120231126
NPM_MAX = 16 * 1024**2
CHUNK = 256 * 1024
ACTIVE_SECONDS, TOTAL_SECONDS, PROCESS_SETTLEMENT = 150, 180, 6
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
READ = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
WRITE = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
PROC_MAX = 4 * 1024**2
MOUNT = '/usr/bin/mount'
UMOUNT = '/usr/bin/umount'
DOWNLOADS = (
    ('chromium.zip', 'storage.googleapis.com',
     '/storage/v1/b/chrome-for-testing-public/o/151.0.7922.34%2Flinux64%2Fchrome-headless-shell-linux64.zip'
     '?alt=media&generation=' + GENERATION, BROWSER_BYTES),
    ('playwright.tgz', 'registry.npmjs.org', '/playwright/-/playwright-1.62.1.tgz', NPM_MAX),
    ('playwright-core.tgz', 'registry.npmjs.org', '/playwright-core/-/playwright-core-1.62.1.tgz', NPM_MAX),
    ('postgres.tgz', 'registry.npmjs.org', '/postgres/-/postgres-3.4.9.tgz', NPM_MAX),
)
ARCHIVES = frozenset(row[0] for row in DOWNLOADS)
TOP_LEVEL = frozenset(('code', 'incoming', 'inputs', 'payload'))


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False) + '\n').encode()


def left(deadline):
    seconds = deadline - time.monotonic()
    require(seconds > 0, 'TOOL elapsed boundary')
    return seconds


def birth(info):
    return info.st_dev, info.st_ino


def identity(info):
    return (*birth(info), info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def named(parent, name):
    return os.stat(name, dir_fd=parent, follow_symlinks=False)


def present(parent, name):
    try:
        named(parent, name)
    except FileNotFoundError:
        return False
    return True


@contextmanager
def owned_fd(fd):
    try:
        yield fd
    except BaseException as error:
        try:
            os.close(fd)
        except OSError:
            error.add_note('TOOL descriptor close refused')
        raise
    else:
        os.close(fd)


@contextmanager
def quiet_command_stdio():
    # Keep the original sealed request and receipt descriptors out of even the
    # fixed child. The kernel already supplies its own private process ledger.
    with ExitStack() as held:
        original = [held.enter_context(owned_fd(os.dup(fd))) for fd in (0, 1, 2)]
        sink = held.enter_context(owned_fd(os.open('/dev/null', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)))
        try:
            for fd in (0, 1, 2):
                os.dup2(sink, fd)
            yield
        finally:
            primary = sys.exception()
            failed = False
            for fd, saved in enumerate(original):
                try:
                    os.dup2(saved, fd)
                except OSError:
                    failed = True
            if failed:
                if primary is None:
                    raise OSError('TOOL command stdio restore refused')
                primary.add_note('TOOL command stdio restore refused')


def require_dir(info, uid, gid, mode, device):
    require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == mode and info.st_uid == uid
            and info.st_gid == gid and info.st_dev == device, 'TOOL directory ownership differs')


def require_file(info, uid, gid, mode, maximum):
    require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == mode and info.st_uid == uid
            and info.st_gid == gid and info.st_nlink == 1 and 0 < info.st_size <= maximum,
            'TOOL regular file custody differs')


def write_all(fd, raw, deadline):
    view = memoryview(raw)
    while view:
        left(deadline)
        count = os.write(fd, view)
        require(0 < count <= len(view), 'TOOL write made no progress')
        view = view[count:]


def read_file(parent, name, uid, gid, maximum, deadline):
    before = named(parent, name)
    require_file(before, uid, gid, 0o600, maximum)
    with owned_fd(os.open(name, READ, dir_fd=parent)) as fd:
        require(identity(os.fstat(fd)) == identity(before), 'TOOL opened file differs')
        result = bytearray()
        while len(result) < before.st_size:
            left(deadline)
            block = os.read(fd, min(CHUNK, before.st_size - len(result)))
            require(block, 'TOOL source truncated')
            result.extend(block)
        left(deadline)
        require(os.read(fd, 1) == b'' and identity(before) == identity(os.fstat(fd))
                == identity(named(parent, name)), 'TOOL source changed')
    return bytes(result)


def bounded_proc(path, maximum):
    with open(path, 'rb', buffering=0) as fd:
        raw = fd.read(maximum + 1)
    require(0 < len(raw) <= maximum, 'TOOL proc observation exceeds bound')
    return raw


def source_module(name, path, raw):
    module = ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    exec(compile(raw, str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


def _download_headers(response, maximum, browser):
    headers = response.getheaders()
    require(response.status == 200 and len(headers) <= 64
            and sum(len(key) + len(value) for key, value in headers) <= 65536,
            'TOOL HTTP response differs')
    values = lambda key: [value.strip() for name, value in headers if name.lower() == key]
    require(values('content-encoding') in ([], ['identity']) and not values('content-range')
            and not values('location'), 'TOOL HTTP encoding or location differs')
    lengths, transfers = values('content-length'), values('transfer-encoding')
    if lengths:
        require(len(lengths) == 1 and not transfers and re.fullmatch(r'[1-9][0-9]{0,9}', lengths[0]),
                'TOOL HTTP content length differs')
        size = int(lengths[0])
        require(size <= maximum, 'TOOL HTTP content length exceeds bound')
    else:
        require(transfers == ['chunked'] and not browser, 'TOOL HTTP framing differs')
        size = None
    if browser:
        require(size == BROWSER_BYTES and values('x-goog-generation') == [GENERATION],
                'TOOL fixed publisher generation or length differs')
    return size


def _drop_downloader(uid, gid):
    require(os.geteuid() == 0 and type(uid) is int and type(gid) is int and uid > 0 and gid > 0,
            'TOOL downloader original identity differs')
    libc = ctypes.CDLL(None, use_errno=True)
    os.setgroups([])
    os.setresgid(gid, gid, gid)
    os.setresuid(uid, uid, uid)
    require(libc.prctl(38, 1, 0, 0, 0) == 0 and os.getresuid() == (uid,)*3
            and os.getresgid() == (gid,)*3 and not os.getgroups(), 'TOOL downloader UID/GID or no-new-privs differs')
    status = bounded_proc('/proc/self/status', 65536)
    for key in (b'CapInh', b'CapPrm', b'CapEff', b'CapAmb'):
        require(re.findall(rb'^' + key + rb':\s+([0-9a-f]+)$', status, re.M) == [b'0000000000000000'],
                'TOOL downloader capabilities differ')
    require(re.findall(rb'^NoNewPrivs:\s+([0-9]+)$', status, re.M) == [b'1'],
            'TOOL downloader no-new-privs differs')


def download(uid, gid, deadline):
    here = pathlib.Path(__file__).absolute()
    root = here.parents[3]
    require(root.parent == ROOT_PARENT and re.fullmatch(ROOT_PREFIX + r'[1-9][0-9]{0,15}', root.name)
            and here == root / 'code' / SOURCE, 'Fixed TOOL downloader source required')
    _drop_downloader(uid, gid)
    left(deadline)
    lengths = {}
    tls = ssl.create_default_context(cafile='/etc/ssl/certs/ca-certificates.crt')
    incoming = root / 'incoming'
    before = incoming.lstat()
    with owned_fd(os.open(incoming, DIR)) as folder:
        require_dir(before, uid, gid, 0o700, root.lstat().st_dev)
        require(identity(os.fstat(folder)) == identity(before), 'TOOL downloader directory changed')
        for name, host, target, maximum in DOWNLOADS:
            connection = http.client.HTTPSConnection(host, timeout=min(10, left(deadline)), context=tls)
            try:
                connection.request('GET', target, headers={'Accept-Encoding': 'identity', 'Connection': 'close'})
                with connection.getresponse() as response:
                    expected = _download_headers(response, maximum, name == 'chromium.zip')
                    total = 0
                    with owned_fd(os.open(name, WRITE, 0o600, dir_fd=folder)) as fd:
                        while True:
                            left(deadline)
                            block = response.read(min(CHUNK, maximum + 1 - total))
                            if not block:
                                break
                            total += len(block)
                            require(total <= maximum, 'TOOL transfer exceeds byte bound')
                            write_all(fd, block, deadline)
                        require(total > 0 and (expected is None or total == expected), 'TOOL HTTP body length differs')
                        lengths[name] = total
            finally:
                connection.close()
        with owned_fd(os.open('download.json', WRITE, 0o600, dir_fd=folder)) as fd:
            write_all(fd, canonical({'lengths': lengths, 'generation': GENERATION}), deadline)
    left(deadline)


class Course:
    def __init__(self, run, uid, gid, start):
        self.name = ROOT_PREFIX + run
        self.path = ROOT_PARENT / self.name
        self.uid, self.gid = uid, gid
        self.active, self.deadline = start + ACTIVE_SECONDS, start + TOTAL_SECONDS
        self.parent = self.root = None
        self.creation_attempted = self.created = False
        self.device = None
        self.births = {}
        self.processes_settled = True
        self.mount_uncertain = False
        self.owned_mount = None
        self.mounts = None
        self.kernel = None
        self.stage = 'root-acquisition'
        self.state = {}

    def create(self, parent):
        left(self.active)
        info = os.fstat(parent)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'TOOL parent is not protected')
        self.parent = parent
        require(not present(parent, self.name), 'TOOL namespace already exists')
        left(self.active)
        self.creation_attempted = True
        os.mkdir(self.name, mode=0o700, dir_fd=parent)
        self.created = True
        first = named(parent, self.name)
        self.births[''] = birth(first)
        self.root = os.open(self.name, DIR, dir_fd=parent)
        self.device = first.st_dev
        self.check_root(0o700)

    def check_root(self, mode):
        require(self.root is not None, 'TOOL root descriptor unavailable')
        parent = ROOT_PARENT.lstat()
        require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and not parent.st_mode & 0o022
                and birth(parent) == birth(os.fstat(self.parent)), 'TOOL parent identity changed')
        before, current = named(self.parent, self.name), os.fstat(self.root)
        require_dir(current, 0, 0, mode, self.device)
        require(birth(current) == self.births[''] and identity(before) == identity(current),
                'TOOL owned root changed')
        return current

    def add_directory(self, name):
        left(self.active)
        os.mkdir(name, mode=0o700, dir_fd=self.root)
        info = named(self.root, name)
        require_dir(info, 0, 0, 0o700, self.device)
        self.births[name] = birth(info)

    def child_directory(self, name, uid=0, gid=0, mode=0o700):
        before = named(self.root, name)
        require_dir(before, uid, gid, mode, self.device)
        require(birth(before) == self.births[name], 'TOOL child directory changed')
        fd = os.open(name, DIR, dir_fd=self.root)
        try:
            require(identity(os.fstat(fd)) == identity(before), 'TOOL opened directory differs')
            return fd
        except BaseException:
            os.close(fd)
            raise

    def install_capsule(self, members):
        self.add_directory('code')
        with owned_fd(self.child_directory('code')) as capsule:
            for relative, raw in members.items():
                left(self.active)
                parts = relative.split('/')
                with ExitStack() as stack:
                    parent = capsule
                    for part in parts[:-1]:
                        fresh = not present(parent, part)
                        if fresh:
                            left(self.active)
                            os.mkdir(part, mode=0o700, dir_fd=parent)
                        parent = stack.enter_context(owned_fd(os.open(part, DIR, dir_fd=parent)))
                        if fresh:
                            left(self.active)
                            os.fchmod(parent, 0o755)
                        require_dir(os.fstat(parent), 0, 0, 0o755, self.device)
                    left(self.active)
                    with owned_fd(os.open(parts[-1], WRITE, 0o400, dir_fd=parent)) as fd:
                        write_all(fd, raw, self.active)
                        left(self.active)
                        os.fchmod(fd, 0o444)
                        info = os.fstat(fd)
                        require_file(info, 0, 0, 0o444, len(raw))
                    with owned_fd(os.open(parts[-1], READ, dir_fd=parent)) as fd:
                        require(identity(os.fstat(fd)) == identity(info), 'TOOL capsule copy identity differs')
                        offset = 0
                        while offset < len(raw):
                            left(self.active)
                            block = os.read(fd, min(CHUNK, len(raw) - offset))
                            require(block and block == raw[offset:offset + len(block)], 'TOOL capsule copy bytes differ')
                            offset += len(block)
                        require(os.read(fd, 1) == b'' and identity(info) == identity(os.fstat(fd))
                                == identity(named(parent, parts[-1])), 'TOOL capsule copy changed')
            left(self.active)
            os.fchmod(capsule, 0o555)
        code = self.path / 'code'
        self.kernel = source_module('aihr_tool_course_process', code / '.github/ci/owned-process.py',
                                    members['.github/ci/owned-process.py'])
        self.inventory = source_module('aihr_tool_course_inventory', code / '.github/ci/runtime_inventory.py',
                                       members['.github/ci/runtime_inventory.py'])
        materializer = '.github/ci/native-workload-browser-tool-installation.py'
        self.installer = source_module('aihr_tool_course_materializer', code / materializer, members[materializer])

    def command(self, argv, deadline, maximum):
        with quiet_command_stdio():
            budget = min(maximum, left(deadline) - PROCESS_SETTLEMENT)
            require(budget > 0, 'TOOL process settlement reserve unavailable')
            self.processes_settled = False
            result = self.kernel.supervise(argv, budget, lambda _event: None)
        self.processes_settled = (result['reaped'] is True and result['groupQuiescent'] is True
                                  and self.kernel.own_children() == [])
        require(self.processes_settled and result['admitted'] is True and result['reason'] == 'complete'
                and result['commandExit'] == 0 and result['escapedSession'] is False,
                'TOOL owned command or settlement refused')
        left(deadline)

    def observe_mounts(self, deadline, *, private=False):
        left(deadline)
        with owned_fd(os.open('/proc/self', os.O_RDONLY | os.O_DIRECTORY)) as proc:
            raw = self.mounts.read_proc(proc, 'mountinfo', PROC_MAX, require)
        rows = self.mounts.parse_mountinfo(raw, require)
        if private:
            for line in raw.splitlines():
                fields = line.split(b' - ', 1)[0].split()
                require(not any(field.startswith((b'shared:', b'master:', b'propagate_from:')) for field in fields[6:]),
                        'TOOL mount propagation is not private')
        left(deadline)
        return rows

    def own_targets(self, rows):
        prefix = str(self.path)
        return [row for row in rows if row['target'] == prefix or row['target'].startswith(prefix + '/')]

    def enter_private_mount_namespace(self):
        require(not self.own_targets(self.observe_mounts(self.active)), 'Existing TOOL namespace mount')
        previous = birth(os.stat('/proc/self/ns/mnt'))
        left(self.active)
        require(ctypes.CDLL(None, use_errno=True).unshare(0x00020000) == 0
                and birth(os.stat('/proc/self/ns/mnt')) != previous, 'TOOL private mount namespace unavailable')
        self.command([MOUNT, '-i', '--make-rprivate', '/'], self.active, 10)
        require(not self.own_targets(self.observe_mounts(self.active, private=True)),
                'Unexpected TOOL mount under private root')

    def acquire(self):
        self.add_directory('incoming')
        self.add_directory('inputs')
        with owned_fd(self.child_directory('incoming')) as folder:
            left(self.active)
            os.fchown(folder, self.uid, self.gid)
            require_dir(os.fstat(folder), self.uid, self.gid, 0o700, self.device)
        left(self.active)
        os.fchmod(self.root, 0o711)
        self.check_root(0o711)
        try:
            self.command(['/usr/bin/python3', '-I', '-B', str(self.path / 'code' / SOURCE), '--download',
                          str(self.uid), str(self.gid), repr(self.active)], self.active, ACTIVE_SECONDS)
        finally:
            active_error = sys.exception()
            try:
                # The named path becomes private even if a process kept an FD.
                # An unknown process state still refuses disposal.
                self.check_root(0o711)
                left(self.deadline)
                os.fchmod(self.root, 0o700)
                self.check_root(0o700)
            except BaseException:
                if active_error is None:
                    raise
                active_error.add_note('TOOL original root privacy restoration refused')
        with owned_fd(self.child_directory('incoming', self.uid, self.gid)) as source, \
             owned_fd(self.child_directory('inputs')) as destination:
            names = set()
            with os.scandir(source) as entries:
                for entry in entries:
                    require(entry.name in ARCHIVES | {'download.json'} and entry.name not in names,
                            'TOOL download inventory differs')
                    names.add(entry.name)
            require(names == ARCHIVES | {'download.json'}, 'TOOL download inventory incomplete')
            fact = json.loads(read_file(source, 'download.json', self.uid, self.gid, 4096, self.active))
            require(type(fact) is dict and set(fact) == {'generation', 'lengths'} and fact['generation'] == GENERATION
                    and type(fact['lengths']) is dict and fact['lengths'].keys() == ARCHIVES, 'TOOL transfer facts differ')
            for name, _, _, maximum in DOWNLOADS:
                self.copy_archive(source, destination, name, maximum, fact['lengths'][name])
        self.state['transfer'] = fact

    def copy_archive(self, source, destination, name, maximum, size):
        left(self.active)
        info = named(source, name)
        require_file(info, self.uid, self.gid, 0o600, maximum)
        require(type(size) is int and size == info.st_size and (name != 'chromium.zip' or size == BROWSER_BYTES),
                'TOOL transfer size differs from owned file')
        with owned_fd(os.open(name, READ, dir_fd=source)) as incoming, \
             owned_fd(os.open(name, WRITE, 0o600, dir_fd=destination)) as sealed:
            require(identity(os.fstat(incoming)) == identity(info), 'TOOL source inode differs')
            remaining = size
            while remaining:
                left(self.active)
                data = os.read(incoming, min(remaining, CHUNK))
                require(data, 'TOOL source archive truncated')
                remaining -= len(data)
                write_all(sealed, data, self.active)
            left(self.active)
            require(os.read(incoming, 1) == b'' and identity(os.fstat(incoming)) == identity(info)
                    == identity(named(source, name)), 'TOOL source archive changed')
            left(self.active)
            os.fchmod(sealed, 0o400)
            require_file(os.fstat(sealed), 0, 0, 0o400, maximum)
            require(os.fstat(sealed).st_size == size, 'TOOL protected archive extent differs')

    def materialize(self):
        self.add_directory('payload')
        with owned_fd(self.child_directory('inputs')) as source, \
             owned_fd(self.child_directory('payload')) as destination, ExitStack() as files:
            archives = []
            for name, _, _, maximum in DOWNLOADS:
                info = named(source, name)
                require_file(info, 0, 0, 0o400, maximum)
                stream = files.enter_context(os.fdopen(os.open(name, READ, dir_fd=source), 'rb'))
                require(identity(os.fstat(stream.fileno())) == identity(info), 'TOOL protected input inode differs')
                archives.append((name, stream, info))
            staged = self.installer.materialize_toolchain(destination, *(row[1] for row in archives), self.active)
            for name, stream, info in archives:
                require(identity(info) == identity(os.fstat(stream.fileno())) == identity(named(source, name)),
                        'TOOL protected input changed')
            self.final_modes(destination, staged)
        return staged

    def final_modes(self, payload, staged):
        # The private materializer completed its full readback. The final
        # mounted pass independently reconciles all rows after these chmods.
        for row in reversed(staged):
            left(self.active)
            parts = row.path.split('/')
            with ExitStack() as stack:
                directory = payload
                for part in parts[:-1]:
                    directory = stack.enter_context(owned_fd(os.open(part, DIR, dir_fd=directory)))
                    require_dir(os.fstat(directory), 0, 0, 0o700, self.device)
                before = named(directory, parts[-1])
                flags = DIR if row.kind == 'directory' else READ
                with owned_fd(os.open(parts[-1], flags, dir_fd=directory)) as fd:
                    require(identity(os.fstat(fd)) == identity(before) and before.st_uid == before.st_gid == 0
                            and before.st_dev == self.device and stat.S_IMODE(before.st_mode) == row.staged_mode
                            and row.archive_mode in (0o444, 0o555), 'TOOL staged mode or identity changed')
                    left(self.active)
                    os.fchmod(fd, row.archive_mode)
                    current = os.fstat(fd)
                    require(birth(current) == birth(before) and stat.S_IMODE(current.st_mode) == row.archive_mode
                            and identity(current) == identity(named(directory, parts[-1])),
                            'TOOL final member mode differs')
        left(self.active)
        os.fchmod(payload, 0o555)

    def payload_mount(self, deadline, before_ids):
        rows = self.own_targets(self.observe_mounts(deadline, private=True))
        if not rows:
            self.mount_uncertain = False
            return None
        target = str(self.path / 'payload')
        require(len(rows) == 1 and rows[0]['target'] == target and rows[0]['id'] not in before_ids,
                'TOOL unexpected mount identity')
        mount = rows[0]
        with owned_fd(os.open('payload', DIR, dir_fd=self.root)) as fd:
            info = os.fstat(fd)
            require_dir(info, 0, 0, 0o555, self.device)
            fields = bounded_proc(f'/proc/self/fdinfo/{fd}', 65536)
            ids = re.findall(rb'^mnt_id:\s+([0-9]+)$', fields, re.M)
            require(ids == [str(mount['id']).encode()] and birth(info) == self.births['payload']
                    and identity(info) == identity(named(self.root, 'payload')),
                    'TOOL opened mount identity differs')
        self.owned_mount = mount['id']
        self.mount_uncertain = False
        return mount

    def seal_payload(self, staged):
        target = str(self.path / 'payload')
        self.check_root(0o700)
        require(birth(named(self.root, 'payload')) == self.births['payload'],
                'TOOL payload changed before bind')
        before = self.observe_mounts(self.active, private=True)
        require(not self.own_targets(before), 'TOOL payload already mounted')
        before_ids = {row['id'] for row in before}
        self.mount_uncertain = True
        try:
            self.command([MOUNT, '-i', '--bind', target, target], self.active, 10)
        except BaseException as error:
            if self.processes_settled:
                try:
                    self.payload_mount(self.deadline, before_ids)
                except BaseException:
                    error.add_note('TOOL bind observation refused')
            raise
        mounted = self.payload_mount(self.active, before_ids)
        require(mounted is not None, 'TOOL bind not observed')
        owned_id = self.owned_mount
        self.mount_uncertain = True
        try:
            self.command([MOUNT, '-i', '-o', 'remount,bind,ro,nosuid,nodev,noexec', target], self.active, 10)
        finally:
            # Reconcile the held mount ID before cleanup even after a failed
            # remount, without replacing the earlier command failure.
            if self.processes_settled:
                active_error = sys.exception()
                try:
                    observed = self.payload_mount(self.deadline if active_error else self.active, before_ids)
                    require(observed is not None and self.owned_mount == owned_id, 'TOOL remount identity changed')
                except BaseException:
                    self.owned_mount, self.mount_uncertain = owned_id, True
                    if active_error is None:
                        raise
                    active_error.add_note('TOOL remount observation refused')
        require({'ro', 'nosuid', 'nodev', 'noexec'} <= observed['options'] and 'rw' not in observed['options'],
                'TOOL payload is not mounted read-only')
        self.state['materialized'] = self.verify_mounted(target, staged, owned_id)

    def verify_mounted(self, target, staged, mount_id):
        expected = {row.path: row for row in staged}
        require(len(expected) == len(staged) and 0 < len(expected) <= 5122, 'TOOL installed tree census differs')
        rows = []
        with self.inventory.PinnedTree(target, lambda ok, reason: require(left(self.active) and ok, reason)) as tree:
            root = os.fstat(tree.fd)
            require_dir(root, 0, 0, 0o555, self.device)
            require(birth(root) == self.births['payload'], 'TOOL mounted payload birth differs')
            fields = bounded_proc(f'/proc/self/fdinfo/{tree.fd}', 65536)
            require(re.findall(rb'^mnt_id:\s+([0-9]+)$', fields, re.M) == [str(mount_id).encode()]
                    and os.fstatvfs(tree.fd).f_flag & os.ST_RDONLY, 'TOOL mounted readback is not read-only')
            entries = tree.entries(maximum=5122)
            require(len(entries) == len(expected) and {path for path, _ in entries} == expected.keys(),
                    'TOOL mounted membership differs')
            for path, info in sorted(entries):
                left(self.active)
                row = expected[path]
                require(info.st_uid == info.st_gid == 0 and info.st_dev == self.device
                        and stat.S_IMODE(info.st_mode) == row.archive_mode, 'TOOL mounted owner or mode differs')
                if row.kind == 'directory':
                    require(stat.S_ISDIR(info.st_mode), 'TOOL mounted directory differs')
                    digest = None
                else:
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == row.bytes,
                            'TOOL mounted file identity differs')
                    hasher = hashlib.sha256()
                    with tree.open_regular(path, row.bytes, expected=self.inventory.identity(info), context='TOOL mounted member') as (stream, before):
                        require(identity(before) == identity(info), 'TOOL opened mounted member differs')
                        remaining = row.bytes
                        while remaining:
                            left(self.active)
                            chunk = stream.read(min(remaining, CHUNK))
                            require(chunk, 'TOOL mounted member truncated')
                            remaining -= len(chunk)
                            hasher.update(chunk)
                        require(stream.read(1) == b'' and identity(os.fstat(stream.fileno())) == identity(before),
                                'TOOL mounted member changed')
                    digest = hasher.hexdigest()
                    require(digest == row.sha256, 'TOOL mounted member hash differs')
                rows.append((path, row.kind, row.archive_mode, row.bytes, digest))
            tree.assert_unchanged()
            require(os.fstatvfs(tree.fd).f_flag & os.ST_RDONLY, 'TOOL mounted readback changed')
        mount_rows = self.own_targets(self.observe_mounts(self.active, private=True))
        require(len(mount_rows) == 1 and mount_rows[0]['id'] == mount_id
                and mount_rows[0]['target'] == target and {'ro', 'nosuid', 'nodev', 'noexec'} <= mount_rows[0]['options'],
                'TOOL mounted final observation differs')
        parser = self.installer._PARSER
        return {'treeSha256': hashlib.sha256(canonical(rows)).hexdigest(), 'entries': len(rows),
                'fileBytes': sum(row[3] for row in rows), 'mountId': mount_id,
                'readOnly': True, 'noSuid': True, 'noDev': True, 'noExec': True,
                'browserSha256': parser.BROWSER_ARCHIVE_SHA, 'browserTreeSha256': parser.BROWSER_TREE_SHA,
                'packageLockSRI': {name: parser.PACKAGES[name][1] for name in ('playwright', 'playwright-core', 'postgres')}}

    def dispose_mounts(self):
        require(self.processes_settled and not self.mount_uncertain, 'TOOL process or mount ownership uncertain')
        self.check_root(0o700)
        observed = self.observe_mounts(self.deadline)
        targets = self.own_targets(observed)
        if self.owned_mount is not None:
            held_id = self.owned_mount
            require(len(targets) == 1 and targets[0]['id'] == held_id
                    and targets[0]['target'] == str(self.path / 'payload'), 'TOOL owned mount changed before disposal')
            matched = self.payload_mount(self.deadline, set())
            require(matched is not None and matched['id'] == held_id, 'TOOL observed disposal mount differs')
            self.command([UMOUNT, '-i', '--', targets[0]['target']], self.deadline, 10)
            observed = self.observe_mounts(self.deadline)
            require(all(row['id'] != self.owned_mount for row in observed), 'TOOL owned mount still live')
        require(not self.own_targets(observed), 'TOOL foreign or leftover mount; preserve directory')
        self.state['mountsAbsent'] = True

    def execute(self, parent, members):
        primary, cleanup = None, 'not-acquired'
        try:
            self.create(parent)
            self.stage = 'source-capsule'
            self.install_capsule(members)
            self.stage = 'private-mount-namespace'
            self.enter_private_mount_namespace()
            self.stage = 'fixed-archive-acquisition'
            self.acquire()
            self.stage = 'strict-materialization'
            staged = self.materialize()
            self.stage = 'readonly-installation-readback'
            self.seal_payload(staged)
            left(self.active)
        except BaseException:
            primary = self.stage
        finally:
            if self.creation_attempted:
                cleanup = 'refused'
            if self.created:
                cleanup = 'refused'
                try:
                    self.dispose_mounts()
                    self.dispose_tree(members)
                    cleanup = 'complete'
                except BaseException:
                    pass
            if self.root is not None:
                try:
                    os.close(self.root)
                except OSError:
                    cleanup = 'refused'
        return primary, cleanup

    def dispose_tree(self, members):
        require(self.state.get('mountsAbsent') is True and self.processes_settled,
                'TOOL disposal requires native mount and process closure')
        self.check_root(0o700)
        count = 0
        fixed_code_paths = set(members)
        for relative in members:
            parts = relative.split('/')
            fixed_code_paths.update('/'.join(parts[:i]) for i in range(1, len(parts)))
        captured, children = {}, {}

        def scan(folder, relative, depth):
            nonlocal count
            require(depth <= 16, 'TOOL disposal depth exceeds bound')
            children[relative] = []
            with os.scandir(folder) as entries:
                for entry in entries:
                    left(self.deadline)
                    name = entry.name
                    path = relative + '/' + name if relative else name
                    count += 1
                    require(count <= 5200 and re.fullmatch(r'[A-Za-z0-9._+@-]+', name),
                            'TOOL disposal inventory exceeds bound')
                    info = named(folder, name)
                    top = path.split('/', 1)[0]
                    allowed = (
                        not relative and name in self.births and name in TOP_LEVEL
                        or top == 'code' and path[5:] in fixed_code_paths
                        or relative == 'incoming' and name in ARCHIVES | {'download.json'}
                        or relative == 'inputs' and name in ARCHIVES
                        or top == 'payload' and relative
                    )
                    owners = {(self.uid, self.gid)} if top == 'incoming' else {(0, 0)}
                    if path == 'incoming':
                        owners.add((0, 0))
                    directory, regular = stat.S_ISDIR(info.st_mode), stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                    require(allowed and info.st_dev == self.device and (info.st_uid, info.st_gid) in owners
                            and (directory or regular)
                            and (relative not in ('incoming', 'inputs') or regular)
                            and (top != 'code' or not relative or directory == (path[5:] not in members)),
                            'TOOL unowned disposal entry; preserve directory')
                    if not relative:
                        require(stat.S_ISDIR(info.st_mode) and birth(info) == self.births[name], 'TOOL disposal root changed')
                    captured[path] = identity(info)
                    children[relative].append(name)
                    if directory:
                        with owned_fd(os.open(name, DIR, dir_fd=folder)) as child:
                            require(identity(os.fstat(child)) == identity(info), 'TOOL disposal directory changed')
                            scan(child, path, depth + 1)
        scan(self.root, '', 0)

        def remove(folder, relative):
            for name in children[relative]:
                left(self.deadline)
                path = relative + '/' + name if relative else name
                info = named(folder, name)
                require(captured.get(path) == identity(info), 'TOOL disposal entry changed')
                if stat.S_ISDIR(info.st_mode):
                    with owned_fd(os.open(name, DIR, dir_fd=folder)) as child:
                        require(identity(os.fstat(child)) == identity(info), 'TOOL disposal opened different directory')
                        remove(child, path)
                        require(birth(named(folder, name)) == birth(os.fstat(child)) == birth(info),
                                'TOOL disposal directory replaced')
                    left(self.deadline)
                    os.rmdir(name, dir_fd=folder)
                else:
                    left(self.deadline)
                    os.unlink(name, dir_fd=folder)
                require(not present(folder, name), 'TOOL disposed entry remains')
                del captured[path]
        # Open a new description, so prior enumeration cannot affect removal.
        with owned_fd(os.open('.', DIR, dir_fd=self.root)) as current:
            require(birth(os.fstat(current)) == self.births[''], 'TOOL disposal opened different root')
            remove(current, '')
        require(not captured, 'TOOL disposal lost entries')
        self.check_root(0o700)
        left(self.deadline)
        os.rmdir(self.name, dir_fd=self.parent)
        require(not present(self.parent, self.name), 'TOOL owned namespace remains')
        self.state['namespaceAbsent'] = True


def course_complete(course, primary, cleanup, ended):
    transfer = course.state.get('transfer', {})
    installed = course.state.get('materialized', {})
    return (primary is None and cleanup == 'complete' and ended < course.deadline
            and course.processes_settled is True
            and course.state.get('mountsAbsent') is True and course.state.get('namespaceAbsent') is True
            and transfer.get('generation') == GENERATION and transfer.get('lengths', {}).keys() == ARCHIVES
            and installed.get('readOnly') is True and installed.get('noExec') is True
            and installed.get('entries', 0) > 0)


def run_course(run, source, uid, gid, members, rows, event_sha):
    require(sys.platform == 'linux' and os.uname().machine == 'x86_64' and os.getresuid() == (0, 0, 0)
            and os.getresgid() == (0, 0, 0) and re.fullmatch(r'[1-9][0-9]{0,15}', run)
            and re.fullmatch(r'[0-9a-f]{40}', source), 'Actual root TOOL platform required')
    release = bounded_proc('/usr/lib/os-release', 65536).splitlines()
    require(b'ID=ubuntu' in release and b'VERSION_ID="24.04"' in release, 'Actual Ubuntu 24.04 TOOL platform required')
    os.umask(0o077)
    start = time.monotonic()
    course = Course(run, uid, gid, start)
    course.mounts = source_module('aihr_tool_course_mountinfo', SOURCE, members['deploy/admission/next_profile.py'])
    primary, cleanup = 'root-parent-acquisition', 'not-acquired'
    try:
        with ExitStack() as parents:
            def interrupt(_number, _frame):
                raise InterruptedError('TOOL owner interrupted')

            for signum in (signal.SIGINT, signal.SIGTERM):
                parents.callback(signal.signal, signum, signal.signal(signum, interrupt))
            parent = parents.enter_context(owned_fd(os.open('/', DIR)))
            for component in ROOT_PARENT.parts[1:]:
                before = named(parent, component)
                require(stat.S_ISDIR(before.st_mode) and before.st_uid == 0 and not before.st_mode & 0o022,
                        'TOOL parent ancestry is not protected')
                child = parents.enter_context(owned_fd(os.open(component, DIR, dir_fd=parent)))
                require(identity(os.fstat(child)) == identity(before), 'TOOL parent ancestry changed')
                parent = child
            primary, cleanup = course.execute(parent, members)
    except BaseException:
        if course.creation_attempted:
            cleanup = 'refused'
        if primary is None:
            primary = 'owner-finalization'
    ended = time.monotonic()
    if ended >= course.deadline:
        cleanup = 'refused'
    complete = course_complete(course, primary, cleanup, ended)
    report = {'kind': 'NATIVE_TOOL_ONLY_COMPONENT', 'complete': complete, 'cleanup': cleanup,
              'source': source, 'controller': source, 'runId': run, 'attempt': 1, 'job': 'native-test',
              'eventSha256': event_sha, 'sourceMembers': rows, 'sourceCapsuleSha256': hashlib.sha256(canonical(rows)).hexdigest(),
              'platform': {'system': sys.platform, 'machine': os.uname().machine, 'python': list(sys.version_info[:3]), 'ubuntu': '24.04'},
              'elapsedMs': int((ended - start) * 1000), 'ownedProcessesSettled': course.processes_settled,
              'browserStarted': False, 'applicationBuilt': False, 'databaseStarted': False,
              'nativeWorkloadQualified': False, 'releaseAuthorized': False, **course.state}
    if not complete:
        report['failure'] = primary if primary is not None else 'owned-settlement'
    return report


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 5 and sys.argv[1] == '--download'
                and all(re.fullmatch(r'[1-9][0-9]{0,9}', part) for part in sys.argv[2:4]),
                'Fixed TOOL downloader request required')
        deadline = float(sys.argv[4])
        require(0 < left(deadline) <= ACTIVE_SECONDS, 'Fixed TOOL downloader deadline differs')
        download(int(sys.argv[2]), int(sys.argv[3]), deadline)
    except BaseException:
        sys.stderr.write('Fixed TOOL downloader refused\n')
        sys.exit(1)
