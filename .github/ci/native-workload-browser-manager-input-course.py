"""Read-only stock manager observations. No DSO load, connect or service authority."""
from contextlib import ExitStack
import os
import re
import select
import stat
import time


_SOCKET = b'/run/dbus/system_bus_socket'
_SOCKET_HEADER = b'Num RefCount Protocol Flags Type St Inode Path'.split()
_BROKER_CGROUP = '0::/system.slice/dbus.service\n'
_BROKER_EXECUTABLE = '/usr/bin/dbus-daemon'
_SECOND = 1_000_000_000


def _need(condition, reason):
    if not condition:
        raise ValueError(reason)


def _listener_inode(table):
    lines = table.splitlines()
    _need(1 < len(lines) <= 8193 and lines[0].split() == _SOCKET_HEADER, 'listener-table')
    listeners = []
    for line in lines[1:]:
        fields = line.split(None, 7)
        if len(fields) == 8 and fields[7] == _SOCKET:
            _, _, protocol, flags, kind, state, inode, _ = fields
            _need(protocol == b'00000000' and kind == b'0001' and re.fullmatch(rb'[0-9A-Fa-f]{8}', flags)
                  and re.fullmatch(rb'[0-9A-Fa-f]{2}', state) and re.fullmatch(rb'[1-9][0-9]{0,19}', inode),
                  'listener-table')
            if int(flags, 16) & 0x10000:
                _need(flags == b'00010000' and state == b'01', 'listener-table')
                listeners.append(int(inode))
    _need(len(listeners) == 1, 'listener-not-unique')
    return listeners[0]


def _listener_holders(view, process, inode, deadline):
    expected = f'socket:[{inode}]'
    with view._own(os.open('fd', view._DIRECTORY, dir_fd=process)) as folder:
        with os.scandir(folder) as entries:
            held = []
            for count, entry in enumerate(entries, 1):
                view._check_clock(deadline)
                _need(count <= 8192 and re.fullmatch(r'[0-9]{1,10}', entry.name), 'listener-fd-census')
                try:
                    target = os.readlink(entry.name, dir_fd=folder)
                except FileNotFoundError:
                    continue
                if target == expected:
                    info = os.stat(entry.name, dir_fd=folder)
                    _need(stat.S_ISSOCK(info.st_mode) and info.st_ino == inode, 'listener-fd-census')
                    held.append(int(entry.name))
            view._check_clock(deadline)
            return tuple(sorted(held))


