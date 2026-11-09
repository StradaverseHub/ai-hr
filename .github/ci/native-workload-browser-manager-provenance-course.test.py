"""Data and custody models for the fixed no-connect manager provenance course."""
import copy
import struct
import tempfile
import unittest
from pathlib import Path
from types import ModuleType


def load(filename):
    source = Path(__file__).with_name(filename)
    module = ModuleType(filename)
    module.__file__ = str(source)
    exec(compile(source.read_bytes(), str(source), 'exec', dont_inherit=True), module.__dict__)
    return module


B = load('native-controller-bootstrap.py')
M = load('native-workload-browser-manager-provenance-course.py')
PREVIOUS = load('native-workload-browser-manager-input-course.test.py')
DIGEST = 'a' * 64


def package(name, version='1:2.3-4ubuntu5', architecture='amd64', status='install ok installed'):
    return f'Package: {name}\nStatus: {status}\nArchitecture: {architecture}\nVersion: {version}\n\n'.encode()


def image_header(interpreter):
    data = bytearray(192)
    data[:7] = b'\x7fELF\x02\x01\x01'
    struct.pack_into('<HHI', data, 16, 3, 62, 1)
    struct.pack_into('<Q', data, 32, 64)
    struct.pack_into('<HHH', data, 52, 64, 56, 1)
    struct.pack_into('<IIQQQQQQ', data, 64, 3, 0, 128, 0, 0, len(interpreter), 0, 0)
    data[128:128+len(interpreter)] = interpreter
    return bytes(data)


