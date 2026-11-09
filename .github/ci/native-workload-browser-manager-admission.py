"""Hold read-only native observations for the fixed synthetic manager course.

The protected caller supplies source-pinned modules and the original role
clock. File observation does not admit a DSO load or authenticate a bus peer.
"""

import hashlib
import math
import os
import re
import select
import stat
import struct
import sys
import time
from contextlib import ExitStack, contextmanager
from types import ModuleType
from typing import Callable, NamedTuple


_LIBRARY = ('usr', 'lib', 'x86_64-linux-gnu', 'libsystemd.so.0.38.0')
_SOCKET = ('run', 'dbus', 'system_bus_socket')
_NAMESPACES = ('pid', 'user', 'net', 'time', 'mnt')
_LIBRARY_LIMIT = 4 * 1024**2
_DYNAMIC_LIMIT = 64 * 1024
_STRING_LIMIT = 256 * 1024
_ADDRESS_LIMIT = 1 << 64
_AMD64_BASE_PAGE = 4096
_PROGRAM = struct.Struct('<IIQQQQQQ')
_DYNAMIC = struct.Struct('<QQ')
_SONAME = 'libsystemd.so.0'
_LINK_NAME = re.compile(rb'[A-Za-z0-9][A-Za-z0-9._+-]{0,127}')
_SELECTED_LINK_TAGS = (
    (15, 'DT_RPATH'), (29, 'DT_RUNPATH'), (0x6ffffefc, 'DT_AUDIT'),
    (0x6ffffefb, 'DT_DEPAUDIT'), (0x7fffffff, 'DT_FILTER'), (0x7ffffffd, 'DT_AUXILIARY'),
)
_STRTAB, _STRSZ, _SONAME_TAG, _FLAGS, _FLAGS_1 = 5, 10, 14, 30, 0x6ffffffb
_SECOND = 1_000_000_000
_FRONTIERS = (16, 32, 42, 56, 60, 75)


class ManagerInputObservation(NamedTuple):
    manager_birth: int
    library_fd: int
    library_birth: tuple[int, int]
    library_bytes: int
    library_sha256: str
    socket_birth: tuple[int, int]
    check_pid1: Callable[[int], int]


class _ManagerLibraryLinkInputs(NamedTuple):
    size: int
    sha256: str
    soname: str
    needed: tuple[str, ...]
    selected_tags: tuple[str, ...]
    flags: int | None
    flags_1: int | None


class _Target(NamedTuple):
    chain: tuple
    fd: int
    name: str
    state: tuple


def _require(ok, reason):
    if not ok:
        raise ValueError(reason)


def _left(deadline_ns):
    _require(time.monotonic_ns() < deadline_ns, 'manager-admission-deadline')


def _seconds(deadline_ns):
    _left(deadline_ns)
    return math.nextafter(deadline_ns / _SECOND, -math.inf)


def _root_credentials():
    _require(os.getresuid() == os.getresgid() == (0, 0, 0), 'manager-admission-root')


def _pid1(launch_view, host, process, deadline):
    raw = launch_view._read_proc(process, 'stat', 8192, deadline)
    _require(raw.startswith(b'1 (systemd) '), 'manager-admission-pid1')
    status = launch_view._read_proc(process, 'status', 65536, deadline).splitlines()
    for key in (b'Uid:', b'Gid:'):
        _require([line[len(key):].split() for line in status if line.startswith(key)] == [[b'0'] * 4],
                 'manager-admission-pid1-credentials')
    return host._process_birth(raw, 1)


