"""Closed same-build Next package/mount/resource checks; no install or cache authority.

The controller supplies the verified protected profile and fixed helper directory.
General managed-path checks and the original generation protocol remain controller-owned.
Synthetic tests of this owner do not prove Linux namespaces or an actual Next server.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import pathlib
import re
import shlex
import stat
import types
from urllib.parse import urlsplit
from typing import Any

CACHE_TARGETS = ('.next/cache/images', '.next/cache/fetch-cache', '.next/server/route-cache')
RUNTIME = {'node': '22.23.3', 'abi': '127', 'platform': 'linux', 'arch': 'x64',
           'glibc': '2.39', 'next': '16.4.1'}
MAX_ENTRIES = 500_000
MAX_MANIFEST = 64 * 1024 * 1024
MAX_FILE = 256 * 1024 * 1024
MAX_TOTAL = 4 * 1024 * 1024 * 1024
SHA = re.compile(r'[a-f0-9]{64}')
SAFE_PATH = re.compile(r'/[A-Za-z0-9_./@-]+')
EXTRA_PROPERTIES = ('ProtectSystem', 'PrivateMounts', 'NoNewPrivileges', 'CapabilityBoundingSet',
                    'RestrictNamespaces', 'BindPaths', 'BindReadOnlyPaths', 'ReadWritePaths',
                    'ReadOnlyPaths', 'Slice', 'CPUQuotaPerSecUSec', 'MemoryHigh', 'MemoryMax')


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                       allow_nan=False) + '\n').encode()


def closed(value: Any, keys: set[str], require) -> None:
    require(isinstance(value, dict) and set(value) == keys, 'Unexpected managed Next fields')


def path(value: Any, require) -> pathlib.Path:
    require(isinstance(value, str) and SAFE_PATH.fullmatch(value) is not None
            and str(pathlib.PurePosixPath(value)) == value and '..' not in value.split('/'),
            'Unsafe managed Next path')
    return pathlib.Path(value)


def relative(value: Any, require) -> str:
    require(isinstance(value, str) and 0 < len(value.encode()) <= 4096
            and len(value.split('/')) <= 128 and '\\' not in value
            and all(part not in ('', '.', '..') for part in value.split('/')),
            'Unsafe managed Next inventory member')
    return value


def digest_file(file: pathlib.Path, secure_path, require, uid: int, limit=MAX_FILE) -> str:
    secure_path(file, uid)
    before = file.lstat()
    require(before.st_nlink == 1 and before.st_size <= limit, 'Unsafe managed Next regular file')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        require(file_identity(before) == file_identity(opened), 'Managed Next file changed while opening')
        h = hashlib.sha256()
        total = 0
        while True:
            block = os.read(fd, 1024 * 1024)
            if not block:
                break
            total += len(block)
            require(total <= limit, 'Managed Next file exceeds bound')
            h.update(block)
        require(total == before.st_size and file_identity(os.fstat(fd)) == file_identity(before)
                and file_identity(file.lstat()) == file_identity(before), 'Managed Next file changed while reading')
        return h.hexdigest()
    finally:
        os.close(fd)


def file_identity(info) -> tuple:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def protected_bytes(file: pathlib.Path, secure_path, require, uid: int, limit: int) -> bytes:
    # Read a second time through a pinned descriptor, with independent identity proof.
    secure_path(file, uid)
    before = file.lstat()
    require(before.st_nlink == 1 and 0 < before.st_size <= limit, 'Unsafe managed Next metadata file')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(file_identity(os.fstat(fd)) == file_identity(before), 'Managed Next metadata changed')
        with os.fdopen(os.dup(fd), 'rb') as source:
            data = source.read(limit + 1)
        require(len(data) == before.st_size and len(data) <= limit
                and file_identity(os.fstat(fd)) == file_identity(before)
                and file_identity(file.lstat()) == file_identity(before), 'Managed Next metadata changed')
        return data
    finally:
        os.close(fd)


def protected_json(file, wanted, secure_path, require, uid, limit=MAX_MANIFEST):
    raw = protected_bytes(file, secure_path, require, uid, limit)
    require(SHA.fullmatch(wanted) is not None and hashlib.sha256(raw).hexdigest() == wanted,
            'Protected managed Next metadata digest differs')
    try:
        value = json.loads(raw)
        require(canonical(value) == raw, 'Managed Next metadata is not canonical')
        return value
    except (ValueError, UnicodeError, TypeError):
        require(False, 'Invalid managed Next metadata')


def load_verified_module(directory, name, wanted, secure_path, require, uid):
    require(name in ('next_profile.py', 'runtime_inventory.py'), 'Unsupported managed helper module')
    raw = protected_bytes(directory / name, secure_path, require, uid, 1024 * 1024)
    require(isinstance(wanted, str) and SHA.fullmatch(wanted) is not None
            and hashlib.sha256(raw).hexdigest() == wanted, 'Managed helper source digest differs')
    # Execute only these exact reviewed source bytes. No importlib .pyc/CWD lookup.
    module = types.ModuleType('aihr_verified_' + name.replace('.', '_'))
    module.__file__ = str(directory / name)
    exec(compile(raw, module.__file__, 'exec'), module.__dict__)
    return module


class NextRuntime:
    def __init__(self, value, helper_directory, secure_path, require, uid=0):
        self.value, self.secure_path, self.require, self.uid = value, secure_path, require, uid
        self.package_trees = {}
        self.verified = {}
        closed(value['trustedModules'], {'next_profile.py', 'runtime_inventory.py'}, require)
        self.inventory = load_verified_module(helper_directory, 'runtime_inventory.py',
            value['trustedModules']['runtime_inventory.py'], secure_path, require, uid)
        package = value['runtimePackage']
        closed(package, {'manifestPath', 'manifestSha256', 'format2ManifestPath',
                         'format2ManifestSha256', 'format2ArchiveSha256', 'privateEnvironmentPath', 'privateEnvironmentSha256'}, require)
        self.private_environment_file = path(package['privateEnvironmentPath'], require)
        require(stat.S_IMODE(self.private_environment_file.lstat().st_mode) == 0o600, 'Private runtime environment mode differs')
        self.private_environment = protected_json(self.private_environment_file, package['privateEnvironmentSha256'], secure_path, require, uid, 1024 * 1024)
        closed(self.private_environment, {'version', 'values'}, require)
        require(type(self.private_environment['version']) is int and self.private_environment['version'] == 1
                and isinstance(self.private_environment['values'], dict) and 0 < len(self.private_environment['values']) <= 256,
                'Closed private runtime environment required')
        for key, value in self.private_environment['values'].items():
            require(isinstance(key, str) and re.fullmatch(r'[A-Z_][A-Z0-9_]{0,159}', key) is not None
                    and isinstance(value, str) and '\0' not in value and len(value.encode()) <= 65536
                    and not forbidden_environment(key) and key not in ('PORT', 'AIHR_APP_WORKERS',
                        'AIHR_DB_TOTAL_CONNECTIONS', 'AIHR_DB_POOL_MAX'), 'Unsafe private runtime environment field')
        environment = self.private_environment['values']
        require(environment.get('NODE_ENV') == 'production' and environment.get('HOME') == '/var/empty/aihr'
                and environment.get('PATH') == '/usr/bin:/bin' and environment.get('NEXT_TELEMETRY_DISABLED') == '1'
                and environment.get('AUTH_PROVIDER') == 'internal' and environment.get('ALLOW_DEMO_SESSION') == 'false',
                'Managed private runtime defaults differ')
        database = urlsplit(environment.get('DATABASE_URL', ''))
        require(database.scheme in ('postgres', 'postgresql') and database.username == 'ai_hr_app'
                and database.hostname == '127.0.0.1' and database.port == 5433
                and database.path in ('/ai_hr_dev', '/ai_hr_test') and not database.query and not database.fragment,
                'Owned hosted app-role database required')
        secure_path(pathlib.Path(environment['HOME']), uid, directory=True)
        require(not any((pathlib.Path(environment['HOME']) / name).exists()
                        or (pathlib.Path(environment['HOME']) / name).is_symlink()
                        for name in ('.node_modules', '.node_libraries')), 'Global application module search path is present')
        self.manifest_file = path(package['manifestPath'], require)
        self.format2_file = path(package['format2ManifestPath'], require)
        self.manifest = protected_json(self.manifest_file, package['manifestSha256'], secure_path, require, uid)
        self.format2 = protected_json(self.format2_file, package['format2ManifestSha256'], secure_path,
                                     require, uid, 16 * 1024 * 1024)
        closed(self.manifest, {'version', 'source', 'build', 'runtime', 'node', 'systemFiles',
                              'producerSourcePath', 'entries'}, require)
        require(type(self.manifest['version']) is int and self.manifest['version'] == 1
                and self.manifest['source'] == value['source'] and self.manifest['build'] == value['build']
                and self.manifest['runtime'] == RUNTIME, 'Managed Next package identity differs')
        self.producer_source = str(path(self.manifest['producerSourcePath'], require))
        closed(self.manifest['node'], {'path', 'sha256'}, require)
        self.node = path(self.manifest['node']['path'], require)
        require(isinstance(self.manifest['node']['sha256'], str)
                and SHA.fullmatch(self.manifest['node']['sha256']) is not None, 'Managed Node digest required')
        self.system_files = self._system_files(self.manifest['systemFiles'])
        self.rows = self._rows(self.manifest['entries'])
        require(all(row['path'] not in CACHE_TARGETS for row in self.manifest['entries']),
                'Cache content cannot be immutable package authority')
        self._format2_contract(package)
        self._resource_contract()
        self._cache_contract()
        require(all(spec['executable'] == str(self.node) for spec in value['units'].values()),
                'Managed worker executable differs')
        self.release_roots = {spec['releaseDirectory'] for spec in value['units'].values()}
        require(len(self.release_roots) == 1, 'Managed workers must share one immutable package')
        require(self.producer_source not in self.release_roots, 'Managed package producer path is not distinct')

    def _rows(self, rows):
        require = self.require
        require(isinstance(rows, list) and 0 < len(rows) <= MAX_ENTRIES, 'Managed package entry count invalid')
        result = {}
        size = 0
        for row in rows:
            require(isinstance(row, dict), 'Managed package entry required')
            kind = row.get('kind')
            keys = {'path', 'kind', 'mode'} | ({'size', 'sha256'} if kind == 'file' else {'target'} if kind == 'link' else set())
            closed(row, keys, require)
            name = relative(row['path'], require)
            require(kind in ('file', 'directory', 'link') and type(row['mode']) is int
                    and 0 <= row['mode'] <= 0o777
                    and (kind == 'link' and row['mode'] == 0o777 or kind != 'link' and not row['mode'] & 0o022),
                    'Unsafe managed package entry mode/type')
            require(name not in result and not self.inventory.private_path(name), 'Private or duplicate managed member')
            if kind == 'file':
                require(type(row['size']) is int and 0 <= row['size'] <= MAX_FILE
                        and isinstance(row['sha256'], str) and SHA.fullmatch(row['sha256']) is not None,
                        'Invalid managed file facts')
                size += row['size']
            elif kind == 'link':
                require(isinstance(row['target'], str) and 0 < len(row['target'].encode()) <= 4096
                        and not row['target'].startswith('/'), 'Managed dependency links must be relative')
            require(not any(name == cache or name.startswith(cache + '/') for cache in CACHE_TARGETS),
                    'Application cache in immutable inventory')
            result[name] = row
        require(size <= MAX_TOTAL and list(result) == sorted(result), 'Managed package inventory order/bytes differs')
        for name in result:
            require(all(result.get('/'.join(name.split('/')[:count]), {}).get('kind') == 'directory'
                        for count in range(1, len(name.split('/')))), 'Managed package parent missing')
        return result

    def _system_files(self, rows):
        self.require(isinstance(rows, list) and 0 < len(rows) <= 256, 'Native runtime closure required')
        result = {}
        for row in rows:
            closed(row, {'path', 'sha256'}, self.require)
            file = path(row['path'], self.require)
            self.require(str(file).startswith('/usr/lib/') and isinstance(row['sha256'], str)
                         and SHA.fullmatch(row['sha256']) is not None and str(file) not in result,
                         'Unsupported native system runtime member')
            result[str(file)] = row['sha256']
        self.require(list(result) == sorted(result), 'Native runtime closure order differs')
        return result

    def _format2_contract(self, package):
        require, compiled = self.require, self.format2
        closed(compiled, {'format', 'capacityProfile', 'kind', 'platform', 'nextBuildId', 'files', 'directories',
                          'aliases', 'unpackedBytes', 'archiveBytes', 'archiveSha256'}, require)
        require(type(compiled['format']) is int and compiled['format'] == 2
                and compiled['kind'] == 'next-build-byte-bundle' and compiled['platform'] == 'linux'
                and compiled['nextBuildId'] == self.value['build']
                and compiled['archiveSha256'] == package['format2ArchiveSha256']
                and isinstance(package['format2ArchiveSha256'], str)
                and SHA.fullmatch(package['format2ArchiveSha256']) is not None
                and compiled['capacityProfile'] == {'profileVersion': 4, 'archiveMaxBytes': 285212672, 'zipMaxBytes': 293601280},
                'Existing format2 build identity differs')
        require(isinstance(compiled['files'], list) and 0 < len(compiled['files']) <= MAX_ENTRIES
                and isinstance(compiled['directories'], list) and isinstance(compiled['aliases'], list),
                'Existing format2 inventory missing')
        require([row.get('path') for row in compiled['files'] if isinstance(row, dict)]
                == sorted({row.get('path') for row in compiled['files'] if isinstance(row, dict)})
                and all(isinstance(row, dict) for row in compiled['files']), 'Duplicate or unordered compiled files')
        for row in compiled['files']:
            closed(row, {'path', 'size', 'sha256', 'mode'}, require)
            name = '.next/' + relative(row['path'], require)
            require(self.rows.get(name) == {'path': name, 'kind': 'file', 'size': row['size'],
                        'sha256': row['sha256'], 'mode': row['mode']}, 'Compiled bytes differ from exact format2 member')
        require(compiled['directories'] == sorted(set(compiled['directories'])), 'Existing format2 directory inventory differs')
        for item in compiled['directories']:
            name = '.next/' + relative(item, require)
            require(self.rows.get(name, {}).get('kind') == 'directory', 'Compiled directory missing')
        require(all(isinstance(row, dict) for row in compiled['aliases'])
                and len(compiled['aliases']) == 2 and {row.get('package') for row in compiled['aliases']} == {'sharp', 'fontkit'},
                'Exact compiled external aliases required')
        expected = {'.next/' + row['path'] for row in compiled['files']} | {'.next/' + row for row in compiled['directories']}
        for alias in compiled['aliases']:
            closed(alias, {'path', 'package', 'version', 'packageJsonSha256', 'packageTreeSha256'}, require)
            name = '.next/' + relative(alias['path'], require)
            require(re.fullmatch(r'node_modules/' + re.escape(alias['package']) + r'-[a-f0-9]{8,64}', alias['path']) is not None
                    and self.inventory.BUILD_ALIAS.fullmatch(name) is not None and self.rows.get(name, {}).get('kind') == 'link',
                    'Unapproved compiled alias')
            expected.add(name)
        # The envelope may create only these cache parents after exact cold format2 verification.
        extras = {name for name in self.rows if name.startswith('.next/')} - expected
        require(extras <= {'.next/cache'}, 'Unknown compiled envelope member')
        require(sum(row['size'] for row in compiled['files']) == compiled['unpackedBytes']
                and type(compiled['archiveBytes']) is int and 0 < compiled['archiveBytes'] <= 285212672,
                'Existing format2 byte bounds differ')

    def _resource_contract(self):
        value, require = self.value['resourceEnvelope'], self.require
        closed(value, {'version', 'kind', 'workers', 'suite', 'cpuOversubscriptionDiagnostic', 'slice', 'cgroupPath',
                       'cpuQuotaPercent', 'memoryHighBytes', 'memoryMaxBytes', 'memorySwapMaxBytes',
                       'totalHeapMiB', 'totalWebConnections', 'totalWaitingBudget', 'tasksMax'}, require)
        workers = len(self.value['units'])
        require(set(self.value['units']) == {'aihr-web@' + str(index) + '.service' for index in range(1, workers + 1)},
                'Managed worker slots must be exact and contiguous')
        require(value['version'] == 1 and type(value['version']) is int and value['kind'] == 'HOSTED_NEXT_SAME_BUILD_V1'
                and workers in (2, 4, 8) and value['workers'] == workers and type(value['workers']) is int
                and value['suite'] in ('workflow-preflight', 'steady-500')
                and type(value['cpuOversubscriptionDiagnostic']) is bool
                and (workers <= 4 and not value['cpuOversubscriptionDiagnostic']
                     or workers == 8 and value['suite'] == 'workflow-preflight' and value['cpuOversubscriptionDiagnostic']),
                'Unsupported managed worker comparison')
        require(value['slice'] == 'aihr-native-next.slice' and value['cgroupPath'] == '/aihr.slice/aihr-native.slice/aihr-native-next.slice'
                and value['cpuQuotaPercent'] == 400 and value['memoryHighBytes'] == 7168 * 1024**2
                and value['memoryMaxBytes'] == 8192 * 1024**2 and value['memorySwapMaxBytes'] == 0
                and value['totalHeapMiB'] == 4096 and value['totalWebConnections'] == 16
                and value['totalWaitingBudget'] == 2048 and value['tasksMax'] == 1024,
                'Managed aggregate resource envelope differs')
        require(hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                == self.value['resourceEnvelopeDigest'], 'Managed resource envelope digest differs')

    def _cache_contract(self):
        require, mounts = self.require, self.value['unitCacheMounts']
        require(isinstance(mounts, dict) and set(mounts) == set(self.value['units']), 'Exact per-unit cache inventory required')
        sources = set()
        for unit, rows in mounts.items():
            require(isinstance(rows, list) and len(rows) == 3, 'Exactly three Next cache mounts required')
            require([row.get('target') for row in rows if isinstance(row, dict)] == list(CACHE_TARGETS),
                    'Unexpected Next cache purpose')
            for row in rows:
                closed(row, {'target', 'source'}, require)
                source = path(row['source'], require)
                slot = unit.removeprefix('aihr-web@').removesuffix('.service')
                expected = '/var/cache/aihr/' + self.value['runtimePackage']['manifestSha256'] + '/' + slot + '/' + row['target'].split('/')[-1]
                require(str(source) == expected, 'Cache source is outside its exact cohort/slot/purpose')
                require(str(source).startswith('/var/cache/aihr/') and str(source) not in sources,
                        'Cache source must be a distinct protected declaration')
                require(not any(source == parent or source in parent.parents or parent in source.parents
                                for parent in map(pathlib.Path, sources)), 'Overlapping Next cache sources')
                sources.add(str(source))

    def metadata_current(self):
        self.require(stat.S_IMODE(self.private_environment_file.lstat().st_mode) == 0o600,
                     'Private runtime environment mode changed')
        for file, key in ((self.manifest_file, 'manifestSha256'), (self.format2_file, 'format2ManifestSha256'),
                          (self.private_environment_file, 'privateEnvironmentSha256')):
            self.require(hashlib.sha256(protected_bytes(file, self.secure_path, self.require, self.uid,
                         MAX_MANIFEST)).hexdigest() == self.value['runtimePackage'][key], 'Managed package metadata changed')

    def verify_release(self, spec):
        """Full read once per controller operation, then descriptor identity rechecks.

        No persistent cached PASS exists. Root-owned code cannot be changed by the
        app; any observed inode/mode/byte metadata change refuses this operation.
        """
        root, require = pathlib.Path(spec['releaseDirectory']), self.require
        self.metadata_current()
        if str(root) in self.verified:
            self.package_trees[str(root)].assert_unchanged()
            return self.verified[str(root)]
        self.secure_path(root, self.uid, directory=True)
        tree = self.inventory.PinnedTree(root, require)
        self.package_trees[str(root)] = tree
        try:
            observed = {}
            def walk(base=''):
                with tree.directory(base) as directory:
                    names = sorted(os.listdir(directory))
                    require(len(names) <= MAX_ENTRIES, 'Managed package directory exceeds bound')
                    for name in names:
                        key = (base + '/' if base else '') + name
                        relative(key, require)
                        before = os.stat(name, dir_fd=directory, follow_symlinks=False)
                        if key in CACHE_TARGETS:
                            require(stat.S_ISDIR(before.st_mode) and before.st_uid == self.uid
                                    and not stat.S_IMODE(before.st_mode) & 0o022,
                                    'Unsafe immutable cache mountpoint')
                            with tree.directory(key) as cache:
                                require(not os.listdir(cache), 'Cold immutable cache mountpoint is not empty')
                            continue
                        require(key in self.rows and len(observed) < MAX_ENTRIES, 'Unknown managed package member')
                        wanted = self.rows[key]
                        require(before.st_uid == self.uid and stat.S_IMODE(before.st_mode) == wanted['mode'],
                                'Managed package ownership or mode differs')
                        observed[key] = before
                        if wanted['kind'] == 'directory':
                            require(stat.S_ISDIR(before.st_mode), 'Managed package directory changed type')
                            walk(key)
                        elif wanted['kind'] == 'link':
                            require(stat.S_ISLNK(before.st_mode) and tree.readlink(key) == wanted['target'],
                                    'Managed package link differs')
                            if key.startswith('node_modules/'):
                                with self.inventory.PinnedTree(root / 'node_modules', require) as dependencies:
                                    dependencies.resolve(key[len('node_modules/'):], allow_absolute=False)
                            else:
                                alias = next((row for row in self.format2['aliases'] if '.next/' + row['path'] == key), None)
                                require(alias is not None, 'Unknown compiled dependency alias')
                                actual, target = self.inventory.package_identity(root, alias['package'], self.producer_source, check=require)
                                require(actual == {field: alias[field] for field in actual}
                                        and self.inventory.build_alias_target(root, key, wanted['target'], check=require) == target,
                                        'Compiled dependency alias target differs')
                        else:
                            require(before.st_nlink == 1, 'Managed package file has external hard links')
                            with tree.open_regular(key, MAX_FILE, expected=self.inventory.identity(before)) as (stream, _):
                                h = hashlib.sha256()
                                for block in iter(lambda: stream.read(1024 * 1024), b''):
                                    h.update(block)
                                require(before.st_size == wanted['size'] and h.hexdigest() == wanted['sha256'],
                                        'Managed package bytes differ')
            walk()
            for cache in CACHE_TARGETS:
                point = tree.metadata(cache)
                require(stat.S_ISDIR(point.st_mode) and point.st_uid == self.uid
                        and not stat.S_IMODE(point.st_mode) & 0o022, 'Missing or unsafe cache mountpoint')
            require(set(observed) == set(self.rows), 'Incomplete managed package inventory')
            require(tree.read_bytes('.next/BUILD_ID', 1024).decode().strip() == self.value['build'],
                    'Managed package build differs')
            prerender = json.loads(tree.read_bytes('.next/prerender-manifest.json', 1024 * 1024))
            require(isinstance(prerender, dict) and set(prerender.get('routes', {})) <= {'/_not-found', '/_global-error', '/404', '/500'}
                    and prerender.get('dynamicRoutes') == {}, 'Managed package contains application prerender data')
            for alias in self.format2['aliases']:
                actual, _target = self.inventory.package_identity(root, alias['package'], self.producer_source, check=require)
                require(actual == {key: alias[key] for key in actual}, 'Compiled external dependency identity differs')
            with self.inventory.PinnedTree(root / 'node_modules', require) as dependencies:
                next_json = dependencies.resolve('next/package.json', allow_absolute=False)
                actual_next = json.loads(dependencies.read_bytes(next_json, 256 * 1024))
                require(actual_next.get('name') == 'next' and actual_next.get('version') == RUNTIME['next'],
                        'Managed Next dependency differs')
            require(digest_file(self.node, self.secure_path, require, self.uid) == self.manifest['node']['sha256'],
                    'Managed Node executable differs')
            for file, wanted in self.system_files.items():
                require(digest_file(pathlib.Path(file), self.secure_path, require, self.uid) == wanted,
                        'Managed system runtime differs')
            tree.assert_unchanged()
            result = {'entries': len(observed), 'root': (root.stat().st_dev, root.stat().st_ino),
                      'systemFiles': len(self.system_files), 'actionManifestSha256': self.rows.get('.next/server/server-reference-manifest.json', {}).get('sha256')}
            require(result['actionManifestSha256'] is not None, 'Immutable action manifest required')
            self.verified[str(root)] = result
            return result
        except BaseException:
            tree.close()
            self.package_trees.pop(str(root), None)
            raise

    def close(self):
        for tree in self.package_trees.values():
            tree.close()
        self.package_trees.clear()

    def cache_sources(self, unit):
        require = self.require
        result = {}
        for row in self.value['unitCacheMounts'][unit]:
            source = pathlib.Path(row['source'])
            self.secure_path(source.parent, self.uid, directory=True)
            before = source.lstat()
            require(stat.S_ISDIR(before.st_mode) and before.st_uid == self.value['units'][unit]['workerUid']
                    and stat.S_IMODE(before.st_mode) == 0o700, 'Unsafe managed Next cache source')
            fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                require(file_identity(os.fstat(fd)) == file_identity(before)
                        and file_identity(source.lstat()) == file_identity(before), 'Next cache source changed')
                result[row['target']] = (source, before)
            finally:
                os.close(fd)
        return result

    def unit_configuration(self, unit, properties, typed):
        """Protected native declarations; worker() separately checks kernel outcomes."""
        require, spec = self.require, self.value['units'][unit]
        envelope = self.value['resourceEnvelope']
        require(all(key in properties for key in EXTRA_PROPERTIES), 'Managed unit properties incomplete')
        require(properties['ProtectSystem'] == 'strict' and properties['PrivateMounts'] == 'yes'
                and properties.get('DynamicUser') == 'no'
                and properties['NoNewPrivileges'] == 'yes' and properties['Slice'] == envelope['slice']
                and properties['CPUQuotaPerSecUSec'] == 'infinity'
                and properties['MemoryHigh'] == 'infinity' and properties['MemoryMax'] == 'infinity'
                and properties['ReadWritePaths'] == '' and properties['ReadOnlyPaths'] == '',
                'Managed worker sandbox/resource declarations differ')
        root = spec['releaseDirectory']
        closed(typed, {'BindPaths', 'BindReadOnlyPaths', 'RestrictNamespaces', 'CapabilityBoundingSet'}, require)
        for name in ('RestrictNamespaces', 'CapabilityBoundingSet'):
            item = typed[name]
            require(isinstance(item, dict) and set(item) == {'type', 'data'} and item['type'] == 't'
                    and isinstance(item['data'], list) and len(item['data']) == 1
                    and type(item['data'][0]) is int and item['data'][0] == 0,
                    'Typed worker privilege/namespace restriction differs')
        for name, expected in (
                ('BindReadOnlyPaths', [[root, root, False, 0]]),
                ('BindPaths', [[row['source'], root + '/' + row['target'], False, 0]
                               for row in self.value['unitCacheMounts'][unit]])):
            item = typed[name]
            require(isinstance(item, dict) and set(item) == {'type', 'data'} and item['type'] == 'a(ssbt)'
                    and isinstance(item['data'], list) and all(isinstance(row, list) and len(row) == 4
                        and type(row[2]) is bool and type(row[3]) is int for row in item['data'])
                    and item['data'] == expected, 'Exact typed nonrecursive cache/release binds required')
        raw = properties.get('ExecStart', '')
        match = re.fullmatch(r'\{ path=([^;\n]+) ; argv\[\]=([^;\n]+) ; ignore_errors=no ; .* \}', raw)
        require(match is not None, 'Unsupported managed Next command representation')
        try:
            argv = shlex.split(match[2].strip())
        except ValueError:
            require(False, 'Invalid managed Next argv')
        heap = envelope['totalHeapMiB'] // envelope['workers']
        require(match[1].strip() == str(self.node) and argv == [str(self.node),
            '--max-old-space-size=' + str(heap), root + '/node_modules/next/dist/bin/next',
            'start', '--hostname', '127.0.0.1'], 'Only the exact stock Next command is supported')
        self.cache_sources(unit)

    def worker(self, unit, properties, typed, identity, port, alive):
        """Prove actual kernel namespace, read-only bytes, runtime and pool inputs.

        Only the already-fenced native PID can select /proc. The sole magic-link
        traversal is its kernel root/namespace descriptor, never a supplied path.
        """
        require, spec = self.require, self.value['units'][unit]
        self.unit_configuration(unit, properties, typed)
        package = self.verify_release(spec)
        require(alive(identity), 'Managed Next worker changed before inspection')
        proc = pathlib.Path('/proc', str(identity['pid']))
        require(proc.stat().st_uid == spec['workerUid'], 'Managed Next worker owner differs')
        with contextlib.ExitStack() as stack:
            proc_fd = os.open(proc, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            stack.callback(os.close, proc_fd)
            ns_fd = os.open('ns/mnt', os.O_RDONLY, dir_fd=proc_fd)
            stack.callback(os.close, ns_fd)
            namespace = os.fstat(ns_fd)
            require(namespace.st_ino != os.stat('/proc/self/ns/mnt').st_ino,
                    'Worker does not have a distinct mount namespace')
            root_fd = os.open('root', os.O_RDONLY | os.O_DIRECTORY, dir_fd=proc_fd)
            stack.callback(os.close, root_fd)
            release_fd = open_beneath(root_fd, spec['releaseDirectory'], require)
            stack.callback(os.close, release_fd)
            release_info = os.fstat(release_fd)
            release_observed = {'device': release_info.st_dev, 'inode': release_info.st_ino,
                                'readOnly': bool(os.fstatvfs(release_fd).f_flag & os.ST_RDONLY)}
            mounts = parse_mountinfo(read_proc(proc_fd, 'mountinfo', 4 * 1024 * 1024, require), require)
            cache_sources = self.cache_sources(unit)
            cache_observed = {}
            for target, (source, before) in cache_sources.items():
                absolute = spec['releaseDirectory'] + '/' + target
                cache_fd = open_beneath(release_fd, target, require)
                stack.callback(os.close, cache_fd)
                info = os.fstat(cache_fd)
                require(file_identity(source.lstat()) == file_identity(before), 'Next cache source changed during namespace proof')
                cache_observed[target] = {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid,
                                          'mode': stat.S_IMODE(info.st_mode),
                                          'readOnly': bool(os.fstatvfs(cache_fd).f_flag & os.ST_RDONLY)}
            mount_proof = validate_namespace(mounts, spec['releaseDirectory'], package['root'], release_observed,
                cache_sources, cache_observed, spec['workerUid'], require)
            require(read_proc(proc_fd, 'cgroup', 65536, require).decode().strip()
                    == '0::' + properties['ControlGroup'], 'Actual worker cgroup differs')
            status = read_proc(proc_fd, 'status', 65536, require).decode()
            fields = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
            require(fields.get('NoNewPrivs', '').strip() == '1' and fields.get('Seccomp', '').strip() == '2'
                    and fields.get('CapEff', '').strip() == '0000000000000000'
                    and fields.get('CapBnd', '').strip() == '0000000000000000',
                    'Actual worker privilege/namespace boundary differs')
            environ = read_proc(proc_fd, 'environ', 1024 * 1024, require)
            self._environment(environ, port)
            self._executable_maps(read_proc(proc_fd, 'maps', 4 * 1024 * 1024, require), spec)
            require(os.fstat(ns_fd).st_ino == namespace.st_ino
                    and os.stat('ns/mnt', dir_fd=proc_fd).st_ino == namespace.st_ino
                    and alive(identity), 'Managed Next worker namespace/process changed')
            self.package_trees[spec['releaseDirectory']].assert_unchanged()
            self.metadata_current()
            return {'namespaceInode': namespace.st_ino, **mount_proof,
                    'actualKernelMountsVerified': True, 'actualEnvironmentVerified': True}

    def _environment(self, raw, port):
        require = self.require
        require(raw.endswith(b'\0'), 'Actual worker environment incomplete')
        values = {}
        try:
            for entry in raw[:-1].split(b'\0'):
                key, value = entry.decode().split('=', 1)
                require(key not in values, 'Duplicate actual worker environment key')
                values[key] = value
        except (ValueError, UnicodeError):
            require(False, 'Invalid actual worker environment')
        require(not any(forbidden_environment(key) for key in values), 'Unsafe actual worker environment override')
        require(all(values.get(key) == value for key, value in self.private_environment['values'].items()),
                'Actual private runtime configuration differs')
        count = self.value['resourceEnvelope']['workers']
        require(values.get('NODE_ENV') == 'production' and values.get('PORT') == str(port)
                and values.get('AIHR_APP_WORKERS') == str(count)
                and values.get('AIHR_DB_TOTAL_CONNECTIONS') == '16'
                and values.get('AIHR_DB_POOL_MAX') == str(16 // count),
                'Actual worker PORT/pool/cohort environment differs')
        # No values, connection strings, cookies or hashes of credentials escape this method.

    def _executable_maps(self, raw, spec):
        require = self.require
        try:
            lines = raw.decode().splitlines()
        except UnicodeError:
            require(False, 'Invalid native executable mapping inventory')
        require(len(lines) <= 32768, 'Native executable mapping inventory exceeds bound')
        observed = set()
        for line in lines:
            fields = line.split(maxsplit=5)
            require(len(fields) in (5, 6), 'Invalid native executable mapping')
            if 'x' not in fields[1] or len(fields) == 5 or fields[5] in ('[vdso]', '[vsyscall]'):
                continue  # V8 anonymous JIT and fixed kernel mappings are not disk module authority.
            file = fields[5]
            require(not file.endswith(' (deleted)'), 'Deleted executable runtime mapping')
            if file == str(self.node):
                wanted = self.manifest['node']['sha256']
            elif file in self.system_files:
                wanted = self.system_files[file]
            elif file.startswith(spec['releaseDirectory'] + '/'):
                row = self.rows.get(file[len(spec['releaseDirectory']) + 1:])
                require(row is not None and row['kind'] == 'file', 'Uninventoried package executable mapping')
                wanted = row['sha256']
            else:
                require(False, 'Unknown native executable mapping')
            info = pathlib.Path(file).stat()
            device = fields[3].split(':')
            require(len(device) == 2 and os.major(info.st_dev) == int(device[0], 16)
                    and os.minor(info.st_dev) == int(device[1], 16) and info.st_ino == int(fields[4]),
                    'Native executable mapping inode differs')
            require(digest_file(pathlib.Path(file), self.secure_path, require, self.uid) == wanted,
                    'Native executable mapping bytes differ')
            observed.add(file)
        require(str(self.node) in observed, 'Actual Node executable mapping missing')

    def resource_state(self, unit, properties):
        """Actual cgroup configuration and ancestry, not a profile digest as proof."""
        require, envelope = self.require, self.value['resourceEnvelope']
        group = envelope['cgroupPath']
        require(properties.get('ControlGroup') == group + '/' + unit, 'Worker is outside its accepted aggregate slice')
        own_proc = os.open('/proc/' + str(os.getpid()), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            host_mounts = parse_mountinfo(read_proc(own_proc, 'mountinfo', 4 * 1024 * 1024, require), require)
        finally:
            os.close(own_proc)
        require(any(row['target'] == '/sys/fs/cgroup' and row['fsType'] == 'cgroup2' for row in host_mounts),
                'Actual unified kernel cgroup mount required')
        directory = pathlib.Path('/sys/fs/cgroup' + group)
        self.secure_path(directory, 0, directory=True)
        wanted = {'memory.high': str(envelope['memoryHighBytes']), 'memory.max': str(envelope['memoryMaxBytes']),
                  'memory.swap.max': '0', 'pids.max': str(envelope['tasksMax']), 'cgroup.type': 'domain'}
        for name, value in wanted.items():
            require(kernel_text(directory / name, self.secure_path, require) == value, 'Actual aggregate resource cap differs')
        cpu = kernel_text(directory / 'cpu.max', self.secure_path, require).split()
        require(len(cpu) == 2 and all(item.isdigit() for item in cpu) and int(cpu[1]) > 0
                and int(cpu[0]) == 4 * int(cpu[1]), 'Actual aggregate CPU quota differs')
        events = key_values(kernel_text(directory / 'memory.events', self.secure_path, require), require)
        require(events.get('oom') == 0 and events.get('oom_kill') == 0 and events.get('high') == 0
                and events.get('max') == 0, 'Aggregate memory failure observed')
        require(kernel_text(directory / 'cgroup.procs', self.secure_path, require) == '',
                'Unexpected process directly inside aggregate slice')
        expected_children = set(self.value['units'])
        with self.inventory.PinnedTree(directory, require) as tree:
            with tree.directory() as fd:
                for entry in os.listdir(fd):
                    info = os.stat(entry, dir_fd=fd, follow_symlinks=False)
                    require(not stat.S_ISDIR(info.st_mode) or entry in expected_children,
                            'Unknown child service in aggregate slice')
        ancestors = []
        worker_directory = directory / unit
        self.secure_path(worker_directory, 0, directory=True)
        for parent in [worker_directory, *worker_directory.parents]:
            if not str(parent).startswith('/sys/fs/cgroup'):
                break
            self.secure_path(parent, 0, directory=True)
            def root_limit(name, unlimited):
                try:
                    (parent / name).lstat()
                except FileNotFoundError:
                    require(parent == pathlib.Path('/sys/fs/cgroup'), 'Missing nonroot ancestor resource cap')
                    return unlimited
                return kernel_text(parent / name, self.secure_path, require)
            memory = root_limit('memory.max', 'max')
            quota = root_limit('cpu.max', 'max 100000').split()
            require(memory == 'max' or memory.isdigit() and int(memory) >= envelope['memoryMaxBytes'],
                    'Ancestor memory cap is below accepted app envelope')
            require(len(quota) == 2 and quota[1].isdigit() and int(quota[1]) > 0
                    and (quota[0] == 'max' or quota[0].isdigit() and int(quota[0]) >= 4 * int(quota[1])),
                    'Ancestor CPU cap is below accepted app envelope')
            ancestors.append({'path': str(parent), 'memoryMax': memory, 'cpuMax': quota})
        cpus = len(os.sched_getaffinity(0))
        require(cpus == 4, 'Hosted native resource profile requires actual four-CPU affinity')
        require(len(os.sched_getaffinity(int(properties.get('MainPID', '0')))) == 4,
                'Worker effective affinity differs from accepted envelope')
        # The current component profile is a standard-hosted comparison only.
        meminfo = kernel_text(pathlib.Path('/proc/meminfo'), self.secure_path, require)
        match = re.search(r'^MemTotal:\s+([0-9]+) kB$', meminfo, re.M)
        require(match is not None and 15 * 1024**3 <= int(match[1]) * 1024 <= 17 * 1024**3,
                'Hosted native resource profile requires actual standard memory')
        memory = {}
        for name in ('memory.current', 'memory.peak'):
            value = kernel_text(directory / name, self.secure_path, require)
            require(value.isdigit() and int(value) <= envelope['memoryHighBytes'], 'Aggregate memory headroom exceeded')
            memory[name] = int(value)
        return {'aggregateCapsVerified': True, 'ancestors': ancestors, 'actualAffinityCpus': cpus,
                'memory': memory, 'memoryEvents': events,
                'cpuStat': key_values(kernel_text(directory / 'cpu.stat', self.secure_path, require), require),
                'cpuOversubscriptionDiagnostic': envelope['cpuOversubscriptionDiagnostic'],
                'productionEquivalent': False}


def validate_namespace(mounts, release, package_root, observed_root, sources, observed_caches, worker_uid, require):
    """Deterministic oracle only; calling it with a model is not native proof."""
    require(observed_root == {'device': package_root[0], 'inode': package_root[1], 'readOnly': True},
            'Worker release is not the identical read-only package')
    release_mounts = [row for row in mounts if row['target'] == release]
    require(len(release_mounts) == 1 and 'ro' in release_mounts[0]['options'], 'Actual read-only release mount required')
    expected = {release + '/' + target for target in CACHE_TARGETS}
    descendants = {row['target'] for row in mounts if row['target'].startswith(release + '/')}
    require(descendants == expected and set(sources) == set(observed_caches) == set(CACHE_TARGETS),
            'Unknown or missing worker package mount')
    proofs = []
    for target, (_source, before) in sources.items():
        rows = [row for row in mounts if row['target'] == release + '/' + target]
        require(len(rows) == 1 and 'rw' in rows[0]['options'], 'Actual writable cache mount required')
        observed = observed_caches[target]
        require(observed == {'device': before.st_dev, 'inode': before.st_ino, 'uid': worker_uid,
                            'mode': 0o700, 'readOnly': False}, 'Worker cache is not its declared writable inode')
        proofs.append({'target': target, 'device': before.st_dev, 'inode': before.st_ino})
    return {'releaseDevice': package_root[0], 'releaseInode': package_root[1], 'cacheMounts': proofs}


def forbidden_environment(key):
    return re.fullmatch(r'(?:LD_.*|DYLD_.*|PYTHON.*|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|NEXT_SERVER_ACTIONS_ENCRYPTION_KEY|NEXT_DEPLOYMENT_ID|__NEXT_PRIVATE_STANDALONE_CONFIG|MIGRATION_DATABASE_URL|TEST_MIGRATION_DATABASE_URL|DEV_TENANT_ID|DEV_USER_ID)', key) is not None


def open_beneath(directory: int, name: str, require) -> int:
    """No user symlinks; an absolute name is anchored to the already-open kernel root."""
    parts = name.lstrip('/').split('/')
    require(parts and len(parts) <= 128 and all(part not in ('', '.', '..') for part in parts),
            'Unsafe worker namespace member')
    current = os.dup(directory)
    try:
        for part in parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def read_proc(directory: int, name: str, limit: int, require) -> bytes:
    require(name in ('mountinfo', 'status', 'environ', 'maps', 'cgroup'), 'Unsupported native process inspection')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        data = bytearray()
        while True:
            block = os.read(fd, min(65536, limit + 1 - len(data)))
            if not block:
                break
            data.extend(block)
            require(len(data) <= limit, 'Native process inspection exceeds bound')
        return bytes(data)
    finally:
        os.close(fd)


def parse_mountinfo(raw: bytes, require) -> list[dict]:
    try:
        lines = raw.decode().splitlines()
        require(len(lines) <= 4096, 'Native mount inventory exceeds bound')
        result, ids = [], set()
        def unescape(value):
            converted = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), value)
            require('\\' not in converted and '\0' not in converted, 'Invalid native mount escaping')
            return converted
        for line in lines:
            left, right = line.split(' - ', 1)
            fields, end = left.split(), right.split()
            require(len(fields) >= 6 and len(end) >= 3 and fields[0].isdigit() and fields[1].isdigit()
                    and int(fields[0]) not in ids, 'Invalid native mount record')
            ids.add(int(fields[0]))
            target = unescape(fields[4])
            require(target.startswith('/') and str(pathlib.PurePosixPath(target)) == target
                    and '..' not in target.split('/'), 'Invalid native mount target')
            result.append({'id': int(fields[0]), 'target': target, 'options': set(fields[5].split(',')), 'fsType': end[0]})
        require(result, 'Native mount inventory missing')
        return result
    except (ValueError, UnicodeError, IndexError):
        require(False, 'Invalid native mount inventory')


def kernel_text(file, secure_path, require) -> str:
    secure_path(file, 0)
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0, 'Unsafe kernel resource file')
        raw = os.read(fd, 65537)
        require(len(raw) <= 65536, 'Kernel resource metadata exceeds bound')
        return raw.decode().strip()
    finally:
        os.close(fd)


def key_values(text, require):
    result = {}
    for line in text.splitlines():
        fields = line.split()
        require(len(fields) == 2 and fields[0] not in result and fields[1].isdigit(), 'Invalid native resource counters')
        result[fields[0]] = int(fields[1])
    return result
