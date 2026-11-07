"""Pure protocol controls. Linux/Nginx/systemd execution is a separate witness."""
import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('admission_controller', pathlib.Path(__file__).with_name('controller.py'))
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)


class Host:
    def __init__(self, profile):
        self.profile = profile
        self.boot_id = 'first-boot'
        self.invocations = {unit: str(index + 1) * 32 for index, unit in enumerate(profile.value['units'])}
        self.phases = {unit: ('activating', 'start-pre') for unit in profile.value['units']}
        self.uncertain = set()
        self.identities = {unit: {'pid': 100 + index, 'startTicks': 10} for index, unit in enumerate(profile.value['units'])}
        self.live = {(row['pid'], row['startTicks']) for row in self.identities.values()} | {(1000, 1), (1001, 1)}
        self.workers = [{'pid': 1001, 'startTicks': 1}]
        self.ready, self.bound = set(), set()
        self.reloads, self.fail_validate, self.fail_after_reload, self.activate = 0, False, False, True
        self.visible_revision = None

    def boot(self):
        return self.boot_id

    def invocation(self, unit, invocation):
        C.require(self.invocations[unit] == invocation, 'Stale service invocation')
        return {'ActiveState': self.phases[unit][0], 'SubState': self.phases[unit][1], 'ControlGroup': '/fixture/' + unit}

    def reservation_invocation(self, unit, invocation):
        props = self.invocation(unit, invocation)
        C.require(self.phases[unit] == ('activating', 'start-pre'), 'Not in prestart')
        return props

    def worker(self, unit, invocation, port):
        C.require(C.admitting_phase(self.invocation(unit, invocation)), 'Not in admitting phase')
        C.require((self.identities[unit]['pid'], self.identities[unit]['startTicks']) in self.live, 'Worker exited')
        return self.identities[unit].copy()

    def generation_dead(self, generation):
        unit = generation['unit']
        identity = self.identities[unit]
        quiescent = self.phases[unit][0] in ('inactive', 'failed') and not C.alive(identity)
        # This pure host models exactly one native process family per unit.
        newer_family = self.invocations[unit] != generation['invocation'] \
            and C.admitting_phase(self.invocation(unit, self.invocations[unit])) and C.alive(identity)
        return unit not in self.uncertain and (quiescent or newer_family) and self.port_free(generation['port']) \
            and (generation.get('process') is None or not C.alive(generation['process']))

    def health(self, port):
        return port in self.ready

    def port_free(self, port):
        return port not in self.bound

    def proxy_master(self):
        return {'pid': 1000, 'startTicks': 1}

    def proxy_workers(self, master):
        return copy.deepcopy(self.workers)

    def validate_proxy(self):
        C.require(not self.fail_validate, 'Proxy rejected the proposed configuration')

    def reload_proxy(self, master):
        self.reloads += 1
        new = {'pid': 1001 + self.reloads, 'startTicks': 1}
        self.workers.append(new)
        self.live.add((new['pid'], new['startTicks']))
        raw = pathlib.Path(self.profile.value['managedInclude']).read_text()
        if self.activate:
            self.visible_revision = re.search(r'return 200 "([0-9a-f]{32})', raw)[1]
        if self.fail_after_reload:
            self.fail_after_reload = False
            raise OSError('Controlled interruption after actual reload boundary')

    def request(self, port, path):
        return 200, (self.visible_revision + '\n').encode() if self.visible_revision else b''


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='aihr-admission-state-')
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        for directory in ['state', 'proxy', 'ports']:
            (self.root / directory).mkdir(mode=0o700)
        self.value = {'version': 1, 'epoch': 'a' * 32, 'source': 'b' * 40, 'build': 'fictional-build',
                      'resourceEnvelopeDigest': 'c' * 64, 'controllerDigest': hashlib.sha256(pathlib.Path(C.__file__).read_bytes()).hexdigest(),
                      'stateDirectory': str(self.root / 'state'), 'nginxBinary': '/usr/sbin/nginx',
                      'nginxConfig': str(self.root / 'proxy/nginx.conf'), 'nginxPrefix': str(self.root / 'proxy'),
                      'nginxPid': str(self.root / 'proxy/nginx.pid'), 'nginxUnit': 'nginx.service',
                      'managedInclude': str(self.root / 'proxy/ready.conf'), 'controlPort': 3199,
                      'ports': [3201, 3202, 3203, 3204], 'units': {}, 'healthSeconds': 1,
                      'activationSeconds': 1, 'drainSeconds': 1, 'reloadGuardDigest': 'd' * 64}
        for index in (1, 2):
            self.value['units']['aihr-web@' + str(index) + '.service'] = {
                'environmentFile': str(self.root / 'ports' / (str(index) + '.env')),
                'releaseDirectory': '/opt/ai-hr', 'workerUid': 1001,
                'commandDigest': 'e' * 64, 'executable': '/usr/bin/node'}
        self.profile_path = self.root / 'profile.json'
        self.write_profile()
        self.profile = C.Profile(self.profile_path, os.getuid())
        self.host = Host(self.profile)
        self.controller = C.Controller(self.profile, self.host)
        self.alive_patch = patch.object(C, 'alive', lambda row: (row['pid'], row['startTicks']) in self.host.live)
        self.alive_patch.start()
        self.controller.initialize()

    def tearDown(self):
        self.alive_patch.stop()
        self.temporary.cleanup()

    def write_profile(self):
        self.profile_path.write_text(json.dumps(self.value))
        self.profile_path.chmod(0o600)

    def reserve(self, unit='aihr-web@1.service'):
        self.host.phases[unit] = ('activating', 'start-pre')
        generation = self.controller.reserve(unit, self.host.invocations[unit])
        self.host.phases[unit] = ('activating', 'start-post')
        return generation

    def admit(self, unit='aihr-web@1.service'):
        generation = self.reserve(unit)
        self.host.ready.add(generation['port'])
        self.controller.admit(unit, self.host.invocations[unit])
        self.host.phases[unit] = ('active', 'running')
        return generation

    def test_cold_endpoint_is_never_in_published_config(self):
        generation = self.reserve()
        self.assertFalse(self.controller.status()['workers'][0]['admitted'])
        self.assertNotIn(':' + str(generation['port']) + ';', pathlib.Path(self.value['managedInclude']).read_text())
        with self.assertRaises(C.Refused):
            self.controller.admit(generation['unit'], generation['invocation'])
        self.assertEqual(self.controller.store.read()['published']['ready'], [])

    def test_reservation_rewrites_overlay_after_interrupted_first_write(self):
        generation = self.reserve()
        environment = pathlib.Path(self.value['units'][generation['unit']]['environmentFile'])
        environment.write_text('PORT=9999\n')
        again = self.reserve()
        self.assertEqual(again, generation)
        self.assertEqual(environment.read_text(), 'PORT=' + str(generation['port']) + '\n')

    def test_current_health_admits_once_and_stale_callbacks_cannot_mutate_it(self):
        generation = self.admit()
        before = self.controller.store.read()
        self.controller.admit(generation['unit'], generation['invocation'])
        self.assertEqual(self.controller.store.read(), before)
        for operation in [self.controller.admit, self.controller.withdraw]:
            with self.assertRaises(C.Refused):
                operation(generation['unit'], 'f' * 32)
            self.assertEqual(self.controller.store.read(), before)

    def test_stopping_at_health_or_publication_never_completes_admission(self):
        unit = 'aihr-web@1.service'
        for phase in [('deactivating', 'stop-sigterm'), ('failed', 'failed'), ('activating', 'start-pre')]:
            self.assertFalse(C.admitting_phase({'ActiveState': phase[0], 'SubState': phase[1]}))
        self.assertTrue(C.admitting_phase({'ActiveState': 'active', 'SubState': 'running'}))
        self.assertTrue(C.admitting_phase({'ActiveState': 'activating', 'SubState': 'start-post'}))
        generation = self.reserve(unit)
        self.host.ready.add(generation['port'])
        def healthy_but_stopping(_port):
            self.host.phases[unit] = ('deactivating', 'stop-sigterm')
            return True
        self.host.health = healthy_but_stopping
        with self.assertRaises(C.Refused):
            self.controller.admit(unit, generation['invocation'])
        self.assertFalse(self.controller.status()['workers'][0]['admitted'])
        self.host.phases[unit] = ('activating', 'start-post')
        self.host.health = lambda _port: True
        original_reload = self.host.reload_proxy
        def stop_during_publication(master):
            original_reload(master)
            self.host.phases[unit] = ('deactivating', 'stop-sigterm')
        self.host.reload_proxy = stop_during_publication
        with self.assertRaises(C.Refused):
            self.controller.admit(unit, generation['invocation'])
        self.assertFalse(self.controller.status()['workers'][0]['admitted'])
        self.assertNotEqual(self.controller.status()['workers'][0]['phase'], 'READY')

    def test_ready_reconciliation_unpublishes_a_live_but_stopping_service(self):
        generation = self.admit()
        self.host.phases[generation['unit']] = ('deactivating', 'stop-sigterm')
        self.assertTrue(C.alive(self.host.identities[generation['unit']]))
        with self.assertRaises(C.Refused):
            self.controller.reconcile()
        self.assertFalse(self.controller.status()['workers'][0]['admitted'])
        self.assertNotEqual(self.controller.status()['workers'][0]['phase'], 'RELEASED')

    def test_pid_reuse_does_not_make_old_identity_alive(self):
        generation = self.admit()
        identity = self.host.identities[generation['unit']]
        self.host.live.remove((identity['pid'], identity['startTicks']))
        self.host.live.add((identity['pid'], identity['startTicks'] + 1))
        with self.assertRaises(C.Refused):
            self.controller.reconcile()
        self.assertFalse(self.controller.status()['workers'][0]['admitted'])

    def test_failed_validation_retains_prior_configuration_and_does_not_admit(self):
        first = self.admit()
        before = pathlib.Path(self.value['managedInclude']).read_bytes()
        second = self.reserve('aihr-web@2.service')
        self.host.ready.add(second['port'])
        self.host.fail_validate = True
        with self.assertRaises(C.Refused):
            self.controller.admit(second['unit'], second['invocation'])
        self.assertEqual(pathlib.Path(self.value['managedInclude']).read_bytes(), before)
        self.assertEqual(self.controller.store.read()['published']['ready'], [first['id']])

    def test_crash_after_reload_requires_fresh_verified_publication_and_tracks_new_readers(self):
        first = self.admit()
        second = self.reserve('aihr-web@2.service')
        self.host.ready.add(second['port'])
        self.host.fail_after_reload = True
        with self.assertRaises(OSError):
            self.controller.admit(second['unit'], second['invocation'])
        state = self.controller.store.read()
        self.assertIsNotNone(state['pending'])
        exposed_revision = self.host.visible_revision
        exposed_readers = copy.deepcopy(self.host.workers)
        self.host.ready.remove(second['port'])
        with self.assertRaises(C.Refused):
            self.controller.reconcile()  # The incomplete candidate remains DOWN.
        recovered = self.controller.store.read()
        self.assertIsNone(recovered['pending'])
        self.assertNotEqual(recovered['published']['revision'], exposed_revision)
        self.assertEqual(recovered['published']['ready'], [first['id']])
        for reader in exposed_readers:
            self.assertIn(reader, recovered['generations'][second['id']]['readers'])

    def test_interrupted_add_retains_late_old_config_child_through_recovery_barrier(self):
        first = self.admit()
        second = self.reserve('aihr-web@2.service')
        self.host.ready.add(second['port'])
        self.host.fail_after_reload = True
        with self.assertRaises(OSError):
            self.controller.admit(second['unit'], second['invocation'])
        self.assertNotIn(second['id'], self.controller.store.read()['published']['ready'])
        self.host.phases[second['unit']] = ('failed', 'failed')
        old_process = self.host.identities[second['unit']]
        self.host.live.remove((old_process['pid'], old_process['startTicks']))
        original_reload, forked = self.host.reload_proxy, []
        def late_fork(master):
            child = {'pid': 2700 + len(forked), 'startTicks': 1}
            forked.append(child)
            self.host.workers.append(child)
            self.host.live.add((child['pid'], child['startTicks']))
            original_reload(master)
        self.host.reload_proxy = late_fork
        self.controller.reconcile()
        state = self.controller.store.read()
        self.assertEqual(len(forked), 2)
        self.assertIn(forked[0], state['generations'][second['id']]['readers'])
        self.assertNotIn(forked[1], state['generations'][second['id']]['readers'])
        self.assertNotEqual(state['generations'][second['id']]['phase'], 'RELEASED')
        self.assertEqual(state['published']['ready'], [first['id']])
        self.host.invocations[second['unit']] = '9' * 32
        self.host.identities[second['unit']] = {'pid': 999, 'startTicks': 20}
        self.host.live.add((999, 20))
        replacement = self.reserve(second['unit'])
        self.assertNotEqual(replacement['port'], second['port'])
        self.assertNotIn(replacement['id'], self.controller.store.read()['published']['ready'])
        for reader in state['generations'][second['id']]['readers']:
            self.host.live.discard((reader['pid'], reader['startTicks']))
        self.controller.reconcile()
        self.assertEqual(self.controller.store.read()['generations'][second['id']]['phase'], 'RELEASED')

    def test_interrupted_cleanup_reaps_only_natively_dead_nonpublished_generations(self):
        generation = self.reserve()
        unit = generation['unit']
        # No saved PID does not make the running startup process dead.
        self.controller.reconcile()
        self.assertEqual(self.controller.store.read()['generations'][generation['id']]['phase'], 'WARMING')
        self.host.phases[unit] = ('inactive', 'dead')
        self.controller.reconcile()
        self.assertNotEqual(self.controller.store.read()['generations'][generation['id']]['phase'], 'RELEASED')
        identity = self.host.identities[unit]
        self.host.live.remove((identity['pid'], identity['startTicks']))
        self.host.uncertain.add(unit)
        self.controller.reconcile()
        self.assertNotEqual(self.controller.store.read()['generations'][generation['id']]['phase'], 'RELEASED')
        self.host.uncertain.clear()
        self.host.bound.add(generation['port'])
        self.controller.reconcile()
        self.assertNotEqual(self.controller.store.read()['generations'][generation['id']]['phase'], 'RELEASED')
        self.host.bound.remove(generation['port'])
        self.controller.reconcile()
        self.assertEqual(self.controller.store.read()['generations'][generation['id']]['phase'], 'RELEASED')

    def test_dead_draining_generation_retains_readers_then_eventually_releases(self):
        generation = self.admit()
        self.controller.withdraw(generation['unit'], generation['invocation'])
        self.host.phases[generation['unit']] = ('inactive', 'dead')
        identity = self.host.identities[generation['unit']]
        self.host.live.remove((identity['pid'], identity['startTicks']))
        self.controller.reconcile()
        state = self.controller.store.read()
        self.assertEqual(state['generations'][generation['id']]['phase'], 'RETIRED')
        for reader in state['generations'][generation['id']]['readers']:
            self.host.live.discard((reader['pid'], reader['startTicks']))
        self.controller.reconcile()
        self.assertEqual(self.controller.store.read()['generations'][generation['id']]['phase'], 'RELEASED')

    def test_drain_timeout_retains_live_process_and_port_until_every_reader_exits(self):
        generation = self.admit()
        with self.assertRaises(C.Refused):
            self.controller.drain(generation['unit'], generation['invocation'])
        state = self.controller.store.read()
        self.assertEqual(state['generations'][generation['id']]['phase'], 'DRAINING')
        self.assertTrue(C.alive(self.host.identities[generation['unit']]))
        self.host.invocations[generation['unit']] = '9' * 32
        with self.assertRaises(C.Refused):
            self.reserve(generation['unit'])
        self.host.invocations[generation['unit']] = generation['invocation']
        for reader in state['generations'][generation['id']]['readers']:
            self.host.live.discard((reader['pid'], reader['startTicks']))
        # Keep the current proxy's separate new readers live for further reloads.
        receipt = self.controller.drain(generation['unit'], generation['invocation'])
        self.assertTrue(receipt['safeToStop'])
        self.assertEqual(self.controller.store.read()['generations'][generation['id']]['phase'], 'DRAINED')

    def test_pre_hup_child_is_retained_and_same_config_barrier_can_retire_it(self):
        generation = self.admit()
        original_reload = self.host.reload_proxy
        forked = []
        def reload_with_late_child(master):
            child = {'pid': 2500 + len(forked), 'startTicks': 1}
            forked.append(child)
            self.host.workers.append(child)
            self.host.live.add((child['pid'], child['startTicks']))
            original_reload(master)
        self.host.reload_proxy = reload_with_late_child
        self.controller.withdraw(generation['unit'], generation['invocation'])
        readers = self.controller.store.read()['generations'][generation['id']]['readers']
        self.assertEqual(len(forked), 2)
        self.assertIn(forked[0], readers)
        self.assertNotIn(forked[1], readers)
        self.assertNotIn(self.host.workers[-1], readers)

    def test_failed_second_barrier_stays_pending_until_a_new_proved_reload(self):
        generation = self.admit()
        original_validate, calls = self.host.validate_proxy, []
        def fail_second_validation():
            calls.append(True)
            C.require(len(calls) != 2, 'Controlled second-barrier validation failure')
            original_validate()
        self.host.validate_proxy = fail_second_validation
        with self.assertRaises(C.Refused):
            self.controller.withdraw(generation['unit'], generation['invocation'])
        state = self.controller.store.read()
        self.assertTrue(state['pending']['retirementBarrier'])
        self.assertEqual(state['published']['ready'], [])
        self.host.validate_proxy = original_validate
        identity = self.host.identities[generation['unit']]
        self.host.live.remove((identity['pid'], identity['startTicks']))
        self.host.phases[generation['unit']] = ('inactive', 'dead')
        reloads = self.host.reloads
        self.controller.reconcile()
        self.assertGreater(self.host.reloads, reloads)
        state = self.controller.store.read()
        self.assertIsNone(state['pending'])
        for reader in state['generations'][generation['id']]['readers']:
            self.host.live.discard((reader['pid'], reader['startTicks']))
        self.controller.reconcile()
        self.assertEqual(self.controller.store.read()['generations'][generation['id']]['phase'], 'RELEASED')

    def test_pool_exhaustion_does_not_recycle_an_uncertain_endpoint(self):
        state = self.controller.store.read()
        for index, port in enumerate(self.value['ports']):
            key = str(index) * 32
            state['generations'][key] = {'id': key, 'port': port, 'phase': 'RETIRED', 'process': None,
                                         'readers': [], 'sequence': index, 'unit': 'aihr-web@1.service'}
        self.controller.store.save(state)
        with self.assertRaises(C.Refused):
            self.reserve()
        self.assertFalse(pathlib.Path(self.value['units']['aihr-web@1.service']['environmentFile']).exists())

    def test_changed_deployment_profile_fences_a_pending_health_callback(self):
        generation = self.reserve()
        self.host.ready.add(generation['port'])
        self.value['epoch'] = '9' * 32
        self.write_profile()
        with self.assertRaises(C.Refused):
            self.controller.admit(generation['unit'], generation['invocation'])

    def test_new_build_overlap_refuses_without_authenticated_compatibility_contract(self):
        self.admit()
        self.value['epoch'] = '9' * 32
        self.value['build'] = 'different-build'
        self.write_profile()
        profile = C.Profile(self.profile_path, os.getuid())
        with self.assertRaisesRegex(C.Refused, 'compatibility-window'):
            C.Controller(profile, Host(profile)).begin()
        self.assertEqual(self.controller.store.read()['epoch'], 'a' * 32)

    def test_closed_profile_rejects_symlinks_shared_permissions_and_code_in_paths(self):
        self.value['units']['aihr-web@1.service']['workerUid'] = 0
        self.write_profile()
        with self.assertRaises(C.Refused):
            C.Profile(self.profile_path, os.getuid())
        self.value['units']['aihr-web@1.service']['workerUid'] = 1001
        self.value['managedInclude'] += '\nExecStart=/bin/false'
        self.write_profile()
        with self.assertRaises(C.Refused):
            C.Profile(self.profile_path, os.getuid())
        self.value['managedInclude'] = str(self.root / 'proxy/ready.conf')
        self.write_profile()
        self.profile_path.chmod(0o666)
        with self.assertRaises(C.Refused):
            C.Profile(self.profile_path, os.getuid())
        self.profile_path.chmod(0o600)
        linked = self.root / 'linked.json'
        linked.symlink_to(self.profile_path)
        with self.assertRaises(C.Refused):
            C.Profile(linked, os.getuid())


if __name__ == '__main__':
    unittest.main()
