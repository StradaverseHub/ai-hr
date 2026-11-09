"""Read-only admission of the fixed manager-visible synthetic browser stage."""

import math
import os
import re
import select
import stat
import time
from contextlib import ExitStack, contextmanager
from typing import NamedTuple


_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_PROC_FILE = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
_MOUNTINFO_LIMIT = 4 * 1024**2
_MAX_ENTRIES = 509
# Projected Chromium and two Playwright packages, original Node cap, three role files.
_MAX_BYTES = 291895066 + 256 * 1024**2 + 45947
_RESERVE_BYTES = 32 * 1024**2
_RESERVE_INODES = 128
_PREPARATION_SECONDS = 180
_MANAGER_EXECUTABLE = '/usr/lib/systemd/systemd'


class LaunchSourceView(NamedTuple):
    path: str
    backing_birth: tuple[int, int]
    local_mount_id: int
    manager_mount_id: int


def _require(condition, reason):
    if not condition:
        raise ValueError(reason)


def _check_clock(deadline):
    _require(time.monotonic() < deadline, 'launch-view-deadline')


@contextmanager
def _own(fd):
    try:
        yield fd
    except BaseException as primary:
        try:
            os.close(fd)
        except OSError:
            primary.add_note('launch-view-close-unproved')
        raise
    else:
        os.close(fd)


def _read_proc(parent, name, limit, deadline):
    _check_clock(deadline)
    data = bytearray()
    with _own(os.open(name, _PROC_FILE, dir_fd=parent)) as fd:
        _require(stat.S_ISREG(os.fstat(fd).st_mode), 'launch-view-proc-file')
        while True:
            _check_clock(deadline)
            block = os.read(fd, min(65536, limit + 1 - len(data)))
            _check_clock(deadline)
            if not block:
                break
            data.extend(block)
            _require(len(data) <= limit, 'launch-view-proc-bound')
    return bytes(data)


def _birth(info):
    return info.st_dev, info.st_ino


def _root_directory(info, mode=None):
    _require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022
             and (mode is None or stat.S_IMODE(info.st_mode) == mode), 'launch-view-directory')
    return (*_birth(info), info.st_mode, info.st_uid, info.st_gid)


def _walk_directories(held, root, components, deadline):
    parent, chain = root, []
    for name, mode in components:
        _check_clock(deadline)
        before = _root_directory(os.stat(name, dir_fd=parent, follow_symlinks=False), mode)
        child = held.enter_context(_own(os.open(name, _DIRECTORY, dir_fd=parent)))
        _require(_root_directory(os.fstat(child), mode) == before, 'launch-view-ancestry')
        chain.append((parent, name, child, before))
        parent = child
    return tuple(chain)