class ManagerProvenanceModels(unittest.TestCase):
    def test_only_exact_self_source_dispatch_reaches_the_new_selector(self):
        fixture = PREVIOUS.ManagerInputModels()
        environment, event = fixture.environment(B.MANAGER_PROVENANCE_BRANCH)
        self.assertEqual(B.manager_provenance_intent(environment, event)[0], '123')
        self.assertEqual(set(B.MANAGER_PROVENANCE_MEMBERS) - set(B.MANAGER_INPUT_MEMBERS),
                         {B.MANAGER_PROVENANCE_SOURCE})
        old, old_event = fixture.environment(B.MANAGER_INPUT_BRANCH)
        self.assertEqual(B.manager_input_intent(old, old_event)[0], '123')
        for env, payload in ((old, old_event), (environment, old_event),
                             ({**environment, 'GITHUB_RUN_ATTEMPT': '2'}, event),
                             (environment, {**event, 'inputs': {**event['inputs'], 'native_tool_only': 'true'}})):
            with self.subTest(ref=env['GITHUB_REF']), self.assertRaises(ValueError):
                B.manager_provenance_intent(env, payload)
        with self.assertRaises(ValueError):
            B.manager_input_intent(environment, event)
        with self.assertRaises(ValueError):
            B.prepare_tool(manager_input=True, manager_provenance=True)

    def test_stock_aliases_and_actual_elf_interpreter_are_closed(self):
        self.assertTrue(M._target('libsystemd.so.0', 'libsystemd.so.0.38.0'))
        for target in ('../libsystemd.so.0.38.0', 'libsystemd.so.1.38.0', 'libsystemd.so.0.38.alt',
                       'libsystemd.so.0.1234567', 'libsystemd.so.0.1.2.3.4'):
            self.assertFalse(M._target('libsystemd.so.0', target))
        exact = image_header(b'/lib64/ld-linux-x86-64.so.2\0')
        M._interpreter(exact)
        for raw in (exact[:120], image_header(b'/lib64/ld-linux-x86-64.so.2\0x'),
                    image_header(b'/tmp/ld-linux-x86-64.so.2\0')):
            with self.subTest(raw=raw[:12]), self.assertRaisesRegex(ValueError, 'stock-interpreter'):
                M._interpreter(raw)

    def test_actual_read_loop_refuses_per_file_and_aggregate_exhaustion(self):
        frontier = M.time.monotonic_ns() + M._SECOND
        data = b'x' * 65537
        with tempfile.TemporaryFile() as fixture:
            fixture.write(data)
            fixture.flush()
            fixture.seek(0)
            budget = [len(data) + 1]
            self.assertEqual(M._read_fd(fixture.fileno(), len(data), budget, frontier), data)
            self.assertEqual(budget, [1])
            for limit, total in ((len(data) - 1, len(data) + 1), (len(data), len(data) - 1)):
                with self.subTest(limit=limit, total=total), self.assertRaisesRegex(ValueError, 'read-bound'):
                    fixture.seek(0)
                    M._read_fd(fixture.fileno(), limit, [total], frontier)

    def test_installed_owner_requires_exact_architecture_status_and_named_membership(self):
        data = {'bytes': 42, 'sha256': DIGEST}
        images = [('libc.so.6', '/usr/lib/x86_64-linux-gnu/libc.so.6', data, ('libc6',))]
        installed = package('libc6')
        listing = b'/lib/x86_64-linux-gnu/libc.so.6\n'
        self.assertEqual(M._associate(images, installed + package('libc6', architecture='i386'), lambda _: listing),
                         [{'image': 'libc.so.6', 'installedFile': 'libc.so.6', **data,
                           'package': 'libc6', 'architecture': 'amd64', 'version': '1:2.3-4ubuntu5'}])
        for status, paths in ((installed + installed, listing),
                              (package('libc6', status='deinstall ok config-files'), listing),
                              (installed, b'/tmp/libc.so.6\n'),
                              (installed, listing.rstrip())):
            with self.subTest(status=status, paths=paths), self.assertRaises(ValueError):
                M._associate(images, status, lambda _: paths)
        alternatives = [('libc.so.6', images[0][1], data, ('libc6', 'another'))]
        with self.assertRaisesRegex(ValueError, 'stock-package-association'):
            M._associate(alternatives, installed + package('another'), lambda _: listing)

    def test_native_mapping_requires_inode_and_reports_unknown_without_path(self):
        known = {b'/usr/bin/python3.12': ('python3.12', (8, 1, 1)),
                 b'/usr/lib/libc.so.6': ('libc.so.6', (8, 1, 2)),
                 b'/usr/lib/ld-linux-x86-64.so.2': ('ld-linux-x86-64.so.2', (8, 1, 3))}
        proc = (b'1000-2000 r-xp 00000000 08:01 1       /usr/bin/python3.12\n'
                b'2000-3000 r-xp 00000000 08:01 2       /usr/lib/libc.so.6\n'
                b'3000-4000 r-xp 00000000 08:01 3       /usr/lib/ld-linux-x86-64.so.2\n'
                b'4000-5000 r-xp 00000000 00:00 0       [vdso]\n'
                b'5000-6000 r-xp 00000000 08:01 4       /private-name\n'
                b'6000-7000 r-xp 00000000 00:00 0\n'
                b'7000-8000 rw-p 00000000 00:00 0\n')
        maps, kernel, anonymous = M._map_rows(proc)
        self.assertEqual(kernel, {b'[vdso]'})
        self.assertEqual(M._mapped_images(maps, anonymous, known), (sorted(M._MAPPED_REQUIRED), 2))
        with self.assertRaisesRegex(ValueError, 'stock-map-inode'):
            M._mapped_images({**maps, b'/usr/bin/python3.12': (8, 1, 7)}, anonymous, known)
        with self.assertRaisesRegex(ValueError, 'stock-map-inode'):
            M._mapped_images(maps, anonymous, {**known, b'/private-name': (M._MAIN, (8, 1, 4))})
        for invalid in (proc.rstrip(b'\n'), proc.replace(b'5000-6000 r-xp', b'5000-6000 rwxp'),
                        proc + proc.splitlines()[0].replace(b'08:01 1 ', b'08:01 9 ') + b'\n'):
            with self.subTest(invalid=invalid[-90:]), self.assertRaises(ValueError):
                M._map_rows(invalid)

    def test_loader_keys_refuse_even_empty_and_never_need_value(self):
        M._loader_env(b'HOME=/nonexistent\0SUDO_COMMAND=irrelevant=value\0', {'LANG': 'C'})
        for raw, current in ((b'HOME=/\0LD_PRELOAD=\0', {}), (b'HOME=/\0GLIBC_TUNABLES=x\0', {}),
                             (b'HOME=/\0', {'LD_FUTURE': ''}), (b'HOME=/\0HOME=/\0', {}),
                             (b'HOME=/', {}), (b'HOME=/\0malformed\0', {})):
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, 'stock-environment'):
                M._loader_env(raw, current)

    def test_receipt_is_closed_and_unclassified_does_not_grant_admission(self):
        environment, _ = PREVIOUS.ManagerInputModels().environment(B.MANAGER_PROVENANCE_BRANCH)
        images = [{'image': name, 'installedFile': name, 'bytes': 32, 'sha256': DIGEST,
                   'package': packages[0], 'architecture': 'amd64', 'version': '1.2'}
                  for name, _, packages in M._FIXED]
        report = {'kind': 'NATIVE_STOCK_MANAGER_PROVENANCE', 'complete': True, 'source': 'a' * 40,
                  'controller': 'a' * 40, 'runId': '123', 'attempt': 1, 'job': 'native-test',
                  'eventSha256': 'b' * 64, 'sourceCapsuleSha256': 'c' * 64,
                  **dict.fromkeys(B.MANAGER_PROVENANCE_INACTIVE, False),
                  'observation': {'elapsedMs': 40, 'images': images, 'mappedImages': sorted(M._MAPPED_REQUIRED),
                                  'unclassifiedExecutableMappings': 1, 'loaderCache': {'bytes': 64, 'sha256': DIGEST},
                                  'loaderPreloadAbsent': True, 'loaderEnvironmentClear': True,
                                  'kernelConfigPresent': False, 'stockFdHolders': ['pid1', 'dbus-daemon'],
                                  'managerDirectInputsMatched': True}}
        M.validate_capture(B._manager_provenance_capture(B.canonical(report), '0', environment))
        for key in B.MANAGER_PROVENANCE_INACTIVE:
            with self.subTest(key=key), self.assertRaises(ValueError):
                B._manager_provenance_capture(B.canonical({**report, key: True}), '0', environment)
        for fields in ({'mappedImages': [*sorted(M._MAPPED_REQUIRED), M._MAIN]},
                       {'unclassifiedExecutableMappings': False}, {'kernelConfigPresent': 'no'},
                       {'images': images[1:] + images[:1]}, {'rawMap': '/private-name'}):
            with self.subTest(fields=list(fields)), self.assertRaises(ValueError):
                invalid = copy.deepcopy(report)
                invalid['observation'].update(fields)
                M.validate_capture(invalid)
        refused = {key: value for key, value in report.items() if key != 'observation'}
        refused.update(complete=False, failure={'phase': 'stock-files', 'reason': 'stock-interpreter'})
        M.validate_capture(B._manager_provenance_capture(B.canonical(refused), '1', environment))
        with self.assertRaises(ValueError):
            M.validate_capture({**refused, 'failure': {'phase': 'stock-files', 'reason': '/private-name'}})


if __name__ == '__main__':
    unittest.main()
