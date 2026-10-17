"""Pure dependency-injected lifecycle regressions. No socket, unit, /proc, key or cgroup access."""
import ast
import pathlib
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
class PinnedCgroupReadback(unittest.TestCase):
    def state(self, *, deleted=False, events=b'populated 0\nfrozen 0\n', device=11, inode=12, path=None):
        pin=(11,12,'/sys/fs/cgroup'+PATH)
        actual_path=path if path is not None else pin[2]+(' (deleted)' if deleted else '')
        with mock.patch.object(peer.os,'fstat',return_value=SimpleNamespace(st_dev=device,st_ino=inode)), \
             mock.patch.object(peer.os,'readlink',return_value=actual_path), \
             mock.patch.object(peer.os,'lseek',return_value=0), \
             mock.patch.object(peer.os,'read',side_effect=events if isinstance(events,OSError) else None,return_value=events):
            return peer.pinned_group_state(77,88,pin)
    def test_readable_deleted_events_do_not_supply_collection_authority(self):
        for path in ['/sys/fs/cgroup'+PATH+' (deleted)',PATH+' (deleted)']:
            with self.assertRaises(Exception):self.state(path=path)
    def test_exact_mount_relative_deleted_path_with_kernel_collection_error_is_collected(self):
        # Actual cgroupfs readlink drops the mount prefix after collection, retaining this inode.
        for error in [peer.errno.ENODEV,peer.errno.ENOENT]:
            self.assertEqual(self.state(path=PATH+' (deleted)',events=OSError(error,'fictional')),'collected')
    def test_live_pinned_cgroup_still_distinguishes_population(self):
        self.assertEqual(self.state(),'empty')
        self.assertEqual(self.state(events=b'populated 1\nfrozen 0\n'),'populated')
    def test_readable_deleted_cgroup_must_not_claim_collection_while_populated(self):
        with self.assertRaises(Exception):self.state(deleted=True,events=b'populated 1\nfrozen 0\n')
    def test_deleted_readable_events_cannot_hide_changed_descriptor_or_foreign_path(self):
        for change in [{'device':99},{'inode':99},{'path':'/sys/fs/cgroup/foreign (deleted)'},{'path':'/sys/fs/cgroup'+PATH+' (deleted) (deleted)'}]:
            with self.assertRaises(Exception):self.state(deleted=True,**change)
    def test_deleted_readable_events_must_still_have_a_valid_population_record(self):
        for events in [b'frozen 0\n',b'populated 2\n',b'populated 0\nunknown 0\n',b'populated 0\n'+b'x'*512]:
            with self.assertRaises(Exception):self.state(deleted=True,events=events)
    def test_only_exact_deleted_descriptor_can_use_kernel_collection_errors(self):
        self.assertEqual(self.state(deleted=True,events=OSError(peer.errno.ENODEV,'fictional')),'collected')
        for deleted,error in [(False,peer.errno.ENODEV),(True,peer.errno.EACCES)]:
            with self.assertRaises(Exception):self.state(deleted=deleted,events=OSError(error,'fictional'))
    def test_mount_relative_collection_errors_cannot_hide_wrong_path_descriptor_or_errno(self):
        for path in [PATH,PATH+' (deleted) (deleted)',PATH+'-other (deleted)',PATH.replace(UNIT,'aihr-report-auth@other.service')+' (deleted)','/foreign/'+UNIT+' (deleted)']:
            with self.assertRaises(Exception):self.state(path=path,events=OSError(peer.errno.ENODEV,'fictional'))
        for change in [{'device':99},{'inode':99}]:
            with self.assertRaises(Exception):self.state(path=PATH+' (deleted)',events=OSError(peer.errno.ENODEV,'fictional'),**change)
        with self.assertRaises(Exception):self.state(path=PATH+' (deleted)',events=OSError(peer.errno.EACCES,'fictional'))

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

class NegativeProbeFraming(unittest.TestCase):
    def test_caller_authority_probe_reaches_strict_keys_after_valid_request_framing(self):
        probe = pathlib.Path(spec.origin).with_name('verify-internal-report-isolation.py')
        tree = ast.parse(probe.read_text())
        programs = [node.args[1] for node in ast.walk(tree)
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'as_user'
                    and len(node.args) > 1 and isinstance(node.args[1], ast.BinOp)
                    and isinstance(node.args[1].op, ast.Mod) and isinstance(node.args[1].left, ast.Constant)
                    and isinstance(node.args[1].left.value, str) and 'caller-authority' in node.args[1].left.value]
        self.assertEqual(len(programs), 1)
        self.assertIsInstance(programs[0].right, ast.Name)
        self.assertEqual(programs[0].right.id, 'SOCKET')
        source = programs[0].left.value % '/run/fictional-probe-only.sock'
        calls = [node for node in ast.walk(ast.parse(source))
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'sendall']
        self.assertEqual(len(calls), 1)
        body = ast.literal_eval(calls[0].args[0])
        self.assertEqual(body, b'{"phase":"status","subject":"caller-authority"}\n')
        self.assertEqual(peer.json.loads(body), {'phase':'status','subject':'caller-authority'})

class EffectiveServiceCredentials(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source=pathlib.Path(spec.origin).with_name('verify-internal-report-isolation.py')
        probe_spec=importlib.util.spec_from_file_location('probe_under_test',source)
        cls.probe=importlib.util.module_from_spec(probe_spec);probe_spec.loader.exec_module(cls.probe)
    def test_actual_effective_group_overrides_an_unrelated_passwd_default_and_keeps_supplementary_groups(self):
        status='Name:\tnode\nUid:\t1001 1001 1001 1001\nGid:\t777 777 777 777\nGroups:\t404 777 888\n'
        self.assertEqual(self.probe.service_credentials(status,1001),(1001,777,[404,777,888]))
    def test_changed_uid_or_nonreproducible_gid_identity_refuses(self):
        for uid,gid in [('1002 1002 1002 1002','777 777 777 777'),('1001 1001 0 1001','777 777 777 777'),('1001 1001 1001 1001','777 778 777 777')]:
            with self.assertRaises(Exception):self.probe.service_credentials('Uid:\t'+uid+'\nGid:\t'+gid+'\nGroups:\t777\n',1001)
    def test_missing_or_duplicate_status_rows_refuse(self):
        for status in ['Uid:\t1001 1001 1001 1001\nGroups:\t777\n','Uid:\t1001 1001 1001 1001\nGid:\t777 777 777 777\nGid:\t777 777 777 777\nGroups:\t777\n']:
            with self.assertRaises(Exception):self.probe.service_credentials(status,1001)
    def test_namespace_calls_do_not_supply_passwd_group_defaults(self):
        tree=ast.parse(pathlib.Path(spec.origin).with_name('verify-internal-report-isolation.py').read_text())
        calls=[node for node in ast.walk(tree) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='process_environment_denial']
        self.assertEqual(len(calls),2)
        self.assertTrue(all(len(node.args)==4 for node in calls))

if __name__ == '__main__': unittest.main()
