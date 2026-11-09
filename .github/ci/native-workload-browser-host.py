"""Finite native browser capability owners. No installed root entry or profile yet."""
from __future__ import annotations

import ctypes
import errno
import json
import os
import pathlib
import re
import select
import socket
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager

DRIVER, BROWSER, THIRD = 62120, 62121, 65534
CONTROL, INGRESS, POSTGRES = 3444, 3443, 5433
LOOPBACK = '127.0.0.1'
LAST_HOOK = 2_147_483_647
MAX_NFT = 1024 * 1024
MAX_FRAME = 512
FRAME_ORDER = (
    ('driver', 'child', 'observer-ready'), ('browser', 'child', 'listener-ready'),
    ('browser', 'root', 'deny-prepare'), ('browser', 'child', 'probe-ready'),
    ('browser', 'root', 'deny-go'), ('browser', 'child', 'negatives-complete'),
    ('third', 'child', 'probe-ready'), ('third', 'root', 'probe'), ('third', 'child', 'control-denied'),
    ('driver', 'root', 'connect'), ('driver', 'child', 'websocket-ready'),
    ('driver', 'root', 'request'), ('driver', 'child', 'ingress-complete'),
    ('driver', 'root', 'stop'), ('driver', 'child', 'driver-closed'),
    ('browser', 'root', 'stop'), ('browser', 'child', 'browser-closed'),
)
ROLE_POLICY = {
    'Type': 'exec', 'Delegate': 'no', 'KillMode': 'control-group',
    'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': '', 'AmbientCapabilities': '',
    'SupplementaryGroups': '', 'ProtectHome': 'yes', 'ProtectSystem': 'strict',
    'PrivateTmp': 'yes', 'PrivateDevices': 'yes', 'ProtectProc': 'invisible',
    'ProtectControlGroups': 'yes', 'ProtectKernelTunables': 'yes',
    'ProtectKernelModules': 'yes', 'ProtectKernelLogs': 'yes', 'UMask': '0077',
    'RestrictAddressFamilies': 'AF_INET', 'SystemCallArchitectures': 'native',
    'SystemCallFilter': '~io_uring_setup:EPERM io_uring_enter:EPERM io_uring_register:EPERM',
    'MemorySwapMax': '0', 'Restart': 'no',
}


class Refused(RuntimeError):
    pass


def require(ok, code):
    if not ok:
        raise Refused(code)


def _object(pairs):
    result = dict(pairs)
    require(len(result) == len(pairs), 'duplicate-json-field')
    return result


def _reject_constant(_):
    raise Refused('invalid-json-number')


def json_object(data):
    try:
        return json.loads(data, object_pairs_hook=_object, parse_constant=_reject_constant)
    except (UnicodeError, json.JSONDecodeError):
        raise Refused('invalid-native-json') from None


class Deadline:
    def __init__(self):
        self.start = time.monotonic()

    def remaining(self, seconds=60):
        require(seconds in (16, 32, 42, 56, 60, 75), 'invalid-clock-frontier')
        left = self.start + seconds - time.monotonic()
        require(left > 0, 'capability-deadline')
        return left


def _match(left, right, op='=='):
    return {'match': {'op': op, 'left': left, 'right': right}}


def _meta(key, value, op='=='):
    return _match({'meta': {'key': key}}, value, op)


def _payload(protocol, field, value):
    return _match({'payload': {'protocol': protocol, 'field': field}}, value)


def _ct(key, value, **options):
    return _match({'ct': {'key': key, **options}}, value, 'in' if isinstance(value, dict) else '==')


def _local_target(port):
    return [_meta('nfproto', 'ipv4'), _meta('l4proto', 'tcp'),
            _payload('ip', 'daddr', LOOPBACK), _payload('tcp', 'dport', port)]


def _original_target(port):
    return [_ct('daddr', LOOPBACK, family='ip', dir='original'), _ct('proto-dst', port, dir='original')]