def _listener_ownership(view, host, mounts, manager, ready_by_ns):
    deadline = ready_by_ns / _SECOND
    read = view._read_proc
    with ExitStack() as held:
        own, directory = view._own, view._DIRECTORY
        root = held.enter_context(own(os.open('/', directory)))
        proc = held.enter_context(own(os.open('proc', directory, dir_fd=root)))
        first = held.enter_context(own(os.open('1', directory, dir_fd=proc)))
        local = held.enter_context(own(os.open(str(os.getpid()), directory, dir_fd=proc)))
        fdinfo = held.enter_context(own(os.open('fdinfo', directory, dir_fd=local)))
        cgroups = view._walk_directories(held, root, tuple((name, None) for name in
                          ('sys', 'fs', 'cgroup', 'system.slice', 'dbus.service')), deadline)
        group = cgroups[-1][2]
        bin_chain = view._walk_directories(held, root, (('usr', None), ('bin', None)), deadline)
        bin_fd = bin_chain[-1][2]
        executable = held.enter_context(own(os.open('dbus-daemon', view._PROC_FILE, dir_fd=bin_fd)))
        image = host._main_exec_stamp(os.fstat(executable))
        group_members = read(group, 'cgroup.procs', 1024, deadline)
        _need(re.fullmatch(rb'[1-9][0-9]{0,6}\n', group_members) is not None, 'listener-broker-cgroup')
        pid = int(group_members)
        _need(1 < pid <= 4194304, 'listener-broker-cgroup')
        pidfd = held.enter_context(own(os.pidfd_open(pid)))
        poll = select.poll()
        poll.register(pidfd, select.POLLIN)
        broker = held.enter_context(own(os.open(str(pid), directory, dir_fd=proc)))
        pid_birth = view._birth(os.fstat(broker))
        start = host._process_birth(read(broker, 'stat', 8192, deadline), pid)
        # /proc/net names the kernel socket inode, which is not the pathname inode.
        net = held.enter_context(own(os.open('net', directory, dir_fd=first)))

        def current():
            manager.check_pid1(ready_by_ns)
            rows = mounts.parse_mountinfo(read(local, 'mountinfo', view._MOUNTINFO_LIMIT, deadline), _need)
            for target, fs, descriptors in (
                ('/proc', 'proc', (proc, first, local, fdinfo, broker, net)),
                ('/sys/fs/cgroup', 'cgroup2', tuple(entry[2] for entry in cgroups[2:])),
            ):
                exact = [row for row in rows if row['target'] == target]
                _need(len(exact) == 1 and exact[0]['fsType'] == fs
                      and all(view._mount_id(fdinfo, fd, deadline) == exact[0]['id'] for fd in descriptors),
                      'listener-native-mount')
            view._check_chain(cgroups)
            view._check_chain(bin_chain)
            _need(not poll.poll(0) and read(group, 'cgroup.procs', 1024, deadline) == group_members
                  and view._birth(os.stat(str(pid), dir_fd=proc, follow_symlinks=False)) == pid_birth
                  and host._process_birth(read(broker, 'stat', 8192, deadline), pid) == start
                  and read(broker, 'cgroup', 1024, deadline).decode('ascii') == _BROKER_CGROUP,
                  'listener-broker-cgroup')
            _need(os.readlink('exe', dir_fd=broker) == _BROKER_EXECUTABLE
                  and host._main_exec_stamp(os.stat('exe', dir_fd=broker)) == image
                  == host._main_exec_stamp(os.fstat(executable))
                  == host._main_exec_stamp(os.stat('dbus-daemon', dir_fd=bin_fd, follow_symlinks=False))
                  and view._birth(os.stat('ns/net', dir_fd=first)) == view._birth(os.stat('ns/net', dir_fd=broker)),
                  'listener-broker-image')
            status = read(broker, 'status', 65536, deadline).splitlines()
            for key in (b'Uid:', b'Gid:'):
                rows = [line[len(key):].split() for line in status if line.startswith(key)]
                _need(len(rows) == 1 and len(rows[0]) == 4 and len(set(rows[0])) == 1
                      and re.fullmatch(rb'[1-9][0-9]{0,9}', rows[0][0]), 'listener-broker-credentials')
            _need(not poll.poll(0), 'listener-broker-cgroup')

        def sample():
            current()
            inode = _listener_inode(read(net, 'unix', 1024**2, deadline))
            fds = tuple(_listener_holders(view, process, inode, deadline) for process in (first, broker))
            _need(any(fds), 'listener-stock-holder-missing')
            current()
            _need(_listener_inode(read(net, 'unix', 1024**2, deadline)) == inode, 'listener-changed')
            return inode, fds

        observed = sample()
        _need(sample() == observed, 'listener-changed')
        return [label for label, fds in zip(('pid1', 'dbus-daemon'), observed[1], strict=True) if fds]


def _library(admission, observed, ready_by_ns):
    observed.check_pid1(ready_by_ns)
    raw = bytearray()
    while len(raw) < observed.library_bytes:
        admission._left(ready_by_ns)
        block = os.pread(observed.library_fd, min(65536, observed.library_bytes - len(raw)), len(raw))
        _need(bool(block), 'library-extent')
        raw.extend(block)
    _need(not os.pread(observed.library_fd, 1, len(raw)), 'library-extent')
    links = admission._describe_fixed_library_link_inputs(bytes(raw))
    _need((links.size, links.sha256) == (observed.library_bytes, observed.library_sha256), 'library-extent')
    observed.check_pid1(ready_by_ns)
    return {'bytes': links.size, 'sha256': links.sha256, 'soname': links.soname,
            'needed': list(links.needed), 'selectedTags': list(links.selected_tags),
            'flags': links.flags, 'flags1': links.flags_1}


def observe_manager_inputs(admission, view, host, mounts):
    """Use only reviewed held observations under one original clock."""
    start = time.monotonic_ns()
    ready = start + 32 * _SECOND
    phase = 'manager-inputs'
    try:
        with admission.held_manager_inputs(view, host, mounts, started_ns=start, ready_by_ns=ready) as observed:
            phase = 'library-bytes'
            library = _library(admission, observed, ready)
            phase = 'listener-ownership'
            holders = _listener_ownership(view, host, mounts, observed, ready)
            phase = 'owner-settlement'
            observed.check_pid1(ready)
        ended = time.monotonic_ns()
        _need(start <= ended < ready, 'owner-deadline')
    except (ValueError, OSError, host.Refused) as error:
        reason = str(error)
        closed = {'listener-table', 'listener-not-unique', 'listener-fd-census', 'listener-broker-cgroup',
                  'listener-broker-image', 'listener-broker-credentials', 'listener-stock-holder-missing',
                  'listener-changed', 'listener-native-mount', 'library-extent', 'owner-deadline'}
        return {'failure': {'phase': phase, 'reason': reason if reason in closed else 'owned-observation-refused'}}
    return {'observation': {'pid1AndBothPathViewsMatched': True, 'elapsedMs': (ended - start) // 1_000_000,
                            'library': library,
                            'listener': {'stockFdHolders': holders, 'cgroupAndImageMatched': True}}}
