"""Closed source models only. No Docker, root, systemd, PostgreSQL or Next executes."""
import contextlib
import copy
import importlib.util
import json
import pathlib
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('next_postgres_scope_source', pathlib.Path(__file__).with_name('test_next_native.py'))
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)
PLAN = {'runId': '123', 'unit': 'db-' + 'b' * 16}


class ScopeModel:
    def __init__(self):
        self.name = 'aihr-ci-123-1-' + PLAN['unit']
        self.identity = {'id': 'a' * 64, 'name': '/' + self.name, 'owner': self.name,
            'pid': 111, 'started': '2026-11-08T01:00:00.000000000Z', 'running': True,
            'memory': 2113929216, 'swap': 2113929216}
        self.driver = b'systemd 2\n'
        self.scope = 'docker-' + 'a' * 64 + '.scope'
        self.group = '/system.slice/' + self.scope
        self.properties = {'Id': self.scope, 'LoadState': 'loaded', 'ActiveState': 'active',
                           'ControlGroup': self.group, 'MemorySwapMax': 'infinity'}
        self.kernel = b'2113929216\n0\n'
        self.proc_group = self.group
        self.extra = b''
        self.events = []
        self.set_error = None

    def run(self, argv, timeout):
        self.events.append(('docker', tuple(argv)))
        assert argv[:3] == ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
        assert timeout == 10
        args = argv[3:]
        if args == ['info', '--format', '{{.CgroupDriver}} {{.CgroupVersion}}']:
            raw = self.driver
        elif args == ['inspect', '--format', F.OwnedPostgresScope.FORMAT, self.name]:
            raw = json.dumps(self.identity).encode()
        else:
            assert args == ['exec', self.name, 'cat', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.swap.max']
            raw = self.kernel
        return types.SimpleNamespace(stdout=raw, stderr=b'', returncode=0)

    def manager(self, *args, **kwargs):
        self.events.append(('manager', args))
        if args[:1] == ('set-property',):
            assert args == ('set-property', '--runtime', self.scope, 'MemorySwapMax=0')
            assert kwargs == {'timeout': 10}
            if self.set_error:
                raise self.set_error
            self.properties['MemorySwapMax'] = '0'
        elif args[:1] == ('show',):
            assert args == ('show', self.scope, '--property=ActiveState,ControlGroup,Id,LoadState,MemorySwapMax')
            assert kwargs == {'timeout': 10}
        else:
            assert args == ('daemon-reload',)
            self.kernel = b'2113929216\n' + (b'0\n' if self.properties['MemorySwapMax'] == '0' else b'max\n')
        return types.SimpleNamespace(stdout=(''.join(k + '=' + v + '\n' for k, v in self.properties.items())).encode() + self.extra,
                                     stderr=b'', returncode=0)

    def read(self, path):
        assert str(path) == '/proc/111/cgroup'
        return ('0::' + self.proc_group + '\n').encode()

    def writes(self):
        return [event for event in self.events if event[0] == 'manager' and event[1][0] == 'set-property']


class NativePostgresScopeModels(unittest.TestCase):
    @contextlib.contextmanager
    def host(self, model=None):
        model = model or ScopeModel()
        with patch.object(F, 'report', {}), patch.object(F, 'save'), \
             patch.object(F, 'run', side_effect=model.run), \
             patch.object(F, 'systemctl', side_effect=model.manager), \
             patch.object(F.pathlib.Path, 'read_bytes', lambda path: model.read(path)):
            yield model

    def test_exact_existing_kernel_zero_is_registered_before_both_reload_boundaries(self):
        with self.host() as model:
            guard = F.OwnedPostgresScope(PLAN)
            for before, after in [('before-config-reload', 'after-config-reload'),
                                  ('before-cleanup-reload', 'after-cleanup-reload')]:
                guard.snapshot(before)
                F.systemctl('daemon-reload')
                guard.snapshot(after)
            guard.snapshot('final')
            self.assertEqual(len(model.writes()), 1)
            self.assertLess(model.events.index(model.writes()[0]), next(i for i, e in enumerate(model.events) if e == ('manager', ('daemon-reload',))))
            receipt = F.report['ownedPostgresScope']
            self.assertEqual([r['stage'] for r in receipt['observations']], ['registered', 'before-config-reload',
                'after-config-reload', 'before-cleanup-reload', 'after-cleanup-reload', 'final'])
            self.assertTrue(all(r['memorySwapMax'] == 0 and r['managerSwapMax'] == '0' for r in receipt['observations']))
            self.assertNotIn(model.name, json.dumps(receipt))
            self.assertNotIn(model.group, json.dumps(receipt))

    def test_foreign_or_invalid_container_never_authorizes_manager_mutation(self):
        for field, value in [('owner', 'foreign'), ('name', '/foreign'), ('id', '../foreign'),
                             ('pid', True), ('running', False), ('memory', 1), ('swap', 1)]:
            with self.subTest(field=field), self.host() as model:
                model.identity[field] = value
                with self.assertRaises(AssertionError):
                    F.OwnedPostgresScope(PLAN)
                self.assertEqual(model.writes(), [])
        with self.host() as model:
            model.driver = b'cgroupfs 2\n'
            with self.assertRaises(AssertionError):
                F.OwnedPostgresScope(PLAN)
            self.assertEqual(model.writes(), [])

    def test_foreign_manager_or_actual_native_process_scope_refuses_before_mutation(self):
        for field, value in [('Id', 'foreign.scope'), ('LoadState', 'not-found'),
                             ('ActiveState', 'inactive'), ('ControlGroup', '/foreign')]:
            with self.subTest(field=field), self.host() as model:
                model.properties[field] = value
                with self.assertRaises(AssertionError):
                    F.OwnedPostgresScope(PLAN)
                self.assertEqual(model.writes(), [])
        with self.host() as model:
            model.proc_group = '/foreign'
            with self.assertRaises(AssertionError):
                F.OwnedPostgresScope(PLAN)
            self.assertEqual(model.writes(), [])

    def test_existing_or_later_drift_never_becomes_a_reset_or_accepted_observation(self):
        with self.host() as model:
            model.kernel = b'2113929216\nmax\n'
            with self.assertRaises(AssertionError):
                F.OwnedPostgresScope(PLAN)
            self.assertEqual(model.writes(), [])
        for target in ['kernel', 'manager', 'identity']:
            with self.subTest(target=target), self.host() as model:
                guard = F.OwnedPostgresScope(PLAN)
                if target == 'kernel':
                    model.kernel = b'2113929216\nmax\n'
                elif target == 'manager':
                    model.properties['MemorySwapMax'] = 'infinity'
                else:
                    model.identity['started'] = '2026-11-08T01:01:00.000000000Z'
                with self.assertRaises(AssertionError):
                    guard.snapshot('after-config-reload')
                self.assertEqual(len(model.writes()), 1)
                self.assertEqual([r['stage'] for r in F.report['ownedPostgresScope']['observations']], ['registered'])

    def test_unacknowledged_set_or_ambiguous_manager_data_never_mints_registration(self):
        with self.host() as model:
            model.set_error = RuntimeError('controlled manager failure')
            with self.assertRaisesRegex(RuntimeError, 'controlled manager failure'):
                F.OwnedPostgresScope(PLAN)
            self.assertNotIn('ownedPostgresScope', F.report)
        for extra in [b'Id=foreign.scope\n', b'Unknown=1\n']:
            with self.subTest(extra=extra), self.host() as model:
                model.extra = extra
                with self.assertRaises(AssertionError):
                    F.OwnedPostgresScope(PLAN)
                self.assertEqual(model.writes(), [])

    def test_plan_and_closed_observation_stage_cannot_choose_foreign_names_or_replay_evidence(self):
        for plan in [{}, {'runId': '../foreign', 'unit': PLAN['unit']}, {'runId': '123', 'unit': 'db-1'}]:
            with self.subTest(plan=plan), self.host() as model:
                with self.assertRaises(AssertionError):
                    F.OwnedPostgresScope(plan)
                self.assertEqual(model.events, [])
        with self.host():
            guard = F.OwnedPostgresScope(PLAN)
            for stage in ['foreign', 'registered']:
                with self.assertRaises(AssertionError):
                    guard.snapshot(stage)
            self.assertEqual(len(F.report['ownedPostgresScope']['observations']), 1)


if __name__ == '__main__':
    unittest.main()