def _local_connection(port, reply=False):
    return [_meta('oifname', 'lo'), _meta('nfproto', 'ipv4'), _meta('l4proto', 'tcp'),
            _payload('ip', 'saddr', LOOPBACK), _payload('ip', 'daddr', LOOPBACK),
            _payload('tcp', 'sport' if reply else 'dport', port),
            _ct('direction', 'reply' if reply else 'original'),
            _ct('state', 'established' if reply else {'set': ['established', 'new']}),
            _ct('saddr', LOOPBACK, family='ip', dir='original'), *_original_target(port)]


def firewall_rules():
    """The ordered native predicates and their stable observation labels."""
    reset = {'reject': {'type': 'tcp reset'}}
    return {
        'output': [
            ('driver-control', [_meta('skuid', DRIVER), *_local_connection(CONTROL)], {'accept': None}),
            ('control-final-denied', _local_target(CONTROL), reset),
            ('control-retarget-denied', [_meta('nfproto', 'ipv4'), _meta('l4proto', 'tcp'),
                                        _ct('direction', 'original'), *_original_target(CONTROL)], reset),
            ('browser-ingress', [_meta('skuid', BROWSER), *_local_connection(INGRESS)], {'accept': None}),
            ('browser-control-reply', [_meta('skuid', BROWSER), *_local_connection(CONTROL, reply=True)], {'accept': None}),
            ('browser-postgres-denied', [_meta('skuid', BROWSER), *_local_target(POSTGRES)], reset),
            ('browser-other-denied', [_meta('skuid', BROWSER)], {'drop': None}),
            ('driver-postgres', [_meta('skuid', DRIVER), *_local_connection(POSTGRES)], {'accept': None}),
            ('driver-other-denied', [_meta('skuid', DRIVER)], {'drop': None}),
        ],
        'input': [('control-nonlocal-denied', [*_local_target(CONTROL), _meta('iifname', 'lo', '!=')], {'drop': None})],
    }


def _table_name(run_id, nonce):
    require(re.fullmatch(r'[1-9][0-9]{0,19}', run_id) and re.fullmatch(r'[0-9a-f]{16}', nonce), 'invalid-firewall-identity')
    return f'aihrbc_{run_id}_{nonce}'


def firewall_spec(name):
    require(re.fullmatch(r'aihrbc_[1-9][0-9]{0,19}_[0-9a-f]{16}', name), 'invalid-firewall-identity')
    scope = {'family': 'inet', 'table': name}
    rows = [('table', {'family': 'inet', 'name': name})]
    for hook, rules in firewall_rules().items():
        rows.append(('chain', {**scope, 'name': hook, 'type': 'filter', 'hook': hook,
                               'prio': LAST_HOOK, 'policy': 'accept'}))
        for _, predicates, verdict in rules:
            rows.append(('rule', {**scope, 'chain': hook, 'expr': [*predicates, {'counter': None}, verdict]}))
    return rows


def _nft_rows(data):
    document = json_object(data)
    require(type(document) is dict and set(document) == {'nftables'} and type(document['nftables']) is list,
            'invalid-nft-inventory')
    rows = document['nftables']
    require(0 < len(rows) <= 4096 and type(rows[0]) is dict and set(rows[0]) == {'metainfo'}, 'invalid-nft-inventory')
    return rows[1:]


def require_terminal_hooks(data, owned=None):
    for row in _nft_rows(data):
        require(type(row) is dict and len(row) == 1, 'invalid-hook-row')
        if 'chain' not in row:
            continue
        chain = row['chain']
        require(type(chain) is dict and type(chain.get('family')) is str, 'invalid-hook-row')
        if chain['family'] not in ('ip', 'inet') or chain.get('hook') not in ('input', 'output'):
            continue
        require(type(chain.get('prio')) is int, 'invalid-hook-priority')
        if chain['prio'] >= LAST_HOOK:
            require(owned is not None and chain['family'] == 'inet' and chain.get('table') == owned
                    and chain.get('name') == chain['hook'], 'competing-terminal-hook')


