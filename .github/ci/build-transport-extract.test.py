import hashlib
import json
import os
import shutil
import subprocess
import sys
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
    def test_real_cli_does_not_dirty_controller_with_local_import_bytecode(self):
        digest=self.archive_with()
        frozen=json.loads((Path(__file__).parent/"fixtures/build-extractor-bytecode-original.json").read_text())
        self.assertEqual(frozen["source"],"2b22122911aa3e2e5ea9c5175c5bc24144742ef7")
        clean_env={k:v for k,v in os.environ.items() if k not in {"PYTHONDONTWRITEBYTECODE","PYTHONPYCACHEPREFIX"}}
        observed=[]
        for label,code in [("original",frozen["code"]),("current",Path(module.__file__).read_text())]:
            controller=self.root/label;controller.mkdir(mode=0o700)
            entry=controller/"build-transport-extract.py";entry.write_text(code)
            shutil.copyfile(Path(module.__file__).with_name("build-bundle.py"),controller/"build-bundle.py")
            result=subprocess.run([sys.executable,str(entry),str(self.archive),str(controller/"out"),digest],env=clean_env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            observed.append((controller/"__pycache__").exists())
        self.assertEqual(observed,[True,False],"Old CLI dirties checkout; repaired CLI must not create bytecode even without caller flags")

if __name__=="__main__":unittest.main()
