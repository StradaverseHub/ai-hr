"""Observe the fixed Ubuntu stock manager loader inputs as data only."""

import hashlib
import os
import re
import stat
import struct
import time
from contextlib import ExitStack


_SECOND = 1_000_000_000
_MIB = 1024**2
_MAX_IMAGE = 8 * _MIB
_MAX_READ = 64 * _MIB
_MULTIARCH = '/usr/lib/x86_64-linux-gnu'
_PYTHON_MODULES = '/usr/lib/python3.12/lib-dynload'
_INTERPRETER = '/lib64/ld-linux-x86-64.so.2'
_MAIN = 'libsystemd.so.0'
_FIXED = (
    ('python3.12', '/usr/bin', ('python3.12-minimal',)),
    ('systemd', '/usr/lib/systemd', ('systemd',)),
    ('dbus-daemon', '/usr/bin', ('dbus-daemon',)),
    (_MAIN, _MULTIARCH, ('libsystemd0',)),
    ('libcap.so.2', _MULTIARCH, ('libcap2',)),
    ('libgcrypt.so.20', _MULTIARCH, ('libgcrypt20',)),
    ('liblz4.so.1', _MULTIARCH, ('liblz4-1',)),
    ('liblzma.so.5', _MULTIARCH, ('liblzma5',)),
    ('libzstd.so.1', _MULTIARCH, ('libzstd1',)),
    ('libc.so.6', _MULTIARCH, ('libc6',)),
    ('ld-linux-x86-64.so.2', _MULTIARCH, ('libc6',)),
    ('libgpg-error.so.0', _MULTIARCH, ('libgpg-error0',)),
)
# These stock mappings can be present before the first manager DSO call.
# The course never opens an object discovered from an unknown mapping.
_OPTIONAL_LIBRARIES = (
    ('libm.so.6', 'libc6'), ('libdl.so.2', 'libc6'), ('libpthread.so.0', 'libc6'),
    ('libcrypt.so.1', 'libcrypt1'), ('libnss_systemd.so.2', 'libnss-systemd'),
    ('libnss_files.so.2', 'libc6'), ('libnss_compat.so.2', 'libc6'),
    ('libnss_resolve.so.2', 'libnss-resolve'), ('libnss_dns.so.2', 'libc6'),
    ('libcrypto.so.3', 'libssl3t64'), ('libssl.so.3', 'libssl3t64'),
    ('libz.so.1', 'zlib1g'), ('libbz2.so.1.0', 'libbz2-1.0'),
    ('libffi.so.8', 'libffi8'), ('libexpat.so.1', 'libexpat1'),
    ('libuuid.so.1', 'libuuid1'), ('libgcc_s.so.1', 'libgcc-s1'),
    ('libmpdec.so.3', 'libmpdec3'), ('libreadline.so.8', 'libreadline8t64'),
    ('libtinfo.so.6', 'libtinfo6'),
)
_PYTHON_SUFFIX = '.cpython-312-x86_64-linux-gnu.so'
_OPTIONAL_MODULES = (
    '_asyncio', '_bisect', '_blake2', '_bz2', '_contextvars', '_ctypes', '_datetime',
    '_decimal', '_hashlib', '_heapq', '_json', '_lzma', '_opcode', '_pickle',
    '_posixsubprocess', '_queue', '_random', '_sha1', '_sha2', '_sha3', '_socket',
    '_ssl', '_struct', '_typing', '_uuid', '_zoneinfo', 'array', 'binascii', 'fcntl',
    'grp', 'math', 'mmap', 'readline', 'select', 'termios', 'unicodedata', 'zlib',
)
_OPTIONAL = (
    *((name, _MULTIARCH, (package,)) for name, package in _OPTIONAL_LIBRARIES),
    *((name + _PYTHON_SUFFIX, _PYTHON_MODULES, ('libpython3.12-minimal', 'libpython3.12-stdlib'))
      for name in _OPTIONAL_MODULES),
)
_ROSTER = (*_FIXED, *_OPTIONAL)
_MAPPED_REQUIRED = {'python3.12', 'ld-linux-x86-64.so.2', 'libc.so.6'}
_DIRECT_NEEDED = tuple(row[0] for row in _FIXED[4:11])
_VERSION = re.compile(rb'[0-9][A-Za-z0-9.+:~\-]{0,95}')
_MAP = re.compile(rb'[a-f0-9]{1,16}-[a-f0-9]{1,16} +([r-][w-][x-][ps]) +[a-f0-9]{1,16} +'
                  rb'([a-f0-9]{1,8}):([a-f0-9]{1,8}) +([0-9]{1,20})(?:[ \t]+(.*))?')