def firewall_readback(name, data):
    actual, expected = _nft_rows(data), firewall_spec(name)
    require(len(actual) == len(expected), 'firewall-census-differs')
    handles, counters = [], {}
    labels = iter(label for rules in firewall_rules().values() for label, *_ in rules)
    for row, (kind, wanted) in zip(actual, expected):
        require(type(row) is dict and set(row) == {kind} and type(row[kind]) is dict, 'firewall-row-differs')
        current = row[kind].copy()
        handle = current.pop('handle', None)
        require(type(handle) is int and handle > 0, 'invalid-firewall-handle')
        handles.append((kind, handle))
        if kind == 'rule':
            expr = current.get('expr')
            require(type(expr) is list and len(expr) == len(wanted['expr']), 'firewall-rule-differs')
            counter = expr[-2]
            require(type(counter) is dict and set(counter) == {'counter'} and type(counter['counter']) is dict
                    and set(counter['counter']) == {'packets', 'bytes'}
                    and all(type(x) is int and x >= 0 for x in counter['counter'].values()), 'invalid-firewall-counter')
            counters[next(labels)] = counter['counter'].copy()
            current['expr'] = [*expr[:-2], {'counter': None}, expr[-1]]
        require(current == wanted, 'firewall-expression-differs')
    return tuple(handles), counters


class Firewall:
    """Own only one exact table. Without proven birth/shape retain protection."""
    def __init__(self, run_id, nonce):
        self.name = _table_name(run_id, nonce)
        self.handles = None
        self.counters = None
        self.attempted = False
        self.removal_attempted = False
        self._child = None

    def _reap_failed_child(self, deadline):
        child = self._child
        if child.poll() is None:
            deadline.remaining(75)
            try:
                child.kill()
            except ProcessLookupError:
                pass
            child.wait(timeout=deadline.remaining(75))
        self._child = None

    def _nft(self, args, deadline, frontier, data=None):
        require(os.geteuid() == 0, 'firewall-root-owner-required')
        require(self._child is None, 'firewall-child-settlement-unproved')
        deadline.remaining(frontier)
        with tempfile.TemporaryFile() as source:
            if data is not None:
                require(len(data) <= 32768, 'firewall-input-bound')
                source.write(data)
                source.seek(0)
            deadline.remaining(frontier)
            child = self._child = subprocess.Popen(['/usr/sbin/nft', '-j', *args], stdin=source,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'},
                close_fds=True)
            raw = bytearray()
            try:
                while True:
                    ready, _, _ = select.select([child.stdout], [], [], deadline.remaining(frontier))
                    require(bool(ready), 'firewall-command-timeout')
                    block = os.read(child.stdout.fileno(), min(16384, MAX_NFT + 1 - len(raw)))
                    if not block:
                        break
                    raw.extend(block)
                    require(len(raw) <= MAX_NFT, 'firewall-output-bound')
                try:
                    status = child.wait(timeout=deadline.remaining(frontier))
                except subprocess.TimeoutExpired:
                    raise Refused('firewall-command-timeout') from None
                self._child = None
                require(status == 0, 'firewall-command-refused')
            except BaseException as primary:
                try:
                    child.stdout.close()
                except BaseException:
                    primary.add_note('firewall-output-close-unproved')
                if self._child is not None:
                    try:
                        self._reap_failed_child(deadline)
                    except BaseException:
                        primary.add_note('firewall-child-settlement-unproved')
                raise
            child.stdout.close()
        result = bytes(raw)
        # A timed wait can reap the child after the active frontier.
        deadline.remaining(frontier)
        return result

    def install(self, deadline):
        require(not self.attempted, 'firewall-install-already-attempted')
        require_terminal_hooks(self._nft(['list', 'chains'], deadline, 16))
        rows = firewall_spec(self.name)
        batch = [{('create' if kind != 'rule' else 'add'): {kind: row}} for kind, row in rows]
        self.attempted = True
        self._nft(['-f', '-'], deadline, 16, json.dumps({'nftables': batch}).encode())
        self.handles, self.counters = firewall_readback(self.name,
            self._nft(['-a', 'list', 'table', 'inet', self.name], deadline, 16))
        self.observe(deadline, 16)

    def observe(self, deadline, frontier=60):
        require(self.handles is not None, 'firewall-birth-unproved')
        require_terminal_hooks(self._nft(['list', 'chains'], deadline, frontier), self.name)
        handles, counters = firewall_readback(self.name,
            self._nft(['-a', 'list', 'table', 'inet', self.name], deadline, frontier))
        require(handles == self.handles and all(counters[k][field] >= self.counters[k][field]
                for k in counters for field in ('packets', 'bytes')), 'firewall-identity-drift')
        packets = {key: value['packets'] for key, value in counters.items()}
        deadline.remaining(frontier)
        self.counters = counters
        return packets

    def remove_after_quiescence(self, deadline):
        require(not self.removal_attempted, 'firewall-removal-already-attempted')
        require_role_credentials_absent(deadline, 75)
        for port in (CONTROL, INGRESS):
            require(not _listeners_on(_bounded_file('/proc/net/tcp', 1024 * 1024),
                                      _bounded_file('/proc/net/tcp6', 1024 * 1024), port), 'native-listener-still-present')
        self.observe(deadline, 75)
        self.removal_attempted = True
        self._nft(['delete', 'table', 'inet', self.name], deadline, 75)
        rows = _nft_rows(self._nft(['list', 'tables'], deadline, 75))
        require(all(type(row) is dict and set(row) == {'table'} and type(row['table']) is dict for row in rows),
                'invalid-terminal-table-inventory')
        require(all(row['table'].get('name') != self.name for row in rows), 'firewall-not-removed')
        deadline.remaining(75)
        self.handles = None


