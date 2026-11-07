"""SOURCE-ONLY synthetic package/policy/kernel-model refusals, never native proof.

The actual Next/systemd/mount/resource fixture is separately admitted and unrun.
These tests execute no app, Node server, database, sudo, mount or systemd command.
"""
import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import stat
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

C = load('next_profile_test_controller', pathlib.Path(__file__).with_name('controller.py'))
N = load('next_profile_source', pathlib.Path(__file__).with_name('next_profile.py'))
I = load('next_profile_shared_inventory', ROOT / '.github/ci/runtime_inventory.py')
sha = lambda raw: hashlib.sha256(raw).hexdigest()

class NextProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aihr-next-profile-source-')
        self.root = pathlib.Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.uid = os.getuid()
        self.original_secure = C.secure_path
        self.release = self.root / 'release'
        self.release.mkdir()
        self.helper = self.root / 'helper'
        self.helper.mkdir()
        for name, source in [('next_profile.py', pathlib.Path(N.__file__)),
                             ('runtime_inventory.py', ROOT / '.github/ci/runtime_inventory.py')]:
            shutil.copyfile(source, self.helper / name)
        self.node = self.root / 'runtime/node'
        self.put(self.node, b'\x7fELFSYNTHETIC-NOT-EXECUTED', 0o755)
        self.put(self.release / '.next/BUILD_ID', b'source-model-build\n')
        self.put(self.release / '.next/prerender-manifest.json', N.canonical({'routes': {}, 'dynamicRoutes': {}}))
        self.put(self.release / '.next/server/server-reference-manifest.json', N.canonical({'encryptionKey': 'synthetic-not-used'}))
        self.put(self.release / '.next/server/app/page.js', b'/* synthetic bytes: not a Next server */\n')
        self.put(self.release / '.aihr-admission-release.json', N.canonical({'source': 'a' * 40, 'build': 'source-model-build'}))
        self.put(self.release / 'package.json', N.canonical({'name': 'synthetic-source-fixture'}))
        next_package = self.release / 'node_modules/.pnpm/next@16.4.1/node_modules/next'
        self.put(next_package / 'package.json', N.canonical({'name': 'next', 'version': '16.4.1'}))
        self.put(next_package / 'dist/bin/next', b'/* synthetic CLI; never run */\n')
        (self.release / 'node_modules/next').symlink_to('.pnpm/next@16.4.1/node_modules/next')
        self.aliases = []
        for name, version in [('fontkit', '1.9.0'), ('sharp', '0.35.5')]:
            self.put(self.release / 'node_modules' / name / 'package.json', N.canonical({'name': name, 'version': version}))
            self.put(self.release / 'node_modules' / name / 'index.js', b'/* synthetic dependency */\n')
            identity, _ = I.package_identity(self.release, name, producer_source='/synthetic-producer')
            target = self.release / '.next/node_modules' / (name + '-abcdef01')
            target.parent.mkdir(exist_ok=True)
            target.symlink_to('../../node_modules/' + name)
            self.aliases.append({'path': 'node_modules/' + target.name, **identity})
        self.format2 = {'format': 2, 'kind': 'next-build-byte-bundle', 'platform': 'linux',
            'capacityProfile': {'profileVersion': 4, 'archiveMaxBytes': 285212672, 'zipMaxBytes': 293601280},
            'nextBuildId': 'source-model-build', 'files': [], 'directories': [], 'aliases': self.aliases,
            'unpackedBytes': 0, 'archiveBytes': 1, 'archiveSha256': 'e' * 64}
        for file in sorted((self.release / '.next').rglob('*')):
            if file.is_symlink():
                continue
            name = file.relative_to(self.release / '.next').as_posix()
            if file.is_dir():
                self.format2['directories'].append(name)
            else:
                data = file.read_bytes()
                self.format2['files'].append({'path': name, 'size': len(data), 'mode': 0o644, 'sha256': sha(data)})
                self.format2['unpackedBytes'] += len(data)
        self.format2['directories'].sort()
        self.format2['files'].sort(key=lambda row: row['path'])
        for cache in N.CACHE_TARGETS:
            (self.release / cache).mkdir(parents=True)
        self.manifest = {'version': 1, 'source': 'a' * 40, 'build': 'source-model-build', 'runtime': N.RUNTIME,
            'node': {'path': str(self.node), 'sha256': sha(self.node.read_bytes())},
            'systemFiles': [{'path': '/usr/lib/aihr-synthetic-native.so', 'sha256': sha(b'synthetic-native')}],
            'producerSourcePath': '/synthetic-producer', 'entries': []}
        self.gather()
        self.environment = {'version': 1, 'values': {'NODE_ENV': 'production', 'HOME': '/var/empty/aihr',
            'PATH': '/usr/bin:/bin', 'NEXT_TELEMETRY_DISABLED': '1', 'AUTH_PROVIDER': 'internal',
            'ALLOW_DEMO_SESSION': 'false', 'DATABASE_URL': 'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',
            'AUTH_SESSION_KEY': 'a' * 64, 'AUTH_PUBLIC_ORIGIN': 'https://localhost:3443', 'AUDIT_HASH_CHAIN_ENABLED': 'true'}}
        self.envelope = {'version': 1, 'kind': 'HOSTED_NEXT_SAME_BUILD_V1', 'workers': 2,
            'suite': 'workflow-preflight', 'cpuOversubscriptionDiagnostic': False, 'slice': 'aihr-native-next.slice',
            'cgroupPath': '/aihr.slice/aihr-native.slice/aihr-native-next.slice', 'cpuQuotaPercent': 400,
            'memoryHighBytes': 7168 * 1024**2, 'memoryMaxBytes': 8192 * 1024**2, 'memorySwapMaxBytes': 0,
            'totalHeapMiB': 4096, 'totalWebConnections': 16, 'totalWaitingBudget': 2048, 'tasksMax': 1024}
        for name in ('state', 'proxy', 'ports'):
            (self.root / name).mkdir()
        self.value = {'version': 2, 'epoch': '1' * 32, 'source': 'a' * 40, 'build': 'source-model-build',
            'resourceEnvelopeDigest': C.digest(self.envelope), 'resourceEnvelope': self.envelope,
            'controllerDigest': sha(pathlib.Path(C.__file__).read_bytes()),
            'trustedModules': {name: sha((self.helper / name).read_bytes()) for name in ('next_profile.py', 'runtime_inventory.py')},
            'runtimePackage': {}, 'unitCacheMounts': {}, 'stateDirectory': str(self.root / 'state'),
            'nginxBinary': '/usr/sbin/nginx', 'nginxConfig': str(self.root / 'proxy/nginx.conf'),
            'nginxPrefix': str(self.root / 'proxy'), 'nginxPid': str(self.root / 'proxy/nginx.pid'),
            'nginxUnit': 'nginx.service', 'managedInclude': str(self.root / 'proxy/ready.conf'),
            'controlPort': 3170, 'ports': list(range(3201, 3233)), 'units': {},
            'healthSeconds': 30, 'activationSeconds': 5, 'drainSeconds': 30, 'reloadGuardDigest': 'd' * 64}
        self.write_metadata()
        self.runtimes = []

    def tearDown(self):
        for runtime in self.runtimes:
            runtime.close()
        self.temp.cleanup()

    def put(self, file, data, mode=0o644):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        file.chmod(mode)

    def gather(self):
        rows = []
        for parent, dirs, files in os.walk(self.release, followlinks=False):
            for name in sorted(dirs + files):
                file = pathlib.Path(parent) / name
                relative = file.relative_to(self.release).as_posix()
                if relative in N.CACHE_TARGETS:
                    continue
                info = file.lstat()
                if stat.S_ISLNK(info.st_mode):
                    row = {'path': relative, 'kind': 'link', 'mode': 0o777, 'target': os.readlink(file)}
                elif file.is_dir():
                    row = {'path': relative, 'kind': 'directory', 'mode': stat.S_IMODE(info.st_mode)}
                else:
                    data = file.read_bytes()
                    row = {'path': relative, 'kind': 'file', 'mode': stat.S_IMODE(info.st_mode), 'size': len(data), 'sha256': sha(data)}
                rows.append(row)
        self.manifest['entries'] = sorted(rows, key=lambda row: row['path'])

    def write_metadata(self):
        for name, value in [('manifest.json', self.manifest), ('format2.json', self.format2), ('environment.json', self.environment)]:
            self.put(self.root / name, N.canonical(value), 0o600)
        self.value['runtimePackage'] = {'manifestPath': str(self.root / 'manifest.json'),
            'manifestSha256': sha(N.canonical(self.manifest)), 'format2ManifestPath': str(self.root / 'format2.json'),
            'format2ManifestSha256': sha(N.canonical(self.format2)), 'format2ArchiveSha256': 'e' * 64,
            'privateEnvironmentPath': str(self.root / 'environment.json'), 'privateEnvironmentSha256': sha(N.canonical(self.environment))}
        self.value['resourceEnvelopeDigest'] = C.digest(self.envelope)
        for number in range(1, self.envelope['workers'] + 1):
            unit = 'aihr-web@' + str(number) + '.service'
            argv = str(self.node) + ' --max-old-space-size=' + str(4096 // self.envelope['workers']) + ' ' + str(self.release) + '/node_modules/next/dist/bin/next start --hostname 127.0.0.1'
            command = '{ path=' + str(self.node) + ' ; argv[]=' + argv + ' ; ignore_errors=no ; pid=0 ; }'
            self.value['units'][unit] = {'environmentFile': str(self.root / 'ports' / (str(number) + '.env')),
                'releaseDirectory': str(self.release), 'workerUid': self.uid + 17,
                'commandDigest': C.command_identity(command), 'executable': str(self.node)}
            self.value['unitCacheMounts'][unit] = [{'target': target, 'source': '/var/cache/aihr/'
                + self.value['runtimePackage']['manifestSha256'] + '/' + str(number) + '/' + target.split('/')[-1]} for target in N.CACHE_TARGETS]
        self.put(self.root / 'profile.json', N.canonical(self.value), 0o600)

    def fixture_secure(self, file, uid, *, directory=False):
        if pathlib.Path(file) == pathlib.Path('/var/empty/aihr'):
            return  # Model declaration only; actual native fixture must prove this root-owned path.
        return self.original_secure(pathlib.Path(file), uid, directory=directory)

    def runtime(self):
        value = N.NextRuntime(self.value, self.helper, self.fixture_secure, C.require, self.uid)
        self.runtimes.append(value)
        return value

    def verified(self, runtime):
        original = N.digest_file
        def model_system(file, secure, require, uid, limit=N.MAX_FILE):
            if str(file) == '/usr/lib/aihr-synthetic-native.so':
                return sha(b'synthetic-native')  # Synthetic system closure only, never native evidence.
            return original(file, secure, require, uid, limit)
        with patch.object(N, 'digest_file', model_system):
            return runtime.verify_release(self.value['units']['aihr-web@1.service'])

    def test_exact_cold_format2_package_reuses_canonical_links_and_detects_later_byte_change(self):
        runtime = self.runtime()
        result = self.verified(runtime)
        self.assertGreater(result['entries'], 10)
        self.assertEqual(result['actionManifestSha256'], sha((self.release / '.next/server/server-reference-manifest.json').read_bytes()))
        self.assertNotIn('actualKernelMountsVerified', result)
        self.put(self.release / '.next/server/app/page.js', b'changed')
        with self.assertRaises(C.Refused):
            self.verified(runtime)

    def test_positive_constructor_keeps_profile_mapping_after_private_environment_validation(self):
        self.environment['values'].update({'AUTH_DEFAULT_ORGANIZATION': 'native-a', 'AI_CONFIG_SECRET': 'b' * 64})
        self.write_metadata()
        runtime = self.runtime()
        self.assertIs(runtime.value, self.value)
        self.assertEqual(runtime.manifest['source'], 'a' * 40)
        self.assertEqual(runtime.manifest['build'], 'source-model-build')
        self.assertEqual(set(runtime.value['units']), {'aihr-web@1.service', 'aihr-web@2.service'})
        self.assertEqual(runtime.private_environment['values']['AUTH_DEFAULT_ORGANIZATION'], 'native-a')
        self.assertEqual(len(runtime.system_files), 1)

    def test_unknown_member_writable_code_and_hardlink_are_not_cache_exceptions(self):
        for kind in ('unknown', 'writable', 'hardlink', 'cache-file'):
            with self.subTest(kind=kind):
                runtime = self.runtime()
                target = self.release / '.next/server/app/page.js'
                if kind == 'unknown':
                    target = self.release / 'unreviewed.js'
                    self.put(target, b'unknown')
                elif kind == 'writable':
                    target.chmod(0o666)
                elif kind == 'hardlink':
                    os.link(target, self.root / 'foreign-hardlink')
                else:
                    target = self.release / N.CACHE_TARGETS[0] / 'unexpected.js'
                    self.put(target, b'not a cold build member')
                try:
                    with self.assertRaises(C.Refused):
                        self.verified(runtime)
                finally:
                    if kind in ('unknown', 'cache-file'):
                        target.unlink()
                    elif kind == 'writable':
                        target.chmod(0o644)
                    else:
                        (self.root / 'foreign-hardlink').unlink()

    def test_escaping_cycle_and_wrong_external_alias_refuse_even_with_a_matching_link_manifest(self):
        for target in ('../../../../outside', 'next', '.pnpm/next@16.4.1/node_modules/next'):
            with self.subTest(target=target):
                link = self.release / '.next/node_modules/sharp-abcdef01'
                previous = os.readlink(link)
                link.unlink()
                link.symlink_to(target)
                self.gather()
                self.write_metadata()
                try:
                    with self.assertRaises((C.Refused, FileNotFoundError)):
                        self.verified(self.runtime())
                finally:
                    link.unlink()
                    link.symlink_to(previous)
                    self.gather()
                    self.write_metadata()
        next_link = self.release / 'node_modules/next'
        next_link.unlink()
        next_link.symlink_to('next')
        self.gather()
        self.write_metadata()
        with self.assertRaises(C.Refused):
            self.verified(self.runtime())

    def test_byte_metadata_build_action_and_environment_bindings_are_independent(self):
        runtime = self.runtime()
        self.verified(runtime)
        for file in (self.root / 'format2.json', self.root / 'environment.json'):
            original = file.read_bytes()
            file.write_bytes(original + b' ')
            try:
                with self.assertRaises(C.Refused):
                    runtime.metadata_current()
            finally:
                file.write_bytes(original)
        (self.root / 'environment.json').chmod(0o644)
        with self.assertRaises(C.Refused):
            runtime.metadata_current()

    def test_no_action_key_loader_owner_database_or_forged_fleet_value_can_be_private_authority(self):
        for key, value in [('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY', ''), ('NODE_OPTIONS', '--import bad.js'),
                           ('MIGRATION_DATABASE_URL', 'postgres://postgres@127.0.0.1/owned'), ('PORT', '3000'),
                           ('DEV_USER_ID', 'synthetic'), ('DATABASE_URL', 'postgres://postgres@127.0.0.1:5433/ai_hr_dev')]:
            with self.subTest(key=key):
                previous = self.environment['values'].get(key)
                self.environment['values'][key] = value
                self.write_metadata()
                try:
                    with self.assertRaises(C.Refused):
                        self.runtime()
                finally:
                    if previous is None:
                        self.environment['values'].pop(key)
                    else:
                        self.environment['values'][key] = previous
                    self.write_metadata()

    def test_resource_costs_do_not_multiply_and_eight_workers_cannot_claim_sustained_capacity(self):
        self.runtime()
        original = copy.deepcopy(self.envelope)
        for changes in ({'totalWebConnections': 32}, {'totalHeapMiB': 8192}, {'memoryMaxBytes': 16 * 1024**3},
                        {'workers': 8, 'suite': 'steady-500', 'cpuOversubscriptionDiagnostic': True},
                        {'workers': 8, 'cpuOversubscriptionDiagnostic': False}):
            self.envelope.clear()
            self.envelope.update(original | changes)
            self.value['units'] = {}
            self.value['unitCacheMounts'] = {}
            self.write_metadata()
            with self.assertRaises(C.Refused):
                self.runtime()
        self.envelope.clear()
        self.envelope.update(original | {'workers': 8, 'cpuOversubscriptionDiagnostic': True})
        self.value['units'] = {}
        self.value['unitCacheMounts'] = {}
        self.write_metadata()
        self.runtime()  # Declaration only; it says nothing about actual CPU/RSS or Next speed.

    def test_actual_environment_bytes_must_match_protected_identity_and_every_pool_and_port(self):
        runtime = self.runtime()
        values = self.environment['values'] | {'PORT': '3201', 'AIHR_APP_WORKERS': '2',
            'AIHR_DB_TOTAL_CONNECTIONS': '16', 'AIHR_DB_POOL_MAX': '8'}
        encode = lambda data: b''.join((key + '=' + value).encode() + b'\0' for key, value in data.items())
        runtime._environment(encode(values), 3201)
        for changes in ({'PORT': '3000'}, {'AIHR_DB_POOL_MAX': '16'}, {'AUTH_SESSION_KEY': 'wrong'},
                        {'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY': ''}, {'NODE_PATH': '/writable/modules'}):
            with self.assertRaises(C.Refused):
                runtime._environment(encode(values | changes), 3201)
        with self.assertRaises(C.Refused):
            runtime._environment(encode(values) + b'PORT=3201\0', 3201)
        for key in ('PLATFORM_DATABASE_URL', 'TEST_DATABASE_URL', 'GH_TOKEN', 'GITHUB_TOKEN',
                    'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL',
                    'ACTIONS_CACHE_URL', 'ACTIONS_RESULTS_URL', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
                    'PGPASSWORD', 'PGSERVICE', 'OWNER_DATABASE_URL', 'OTHER_DATABASE_URL',
                    'OPENAI_API_KEY', 'WORKOS_API_KEY', 'UNREVIEWED_APPLICATION_FIELD'):
            with self.subTest(key=key), self.assertRaises(C.Refused):
                runtime._environment(encode(values | {key: 'must-never-reach-app'}), 3201)
            self.environment['values'][key] = 'must-never-reach-app'
            self.write_metadata()
            with self.subTest(key=key), self.assertRaises(C.Refused):
                self.runtime()
            del self.environment['values'][key]
            self.write_metadata()
        runtime._environment(encode(values | {'INVOCATION_ID': '1' * 32, 'SYSTEMD_EXEC_PID': '424242',
            'USER': 'nobody', 'LOGNAME': 'nobody'}), 3201, invocation='1' * 32, pid=424242, user='nobody')
        for changes in ({'INVOCATION_ID': '2' * 32}, {'SYSTEMD_EXEC_PID': '424243'}, {'USER': 'root'}):
            with self.assertRaises(C.Refused):
                runtime._environment(encode(values | {'INVOCATION_ID': '1' * 32, 'SYSTEMD_EXEC_PID': '424242',
                    'USER': 'nobody'} | changes), 3201, invocation='1' * 32, pid=424242, user='nobody')
        runtime.environment_source('\n'.join(key + '=' + value for key, value in values.items()))
        for extra in ('ACTIONS_RUNTIME_TOKEN=token', 'SSH_AUTH_SOCK=/private/agent',
                      'PLATFORM_DATABASE_URL=owner', 'OPENAI_API_KEY=provider', 'UNKNOWN=value',
                      'PORT=3000', 'PORT=3201 PORT=3202', 'NODE_ENV=development'):
            with self.assertRaises(C.Refused):
                runtime.environment_source(extra)

    def test_controller_version_dispatch_verifies_exact_helper_bytes_and_preserves_v1_shape(self):
        with patch.object(C, 'NEXT_MODULE_DIRECTORY', self.helper), patch.object(C, 'secure_path', self.fixture_secure):
            profile = C.Profile(self.root / 'profile.json', self.uid)
            try:
                self.assertIsNotNone(profile.next_runtime)
            finally:
                profile.close()
            helper = self.helper / 'next_profile.py'
            helper.write_bytes(helper.read_bytes() + b'\n# unbound change\n')
            with self.assertRaises(C.Refused):
                C.Profile(self.root / 'profile.json', self.uid)
        legacy = copy.deepcopy(self.value)
        legacy['version'] = 1
        for key in ('runtimePackage', 'trustedModules', 'resourceEnvelope', 'unitCacheMounts'):
            legacy.pop(key)
        self.put(self.root / 'legacy.json', N.canonical(legacy), 0o600)
        profile = C.Profile(self.root / 'legacy.json', self.uid)
        self.assertIsNone(profile.next_runtime)
        profile.close()
        legacy['runtimePackage'] = self.value['runtimePackage']
        self.put(self.root / 'legacy.json', N.canonical(legacy), 0o600)
        with self.assertRaises(C.Refused):
            C.Profile(self.root / 'legacy.json', self.uid)

    def test_unit_policy_requires_exact_typed_nonrecursive_binds_and_privilege_restrictions(self):
        runtime, unit = self.runtime(), 'aihr-web@1.service'
        root = str(self.release)
        props = {key: '' for key in N.EXTRA_PROPERTIES}
        props.update({'ProtectSystem': 'strict', 'PrivateMounts': 'yes', 'NoNewPrivileges': 'yes', 'DynamicUser': 'no',
            'Slice': self.envelope['slice'], 'CPUQuotaPerSecUSec': 'infinity',
            'MemoryHigh': 'infinity', 'MemoryMax': 'infinity',
            'ExecStart': '{ path=' + str(self.node) + ' ; argv[]=' + str(self.node)
                + ' --max-old-space-size=2048 ' + root + '/node_modules/next/dist/bin/next start --hostname 127.0.0.1 ; ignore_errors=no ; pid=0 ; }'})
        typed = {'CapabilityBoundingSet': {'type': 't', 'data': [0]},
            'RestrictNamespaces': {'type': 't', 'data': [0]},
            'BindReadOnlyPaths': {'type': 'a(ssbt)', 'data': [[root, root, False, 0]]},
            'BindPaths': {'type': 'a(ssbt)', 'data': [[row['source'], root + '/' + row['target'], False, 0]
                for row in self.value['unitCacheMounts'][unit]]}}
        with patch.object(runtime, 'cache_sources', return_value={}):
            runtime.unit_configuration(unit, props, typed)  # Declaration validation only.
            for key, value in [('CapabilityBoundingSet', {'type': 't', 'data': [False]}),
                               ('RestrictNamespaces', {'type': 't', 'data': [1]}),
                               ('BindPaths', {'type': 'a(ssbt)', 'data': []}),
                               ('BindReadOnlyPaths', {'type': 'a(ssbt)', 'data': [[root, root, False, 4096]]})]:
                with self.assertRaises(C.Refused):
                    runtime.unit_configuration(unit, props, typed | {key: value})
            for changes in ({'ProtectSystem': 'no'}, {'ReadWritePaths': root}, {'DynamicUser': 'yes'},
                            {'ExecStart': props['ExecStart'].replace('--hostname 127.0.0.1', '-p 3000')},
                            {'NoNewPrivileges': 'no'}):
                with self.assertRaises(C.Refused):
                    runtime.unit_configuration(unit, props | changes, typed)

    def test_nonstarting_declarations_do_not_issue_resource_evidence_and_readiness_requires_it(self):
        # Model the controller seam, not a successful native service. An inactive
        # declaration can be inspected without starting a process/cgroup; a live
        # worker can never bypass a failed resource observation into readiness.
        unit = 'aihr-web@1.service'
        runtime = Mock()
        runtime.resource_state.side_effect = C.Refused('Unverified model resources')
        profile = types.SimpleNamespace(value=self.value, next_runtime=runtime)
        host = C.LinuxHost(profile)
        with patch.object(host, 'unit_root_boundary') as boundary, patch.object(host, 'next_bindings', return_value={'model': True}):
            self.assertEqual(host.next_configuration(unit, {}), {'model': True})
            boundary.assert_called_once_with(unit, {})
            runtime.unit_configuration.assert_called_once_with(unit, {}, {'model': True})
            runtime.resource_state.assert_not_called()
            self.assertEqual(host.next_configuration_evidence, {})
        props = {'ActiveState': 'activating', 'SubState': 'start-post', 'MainPID': '424242'}
        spec = self.value['units'][unit]
        identity = {'pid': 424242, 'start': 123}
        realpath = lambda name: spec['executable'] if name.endswith('/exe') else spec['releaseDirectory']
        with patch.object(host, 'invocation', return_value=props), patch.object(C, 'process_identity', return_value=identity), \
                patch.object(pathlib.Path, 'stat', return_value=types.SimpleNamespace(st_uid=spec['workerUid'])), \
                patch.object(C.os.path, 'realpath', side_effect=realpath), patch.object(host, 'owns_listener') as listener:
            with self.assertRaisesRegex(C.Refused, 'Unverified model resources'):
                host.worker(unit, '1' * 32, 3201)
            runtime.resource_state.assert_called_once_with(unit, props)
            runtime.worker.assert_not_called()
            listener.assert_not_called()
            self.assertEqual(host.next_worker_evidence, {})

    def test_kernel_model_needs_inode_and_readonly_proof_even_when_mount_text_matches(self):
        release = '/immutable/release'
        root = {'device': 1, 'inode': 10, 'readOnly': True}
        sources = {target: (pathlib.Path('/model'), types.SimpleNamespace(st_dev=1, st_ino=index + 20))
                   for index, target in enumerate(N.CACHE_TARGETS)}
        observed = {target: {'device': 1, 'inode': info.st_ino, 'uid': 1001, 'mode': 0o700, 'readOnly': False}
                    for target, (_path, info) in sources.items()}
        mounts = [{'target': release, 'options': {'ro'}}] + [
            {'target': release + '/' + target, 'options': {'rw'}} for target in N.CACHE_TARGETS]
        proof = N.validate_namespace(mounts, release, (1, 10), root, sources, observed, 1001, C.require)
        self.assertNotIn('actualKernelMountsVerified', proof)
        for bad_root in (root | {'inode': 999}, root | {'readOnly': False}):
            with self.assertRaises(C.Refused):
                N.validate_namespace(mounts, release, (1, 10), bad_root, sources, observed, 1001, C.require)
        for changed in ({'inode': 999}, {'readOnly': True}, {'uid': 0}, {'mode': 0o777}):
            bad = copy.deepcopy(observed)
            bad[N.CACHE_TARGETS[0]].update(changed)
            with self.assertRaises(C.Refused):
                N.validate_namespace(mounts, release, (1, 10), root, sources, bad, 1001, C.require)
        for bad_mounts in (mounts + [{'target': release + '/server-code', 'options': {'rw'}}], mounts[:-1],
                           mounts + [mounts[1]]):
            with self.assertRaises(C.Refused):
                N.validate_namespace(bad_mounts, release, (1, 10), root, sources, observed, 1001, C.require)

    def test_mount_parser_refuses_truncation_duplicate_ids_and_unbounded_or_escaped_targets(self):
        text = b'10 1 0:2 / /immutable/release ro - ext4 /dev/model rw\n'
        self.assertEqual(N.parse_mountinfo(text, C.require)[0]['target'], '/immutable/release')
        for raw in (text + text, b'missing fields', b'10 1 0:2 / /bad/../target rw - ext4 /dev/model rw\n',
                    b'10 1 0:2 / /bad\\000target rw - ext4 /dev/model rw\n'):
            with self.assertRaises(C.Refused):
                N.parse_mountinfo(raw, C.require)

if __name__ == '__main__':
    unittest.main()
