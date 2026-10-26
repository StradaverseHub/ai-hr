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
            shim.write_text('#!/bin/sh\nbasedir=fixture\nexport NODE_PATH="'+str(root/"node_modules")+'/.pnpm/node_modules"\nexec node "$basedir/../../../semver/bin/semver.js" "$@"\n')
        self.shim=self.target/"node_modules/.store/sharp/node_modules/.bin/semver"
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

if __name__=="__main__":unittest.main()