def counter_window(before, after, increased):
    require(set(before) == set(after) and set(increased) <= set(before), 'counter-window-shape')
    require(all(type(before[key]) is int and type(after[key]) is int and
                (after[key] > before[key] if key in increased else after[key] == before[key])
                for key in before), 'counter-window-differs')


FRAME_FIELDS = {
    'observer-ready': {'pid', 'tag'}, 'listener-ready': {'pid'}, 'probe-ready': {'pid'},
    'deny-prepare': {'pid'}, 'negatives-complete': {'checks'}, 'ingress-complete': {'status'},
}
PROBE_CHECKS = ['own-canary', 'ingress', 'driver-canary-denied', 'driver-credential-denied',
                'driver-proc-denied', 'host-sockets-denied', 'socket-families-denied', 'rings-denied',
                'postgres-denied', 'control-denied']


def decode_frame(raw, expected):
    require(type(raw) is bytes and 1 < len(raw) <= MAX_FRAME and raw.endswith(b'\n')
            and raw.count(b'\n') == 1, 'invalid-capability-frame-length')
    value = json_object(raw)
    require(type(value) is dict and set(value) == {'op', *FRAME_FIELDS.get(expected, ())}
            and value['op'] == expected, 'invalid-capability-frame')
    if 'pid' in value:
        require(type(value['pid']) is int and 1 < value['pid'] <= 4194304, 'invalid-capability-pid')
    if 'tag' in value:
        require(type(value['tag']) is str and re.fullmatch(r'aihrbc_[0-9a-f]{16}', value['tag']), 'invalid-observer-tag')
    if 'status' in value:
        require(type(value['status']) is int and value['status'] == 200, 'invalid-capability-status')
    if 'checks' in value:
        require(value['checks'] == PROBE_CHECKS, 'invalid-probe-census')
    return value


class Frames:
    def __init__(self):
        self.position = 0

    def accept(self, role, direction, raw):
        require(not self.complete(), 'unexpected-capability-frame')
        wanted_role, wanted_direction, op = FRAME_ORDER[self.position]
        require((role, direction) == (wanted_role, wanted_direction), 'unexpected-capability-frame-direction')
        value = decode_frame(raw, op)
        self.position += 1
        return value

    def complete(self):
        return self.position == len(FRAME_ORDER)


def role_properties(role):
    require(role in ('driver', 'browser'), 'invalid-systemd-role')
    memory, tasks = (512, 64) if role == 'driver' else (2048, 512)
    return {**ROLE_POLICY, 'User': 'aihrbc-' + role, 'Group': 'aihrbc-' + role,
            'RuntimeMaxSec': '75s', 'TimeoutStopSec': '3s',
            'MemoryMax': f'{memory}M', 'TasksMax': str(tasks)}


