"""Actual private Linux cleanup fixtures; no application, service, network or database."""
import hashlib,importlib.util,json,os,platform,shutil,sys,tempfile,unittest
from pathlib import Path
from unittest import mock
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location("cleanup_install",Path(__file__).with_name("cleanup-install.py"));cleanup=importlib.util.module_from_spec(spec);spec.loader.exec_module(cleanup)
class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="install-cleanup-");self.root=Path(self.temp.name).resolve()
        self.parent=self.root/".aihr-ci-builds";self.parent.mkdir(mode=0o700)
        self.uuid="00000000-0000-4000-8000-000000000002";self.directory=self.parent/self.uuid;self.directory.mkdir(mode=0o700)
        self.source=self.root/"source";self.source.mkdir();(self.source/".next").mkdir();(self.source/".next/BUILD_ID").write_text("new-build\n")
        (self.source/".next/app.js").write_text("active compiled bytes")
        for child in ["next","packet","audit"]:(self.directory/child).mkdir(mode=0o700)
        (self.directory/"next/BUILD_ID").write_text("old-build\n");(self.directory/"packet/bundle").write_text("owned packet")
        (self.directory/"audit/original-ci-observation").write_text("original build bytes/timestamps retained")
        self.grant={"source":"a"*40,"installId":self.uuid,"baselineBuildId":"old-build","build":{"buildRecordId":"00000000-0000-4000-8000-000000000001","nextBuildId":"new-build"}}
        data=cleanup.canonical(self.grant);(self.directory/"authorization.json").write_bytes(data)
        self.authority={"format":1,"kind":"OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL","sourceDirectory":str(self.source),"source":self.grant["source"],
            "installId":self.uuid,"buildRecordId":self.grant["build"]["buildRecordId"],"nextBuildId":"new-build","authorizationSha256":hashlib.sha256(data).hexdigest(),
            "directory":cleanup.identity(self.directory.stat()),"activeDirectory":cleanup.identity((self.source/".next").stat()),
            "retainedDirectory":cleanup.identity((self.directory/"next").stat()),"packetDirectory":cleanup.identity((self.directory/"packet").stat())}
        self.save_authority()
    def save_authority(self):(self.directory/"cleanup-authorized.json").write_bytes(cleanup.canonical(self.authority))
    def tearDown(self):self.temp.cleanup()
    def run_cleanup(self):return cleanup.cleanup_install(self.directory,self.source)
    def assert_runtime_preserved(self):
        self.assertEqual((self.source/".next/BUILD_ID").read_text(),"new-build\n")
        self.assertEqual((self.source/".next/app.js").read_text(),"active compiled bytes")
    def test_actual_cleanup_removes_only_owned_trees_and_retains_original_audit_and_runtime(self):
        outside=self.root/"outside";outside.mkdir();(outside/"sentinel").write_text("preserve")
        (self.directory/"next/native-alias").symlink_to(outside,target_is_directory=True)
        sibling=self.parent/"another-install";sibling.mkdir();(sibling/"sentinel").write_text("preserve sibling")
        result=self.run_cleanup();self.assertEqual(result["verifiedAbsent"],["next","packet"]);self.assertFalse(result["releaseHandbackVerified"])
        self.assertFalse((self.directory/"next").exists());self.assertFalse((self.directory/"packet").exists())
        self.assertEqual((outside/"sentinel").read_text(),"preserve");self.assertEqual((sibling/"sentinel").read_text(),"preserve sibling")
        self.assertEqual((self.directory/"audit/original-ci-observation").read_text(),"original build bytes/timestamps retained")
        self.assert_runtime_preserved()
    def test_replay_rechecks_absence_and_runtime_without_deleting_evidence(self):
        first=self.run_cleanup();before=(self.directory/"cleanup-result.json").read_bytes()
        self.assertEqual(self.run_cleanup(),first);self.assertEqual((self.directory/"cleanup-result.json").read_bytes(),before);self.assert_runtime_preserved()
    def test_packet_symlink_refuses_before_either_owned_tree_is_removed(self):
        shutil.rmtree(self.directory/"packet");outside=self.root/"outside";outside.mkdir();(outside/"keep").touch();(self.directory/"packet").symlink_to(outside,target_is_directory=True)
        with self.assertRaises(ValueError):self.run_cleanup()
        self.assertTrue((self.directory/"next/BUILD_ID").exists());self.assertTrue((outside/"keep").exists());self.assert_runtime_preserved()
    def test_replacement_packet_directory_refuses_and_preserves_replacement(self):
        (self.directory/"packet").rename(self.directory/"packet-moved");(self.directory/"packet").mkdir();(self.directory/"packet/foreign").write_text("preserve")
        with self.assertRaises(ValueError):self.run_cleanup()
        self.assertEqual((self.directory/"packet/foreign").read_text(),"preserve");self.assertTrue((self.directory/"next").exists())
    def test_wrong_active_build_or_directory_refuses_before_cleanup(self):
        (self.source/".next/BUILD_ID").write_text("wrong-build\n")
        with self.assertRaises(ValueError):self.run_cleanup()
        self.assertTrue((self.directory/"packet").exists());self.assertTrue((self.directory/"next").exists())
    def test_changed_grant_or_old_build_refuses_without_mutation(self):
        original=(self.directory/"authorization.json").read_bytes();(self.directory/"authorization.json").write_bytes(original+b" ")
        with self.assertRaises(ValueError):self.run_cleanup()
        (self.directory/"authorization.json").write_bytes(original);(self.directory/"next/BUILD_ID").write_text("unexpected\n")
        with self.assertRaises(ValueError):self.run_cleanup()
        self.assertTrue((self.directory/"packet").exists());self.assertTrue((self.directory/"next").exists())
    def test_partial_delete_failure_retains_intent_and_retry_verifies_remaining_owned_cleanup(self):
        original=shutil.rmtree
        def interrupted(name,*args,**kwargs):
            if name=="packet":raise OSError("private simulated cleanup interruption")
            return original(name,*args,**kwargs)
        with mock.patch.object(cleanup.shutil,"rmtree",side_effect=interrupted):
            with self.assertRaisesRegex(OSError,"simulated"):self.run_cleanup()
        self.assertFalse((self.directory/"next").exists());self.assertTrue((self.directory/"packet").exists());self.assertTrue((self.directory/"cleanup-intent.json").exists())
        self.assertEqual(self.run_cleanup()["verifiedAbsent"],["next","packet"]);self.assert_runtime_preserved()
    def test_replaced_parent_path_preserves_foreign_tree_and_refuses_final_result(self):
        original=shutil.rmtree;moved=self.parent/"moved-owned";called=False
        def replace(name,*args,**kwargs):
            nonlocal called
            if not called:
                called=True;self.directory.rename(moved);self.directory.mkdir(mode=0o700);(self.directory/"foreign").write_text("preserve")
            return original(name,*args,**kwargs)
        with mock.patch.object(cleanup.shutil,"rmtree",side_effect=replace):
            with self.assertRaisesRegex(ValueError,"path replaced"):self.run_cleanup()
        self.assertEqual((self.directory/"foreign").read_text(),"preserve");self.assertTrue((moved/"packet").exists());self.assertFalse((moved/"cleanup-result.json").exists());self.assert_runtime_preserved()
    def test_non_linux_or_missing_authority_refuses(self):
        with mock.patch.object(cleanup.platform,"system",return_value="Darwin"):
            with self.assertRaises(ValueError):self.run_cleanup()
        (self.directory/"cleanup-authorized.json").unlink()
        with self.assertRaises(FileNotFoundError):self.run_cleanup()
        self.assertTrue((self.directory/"next").exists())
if __name__=="__main__":unittest.main()