_PHASES = ('held-manager', 'stock-files', 'package-association', 'executable-maps', 'owner-settlement')
_REASONS = (
    'read-bound', 'stock-file', 'stock-alias', 'stock-image', 'stock-image-changed', 'stock-interpreter',
    'stock-packages', 'stock-package-association', 'stock-maps', 'stock-map-inode', 'stock-map-changed',
    'stock-environment', 'stock-preload', 'stock-proc', 'stock-library-links', 'owner-deadline', 'owned-observation-refused',
)


def _need(value, reason):
    if not value:
        raise ValueError(reason)


def _left(ready):
    _need(time.monotonic_ns() < ready, 'owner-deadline')


def _stamp(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _stat(folder, leaf):
    return os.stat(leaf, dir_fd=folder, follow_symlinks=False)


def _maybe(folder, leaf):
    try:
        return _stat(folder, leaf)
    except FileNotFoundError:
        return None


def _target(alias, target):
    return re.fullmatch(re.escape(alias) + r'(?:\.[0-9]{1,6}){1,3}', target) is not None


def _read_fd(fd, limit, budget, ready):
    output = bytearray()
    while True:
        _left(ready)
        count = min(65536, limit + 1 - len(output), budget[0])
        _need(count > 0, 'read-bound')
        block = os.read(fd, count)
        budget[0] -= len(block)
        _left(ready)
        if not block:
            return bytes(output)
        output.extend(block)
        _need(len(output) <= limit, 'read-bound')


def _interpreter(raw):
    _need(len(raw) >= 64 and raw[:7] == b'\x7fELF\x02\x01\x01', 'stock-interpreter')
    kind, machine, version = struct.unpack_from('<HHI', raw, 16)
    offset, = struct.unpack_from('<Q', raw, 32)
    size, entry, count = struct.unpack_from('<HHH', raw, 52)
    _need((kind, machine, version, size, entry) == (3, 62, 1, 64, 56)
          and 1 <= count <= 128 and 64 <= offset <= len(raw) - entry * count, 'stock-interpreter')
    found = []
    for row in range(offset, offset + entry * count, entry):
        p_type, _flags, start, _vaddr, _paddr, length, _mem, _align = struct.unpack_from('<IIQQQQQQ', raw, row)
        if p_type == 3:
            _need(0 < length <= 128 and start <= len(raw) - length, 'stock-interpreter')
            found.append(raw[start:start + length])
    _need(found == [_INTERPRETER.encode() + b'\0'], 'stock-interpreter')


def _map_rows(raw):
    _need(raw.endswith(b'\n') and 0 < raw.count(b'\n') <= 4096, 'stock-maps')
    images, kernel = {}, set()
    anonymous = 0
    for line in raw.split(b'\n')[:-1]:
        match = _MAP.fullmatch(line)
        _need(match is not None, 'stock-maps')
        perms, major, minor, inode, path = match.groups()
        if perms[2:3] != b'x':
            continue
        _need(perms[1:2] != b'w', 'stock-maps')
        birth = (int(major, 16), int(minor, 16), int(inode))
        if path in (b'[vdso]', b'[vsyscall]'):
            _need(birth == (0, 0, 0) and path not in kernel, 'stock-maps')
            kernel.add(path)
        elif not path or not path.startswith(b'/') or birth[2] == 0:
            anonymous += 1
        else:
            _need(path not in images or images[path] == birth, 'stock-map-inode')
            images[path] = birth
    return images, kernel, anonymous


def _mapped_images(maps, anonymous, fixed_maps):
    mapped = set()
    unknown = anonymous
    for path, observed in maps.items():
        if path not in fixed_maps:
            unknown += 1
            continue
        label, birth = fixed_maps[path]
        _need(observed == birth, 'stock-map-inode')
        mapped.add(label)
    _need(_MAPPED_REQUIRED <= mapped and _MAIN not in mapped, 'stock-map-inode')
    return sorted(mapped), unknown


def _loader_env(raw, current):
    _need(raw.endswith(b'\0') and 0 < raw.count(b'\0') <= 512, 'stock-environment')
    seen = set()
    for entry in raw[:-1].split(b'\0'):
        name, equals, _ = entry.partition(b'=')
        _need(equals and re.fullmatch(rb'[A-Za-z_][A-Za-z0-9_]{0,127}', name) and name not in seen,
              'stock-environment')
        seen.add(name)
    def unsafe(name):
        return name.startswith(b'LD_') or name in (b'GLIBC_TUNABLES', b'GCONV_PATH', b'LOCPATH')
    _need(not any(unsafe(name) for name in seen) and not any(unsafe(os.fsencode(name)) for name in current),
          'stock-environment')


def _installed(raw, wanted):
    _need(raw.endswith(b'\n') and raw.count(b'\n\n') <= 16384, 'stock-packages')
    matches = {}
    for paragraph in raw.split(b'\n\n'):
        first, _, _ = paragraph.partition(b'\n')
        if not first.startswith(b'Package: ') or first[9:] not in wanted:
            continue
        name = first[9:]
        fields = {}
        for line in paragraph.split(b'\n'):
            key, separator, value = line.partition(b': ')
            if separator and key in (b'Package', b'Status', b'Architecture', b'Version'):
                _need(key not in fields, 'stock-packages')
                fields[key] = value
        if fields.get(b'Architecture') != b'amd64' or fields.get(b'Status') != b'install ok installed':
            continue
        version = fields.get(b'Version', b'')
        _need(name not in matches and _VERSION.fullmatch(version), 'stock-packages')
        matches[name] = version.decode('ascii')
    return matches


def _package_paths(path):
    # dpkg may retain the pre-usrmerge spelling; the held file stays canonical.
    paths = (path, path[4:]) if path.startswith('/usr/lib/') or path.startswith('/usr/lib64/') else (path,)
    return {value.encode('ascii') for value in paths}


def _digest_row(value, maximum):
    return type(value) is dict and set(value) == {'bytes', 'sha256'} and type(value['bytes']) is int and (
        0 < value['bytes'] <= maximum and type(value['sha256']) is str
        and re.fullmatch(r'[a-f0-9]{64}', value['sha256']) is not None)


def validate_capture(report):
    if report['complete'] is False:
        failure = report['failure']
        _need(type(failure) is dict and set(failure) == {'phase', 'reason'} and failure['phase'] in _PHASES
              and failure['reason'] in _REASONS, 'Manager provenance failure differs')
        return
    observation = report['observation']
    _need(type(observation) is dict and set(observation) == {'elapsedMs', 'images', 'mappedImages',
          'unclassifiedExecutableMappings', 'loaderCache', 'loaderPreloadAbsent', 'loaderEnvironmentClear',
          'kernelConfigPresent', 'stockFdHolders', 'managerDirectInputsMatched'},
          'Manager provenance observation fields differ')
    _need(type(observation['elapsedMs']) is int and 0 <= observation['elapsedMs'] < 32000
          and type(observation['unclassifiedExecutableMappings']) is int
          and 0 <= observation['unclassifiedExecutableMappings'] <= 4096
          and observation['managerDirectInputsMatched'] is True
          and observation['loaderPreloadAbsent'] is True and observation['loaderEnvironmentClear'] is True
          and type(observation['kernelConfigPresent']) is bool and _digest_row(observation['loaderCache'], 2 * _MIB)
          and observation['stockFdHolders'] in (['pid1'], ['dbus-daemon'], ['pid1', 'dbus-daemon']),
          'Manager provenance observation values differ')
    images = observation['images']
    _need(type(images) is list and len(_FIXED) <= len(images) <= len(_ROSTER), 'Manager provenance image census differs')
    labels = []
    specs = {name: (parent, packages) for name, parent, packages in _ROSTER}
    for image in images:
        _need(type(image) is dict and set(image) == {'image', 'installedFile', 'bytes', 'sha256', 'package',
              'architecture', 'version'}, 'Manager provenance image fields differ')
        label, leaf, version = image['image'], image['installedFile'], image['version']
        _need(type(label) is str and label in specs and type(leaf) is str
              and (leaf == label or specs[label][0] == _MULTIARCH and _target(label, leaf))
              and image['package'] in specs[label][1] and image['architecture'] == 'amd64'
              and type(version) is str and version.isascii() and _VERSION.fullmatch(version.encode())
              and _digest_row({'bytes': image['bytes'], 'sha256': image['sha256']}, _MAX_IMAGE),
              'Manager provenance image values differ')
        labels.append(label)
    required = [name for name, _, _ in _FIXED]
    _need(labels == [*required, *(name for name, _, _ in _OPTIONAL if name in labels)]
          and sum(row['bytes'] for row in images) <= _MAX_READ, 'Manager provenance image order differs')
    mapped = observation['mappedImages']
    _need(type(mapped) is list and all(type(label) is str for label in mapped)
          and mapped == sorted(set(mapped)) and _MAPPED_REQUIRED <= set(mapped) <= set(labels) - {_MAIN}
          and set(labels[len(required):]) <= set(mapped), 'Manager provenance mapping census differs')


def _associate(images, status, get_list):
    wanted = {package.encode() for _, _, _, packages in images for package in packages}
    versions = _installed(status, wanted)
    membership = {}
    for package in sorted(versions):
        contents = get_list(package.decode('ascii'))
        _need(contents.endswith(b'\n') and contents.count(b'\n') <= 32768, 'stock-package-association')
        membership[package.decode('ascii')] = set(contents.split(b'\n')[:-1])
    rows = []
    for label, path, data, packages in images:
        valid = [name for name in packages if _package_paths(path) & membership.get(name, set())]
        _need(len(valid) == 1, 'stock-package-association')
        package = valid[0]
        rows.append({'image': label, 'installedFile': path.rsplit('/', 1)[1], **data,
                     'package': package, 'architecture': 'amd64', 'version': versions[package.encode()]})
    return rows


def observe_manager_provenance(admission, view, host, mounts, original):
    """Bind same-owner file and mapping observations, without opening a transport."""
    start = time.monotonic_ns()
    ready = start + 32 * _SECOND
    deadline = ready / _SECOND
    budget = [_MAX_READ]
    phase = 'held-manager'
    try:
        with admission.held_manager_inputs(view, host, mounts, started_ns=start, ready_by_ns=ready) as manager:
            budget[0] -= manager.library_bytes  # Existing admission's held image read.
            with ExitStack() as held:
                root = held.enter_context(view._own(os.open('/', view._DIRECTORY)))
                chains, rechecks = {}, []
                def folder(path):
                    if path not in chains:
                        chains[path] = view._walk_directories(held, root, tuple((part, None) for part in path[1:].split('/')), deadline)
                    return chains[path][-1][2]

                def link(parent, name, info):
                    _need(stat.S_ISLNK(info.st_mode) and info.st_uid == info.st_gid == 0, 'stock-alias')
                    value = os.readlink(name, dir_fd=parent)
                    def current():
                        _need(_stamp(_stat(parent, name)) == _stamp(info) and os.readlink(name, dir_fd=parent) == value,
                              'stock-alias')
                    current()
                    rechecks.append(current)
                    return value

                def file(parent, name, maximum):
                    _left(ready)
                    before = _stat(parent, name)
                    _need(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0
                          and not before.st_mode & 0o7022 and before.st_nlink >= 1
                          and 0 < before.st_size <= maximum, 'stock-file')
                    fd = held.enter_context(view._own(os.open(name, view._PROC_FILE, dir_fd=parent)))
                    def current():
                        _need(_stamp(os.fstat(fd)) == _stamp(before) == _stamp(_stat(parent, name))
                              and not os.get_inheritable(fd), 'stock-image-changed')
                    current()
                    raw = _read_fd(fd, before.st_size, budget, ready)
                    _need(len(raw) == before.st_size, 'stock-image-changed')
                    current()
                    rechecks.append(current)
                    return raw, before

                def proc(parent, name, maximum):
                    _left(ready)
                    before = _stat(parent, name)
                    with view._own(os.open(name, view._PROC_FILE, dir_fd=parent)) as fd:
                        _need(stat.S_ISREG(before.st_mode) and _stamp(os.fstat(fd)) == _stamp(before), 'stock-proc')
                        raw = _read_fd(fd, maximum, budget, ready)
                        _need(_stamp(os.fstat(fd)) == _stamp(before) == _stamp(_stat(parent, name)), 'stock-proc')
                    return raw

                phase = 'stock-files'
                local = folder('/proc/' + str(os.getpid()))
                etc = folder('/etc')
                _need(_maybe(etc, 'ld.so.preload') is None, 'stock-preload')
                raw_cache, _ = file(etc, 'ld.so.cache', 2 * _MIB)
                cache = {'bytes': len(raw_cache), 'sha256': hashlib.sha256(raw_cache).hexdigest()}
                loader_env = proc(local, 'environ', 64 * 1024)
                _loader_env(loader_env, os.environ)
                link64 = _stat(root, 'lib64')
                _need(link(root, 'lib64', link64) == 'usr/lib64', 'stock-interpreter')
                lib64 = folder('/usr/lib64')
                alias = _stat(lib64, 'ld-linux-x86-64.so.2')
                _need(link(lib64, 'ld-linux-x86-64.so.2', alias) in (
                    '../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
                    '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'), 'stock-interpreter')
                lib = _stat(root, 'lib')
                _need(link(root, 'lib', lib) == 'usr/lib', 'stock-interpreter')

                maps, kernel, anonymous = _map_rows(proc(local, 'maps', _MIB))
                images, fixed_maps = [], {}
                python_birth = loader_birth = None
                for index, (name, parent, packages) in enumerate(_ROSTER):
                    prefix = (parent + '/' + name).encode()
                    if index >= len(_FIXED) and not any(
                            path == prefix or (parent == _MULTIARCH and path.startswith(prefix)
                                               and _target(name, path[len(parent) + 1:].decode('ascii', 'replace')))
                            for path in maps):
                        continue
                    directory = folder(parent)
                    before = _stat(directory, name)
                    leaf = name
                    if stat.S_ISLNK(before.st_mode):
                        leaf = link(directory, name, before)
                        _need(parent == _MULTIARCH and _target(name, leaf), 'stock-alias')
                    path = parent + '/' + leaf
                    raw, info = file(directory, leaf, _MAX_IMAGE)
                    _need(raw.startswith(b'\x7fELF\x02\x01\x01'), 'stock-image')
                    data = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                    if name == _MAIN:
                        _need((info.st_dev, info.st_ino) == manager.library_birth
                              and (data['bytes'], data['sha256']) == (manager.library_bytes, manager.library_sha256),
                              'stock-image-changed')
                        descriptor = admission._describe_fixed_library_link_inputs(raw)
                        _need(descriptor.needed == _DIRECT_NEEDED and descriptor.selected_tags == (),
                              'stock-library-links')
                    if name == 'python3.12':
                        _interpreter(raw)
                        python_birth = _stamp(info)
                    if name == 'ld-linux-x86-64.so.2':
                        loader_birth = _stamp(info)
                    images.append((name, path, data, packages))
                    birth = (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino)
                    fixed_maps[path.encode()] = (name, birth)
                    fixed_maps[(parent + '/' + name).encode()] = (name, birth)
                def check_interpreter():
                    _need(os.readlink('exe', dir_fd=local) == '/usr/bin/python3.12'
                          and _stamp(os.stat('exe', dir_fd=local)) == python_birth
                          and _stamp(os.stat(_INTERPRETER[1:], dir_fd=root)) == loader_birth, 'stock-interpreter')
                check_interpreter()

                phase = 'package-association'
                dpkg = folder('/var/lib/dpkg')
                status, _ = file(dpkg, 'status', 16 * _MIB)
                lists = folder('/var/lib/dpkg/info')
                def get_list(package):
                    candidates = [leaf for leaf in (package + ':amd64.list', package + '.list') if _maybe(lists, leaf) is not None]
                    _need(len(candidates) == 1, 'stock-package-association')
                    return file(lists, candidates[0], 2 * _MIB)[0]
                rows = _associate(images, status, get_list)

                phase = 'executable-maps'
                mapped, unknown = _mapped_images(maps, anonymous, fixed_maps)
                holders = original._listener_ownership(view, host, mounts, manager, ready)
                # Only report availability. The kernel config bytes and UNIX_DIAG are unadmitted.
                kernel_config = _maybe(folder('/proc'), 'config.gz')
                phase = 'owner-settlement'
                _need((maps, kernel, anonymous) == _map_rows(proc(local, 'maps', _MIB)), 'stock-map-changed')
                _need(loader_env == proc(local, 'environ', 64 * 1024), 'stock-environment')
                _loader_env(loader_env, os.environ)
                check_interpreter()
                for current in rechecks:
                    _left(ready)
                    current()
                for chain in chains.values():
                    view._check_chain(chain)
                _need(_maybe(etc, 'ld.so.preload') is None, 'stock-preload')
                manager.check_pid1(ready)
        ended = time.monotonic_ns()
        _need(start <= ended < ready, 'owner-deadline')
    except (ValueError, OSError, host.Refused) as error:
        reason = str(error)
        return {'failure': {'phase': phase, 'reason': reason if reason in _REASONS else 'owned-observation-refused'}}
    return {'observation': {'elapsedMs': (ended - start) // 1_000_000, 'images': rows,
                            'mappedImages': mapped, 'unclassifiedExecutableMappings': unknown,
                            'loaderCache': cache, 'loaderPreloadAbsent': True, 'loaderEnvironmentClear': True,
                            'kernelConfigPresent': kernel_config is not None,
                            'stockFdHolders': holders, 'managerDirectInputsMatched': True}}
