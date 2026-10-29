"""Private byte fixtures for a known pnpm shim's relocated NODE_PATH; no command is executed."""
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location("fixtures",Path(__file__).with_name("build-bundle.test.py"))
fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)
bundle=fixtures.bundle

class InstallerPathComparison(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.BundleTests();self.fixture.setUp()
        for name in ["source","target","output","destination"]:
            setattr(self,name,getattr(self.fixture,name))
        for root in [self.source,self.target]:
            package=root/"node_modules/.store/sharp"
            (package/"package.json").write_text('{"name":"sharp","version":"0.35.5"}')
            shim=package/"node_modules/.bin/semver";shim.parent.mkdir(parents=True)
            cli=root/"node_modules/.store/semver/bin/semver.js";cli.parent.mkdir(parents=True);cli.write_text("// semver cli\n")
            other=root/"node_modules/.store/other/bin/other.js";other.parent.mkdir(parents=True);other.write_text("// other cli\n")
            shim.write_text(self.wrapper(root,"../../../semver/bin/semver.js"))
        self.shim=self.target/"node_modules/.store/sharp/node_modules/.bin/semver"
    @staticmethod
    def wrapper(root,target):
        # pnpm's real layout: two exec lines naming the same target, and NODE_PATH holding the runtime prefix.
        return ('#!/bin/sh\nbasedir=fixture\nexport NODE_PATH="'+str(root/"node_modules")+'/.pnpm/node_modules"\n'
                'if [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/'+target+'" "$@"\nelse\n  exec node  "$basedir/'+target+'" "$@"\nfi\n')
    def tearDown(self):self.fixture.tearDown()
    def packed(self):return self.fixture.packed()
    def test_default_raw_comparison_refuses_and_explicit_origin_preserves_every_other_byte(self):
        m,archive,manifest=self.packed();before=self.shim.read_bytes()
        with self.assertRaisesRegex(ValueError,"installed external package differs"):bundle.unpack(archive,manifest,self.destination,self.target)
        self.assertFalse(self.destination.exists())
        bundle.unpack(archive,manifest,self.destination,self.target,str(self.source))
        self.assertEqual(self.shim.read_bytes(),before)
        self.assertTrue((self.destination/"node_modules/sharp-aaaaaaaa").is_symlink())
    def test_wrong_original_prefix_refuses(self):
        _,archive,manifest=self.packed()
        with self.assertRaises(ValueError):bundle.unpack(archive,manifest,self.destination,self.target,str(self.source.parent/"other-producer"))
        self.assertFalse(self.destination.exists())
    def test_changed_cli_command_refuses_after_path_comparison(self):
        _,archive,manifest=self.packed();self.shim.write_text(self.shim.read_text().replace("exec node","exec evil"))
        with self.assertRaises(ValueError):bundle.unpack(archive,manifest,self.destination,self.target,str(self.source))
        self.assertFalse(self.destination.exists())
    def test_other_package_code_is_never_path_normalized(self):
        package=self.source/"node_modules/.store/sharp";runtime=self.target/"node_modules/.store/sharp"
        (package/"index.js").write_text('module.exports='+repr(str(self.source/"node_modules")))
        (runtime/"index.js").write_text('module.exports='+repr(str(self.target/"node_modules")))
        _,archive,manifest=self.packed()
        with self.assertRaises(ValueError):bundle.unpack(archive,manifest,self.destination,self.target,str(self.source))
        self.assertFalse(self.destination.exists())
    def test_stale_producer_shim_in_receiver_is_refused_even_if_original_hash_matches(self):
        _,archive,manifest=self.packed()
        self.shim.write_bytes((self.source/"node_modules/.store/sharp/node_modules/.bin/semver").read_bytes())
        with self.assertRaisesRegex(ValueError,"does not belong to this runtime"):bundle.unpack(archive,manifest,self.destination,self.target,str(self.source))
        self.assertFalse(self.destination.exists())
    def test_runtime_prefix_outside_node_path_and_noncanonical_origin_refuse(self):
        data=self.shim.read_bytes()+('echo "'+str(self.target/"node_modules")+'"\n').encode()
        with self.assertRaisesRegex(ValueError,"outside generated NODE_PATH"):bundle.rebase_installer_shim(data,self.target,str(self.source))
        for origin in ["relative",str(self.source)+"/../elsewhere",str(self.target)]:
            with self.assertRaises(ValueError):bundle.rebase_installer_shim(self.shim.read_bytes(),self.target,origin)

    def test_the_same_target_spelled_through_a_sibling_link_is_accepted(self):
        # The real staging case (29 October 2026): CI's fresh install spells the store path, the box's incremental
        # relink spells it through the sibling `semver` link. Both resolve to one file, so both wrappers hash alike.
        import shutil
        for root in [self.source,self.target]:
            store=root/"node_modules/.store";real=store/"semver@7.8.5/node_modules/semver"
            real.parent.mkdir(parents=True);shutil.move(str(store/"semver"),str(real));(store/"semver").symlink_to("semver@7.8.5/node_modules/semver")
        produced=self.source/"node_modules/.store/sharp/node_modules/.bin/semver"
        produced.write_text(self.wrapper(self.source,"../../../semver@7.8.5/node_modules/semver/bin/semver.js"))
        self.shim.write_text(self.wrapper(self.target,"../../../semver/bin/semver.js"))
        _,archive,manifest=self.packed()
        bundle.unpack(archive,manifest,self.destination,self.target,str(self.source))
        self.assertTrue((self.destination/"node_modules/sharp-aaaaaaaa").is_symlink())
    def test_a_wrapper_aimed_at_another_file_still_differs(self):
        _,archive,manifest=self.packed()
        self.shim.write_text(self.wrapper(self.target,"../../../other/bin/other.js"))
        # Refused before hashing (not a semver wrapper any more) or by the hash; never accepted.
        with self.assertRaises(ValueError):bundle.unpack(archive,manifest,self.destination,self.target,str(self.source))
        self.assertFalse(self.destination.exists())
    def test_a_wrapper_target_outside_node_modules_or_missing_refuses(self):
        outside=self.root_of_target()/"outside.js";outside.write_text("// outside\n")
        for target in ["../../../../../../outside.js","../../../semver/bin/missing.js"]:
            with self.assertRaises(ValueError):bundle.resolve_installer_exec(self.wrapper(self.target,target).encode(),self.shim,self.target/"node_modules")
    def test_two_exec_lines_must_name_one_target(self):
        data=self.wrapper(self.target,"../../../semver/bin/semver.js").replace('exec node  "$basedir/../../../semver','exec node  "$basedir/../../../other',1)
        data=data.replace('other/bin/semver.js','other/bin/other.js')
        with self.assertRaisesRegex(ValueError,"exactly one target"):bundle.resolve_installer_exec(data.encode(),self.shim,self.target/"node_modules")
    def root_of_target(self):return self.target.parent

if __name__=="__main__":unittest.main()
