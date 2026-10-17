"""Pure dependency-injected lifecycle regressions. No socket, unit, /proc, key or cgroup access."""
import importlib.util
import sys
import unittest
spec = importlib.util.spec_from_file_location('peer_under_test', sys.argv.pop(1))
peer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(peer)
UNIT = 'aihr-report-auth@4-connection.service'
PATH = '/aihrmanagedmail.slice/aihrmanagedmail-dispatch.slice/' + UNIT
IDENTITY = {'version': 1, 'unit': UNIT, 'invocationId': 'a' * 32, 'cgroup': PATH, 'replyBytes': 18}
class Retirement(unittest.TestCase):
    def test_foreign_or_already_deleted_descriptor_cannot_supply_authority(self):
        for path in ['/sys/fs/cgroup/system.slice/' + UNIT, '/sys/fs/cgroup' + PATH + ' (deleted)', '/sys/fs/cgroup' + PATH + '/child']:
            with self.assertRaises(Exception): peer.retirement_identity(IDENTITY, path)
        self.assertEqual(peer.retirement_identity(IDENTITY, '/sys/fs/cgroup' + PATH), IDENTITY)
    def test_unknown_metadata_or_invocation_is_refused(self):
        for change in [{'key': 'never'}, {'invocationId': 'b'}, {'replyBytes': 524289}, {'unit': '../other.service'}]:
            with self.assertRaises(Exception): peer.retirement_identity(dict(IDENTITY, **change), '/sys/fs/cgroup' + PATH)
    def run_wait(self, states, unit, timeout=1):
        now = [0.0]; observations = []
        def group():
            value = states[min(len(observations), len(states)-1)];observations.append(value);return value
        def sleep(ms): now[0] += ms
        peer.wait_retirement(IDENTITY, group, lambda: unit, lambda: now[0], sleep, timeout)
        return observations
    def test_eof_with_populated_unit_never_authorizes(self):
        with self.assertRaises(Exception): self.run_wait(['populated'], {'load':'loaded','active':'active','invocation':'a'*32,'pid':123,'cgroup':PATH})
    def test_empty_cgroup_still_requires_retired_exact_activation(self):
        with self.assertRaises(Exception): self.run_wait(['empty'], {'load':'loaded','active':'active','invocation':'a'*32,'pid':123,'cgroup':PATH})
        with self.assertRaises(Exception): self.run_wait(['empty'], {'load':'loaded','active':'inactive','invocation':'b'*32,'pid':0,'cgroup':''})
    def test_known_empty_same_activation_can_retire_without_a_timing_guess(self):
        self.assertEqual(self.run_wait(['populated','empty'], {'load':'loaded','active':'inactive','invocation':'a'*32,'pid':0,'cgroup':''}), ['populated','empty'])
    def test_collection_requires_not_found_not_a_missing_or_reused_path(self):
        self.run_wait(['collected'], {'load':'not-found','active':'inactive','invocation':'','pid':0,'cgroup':''})
        with self.assertRaises(Exception): self.run_wait(['collected'], {'load':'loaded','active':'active','invocation':'b'*32,'pid':123,'cgroup':PATH})
    def test_interrupted_or_unknown_unit_and_descriptor_states_refuse(self):
        for value in ['unknown','deleted-at-receipt']:
            with self.assertRaises(Exception): self.run_wait([value], {'load':'not-found','active':'inactive','invocation':'','pid':0,'cgroup':''})
if __name__ == '__main__': unittest.main()