def _check_chain(chain):
    for parent, name, child, wanted in chain:
        _require(_root_directory(os.fstat(child)) == wanted
                 == _root_directory(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'launch-view-ancestry')


def _hold_manager_executable(held, mounts, root, deadline):
    chain = _walk_directories(held, root, (('usr', None), ('lib', None), ('systemd', None)), deadline)
    folder = chain[-1][2]
    _check_clock(deadline)
    before = os.stat('systemd', dir_fd=folder, follow_symlinks=False)
    _require(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0
             and before.st_mode & 0o100 and not before.st_mode & 0o7022
             and before.st_size > 0 and before.st_nlink > 0, 'launch-view-manager-executable')
    fd = held.enter_context(_own(os.open('systemd', _PROC_FILE, dir_fd=folder)))
    wanted = mounts.file_identity(before)
    _require(mounts.file_identity(os.fstat(fd)) == wanted, 'launch-view-manager-executable')
    return chain, fd, wanted


def _check_manager_uid(proc, deadline):
    status = _read_proc(proc, 'status', 65536, deadline)
    uid_rows = [line[4:].split() for line in status.splitlines() if line.startswith(b'Uid:')]
    _require(uid_rows == [[b'0'] * 4], 'launch-view-manager-uid')


def _mount_id(fdinfo, fd, deadline):
    raw = _read_proc(fdinfo, str(fd), 65536, deadline)
    ids = re.findall(rb'^mnt_id:[ \t]+([1-9][0-9]{0,9})$', raw, re.M)
    _require(len(ids) == 1, 'launch-view-fd-mount')
    return int(ids[0])


def _observe_mount(mounts, proc, fdinfo, chain, owned_root, deadline):
    rows = mounts.parse_mountinfo(_read_proc(proc, 'mountinfo', _MOUNTINFO_LIMIT, deadline), _require)
    run_rows = [row for row in rows if row['target'] == '/run']
    _require(len(run_rows) == 1 and run_rows[0]['fsType'] == 'tmpfs'
             and {'rw', 'nosuid', 'nodev'} <= run_rows[0]['options']
             and not {'ro', 'noexec'} & run_rows[0]['options'], 'launch-view-run-mount')
    _require(not any(row['target'] == owned_root or row['target'].startswith(owned_root + '/') for row in rows),
             'launch-view-foreign-mount')
    mount_id = run_rows[0]['id']
    _require(all(_mount_id(fdinfo, row[2], deadline) == mount_id for row in chain), 'launch-view-fd-mount')
    _check_chain(chain)
    _check_clock(deadline)
    return mount_id


def _capacity(fd, planned_bytes, planned_entries):
    info = os.fstatvfs(fd)
    required = os.ST_NOSUID | os.ST_NODEV
    forbidden = os.ST_RDONLY | os.ST_NOEXEC
    _require(info.f_flag & required == required and not info.f_flag & forbidden, 'launch-view-fd-flags')
    fragment = info.f_frsize
    _require(0 < fragment <= 65536 and not fragment & (fragment - 1), 'launch-view-fragment')
    required_bytes = planned_bytes + (planned_entries + 16) * fragment + _RESERVE_BYTES
    _require(info.f_bavail * fragment >= required_bytes and info.f_favail >= planned_entries + _RESERVE_INODES,
             'launch-view-capacity')


@contextmanager
def held_launch_source(host, mounts, *, run_id, stage_fd, planned_bytes, planned_entries, deadline):
    """Compare a caller-held stage to fresh current and PID1 path views.

    The future issuer supplies source-pinned host/mount parsers, the exact
    owned directory FD from its current namespace and projected copy size
    from its sealed inputs. An exceptional exit requires independent cleanup
    admission before any future destructive operation.
    Mount IDs are compared only inside the namespace which supplied them.
    """
    _require(type(run_id) is str and re.fullmatch(r'[1-9][0-9]{0,15}', run_id)
             and int(run_id) <= 9007199254740991, 'launch-view-run')
    _require(type(stage_fd) is int and stage_fd > 2 and not os.get_inheritable(stage_fd), 'launch-view-stage-fd')
    _require(type(planned_bytes) is int and type(planned_entries) is int
             and 0 <= planned_bytes <= _MAX_BYTES and 0 <= planned_entries <= _MAX_ENTRIES
             and (planned_bytes == 0 or planned_entries > 0), 'launch-view-copy-bound')
    _require(type(deadline) in (int, float) and math.isfinite(deadline)
             and 0 < deadline - time.monotonic() <= _PREPARATION_SECONDS, 'launch-view-deadline')
    _require(os.getresuid() == (0, 0, 0) and os.getresgid() == (0, 0, 0), 'launch-view-root')
    run_name = 'aihr-browser-capability-' + run_id
    owned_root = '/run/' + run_name
    with ExitStack() as held:
        proc = held.enter_context(_own(os.open('/proc', _DIRECTORY)))
        self_name = str(os.getpid())
        _require(os.readlink('self', dir_fd=proc) == self_name, 'launch-view-proc-identity')
        self_proc = held.enter_context(_own(os.open(self_name, _DIRECTORY, dir_fd=proc)))
        manager_proc = held.enter_context(_own(os.open('1', _DIRECTORY, dir_fd=proc)))
        proc_births = tuple(_root_directory(os.fstat(fd)) for fd in (proc, self_proc, manager_proc))
        pidfd = held.enter_context(_own(os.pidfd_open(1)))
        fdinfo = held.enter_context(_own(os.open('fdinfo', _DIRECTORY, dir_fd=self_proc)))
        manager_stat = _read_proc(manager_proc, 'stat', 8192, deadline)
        _require(manager_stat.startswith(b'1 (systemd) '), 'launch-view-manager-birth')
        start = host._process_birth(manager_stat, 1)
        _check_manager_uid(manager_proc, deadline)

        # Only the fixed PID1 root/exe and namespace handles follow proc magic
        # links. All ordinary path components below the roots are no-follow.
        local_root = held.enter_context(_own(os.open('/', _DIRECTORY)))
        root_birth = _root_directory(os.fstat(local_root))
        local_binary = _hold_manager_executable(held, mounts, local_root, deadline)
        executable = local_binary[2]
        _check_clock(deadline)
        _require(os.readlink('exe', dir_fd=manager_proc) == _MANAGER_EXECUTABLE, 'launch-view-manager-executable')
        actual_exe = held.enter_context(_own(os.open('exe', _PROC_FILE & ~os.O_NOFOLLOW, dir_fd=manager_proc)))
        _require(mounts.file_identity(os.fstat(actual_exe)) == executable, 'launch-view-manager-executable')
        _require(os.readlink('root', dir_fd=manager_proc) == '/', 'launch-view-root-identity')
        manager_root = held.enter_context(_own(os.open('root', _DIRECTORY & ~os.O_NOFOLLOW, dir_fd=manager_proc)))
        _require(_root_directory(os.fstat(manager_root)) == root_birth, 'launch-view-root-identity')
        manager_binary = _hold_manager_executable(held, mounts, manager_root, deadline)
        _require(manager_binary[2] == executable, 'launch-view-manager-executable')
        namespaces = []
        for process in (self_proc, manager_proc):
            ns = held.enter_context(_own(os.open('ns', _DIRECTORY, dir_fd=process)))
            for name in ('pid', 'mnt'):
                fd = held.enter_context(_own(os.open(name, os.O_RDONLY | os.O_CLOEXEC, dir_fd=ns)))
                namespaces.append((ns, name, fd, _birth(os.fstat(fd))))
        _require(namespaces[0][3] == namespaces[2][3], 'launch-view-pid-namespace')
        stage = (('run', None), (run_name, 0o711), ('launch-source', 0o700))
        local = _walk_directories(held, local_root, stage, deadline)
        manager = _walk_directories(held, manager_root, stage, deadline)
        _require(tuple(row[3] for row in local) == tuple(row[3] for row in manager), 'launch-view-backing-identity')

        def current():
            _check_clock(deadline)
            _require(os.readlink('self', dir_fd=proc) == self_name and proc_births == (
                _root_directory(os.stat('/proc', follow_symlinks=False)),
                _root_directory(os.stat(self_name, dir_fd=proc, follow_symlinks=False)),
                _root_directory(os.stat('1', dir_fd=proc, follow_symlinks=False))), 'launch-view-proc-identity')
            manager_stat = _read_proc(manager_proc, 'stat', 8192, deadline)
            _require(not select.select([pidfd], [], [], 0)[0]
                     and manager_stat.startswith(b'1 (systemd) ')
                     and host._process_birth(manager_stat, 1) == start,
                     'launch-view-manager-birth')
            _check_manager_uid(manager_proc, deadline)
            for chain, fd, _ in (local_binary, manager_binary):
                _check_chain(chain)
                _require(mounts.file_identity(os.fstat(fd)) == executable == mounts.file_identity(
                    os.stat('systemd', dir_fd=chain[-1][2], follow_symlinks=False)), 'launch-view-manager-executable')
            _require(os.readlink('exe', dir_fd=manager_proc) == _MANAGER_EXECUTABLE
                     and mounts.file_identity(os.fstat(actual_exe)) == executable
                     == mounts.file_identity(os.stat('exe', dir_fd=manager_proc)), 'launch-view-manager-executable')
            _require(os.readlink('root', dir_fd=manager_proc) == '/'
                     and _root_directory(os.stat('/', follow_symlinks=False)) == root_birth
                     == _root_directory(os.stat('root', dir_fd=manager_proc)), 'launch-view-root-identity')
            for ns, name, fd, wanted in namespaces:
                _require(_birth(os.fstat(fd)) == wanted == _birth(os.stat(name, dir_fd=ns)), 'launch-view-namespace')
            _require(not os.get_inheritable(stage_fd) and _root_directory(os.fstat(stage_fd), 0o700) == local[-1][3],
                     'launch-view-stage-fd')

        def observe(bytes_needed, entries_needed):
            current()
            ids = (_observe_mount(mounts, self_proc, fdinfo, local, owned_root, deadline),
                   _observe_mount(mounts, manager_proc, fdinfo, manager, owned_root, deadline))
            _require(_mount_id(fdinfo, stage_fd, deadline) == ids[0], 'launch-view-stage-mount')
            for chain in (local, manager):
                _capacity(chain[-1][2], bytes_needed, entries_needed)
                _check_chain(chain)
            current()
            _check_clock(deadline)
            return ids

        ids = observe(planned_bytes, planned_entries)
        yield LaunchSourceView(owned_root + '/launch-source', local[-1][3][:2], *ids)
        _require(observe(0, 0) == ids, 'launch-view-mount-changed')
    _check_clock(deadline)
