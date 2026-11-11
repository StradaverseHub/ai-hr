"""Pure custody counterexamples only. These packets are NOT native evidence."""
import copy
import sys
import unittest
import tempfile
import json
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

source = Path(__file__).with_name('employee-postgres-policy.py')
policy = ModuleType('actual_employee_postgres_policy')
exec(compile(source.read_bytes(), str(source), 'exec', dont_inherit=True), policy.__dict__)


def fixture():
    context = {'run': '123', 'attempt': '1', 'unit': 'db-' + 'a' * 16, 'resourceNonce': 'b' * 64,
               'source': 'c' * 40, 'controller': 'd' * 40}
    value = {'Id': 'e' * 64, 'Name': '/' + policy.name(context), 'Image': 'sha256:' + 'f' * 64,
             'Created': '2026-11-08T00:00:01.000000001Z',
             'Config': {'Image': policy.IMAGE, 'Labels': policy.labels(context), 'Cmd': policy.COMMAND.copy(),
                        'Entrypoint': ['docker-entrypoint.sh'], 'User': '', 'Tty': False, 'OpenStdin': False,
                        'Env': ['PATH=/usr/bin:/bin', 'POSTGRES_HOST_AUTH_METHOD=trust', 'TZ=Asia/Kuala_Lumpur'],
                        'Volumes': {'/var/lib/postgresql/data': {}}},
             'HostConfig': {'NetworkMode': 'host', 'Memory': policy.MEMORY, 'MemorySwap': policy.MEMORY,
                            'ShmSize': 134217728, 'Privileged': False, 'AutoRemove': False, 'IpcMode': 'private'},
             'Mounts': [{'Type': 'volume', 'Destination': '/var/lib/postgresql/data', 'RW': True, 'Name': '1' * 64}],
             'State': {'Running': True, 'Dead': False, 'Restarting': False, 'OOMKilled': False, 'Error': '',
                       'Status': 'running', 'Pid': 4321, 'StartedAt': '2026-11-08T00:00:02.000000001Z'}}
    return context, value


class CustodyModels(unittest.TestCase):
    def test_requires_all_source_run_attempt_nonce_labels_without_an_extra_capability(self):
        context, value = fixture()
        self.assertEqual(policy.container(value, context)['cid'], value['Id'])
        for key in value['Config']['Labels']:
            bad = copy.deepcopy(value)
            bad['Config']['Labels'][key] = 'foreign'
            with self.assertRaises(ValueError):
                policy.container(bad, context)

        bad = copy.deepcopy(value)
        bad['Config']['Labels']['foreign'] = 'extra'
        with self.assertRaises(ValueError):
            policy.container(bad, context)

    def test_a_known_cid_never_retargets_an_identically_named_replacement(self):
        context, value = fixture()
        recorded = policy.container(value, context)
        value['Id'] = '2' * 64
        with self.assertRaises(ValueError):
            policy.cleanup_target(value, context, recorded, {'wallTimeNs': '0'})
        # CREATE returned an ID, but validation metadata publication was lost.
        with self.assertRaises(ValueError):
            policy.cleanup_target(value, context, None, {'wallTimeNs': '0'}, known_cid=recorded['cid'])

    def test_pinned_reference_and_native_image_id_and_created_identity_are_independent(self):
        context, value = fixture()
        for kwargs in ({'image_id': 'sha256:' + '0' * 64}, {'created': '2026-11-08T00:00:00Z'}, {'cid': '0' * 64}):
            with self.assertRaises(ValueError):
                policy.container(value, context, **kwargs)
        value['Config']['Image'] = 'postgres:16'
        with self.assertRaises(ValueError):
            policy.container(value, context)

    def test_network_privilege_memory_mount_or_command_drift_refuses(self):
        context, value = fixture()
        for key, replacement in [('NetworkMode', 'bridge'), ('Memory', policy.MEMORY + 1), ('MemorySwap', -1),
                                 ('Privileged', True), ('Binds', ['/foreign:/var/lib/postgresql/data']),
                                 ('PidMode', 'host'), ('IpcMode', 'host'), ('AutoRemove', True), ('CapAdd', ['SYS_ADMIN'])]:
            bad = copy.deepcopy(value)
            bad['HostConfig'][key] = replacement
            with self.assertRaises(ValueError):
                policy.container(bad, context)
        for key, replacement in [('Cmd', ['sh']), ('Entrypoint', ['sh']), ('User', 'root')]:
            bad = copy.deepcopy(value)
            bad['Config'][key] = replacement
            with self.assertRaises(ValueError):
                policy.container(bad, context)

    def test_private_socket_connection_cannot_be_redirected_by_pg_environment(self):
        context, value = fixture()
        for key in ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGPASSWORD', 'POSTGRES_PASSWORD']:
            bad = copy.deepcopy(value)
            bad['Config']['Env'].append(key + '=foreign')
            with self.assertRaises(ValueError):
                policy.container(bad, context)

    def test_lost_create_requires_intent_and_post_intent_native_birth_and_never_produces_admission(self):
        context, value = fixture()
        with self.assertRaises(ValueError):
            policy.cleanup_target(value, context, None, None)
        result = policy.cleanup_target(value, context, None, {'wallTimeNs': '0'})
        self.assertEqual(set(result), {'cid', 'imageId', 'created', 'volume'})
        self.assertNotIn('admitted', result)
        with self.assertRaises(ValueError):
            policy.cleanup_target(value, context, None, {'wallTimeNs': '9999999999999999999'})

    def test_native_postmaster_birth_must_remain_identical_and_healthy(self):
        context, value = fixture()
        birth = policy.started(value)
        policy.same_birth(value, birth)
        for key, replacement in [('Pid', 4322), ('StartedAt', '2026-11-08T00:00:03Z'), ('Running', False),
                                 ('Restarting', True), ('Dead', True), ('OOMKilled', True), ('Error', 'failure')]:
            bad = copy.deepcopy(value)
            bad['State'][key] = replacement
            with self.assertRaises(ValueError):
                policy.same_birth(bad, birth)

    def test_only_one_exact_anonymous_data_volume_is_owned(self):
        context, value = fixture()
        for replacement in [[], value['Mounts'] * 2, [{**value['Mounts'][0], 'Type': 'bind'}],
                            [{**value['Mounts'][0], 'Name': 'foreign-named-volume'}],
                            [{**value['Mounts'][0], 'Destination': '/foreign'}]]:
            bad = copy.deepcopy(value)
            bad['Mounts'] = replacement
            with self.assertRaises(ValueError):
                policy.container(bad, context)