def _bounded_bytes(source, limit):
    data = bytearray()
    while True:
        block = source.read(min(16384, limit + 1 - len(data)))
        require(type(block) is bytes and len(data) + len(block) <= limit, 'native-file-bound')
        if not block:
            return bytes(data)
        data.extend(block)


def _bounded_file(path, limit):
    with open(path, 'rb', buffering=0) as source:
        return _bounded_bytes(source, limit)


def _process_birth(raw, pid):
    last = raw.rfind(b')')
    require(last > 0 and raw.startswith(f'{pid} ('.encode()), 'invalid-proc-stat')
    parts = raw[last + 2:].split()
    require(len(parts) > 19 and parts[0] != b'Z' and parts[19].isdigit() and int(parts[19]) > 0,
            'invalid-or-dead-process')
    return int(parts[19])


def _status_fields(raw):
    values = {}
    wanted = {b'Uid', b'Gid', b'Groups', b'NoNewPrivs', b'CapEff', b'CapPrm', b'CapBnd', b'CapAmb',
              b'Seccomp', b'Seccomp_filters'}
    for row in raw.splitlines():
        key, _, value = row.partition(b':')
        if key in wanted:
            require(key not in values, 'duplicate-proc-status')
            values[key] = value.split()
    require(set(values) == wanted, 'incomplete-proc-status')
    return values


def _id_map(raw, host_id):
    rows = [row.split() for row in raw.splitlines()]
    require(len(rows) == 1 and len(rows[0]) == 3 and all(part.isdigit() for part in rows[0]), 'invalid-browser-id-map')
    require(int(rows[0][1]) == host_id and int(rows[0][2]) == 1, 'browser-id-map-escapes-role')


def _role_status(raw, uid, initial_user_namespace):
    data = _status_fields(raw)
    require(all(data[key] == [str(uid).encode()] * 4 for key in (b'Uid', b'Gid'))
            and all(group == str(uid).encode() for group in data[b'Groups']), 'native-role-credentials-differ')
    require(data[b'NoNewPrivs'] == [b'1'] and data[b'Seccomp'] == [b'2'] and len(data[b'Seccomp_filters']) == 1
            and data[b'Seccomp_filters'][0].isdigit() and int(data[b'Seccomp_filters'][0]) > 0, 'native-role-seccomp-differs')
    if initial_user_namespace:
        for key in (b'CapEff', b'CapPrm', b'CapBnd', b'CapAmb'):
            require(len(data[key]) == 1 and re.fullmatch(rb'0+', data[key][0]), 'initial-role-capabilities-present')
    return int(data[b'Seccomp_filters'][0])


def held_role_process(pid, role, control_group):
    """Root-only positive process fact. The caller owns the retained pidfd."""
    require(os.geteuid() == 0 and type(pid) is int and 1 < pid <= 4194304 and role in ('driver', 'browser'),
            'native-process-owner-required')
    require(re.fullmatch(r'/system\.slice/aihrbc-' + role + r'-[1-9][0-9]{0,19}\.service', control_group),
            'native-role-cgroup-path')
    group = pathlib.Path('/sys/fs/cgroup' + control_group)
    proc = pathlib.Path('/proc', str(pid))
    fd = os.pidfd_open(pid)
    try:
        require(not select.select([fd], [], [], 0)[0], 'native-role-process-exited')
        start = _process_birth(_bounded_file(proc / 'stat', 8192), pid)
        group_info = group.lstat()
        require(stat.S_ISDIR(group_info.st_mode) and _bounded_file(proc / 'cgroup', 8192) == f'0::{control_group}\n'.encode(),
                'native-role-cgroup-differs')
        initial_ns = os.stat('/proc/1/ns/user').st_ino
        user_ns, pid_ns = (os.stat(proc / 'ns' / namespace).st_ino for namespace in ('user', 'pid'))
        uid = DRIVER if role == 'driver' else BROWSER
        filters = _role_status(_bounded_file(proc / 'status', 32768), uid, user_ns == initial_ns)
        if user_ns != initial_ns:
            require(role == 'browser', 'unexpected-driver-user-namespace')
            _id_map(_bounded_file(proc / 'uid_map', 4096), uid)
            _id_map(_bounded_file(proc / 'gid_map', 4096), uid)
        executable = os.readlink(proc / 'exe')
        argv = _bounded_file(proc / 'cmdline', 32768)
        require(argv.endswith(b'\0') and executable.startswith('/') and not executable.endswith(' (deleted)'),
                'native-role-executable-differs')
        final_group = group.lstat()
        require((group_info.st_dev, group_info.st_ino) == (final_group.st_dev, final_group.st_ino)
                and _process_birth(_bounded_file(proc / 'stat', 8192), pid) == start
                and not select.select([fd], [], [], 0)[0], 'native-role-process-changed')
        return fd, {'pid': pid, 'start': start, 'cgroupBirth': (group_info.st_dev, group_info.st_ino),
                    'userNamespace': user_ns, 'pidNamespace': pid_ns, 'seccompFilters': filters,
                    'executable': executable, 'argv': argv[:-1].split(b'\0')}
    except BaseException:
        os.close(fd)
        raise


