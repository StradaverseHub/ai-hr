"""Pure sealed-dependency provisioning controls: no native process, Git command, DB or network.
Temporary files/ZIPs are real; root-only protection is simulated solely in these controls.
"""
import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE=Path(__file__).resolve().parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

p=load('dependency_provision_subject',HERE/'bank_import_worker_throughput_proof.py')
fmt=load('dependency_provision_real_format',HERE.parent/'deploy/systemd/bank_import_worker_format.py')
SOURCE='a'*40

@contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='bank-dependency-provision-') as temporary:
        base=Path(temporary);workspace=base/'workspace';source=workspace/'source';source.mkdir(parents=True);root=base/'root';root.mkdir(mode=0o700)
        files={'package.json':b'{"name":"fictional-fixture"}\n','pnpm-lock.yaml':b'fictional-lock\n','tsconfig.json':b'{}\n','scripts/bank-import-runner.ts':b'// fictional source; never executed\n','i18n/config.ts':b'// fictional i18n\n','localization/registry.ts':b'// fictional registry\n','node_modules/.modules.yaml':b'storeDir: /producer/accepted/store\n','node_modules/.pnpm/package.cjs':b'module.exports = 42;\n','node_modules/tsx/package.json':b'{"name":"tsx"}\n'}
        directories=['i18n','localization','scripts','node_modules','node_modules/.pnpm','node_modules/tsx']
        tracked={'.gitignore':b'/node_modules\n',**{name:raw for name,raw in files.items() if not name.startswith('node_modules/')}}
        for name,raw in tracked.items():
            path=source/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
        target=source/'node_modules';target.mkdir();(target/'.modules.yaml').write_bytes(b'storeDir: /fresh/runner/store\n');(target/'fresh-only').write_bytes(b'fresh ignored install')
        rows=[{'path':name,'type':'directory'} for name in directories]
        rows += [{'path':name,'type':'file','size':len(raw),'sha256':p.digest(raw),'mode':0o644} for name,raw in files.items()]
        rows += [{'path':'node_modules/pkg','type':'symlink','target':'.pnpm/package.cjs'}]
        manifest={'format':2,'kind':'bank-import-worker-package-v2','source':SOURCE,'controllerSource':'b'*40,'producerSha256':'1'*64,'formatSha256':'2'*64,'runtime':fmt.RUNTIME,'packageSha256':p.digest(files['package.json']),'lockSha256':p.digest(files['pnpm-lock.yaml']),'entries':sorted(rows,key=lambda r:r['path'])}
        archive=root/'worker-package.zip'
        with zipfile.ZipFile(archive,'w') as packet:
            packet.writestr('worker-manifest.json',fmt.canonical(manifest))
            for name,raw in files.items(): packet.writestr('payload/'+name,raw)
        class Registry:
            def __init__(self): self.root=root;self.tree_override=None
            def run(self,argv,**options):
                self.last=argv;words=argv[argv.index('-C')+2:]
                if words[0]=='rev-parse': output=SOURCE+'\n'
                elif words[0]=='status': output=''
                elif words[0]=='check-ignore': output='node_modules\n'
                elif words[0]=='ls-tree':
                    output=''.join('100644 blob '+hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()+'\t'+name+'\0' for name,raw in sorted(tracked.items()))
                    if self.tree_override: output+=self.tree_override
                else: raise AssertionError('Unexpected Git operation')
                return SimpleNamespace(returncode=0,stdout=output,stderr='')
        registry=Registry()
        with patch.dict(os.environ,{'GITHUB_WORKSPACE':str(workspace),'SUDO_UID':str(source.stat().st_uid)}),patch.object(p,'protected',side_effect=lambda path,directory=False:Path(path).lstat()):
            yield SimpleNamespace(source=source,root=root,registry=registry,archive=archive,manifest=manifest,files=files,tracked=tracked)

def provision(f): p.provision_dependencies(f.source,f.manifest,f.archive,fmt,f.registry,SOURCE)

