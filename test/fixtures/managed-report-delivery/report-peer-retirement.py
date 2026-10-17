"""Pure dependency-injected lifecycle regressions. No socket, unit, /proc, key or cgroup access."""
import importlib.util
import sys
import unittest
from unittest import mock
from types import SimpleNamespace
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
    def test_descriptor_requires_root_readonly_directory_on_the_cgroup_mount(self):
        valid={'st_mode':peer.stat.S_IFDIR|0o755,'st_uid':0,'st_dev':11,'st_ino':12}
        for change,flags in [({'st_uid':1001},peer.os.O_RDONLY),({'st_dev':99},peer.os.O_RDONLY),({'st_mode':peer.stat.S_IFDIR|0o777},peer.os.O_RDONLY),({},peer.os.O_RDWR)]:
            with mock.patch.object(peer.os,'fstat',return_value=SimpleNamespace(**dict(valid,**change))),mock.patch.object(peer.os,'stat',return_value=SimpleNamespace(st_dev=11)),mock.patch.object(peer.os,'readlink',return_value='/sys/fs/cgroup'+PATH),mock.patch.object(peer.fcntl,'fcntl',return_value=flags):
                with self.assertRaises(Exception):peer.cgroup_identity(77,IDENTITY)
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
class AncillaryReceipt(unittest.TestCase):
    def receive(self, descriptors, flags=0, envelope=IDENTITY, reply=b'{"available":true}'):
        closed=[]
        class Socket:
            def settimeout(self, _): pass
            def recvmsg(self, *_):
                ancillary=[] if descriptors is None else [(peer.socket.SOL_SOCKET,peer.socket.SCM_RIGHTS,peer.array.array('i',descriptors).tobytes())]
                return peer.json.dumps(envelope).encode()+b'\n'+reply,ancillary,flags,None
        with mock.patch.object(peer.socket,'MSG_CMSG_CLOEXEC',0,create=True),mock.patch.object(peer.os,'close',closed.append):
            try: result=peer.receive_activation(Socket(),peer.time.monotonic()+1)
            except Exception: return None,closed
        return result,closed
    def test_one_complete_descriptor_is_transferred_not_closed(self):
        result,closed=self.receive([77]);self.assertEqual(result,(IDENTITY,b'{"available":true}',77));self.assertEqual(closed,[])
    def test_missing_extra_and_truncated_descriptors_refuse_and_close_every_received_fd(self):
        for descriptors,flags,expected in [(None,0,[]),([77,88],0,[77,88]),([77],peer.socket.MSG_CTRUNC,[77])]:
            result,closed=self.receive(descriptors,flags);self.assertIsNone(result);self.assertEqual(closed,expected)
    def test_wrong_length_or_oversized_reply_closes_received_descriptor(self):
        for reply in [b'{"available":true}extra',b'x'*(peer.RESPONSE_MAX+1)]:
            result,closed=self.receive([77],reply=reply);self.assertIsNone(result);self.assertEqual(closed,[77])
    def test_client_refuses_a_key_bearing_environment_before_any_user_socket_or_unit_read(self):
        with mock.patch.dict(peer.os.environ,{'AUTH_SESSION_KEY':'fictional-test-only'},clear=True):
            with self.assertRaises(Exception):peer.client_main()

if __name__ == '__main__': unittest.main()
