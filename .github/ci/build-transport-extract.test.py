import hashlib
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile
spec=importlib.util.spec_from_file_location("extractor",Path(__file__).with_name("build-transport-extract.py"))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Extraction(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.root.chmod(0o700)
        self.archive=self.root/"input.zip";self.output=self.root/"out"
    def tearDown(self): self.temp.cleanup()
    def archive_with(self, extra=None, remove=None, symlink=False):
        with zipfile.ZipFile(self.archive,"w") as z:
            for name in module.LIMITS:
                if name==remove:continue
                if symlink and name=="build-provenance.json":
                    info=zipfile.ZipInfo(name);info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(info,b"elsewhere")
                else:z.writestr(name,b"fixture-"+name.encode())
            if extra:z.writestr(extra,b"extra")
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()
    def test_exact_regular_inventory(self):
        digest=self.archive_with();module.extract(self.archive,self.output,digest)
        self.assertEqual({str(p.relative_to(self.output)) for p in self.output.rglob("*") if p.is_file()},set(module.LIMITS))
    def test_digest_refusal_before_output(self):
        self.archive_with()
        with self.assertRaisesRegex(ValueError,"digest differs"):module.extract(self.archive,self.output,"a"*64)
        self.assertFalse(self.output.exists())
    def test_extra_traversal_and_missing_refuse(self):
        for extra,remove in [("../escape",None),("extra",None),(None,"system-testing.json")]:
            digest=self.archive_with(extra=extra,remove=remove)
            with self.assertRaises(ValueError):module.extract(self.archive,self.output,digest)
            self.assertFalse(self.output.exists())
    def test_duplicate_and_symlink_refuse(self):
        for options in [dict(extra="system-testing.json"),dict(symlink=True)]:
            digest=self.archive_with(**options)
            with self.assertRaises(ValueError):module.extract(self.archive,self.output,digest)
            self.assertFalse(self.output.exists())
    def test_existing_output_untouched(self):
        digest=self.archive_with();self.output.mkdir();(self.output/"sentinel").write_text("keep")
        with self.assertRaises(FileExistsError):module.extract(self.archive,self.output,digest)
        self.assertEqual((self.output/"sentinel").read_text(),"keep")
    def test_oversize_header_refuses_before_output(self):
        digest=self.archive_with()
        original=module.LIMITS["system-testing.json"];module.LIMITS["system-testing.json"]=1
        try:
            with self.assertRaises(ValueError):module.extract(self.archive,self.output,digest)
        finally:module.LIMITS["system-testing.json"]=original
        self.assertFalse(self.output.exists())
if __name__=="__main__":unittest.main()