def require_renderer(renderer, launcher, chromium):
    require(renderer['cgroupBirth'] == launcher['cgroupBirth'] == chromium['cgroupBirth']
            and renderer['userNamespace'] not in {launcher['userNamespace'], chromium['userNamespace']}
            and renderer['pidNamespace'] not in {launcher['pidNamespace'], chromium['pidNamespace']}
            and renderer['seccompFilters'] > max(launcher['seccompFilters'], chromium['seccompFilters'])
            and b'--type=renderer' in renderer['argv'], 'native-renderer-sandbox-differs')


def _listeners_on(ipv4, ipv6, port):
    require(port in (CONTROL, INGRESS, POSTGRES), 'invalid-native-listener')
    matches = []
    for width, contents in ((8, ipv4), (32, ipv6)):
        rows = contents.splitlines()
        require(bool(rows) and b'local_address' in rows[0], 'invalid-native-tcp-table')
        for row in rows[1:]:
            fields = row.split()
            require(len(fields) >= 10 and re.fullmatch(rb'[0-9A-F]+:[0-9A-F]{4}', fields[1])
                    and len(fields[1]) == width + 5 and re.fullmatch(rb'[0-9A-F]{2}', fields[3]),
                    'invalid-native-tcp-row')
            if fields[3] == b'0A' and int(fields[1].split(b':')[1], 16) == port:
                matches.append((fields[1], fields[7], fields[9]))
    return matches


def listener_inode(ipv4, ipv6, port, uid):
    matches = _listeners_on(ipv4, ipv6, port)
    require(len(matches) == 1, 'native-listener-not-unique')
    address, owner, inode = matches[0]
    require(address == f'0100007F:{port:04X}'.encode() and owner == str(uid).encode()
            and inode.isdigit() and int(inode) > 0, 'native-listener-address-or-owner-differs')
    return int(inode)


def _role_credentials(raw):
    result = {}
    for line in raw.splitlines():
        key, _, value = line.partition(b':')
        if key in (b'Uid', b'Gid', b'Groups'):
            fields = value.split()
            require(key not in result and all(part.isdigit() for part in fields)
                    and (key == b'Groups' or len(fields) == 4), 'invalid-proc-credentials')
            result[key] = {int(part) for part in fields}
    require(set(result) == {b'Uid', b'Gid', b'Groups'}, 'incomplete-proc-credentials')
    return set.union(*result.values())


MAX_PROC_IDS = 4096
PROC_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def _directory_id(info):
    require(stat.S_ISDIR(info.st_mode), 'native-proc-directory-differs')
    return info.st_dev, info.st_ino


