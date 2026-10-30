import hashlib
import json
import io
import os
import shutil
import subprocess
import sys
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
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

    def test_capacity_is_derived_from_bundle_and_actual_javascript_contract(self):
        javascript=Path(__file__).with_name('build-production.mjs').resolve().as_uri()
        script='import {BUILD_CAPACITY_PROFILE} from '+json.dumps(javascript)+';console.log(JSON.stringify(BUILD_CAPACITY_PROFILE));'
        actual=json.loads(subprocess.run(['node','--input-type=module','-e',script],capture_output=True,text=True,check=True).stdout)
        self.assertEqual(module.CAPACITY_PROFILE,actual)
        self.assertEqual(module.CAPACITY_PROFILE,module.bundle.CAPACITY_PROFILE)
        self.assertEqual((module.MAX_ARCHIVE,module.MAX_ZIP,module.LIMITS['bytes/build-bundle.tar.gz']),
                         (276824064,293601280,276824064))
        self.assertEqual(module.LIMITS['bytes/build-bundle-files.json'],16*1024**2)

    def test_individually_legal_declared_members_over_aggregate_refuse_before_output(self):
        digest=self.archive_with()
        entries=[]
        for name,limit in module.LIMITS.items():
            info=zipfile.ZipInfo(name);info.file_size=limit;entries.append(info)
        self.assertGreater(sum(i.file_size for i in entries),module.MAX_ZIP)
        # Unit-test hostile decoder metadata without allocating hundreds of MiB or changing real caps.
        with mock.patch.object(module.zipfile,'ZipFile') as constructor:
            reader=constructor.return_value.__enter__.return_value;reader.infolist.return_value=entries
            with self.assertRaisesRegex(ValueError,'declared ZIP member aggregate'):
                module.extract(self.archive,self.output,digest)
            reader.open.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_streamed_aggregate_growth_refuses_and_removes_only_owned_output(self):
        digest=self.archive_with();limit=self.archive.stat().st_size+10
        entries=[zipfile.ZipInfo(name) for name in module.LIMITS]
        for info in entries:info.file_size=0
        # A bounded fake decoder expands beyond the aggregate while remaining inside the first member cap.
        self.assertLess(limit+1,module.LIMITS[entries[0].filename])
        with mock.patch.object(module,'MAX_ZIP',limit),mock.patch.object(module.zipfile,'ZipFile') as constructor:
            reader=constructor.return_value.__enter__.return_value;reader.infolist.return_value=entries
            reader.open.return_value=io.BytesIO(b'x'*(limit+1))
            with self.assertRaisesRegex(ValueError,'streamed ZIP member aggregate'):
                module.extract(self.archive,self.output,digest)
        self.assertFalse(self.output.exists());self.assertTrue(self.archive.exists())

    def test_streamed_truncation_and_individual_growth_still_refuse(self):
        digest=self.archive_with();entries=[zipfile.ZipInfo(name) for name in module.LIMITS]
        for info in entries:info.file_size=1
        for payload,message in [(b'', 'ZIP file size differs'),
                                (b'x'*(module.LIMITS[entries[0].filename]+1),'expanded ZIP exceeds bound')]:
            with mock.patch.object(module.zipfile,'ZipFile') as constructor:
                reader=constructor.return_value.__enter__.return_value;reader.infolist.return_value=entries
                reader.open.return_value=io.BytesIO(payload)
                with self.assertRaisesRegex(ValueError,message):module.extract(self.archive,self.output,digest)
            self.assertFalse(self.output.exists())

    def test_actual_outer_zip_over_unchanged_limit_refuses_before_digest_or_output(self):
        with self.archive.open('wb') as stream:stream.truncate(module.MAX_ZIP+1)
        with mock.patch.object(module.bundle,'digest_file',side_effect=AssertionError('oversize input must not be hashed')):
            with self.assertRaisesRegex(ValueError,'oversized file'):
                module.extract(self.archive,self.output,'a'*64)
        self.assertFalse(self.output.exists())

if __name__=="__main__":unittest.main()