class DependencyProvisioning(unittest.TestCase):
    def test_installs_exact_generated_metadata_and_internal_links_without_source_changes(self):
        with fixture() as f:
            provision(f)
            self.assertEqual((f.source/'node_modules/.modules.yaml').read_bytes(),f.files['node_modules/.modules.yaml'])
            self.assertFalse((f.source/'node_modules/fresh-only').exists())
            self.assertEqual(os.readlink(f.source/'node_modules/pkg'),'.pnpm/package.cjs')
            for name,raw in f.tracked.items(): self.assertEqual((f.source/name).read_bytes(),raw)
            receipt=json.loads((f.root/'dependency-provision.json').read_bytes())
            self.assertEqual(receipt['state'],'installed');self.assertEqual(set(receipt['cleanup'].values()),{'removed'})
            before=(f.source/'node_modules').stat().st_ino;provision(f)
            self.assertEqual((f.source/'node_modules').stat().st_ino,before)

    def test_independent_git_objects_and_tracked_dependency_refusal(self):
        with fixture() as f:
            (f.source/'scripts/bank-import-runner.ts').write_bytes(b'changed tracked source despite mocked clean status')
            with self.assertRaises(ValueError): provision(f)
            self.assertFalse((f.root/'dependency-provision.json').exists())
        with fixture() as f:
            f.registry.tree_override='100644 blob '+'c'*40+'\tnode_modules/tracked\0'
            with self.assertRaises(ValueError): provision(f)
            self.assertFalse((f.root/'dependency-provision.json').exists())

    def test_fixed_target_real_directory_and_no_escaping_packet_links(self):
        with fixture() as f:
            other=f.root/'foreign';other.mkdir();target=f.source/'node_modules'
            import shutil
            shutil.rmtree(target);target.symlink_to(other,target_is_directory=True)
            with self.assertRaises(ValueError): provision(f)
            self.assertTrue(other.exists())
        with fixture() as f:
            malformed=copy.deepcopy(f.manifest)
            next(row for row in malformed['entries'] if row['type']=='symlink')['target']='../../outside'
            bad=f.root/'escaping.zip'
            with zipfile.ZipFile(bad,'w') as packet:
                packet.writestr('worker-manifest.json',fmt.canonical(malformed))
                for name,raw in f.files.items(): packet.writestr('payload/'+name,raw)
            with self.assertRaises(ValueError): p.provision_dependencies(f.source,malformed,bad,fmt,f.registry,SOURCE)
            p.cleanup_dependency_staging(f.root)
            self.assertEqual((f.source/'node_modules/.modules.yaml').read_bytes(),b'storeDir: /fresh/runner/store\n')

    def test_later_byte_or_extra_inventory_drift_is_refused_without_reset(self):
        with fixture() as f:
            provision(f);path=f.source/'node_modules/.modules.yaml';path.write_bytes(b'later drift')
            with self.assertRaises(ValueError): provision(f)
            self.assertEqual(path.read_bytes(),b'later drift')
        with fixture() as f:
            provision(f);extra=f.source/'node_modules/extra';extra.write_bytes(b'extra')
            with self.assertRaises(ValueError): provision(f)
            self.assertTrue(extra.exists())
        with fixture() as f:
            provision(f);os.link(f.source/'node_modules/.modules.yaml',f.root/'outside-hardlink')
            with self.assertRaises(ValueError): provision(f)

    def test_interrupted_fixed_swap_has_exact_cleanup_and_cannot_restart_provision(self):
        with fixture() as f:
            rename=p.rename_no_replace
            def interrupted(source,target):
                if Path(source)==f.root/'dependency-stage/node_modules': raise OSError('injected pre-install interruption')
                return rename(source,target)
            with patch.object(p,'rename_no_replace',side_effect=interrupted),self.assertRaises(OSError): provision(f)
            value=json.loads((f.root/'dependency-provision.json').read_bytes());self.assertEqual(value['state'],'install-pending')
            self.assertFalse((f.source/'node_modules').exists());self.assertTrue((f.root/'dependency-quarantine').exists())
            p.cleanup_dependency_staging(f.root)
            self.assertFalse((f.root/'dependency-stage').exists());self.assertFalse((f.root/'dependency-quarantine').exists())
            with self.assertRaises(ValueError): provision(f)
            for name,raw in f.tracked.items(): self.assertEqual((f.source/name).read_bytes(),raw)
        for collision in ['dependency-quarantine','node_modules']:
            with fixture() as f:
                rename=p.rename_no_replace;foreign=[]
                def collide(source,target):
                    target=Path(target)
                    if target.name==collision:
                        target.mkdir();foreign.append((target,target.stat().st_ino))
                    return rename(source,target)
                with patch.object(p,'rename_no_replace',side_effect=collide),self.assertRaises(OSError): provision(f)
                path,inode=foreign[0];self.assertEqual(path.stat().st_ino,inode);self.assertEqual(list(path.iterdir()),[])
                self.assertTrue((f.root/'dependency-stage/node_modules').is_dir())
                if collision=='dependency-quarantine': self.assertTrue((f.source/'node_modules/.modules.yaml').exists())
        with fixture() as f:
            with patch.object(p.ctypes,'CDLL',return_value=SimpleNamespace()),patch.object(p.os,'rename') as fallback,self.assertRaises(ValueError):
                p.rename_no_replace(f.source/'node_modules',f.root/'dependency-quarantine')
            fallback.assert_not_called();self.assertTrue((f.source/'node_modules/.modules.yaml').exists())

    def test_interrupted_staging_removal_recovers_but_changed_inode_is_retained(self):
        with fixture() as f:
            remove=p.shutil.rmtree
            def interrupted(path):
                remove(path)
                if Path(path)==f.root/'dependency-stage': raise OSError('injected after stage removal')
            with patch.object(p.shutil,'rmtree',side_effect=interrupted) as mocked:
                mocked.avoids_symlink_attacks=True
                with self.assertRaises(OSError): provision(f)
            value=json.loads((f.root/'dependency-provision.json').read_bytes());self.assertEqual(value['cleanup']['dependency-stage'],'remove-pending')
            p.cleanup_dependency_staging(f.root);provision(f)
            self.assertEqual((f.source/'node_modules/.modules.yaml').read_bytes(),f.files['node_modules/.modules.yaml'])
        with fixture() as f:
            with patch.object(p,'rename_no_replace',side_effect=OSError('injected before quarantine')),self.assertRaises(OSError): provision(f)
            value=json.loads((f.root/'dependency-provision.json').read_bytes());value['stageIdentity']['ino']+=1;p.atomic_root(f.root/'dependency-provision.json',value)
            with self.assertRaises(ValueError): p.cleanup_dependency_staging(f.root)
            self.assertTrue((f.root/'dependency-stage').exists())
        # Same major/minor device in mountinfo models a bind that st_dev cannot detect.
        for descendant in [False,True]:
            with fixture() as f:
                with patch.object(p,'rename_no_replace',side_effect=OSError('injected before quarantine')),self.assertRaises(OSError): provision(f)
                stage=f.root/'dependency-stage';mount=stage/'bind space\\name' if descendant else stage
                escaped=str(mount).replace('\\','\\134').replace(' ','\\040')
                raw=('1 0 0:99 / / rw - tmpfs tmpfs rw\n2 1 0:99 / '+escaped+' rw - tmpfs tmpfs rw\n').encode()
                self.assertIn(mount,p.parse_mountinfo(raw))
                with patch.object(p,'mountinfo_points',side_effect=lambda:p.parse_mountinfo(raw)),patch.object(p.os,'walk') as walk,self.assertRaises(ValueError): p.cleanup_dependency_staging(f.root)
                walk.assert_not_called();self.assertTrue(stage.is_dir())
        for malformed in [b'',b'1 0 0:99 / / rw - tmpfs tmpfs rw',b'1 0 0:99 / /bad\\999 rw - tmpfs tmpfs rw\n',b'bad mountinfo\n']:
            with self.assertRaises(ValueError): p.parse_mountinfo(malformed)
        encoded=b'1 0 0:99 / /space\\040tab\\011line\\012slash\\134 rw - tmpfs tmpfs rw\n'
        self.assertEqual(p.parse_mountinfo(encoded),[Path('/space tab\tline\nslash\\')])
        with patch.object(Path,'open',side_effect=OSError('unreadable mountinfo')),self.assertRaises(ValueError): p.mountinfo_points()

if __name__=='__main__':
    if not(os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('CI')=='true' and os.uname().sysname=='Linux'):
        raise SystemExit('Dependency provisioning controls require disposable GitHub Linux CI; no local execution.')
    unittest.main()