def _hold_target(held, launch_view, mounts, root, components, library, deadline):
    chain = launch_view._walk_directories(held, root, tuple((name, None) for name in components[:-1]), deadline)
    parent, name = chain[-1][2], components[-1]
    launch_view._check_clock(deadline)
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    _require(before.st_uid == before.st_gid == 0 and before.st_nlink == 1, 'manager-admission-target-owner')
    if library:
        _require(stat.S_ISREG(before.st_mode) and not before.st_mode & 0o7022
                 and 64 <= before.st_size <= _LIBRARY_LIMIT, 'manager-admission-library')
        flags = launch_view._PROC_FILE
    else:
        _require(stat.S_ISSOCK(before.st_mode), 'manager-admission-socket')
        flags = os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = held.enter_context(launch_view._own(os.open(name, flags, dir_fd=parent)))
    target = _Target(chain, fd, name, mounts.file_identity(before))
    _check_target(launch_view, mounts, target, deadline)
    return target


def _check_target(launch_view, mounts, target, deadline):
    launch_view._check_clock(deadline)
    launch_view._check_chain(target.chain)
    _require(not os.get_inheritable(target.fd) and mounts.file_identity(os.fstat(target.fd)) == target.state
             == mounts.file_identity(os.stat(target.name, dir_fd=target.chain[-1][2], follow_symlinks=False)),
             'manager-admission-target-changed')


def _library_program_table(header, size):
    _require(len(header) == 64 and header.startswith(b'\x7fELF\x02\x01\x01')
             and struct.unpack_from('<HHI', header, 16) == (3, 62, 1), 'manager-admission-library-elf')
    phoff, = struct.unpack_from('<Q', header, 32)
    ehsize, phentsize, phnum = struct.unpack_from('<HHH', header, 52)
    _require(ehsize == 64 and phentsize == 56 and 1 <= phnum <= 128
             and 64 <= phoff <= size - phentsize * phnum, 'manager-admission-library-elf')
    return phoff, phnum


