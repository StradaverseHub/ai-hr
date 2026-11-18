"""Hosted Linux: fresh full runtime hashing, adversarial identity changes and actual memory cap."""
import hashlib,importlib.util,json,os,resource,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('runtime_hash_owner',ROOT/'deploy/systemd/bank_import_worker_ci_runtime_v1.py')
owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
def check(ok,message):
    if not ok:raise ValueError(message)
base=SimpleNamespace(check=check)

if '--memory-child'in sys.argv:
    index=sys.argv.index('--memory-child');path=Path(sys.argv[index+1]);expected=sys.argv[index+2]
    resource.setrlimit(resource.RLIMIT_AS,(64*1024**2,64*1024**2))
    assert owner.bounded_file_sha256(base,path,128*1024**2)==expected
    print(json.dumps({'kind':'ACTUAL_FULL_96MIB_RUNTIME_HASH_UNDER_64MIB_ADDRESS_SPACE','fileBytes':path.stat().st_size,'maxRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'completeFreshBytes':True}))
    raise SystemExit(0)

class RuntimeHashTests(unittest.TestCase):
    def fixture(self,data=b'actual pinned executable bytes'):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);p=Path(temp.name)/'node';p.write_bytes(data);return p
    def test_fresh_complete_reads_every_call_without_cache(self):
        data=b'a'*(3*1024**2+17);path=self.fixture(data);real=os.read;counts=[]
        def read(fd,n):
            self.assertLessEqual(n,1024**2);block=real(fd,n);counts.append(len(block));return block
        with patch.object(owner.os,'read',side_effect=read):
            for expected in (data,b'b'*len(data)):
                path.write_bytes(expected);before=sum(counts)
                self.assertEqual(owner.bounded_file_sha256(base,path,128*1024**2),hashlib.sha256(expected).hexdigest())
                self.assertEqual(sum(counts)-before,len(expected))
    def test_actual_96mib_file_hash_fits_64mib_process_address_space(self):
        path=self.fixture();size=96*1024**2
        with path.open('r+b')as stream:stream.truncate(size)
        expected=hashlib.sha256();zero=bytes(1024**2)
        for _ in range(96):expected.update(zero)
        child=subprocess.run([sys.executable,'-I','-B',str(Path(__file__).resolve()),'--memory-child',str(path),expected.hexdigest()],capture_output=True,text=True,check=True,timeout=30)
        proof=json.loads(child.stdout);self.assertEqual(proof['fileBytes'],size);self.assertLess(proof['maxRssKiB'],64*1024)
        print(child.stdout.strip())
    def test_oversize_refuses_before_read(self):
        path=self.fixture(b'x'*2048)
        with patch.object(owner.os,'read',side_effect=AssertionError('oversize input was read')):
            self.assertRaisesRegex(ValueError,'bounded non-linked',owner.bounded_file_sha256,base,path,1024)
    def test_symlink_and_hardlink_refuse(self):
        path=self.fixture();link=path.with_name('link');link.symlink_to(path)
        self.assertRaises(OSError,owner.bounded_file_sha256,base,link,4096)
        link.unlink();os.link(path,link)
        self.assertRaisesRegex(ValueError,'non-linked',owner.bounded_file_sha256,base,path,4096)
    def test_mutating_bytes_with_restored_mtime_still_refuses(self):
        path=self.fixture(b'a'*(2*1024**2));before=path.stat();real=os.read;changed=False
        def read(fd,n):
            nonlocal changed
            result=real(fd,n)
            if result and not changed:
                changed=True
                with path.open('r+b')as output:output.seek(1024**2);output.write(b'b')
                os.utime(path,ns=(before.st_atime_ns,before.st_mtime_ns))
            return result
        with patch.object(owner.os,'read',side_effect=read):self.assertRaisesRegex(ValueError,'runtime bytes or named identity changed',owner.bounded_file_sha256,base,path,128*1024**2)
        self.assertTrue(changed)
    def test_named_inode_replacement_refuses_even_identical_bytes(self):
        path=self.fixture(b'a'*(2*1024**2));real=os.read;changed=False
        def read(fd,n):
            nonlocal changed
            result=real(fd,n)
            if result and not changed:
                changed=True;path.rename(path.with_name('retained-original'));path.write_bytes(b'a'*(2*1024**2))
            return result
        with patch.object(owner.os,'read',side_effect=read):self.assertRaisesRegex(ValueError,'runtime bytes or named identity changed',owner.bounded_file_sha256,base,path,128*1024**2)
        self.assertTrue(changed)
    def test_mode_drift_during_fresh_read_refuses(self):
        path=self.fixture();real=os.read;changed=False
        def read(fd,n):
            nonlocal changed
            result=real(fd,n)
            if result and not changed:changed=True;path.chmod(0o700)
            return result
        with patch.object(owner.os,'read',side_effect=read):self.assertRaisesRegex(ValueError,'runtime bytes or named identity changed',owner.bounded_file_sha256,base,path,4096)
    def test_existing_absolute_slot_expiry_refuses_and_closes_fd(self):
        path=self.fixture();real=os.open;opened=[]
        def record(*args,**kw):
            fd=real(*args,**kw);opened.append(fd);return fd
        with patch.object(owner,'SLOT_DEADLINE',time.monotonic()-1),patch.object(owner.os,'open',side_effect=record):
            self.assertRaisesRegex(ValueError,'aggregate proof slot expired',owner.bounded_file_sha256,base,path,4096)
        self.assertEqual(len(opened),1);self.assertRaises(OSError,os.fstat,opened[0])
    def test_compiled_source_filters_keep_exact_anchoring_and_basename_semantics(self):
        matches=owner.source_excluder(['.git','node_modules','*.test.ts','/only/root/*.js'])
        expected={'.git':True,'nested/.git':True,'nested/.git/config':False,'node_modules':True,'a/node_modules':True,'a.test.ts':True,'nested/a.test.ts':True,'only/root/a.js':True,'only/root/deep/a.js':False,'nested/only/root/a.js':False,'plain.ts':False}
        for path,value in expected.items():self.assertEqual(matches(path),value,path)
    def test_compiled_actual_owner_filters_match_prior_grammar_for_complete_source_paths(self):
        actual_base=SimpleNamespace(check=check,read_bounded=lambda p,n:p.read_bytes())
        filters=owner.canonical_filters(actual_base,ROOT);matches=owner.source_excluder(filters)
        names=['file.ts','file.test.ts','.git','.next','node_modules','file name.js','日本語.ts','a-b','a.b','cache']
        paths=[prefix+name for prefix in('','app/','node_modules/','nested/.git/','public/','test/fixtures/')for name in names]
        paths.extend(str(path.relative_to(ROOT))for path in(ROOT/'deploy/systemd').iterdir())
        for path in paths:self.assertEqual(matches(path),owner.excluded(path,filters),path)

unittest.main()