def _directory_birth(path, dir_fd=None):
    try:
        current = os.stat(path, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    return _directory_id(current)


@contextmanager
def _hold_proc_directory(path, dir_fd=None):
    fd = os.open(path, PROC_DIRECTORY_FLAGS, dir_fd=dir_fd)
    try:
        yield fd, _directory_id(os.fstat(fd))
    finally:
        os.close(fd)


def _task_census_budget(check_clock):
    count = 0
    def charge():
        nonlocal count
        check_clock()
        count += 1
        require(count <= MAX_PROC_IDS, 'credential-task-census-bound')
    return charge


def _task_births(directory, charge):
    births = {}
    # A fresh directory description starts the second enumeration at its beginning.
    with _hold_proc_directory('.', directory) as (scan, _), os.scandir(scan) as entries:
        for entry in entries:
            charge()
            require(re.fullmatch(r'[1-9][0-9]{0,6}', entry.name), 'credential-task-name-differs')
            birth = _directory_birth(entry.name, scan)
            if birth is not None:
                births[entry.name] = birth
    return births


def _task_credentials(task):
    fd = os.open('status', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=task)
    with os.fdopen(fd, 'rb', buffering=0) as source:
        return _role_credentials(_bounded_bytes(source, 32768))


def _require_proc_credentials_absent(proc_root, check_clock):
    observe, verify = _task_census_budget(check_clock), _task_census_budget(check_clock)
    with os.scandir(proc_root) as processes:
        for index, process in enumerate(processes):
            check_clock()
            require(index < MAX_PROC_IDS, 'credential-census-bound')
            if not re.fullmatch(r'[1-9][0-9]{0,6}', process.name):
                continue
            path = pathlib.Path(process.path)
            birth = _directory_birth(path)
            if birth is None:
                continue
            try:
                with _hold_proc_directory(path) as (group, held_birth):
                    require(held_birth == birth, 'credential-process-birth-differs')
                    with _hold_proc_directory('task', group) as (directory, task_dir_birth):
                        tasks = _task_births(directory, observe)
                        for name, task_birth in tasks.items():
                            check_clock()
                            try:
                                with _hold_proc_directory(name, directory) as (task, held_task_birth):
                                    require(held_task_birth == task_birth, 'credential-task-birth-differs')
                                    credentials = _task_credentials(task)
                            except FileNotFoundError:
                                require(_directory_birth(name, directory) is None, 'credential-census-ambiguous-task')
                                continue
                            require(_directory_birth(name, directory) in (None, task_birth), 'credential-task-birth-differs')
                            require(not credentials & {DRIVER, BROWSER}, 'capability-role-process-present')
                        after = _task_births(directory, verify)
                    require(_directory_birth('task', group) in (None, task_dir_birth), 'credential-task-directory-differs')
            except FileNotFoundError:
                require(_directory_birth(path) is None, 'credential-census-ambiguous-process')
                continue
            final_birth = _directory_birth(path)
            if final_birth is None:
                continue
            require(final_birth == birth and _directory_birth(path / 'task') == task_dir_birth,
                    'credential-process-birth-differs')
            require(bool(tasks) and bool(after) and all(tasks.get(name) == task_birth for name, task_birth in after.items()),
                    'credential-task-membership-differs')


def require_role_credentials_absent(deadline, frontier):
    require(os.geteuid() == 0, 'credential-census-root-owner-required')
    _require_proc_credentials_absent('/proc', lambda: deadline.remaining(frontier))


def require_role_listener(pidfd, observed, port, uid):
    """Join one native IPv4 listener to an already-held process and its FD table."""
    require(os.geteuid() == 0 and not select.select([pidfd], [], [], 0)[0], 'listener-process-exited')
    proc = pathlib.Path('/proc', str(observed['pid']))
    require(_process_birth(_bounded_file(proc / 'stat', 8192), observed['pid']) == observed['start'],
            'listener-process-birth-differs')
    def inode():
        return listener_inode(_bounded_file('/proc/net/tcp', 1024 * 1024),
                              _bounded_file('/proc/net/tcp6', 1024 * 1024), port, uid)
    expected = inode()
    found = False
    for index, fd in enumerate((proc / 'fd').iterdir()):
        require(index < 2048, 'listener-descriptor-bound')
        try:
            target = os.readlink(fd)
        except FileNotFoundError:
            continue  # Unrelated descriptors may settle during observation.
        require(target != 'anon_inode:[io_uring]', 'native-ring-descriptor-present')
        found |= target == f'socket:[{expected}]'
    require(found and inode() == expected and not select.select([pidfd], [], [], 0)[0]
            and _process_birth(_bounded_file(proc / 'stat', 8192), observed['pid']) == observed['start'],
            'native-listener-process-join-differs')

def _tcp(port, expected):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(1)
        require(client.connect_ex((LOOPBACK, port)) == expected, 'tcp-probe-differs')


def _unreadable(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except OSError as error:
        require(error.errno in (errno.EACCES, errno.EPERM, errno.ENOENT), 'private-path-probe-differs')
    else:
        os.close(fd)
        raise Refused('private-path-readable')


def _socket_denied(family):
    try:
        with socket.socket(family, socket.SOCK_STREAM):
            raise Refused('socket-family-accessible')
    except OSError as error:
        require(error.errno == errno.EAFNOSUPPORT, 'socket-family-probe-differs')


def _ring_denials():
    require(os.uname().machine == 'x86_64', 'native-ring-abi-differs')
    syscall = ctypes.CDLL(None, use_errno=True).syscall
    params = ctypes.create_string_buffer(120)
    attempts = ((425, 1, ctypes.byref(params)), (426, -1, 0, 0, 0, 0, 0), (427, -1, 0, 0, 0))
    for args in attempts:
        ctypes.set_errno(0)
        result = syscall(*args)
        if args[0] == 425 and result >= 0:
            os.close(result)
        require(result == -1 and ctypes.get_errno() == errno.EPERM, 'ring-syscall-probe-differs')


def _browser_probe(pid):
    require(os.getresuid() == (BROWSER,) * 3 and os.getresgid() == (BROWSER,) * 3, 'browser-probe-principal')
    home = os.environ.get('HOME', '')
    match = re.fullmatch(r'/run/aihr-browser-capability-([1-9][0-9]{0,19})/browser-home', home)
    require(match is not None and re.fullmatch(r'[1-9][0-9]{0,6}', pid) and 1 < int(pid) <= 4194304,
            'browser-probe-input')
    sys.stdout.write(f'{{"op":"probe-ready","pid":{os.getpid()}}}\n')
    sys.stdout.flush()
    decode_frame(sys.stdin.buffer.readline(MAX_FRAME + 1), 'deny-go')
    with open(home + '/canary', 'rb') as source:
        require(source.read(16) == b'browser-canary\n', 'browser-canary-differs')
    _tcp(INGRESS, 0)
    _unreadable(str(pathlib.Path(home).parent / 'driver-home' / 'canary'))
    _unreadable(f'/run/credentials/aihrbc-driver-{match[1]}.service/observer')
    for name in ('environ', 'mem', 'fd/0'):
        _unreadable(f'/proc/{pid}/{name}')
    for name in ('/run/docker.sock', '/run/containerd/containerd.sock'):
        try:
            mode = os.stat(name).st_mode
        except OSError as error:
            require(error.errno in (errno.ENOENT, errno.EACCES, errno.EPERM), 'host-socket-probe-differs')
        else:
            require(stat.S_IMODE(mode) == 0, 'host-socket-visible')
    _socket_denied(socket.AF_UNIX)
    _socket_denied(socket.AF_INET6)
    _ring_denials()
    _tcp(POSTGRES, errno.ECONNREFUSED)
    _tcp(CONTROL, errno.ECONNREFUSED)
    print(json.dumps({'op': 'negatives-complete', 'checks': PROBE_CHECKS}, separators=(',', ':')), flush=True)


def _third_probe():
    require(os.getresuid() == (THIRD,) * 3 and os.getresgid() == (THIRD,) * 3
            and all(group == THIRD for group in os.getgroups()), 'third-probe-principal')
    print(f'{{"op":"probe-ready","pid":{os.getpid()}}}', flush=True)
    decode_frame(sys.stdin.buffer.readline(MAX_FRAME + 1), 'probe')
    _tcp(CONTROL, errno.ECONNREFUSED)
    print('{"op":"control-denied"}', flush=True)


if __name__ == '__main__':
    try:
        require(sys.platform == 'linux', 'native-linux-required')
        if len(sys.argv) == 3 and sys.argv[1] == 'probe-browser':
            _browser_probe(sys.argv[2])
        elif sys.argv[1:] == ['probe-third']:
            _third_probe()
        else:
            raise Refused('root-capability-caller-uninstalled')
    except BaseException:
        sys.exit(19)