class ActualAtomicPublication(unittest.TestCase):
    @staticmethod
    def resource_owner():
        actual_source = Path(__file__).with_name('employee-postgres-resource.py')
        actual = ModuleType('actual_resource_operation_functions')
        actual.__file__ = str(actual_source.resolve())
        exec(compile(actual_source.read_bytes(), str(actual_source), 'exec', dont_inherit=True), actual.__dict__)
        return actual

    def test_single_link_complete_payload_and_no_overwrite_on_the_actual_filesystem(self):
        adapter_source = Path(__file__).with_name('employee-lifecycle-supervisor.py')
        adapter = ModuleType('actual_lifecycle_publication')
        adapter.__file__ = str(adapter_source.resolve())
        exec(compile(adapter_source.read_bytes(), str(adapter_source), 'exec', dont_inherit=True), adapter.__dict__)
        with tempfile.TemporaryDirectory(prefix='employee-publish-') as directory:
            path = Path(directory) / 'proof.json'
            adapter.publish(path, {'version': 1, 'fictional': True})
            self.assertEqual(path.stat().st_nlink, 1)
            self.assertEqual(json.loads(path.read_bytes()), {'version': 1, 'fictional': True})
            self.assertEqual(list(Path(directory).iterdir()), [path])
            before = path.read_bytes()
            with self.assertRaises(FileExistsError):
                adapter.publish(path, {'foreign': 'must never replace owned proof'})
            self.assertEqual(path.read_bytes(), before)

    def test_interrupted_partial_and_complete_pending_members_neither_block_nor_get_overwritten(self):
        actual = self.resource_owner()
        with tempfile.TemporaryDirectory(prefix='employee-interrupted-publication-') as directory:
            context = {'evidenceDirectory': directory, 'unit': 'db-' + 'a' * 16}
            value = {'version': 1, 'complete': True, 'fictional': True}
            path = Path(directory) / (context['unit'] + '-employee-container-stopped.json')
            complete = path.with_name(path.name + '.pending-' + '0' * 32)
            partial = path.with_name(path.name + '.pending-' + '1' * 32)
            complete.write_bytes(json.dumps(value, separators=(',', ':')).encode())
            partial.write_bytes(b'{"ver')
            before = [(p, p.stat().st_ino, p.read_bytes()) for p in (complete, partial)]
            with patch.object(actual.adapter.os, 'urandom', return_value=b'\x22' * 16):
                actual.publish_stopped(context, value)
            self.assertEqual(json.loads(path.read_bytes()), value)
            self.assertEqual(path.stat().st_nlink, 1)
            for old, inode, data in before:
                self.assertEqual(old.stat().st_ino, inode)
                self.assertEqual(old.read_bytes(), data)

    def test_missing_public_stop_can_be_repaired_without_overwriting_a_conflicting_member(self):
        actual = self.resource_owner()
        with tempfile.TemporaryDirectory(prefix='employee-public-repair-') as directory:
            context = {'evidenceDirectory': directory, 'unit': 'db-' + 'a' * 16}
            value = {'version': 1, 'complete': True, 'fictional': True}
            actual.publish_stopped(context, value)
            path = Path(directory) / (context['unit'] + '-employee-container-stopped.json')
            before = path.read_bytes()
            actual.publish_stopped(context, value)
            self.assertEqual(path.read_bytes(), before)
            with self.assertRaises(ValueError):
                actual.publish_stopped(context, {**value, 'foreign': True})
            self.assertEqual(path.read_bytes(), before)

    def test_every_command_uses_one_remaining_aggregate_deadline_and_refuses_late_completion(self):
        actual = self.resource_owner()
        actual.OPERATION_DEADLINE = 10
        with tempfile.TemporaryDirectory(prefix='employee-budget-model-') as directory:
            private = Path(directory)
            with patch.object(actual.time, 'monotonic', side_effect=[8.5, 9]), patch.object(actual.subprocess, 'run') as run:
                run.return_value.returncode = 0
                self.assertEqual(actual.command(['fictional-never-executed'], private, 20), (0, b''))
                self.assertEqual(run.call_args.kwargs['timeout'], 1.5)
            with patch.object(actual.time, 'monotonic', return_value=10.01), patch.object(actual.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    actual.command(['fictional-never-executed'], private, 20)
                run.assert_not_called()
            with patch.object(actual.time, 'monotonic', side_effect=[9, 10.01]), patch.object(actual.subprocess, 'run') as run:
                run.return_value.returncode = 0
                with self.assertRaises(ValueError):
                    actual.command(['fictional-never-executed'], private, 20)


if __name__ == '__main__':
    unittest.main()