def _library_file_offset(loads, address, size):
    end = address + size
    reason = 'manager-admission-library-link-mapping'
    _require(end < _ADDRESS_LIMIT, reason)
    first_page, last_page = address // _AMD64_BASE_PAGE, (end - 1) // _AMD64_BASE_PAGE
    # A disjoint load's mapped page or BSS can still cover the inspected bytes.
    # A zero-sized load with an unaligned start can still round to one page.
    owners = [(offset, start, file_size) for offset, start, file_size, memory_size in loads
              if (memory_size or start % _AMD64_BASE_PAGE) and start // _AMD64_BASE_PAGE <= last_page
              and first_page <= (start + memory_size - 1) // _AMD64_BASE_PAGE]
    _require(len(owners) == 1, reason)
    offset, start, file_size = owners[0]
    _require(start <= address and end <= start + file_size, reason)
    return offset + address - start


def _library_link_name(table, offset):
    reason = 'manager-admission-library-link-name'
    _require(offset < len(table), reason)
    end = table.find(b'\0', offset, offset + 129)
    _require(end >= 0 and _LINK_NAME.fullmatch(table[offset:end]) is not None, reason)
    return table[offset:end].decode('ascii')


def _describe_fixed_library_link_inputs(raw):
    """Describe one bounded byte image. The caller owns its provenance and any load."""
    _require(type(raw) is bytes and len(raw) <= _LIBRARY_LIMIT, 'manager-admission-library-link-bytes')
    phoff, phnum = _library_program_table(raw[:64], len(raw))
    loads, dynamics = [], []
    for index in range(phnum):
        program = _PROGRAM.unpack_from(raw, phoff + index * _PROGRAM.size)
        kind, _, offset, address, _, file_size, memory_size, _ = program
        _require(kind != 3, 'manager-admission-library-link-interpreter')  # PT_INTERP
        if kind in (1, 2):  # PT_LOAD, PT_DYNAMIC
            _require(offset + file_size <= len(raw) and file_size <= memory_size
                     and address + memory_size < _ADDRESS_LIMIT, 'manager-admission-library-link-extent')
            if kind == 1:
                _require(offset % _AMD64_BASE_PAGE == address % _AMD64_BASE_PAGE,
                         'manager-admission-library-link-mapping')
            segment = (offset, address, file_size, memory_size)
            (loads if kind == 1 else dynamics).append(segment)
    reason = 'manager-admission-library-link-dynamic'
    _require(len(dynamics) == 1, reason)
    offset, address, size, _ = dynamics[0]
    _require(0 < size <= _DYNAMIC_LIMIT and size % _DYNAMIC.size == 0, reason)
    _require(_library_file_offset(loads, address, size) == offset, 'manager-admission-library-link-mapping')

    seen, singletons, needed = set(), {}, []
    for tag, value in _DYNAMIC.iter_unpack(raw[offset:offset + size]):
        if tag == 0:  # DT_NULL
            break
        if tag in (_STRTAB, _STRSZ, _SONAME_TAG, _FLAGS, _FLAGS_1):
            _require(tag not in singletons, reason)
            singletons[tag] = value
        if tag == 1:  # DT_NEEDED
            _require(len(needed) < 64, reason)
            needed.append(value)
        seen.add(tag)
    else:
        raise ValueError(reason)

    _require(needed and {_STRTAB, _STRSZ, _SONAME_TAG} <= singletons.keys(), reason)
    table_size = singletons[_STRSZ]
    _require(0 < table_size <= _STRING_LIMIT, 'manager-admission-library-link-strings')
    table_offset = _library_file_offset(loads, singletons[_STRTAB], table_size)
    table = raw[table_offset:table_offset + table_size]
    soname = _library_link_name(table, singletons[_SONAME_TAG])
    _require(soname == _SONAME, 'manager-admission-library-link-soname')
    return _ManagerLibraryLinkInputs(len(raw), hashlib.sha256(raw).hexdigest(), soname,
                                     tuple(_library_link_name(table, value) for value in needed),
                                     tuple(name for tag, name in _SELECTED_LINK_TAGS if tag in seen),
                                     singletons.get(_FLAGS), singletons.get(_FLAGS_1))


def _hash_library(launch_view, mounts, library, deadline):
    size = library.state[5]
    launch_view._check_clock(deadline)
    header = os.pread(library.fd, 64, 0)
    _library_program_table(header, size)
    offset = len(header)
    digest = hashlib.sha256(header)
    while offset < size:
        launch_view._check_clock(deadline)
        amount = min(65536, size - offset)
        block = os.pread(library.fd, amount, offset)
        _require(0 < len(block) <= amount, 'manager-admission-library-extent')
        offset += len(block)
        digest.update(block)
    launch_view._check_clock(deadline)
    _require(not os.pread(library.fd, 1, size), 'manager-admission-library-extent')
    _check_target(launch_view, mounts, library, deadline)
    return digest.hexdigest()


def _check_mounts(launch_view, mounts, fdinfo, process, root, binary, library, endpoint, deadline):
    rows = mounts.parse_mountinfo(launch_view._read_proc(process, 'mountinfo', launch_view._MOUNTINFO_LIMIT, deadline), _require)
    root_id = launch_view._mount_id(fdinfo, root, deadline)
    roots = [row for row in rows if row['target'] == '/']
    runs = [row for row in rows if row['target'] == '/run']
    _require(len(roots) == 1 and roots[0]['id'] == root_id and len(runs) == 1 and runs[0]['fsType'] == 'tmpfs'
             and {'rw', 'nosuid', 'nodev'} <= runs[0]['options'] and 'ro' not in runs[0]['options']
             and not any(row['target'] == '/run/dbus' or row['target'].startswith('/run/dbus/') for row in rows),
             'manager-admission-mount-view')
    stock_names = (launch_view._MANAGER_EXECUTABLE, '/' + '/'.join(_LIBRARY))
    for row in rows:
        target = row['target']
        _require(target == '/' or not any(name == target or name.startswith(target + '/') for name in stock_names),
                 'manager-admission-target-mount')
    for chain, fd, mount in ((binary[0], binary[1], root_id), (library.chain, library.fd, root_id),
                             (endpoint.chain, endpoint.fd, runs[0]['id'])):
        _require(all(launch_view._mount_id(fdinfo, part[2], deadline) == mount for part in chain)
                 and launch_view._mount_id(fdinfo, fd, deadline) == mount, 'manager-admission-target-mount')


@contextmanager
def held_manager_inputs(launch_view, host, mounts, *, started_ns, ready_by_ns):
    """Hold fixed PID1, library and pathname observations under one original clock.

    The library FD is borrowed, and the socket birth identifies a filesystem
    node only. A later owner must separately admit the library and actual peer.
    """
    _require(all(type(module) is ModuleType for module in (launch_view, host, mounts))
             and sys.platform == 'linux' and os.uname().machine == 'x86_64', 'manager-admission-context')
    _root_credentials()
    _require(type(started_ns) is int and type(ready_by_ns) is int and 0 <= started_ns <= time.monotonic_ns()
             and ready_by_ns in (started_ns + 16 * _SECOND, started_ns + 32 * _SECOND), 'manager-admission-clock')
    deadline = _seconds(ready_by_ns)
    with ExitStack() as held:
        own, directory = launch_view._own, launch_view._DIRECTORY
        proc = held.enter_context(own(os.open('/proc', directory)))
        self_name = str(os.getpid())
        _require(os.readlink('self', dir_fd=proc) == self_name, 'manager-admission-proc')
        current_proc = held.enter_context(own(os.open(self_name, directory, dir_fd=proc)))
        manager_proc = held.enter_context(own(os.open('1', directory, dir_fd=proc)))
        process_stamps = tuple(launch_view._root_directory(os.fstat(fd)) for fd in (proc, current_proc, manager_proc))
        pidfd = held.enter_context(own(os.pidfd_open(1)))
        poll = select.poll()
        poll.register(pidfd, select.POLLIN)
        _require(not poll.poll(0) and not os.get_inheritable(pidfd), 'manager-admission-pid1')
        fdinfo = held.enter_context(own(os.open('fdinfo', directory, dir_fd=current_proc)))
        start = _pid1(launch_view, host, manager_proc, deadline)

        _require(os.readlink('root', dir_fd=manager_proc) == '/'
                 and os.readlink('exe', dir_fd=manager_proc) == launch_view._MANAGER_EXECUTABLE,
                 'manager-admission-pid1-root-exe')
        local_root = held.enter_context(own(os.open('/', directory)))
        manager_root = held.enter_context(own(os.open('root', directory & ~os.O_NOFOLLOW, dir_fd=manager_proc)))
        root_stamp = launch_view._root_directory(os.fstat(local_root))
        _require(launch_view._root_directory(os.fstat(manager_root)) == root_stamp, 'manager-admission-root-view')
        actual_exe = held.enter_context(own(os.open('exe', launch_view._PROC_FILE & ~os.O_NOFOLLOW, dir_fd=manager_proc)))
        observed = []
        namespaces = []
        for root, process in ((local_root, current_proc), (manager_root, manager_proc)):
            binary = launch_view._hold_manager_executable(held, mounts, root, deadline)
            library = _hold_target(held, launch_view, mounts, root, _LIBRARY, True, deadline)
            endpoint = _hold_target(held, launch_view, mounts, root, _SOCKET, False, deadline)
            observed.append((root, process, binary, library, endpoint))
            ns = held.enter_context(own(os.open('ns', directory, dir_fd=process)))
            for name in _NAMESPACES:
                launch_view._check_clock(deadline)
                fd = held.enter_context(own(os.open(name, os.O_RDONLY | os.O_CLOEXEC, dir_fd=ns)))
                namespaces.append((ns, name, fd, launch_view._birth(os.fstat(fd))))
        local, manager = observed
        binary, library, endpoint = local[2:]
        _require(binary[2] == manager[2][2] == mounts.file_identity(os.fstat(actual_exe))
                 and library.state == manager[3].state and endpoint.state == manager[4].state
                 and all(tuple(row[3] for row in a.chain) == tuple(row[3] for row in b.chain)
                         for a, b in ((library, manager[3]), (endpoint, manager[4]))), 'manager-admission-root-view')
        local_ns = len(_NAMESPACES)
        _require(all(namespaces[i][3] == namespaces[i + local_ns][3]
                     for i, name in enumerate(_NAMESPACES) if name != 'mnt'),
                 'manager-admission-namespace')
        active = True

        def check_names(root, image, image_library, image_socket, limit):
            chain, fd, state = image
            launch_view._check_clock(limit)
            launch_view._check_chain(chain)
            _require(launch_view._root_directory(os.fstat(root)) == root_stamp
                     and mounts.file_identity(os.fstat(fd)) == state == mounts.file_identity(
                         os.stat('systemd', dir_fd=chain[-1][2], follow_symlinks=False)), 'manager-admission-pid1-root-exe')
            _check_target(launch_view, mounts, image_library, limit)
            _check_target(launch_view, mounts, image_socket, limit)

        def current_process(limit):
            _root_credentials()
            _require(str(os.getpid()) == self_name == os.readlink('self', dir_fd=proc)
                     and process_stamps == tuple(launch_view._root_directory(os.fstat(fd))
                                                 for fd in (proc, current_proc, manager_proc))
                     and process_stamps == tuple(launch_view._root_directory(info) for info in (
                         os.stat('/proc', follow_symlinks=False), os.stat(self_name, dir_fd=proc, follow_symlinks=False),
                         os.stat('1', dir_fd=proc, follow_symlinks=False))), 'manager-admission-proc')
            _require(not poll.poll(0) and not os.get_inheritable(pidfd)
                     and _pid1(launch_view, host, manager_proc, limit) == start, 'manager-admission-pid1')
            _require(os.readlink('root', dir_fd=manager_proc) == '/' and root_stamp == launch_view._root_directory(
                         os.stat('/', follow_symlinks=False)) == launch_view._root_directory(os.stat('root', dir_fd=manager_proc))
                     and os.readlink('exe', dir_fd=manager_proc) == launch_view._MANAGER_EXECUTABLE
                     and mounts.file_identity(os.fstat(actual_exe)) == binary[2]
                     == mounts.file_identity(os.stat('exe', dir_fd=manager_proc)), 'manager-admission-pid1-root-exe')
            for ns, name, fd, birth in namespaces:
                launch_view._check_clock(limit)
                _require(launch_view._birth(os.fstat(fd)) == birth == launch_view._birth(os.stat(name, dir_fd=ns)),
                         'manager-admission-namespace')

        def check_pid1(deadline_ns):
            _require(active and type(deadline_ns) is int
                     and deadline_ns - started_ns in tuple(value * _SECOND for value in _FRONTIERS),
                     'manager-admission-check-clock')
            limit = _seconds(deadline_ns)
            current_process(limit)
            for root, _, image, image_library, image_socket in observed:
                check_names(root, image, image_library, image_socket, limit)
            for root, process, image, image_library, image_socket in observed:
                _check_mounts(launch_view, mounts, fdinfo, process, root, image, image_library, image_socket, limit)
            # Recheck both named views after the last census, including the first view's executable.
            for root, _, image, image_library, image_socket in observed:
                check_names(root, image, image_library, image_socket, limit)
            current_process(limit)
            _require(not poll.poll(0), 'manager-admission-pid1')
            _left(deadline_ns)
            return start

        check_pid1(ready_by_ns)
        digest = _hash_library(launch_view, mounts, library, deadline)
        check_pid1(ready_by_ns)
        try:
            yield ManagerInputObservation(start, library.fd, library.state[:2], library.state[5], digest,
                                          endpoint.state[:2], check_pid1)
            check_pid1(started_ns + 75 * _SECOND)
        finally:
            active = False
