import copy
import sys
sys.dont_write_bytecode=True
import importlib.util
from pathlib import Path
import tempfile
import unittest
import warnings
import zipfile

spec=importlib.util.spec_from_file_location('worker_format',Path(__file__).resolve().parents[2]/'deploy/systemd/bank_import_worker_format.py')
fmt=importlib.util.module_from_spec(spec);spec.loader.exec_module(fmt)
SOURCE='1'*40

class WorkerPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.payload={'package.json':b'{"name":"fixture"}','pnpm-lock.yaml':b'fixture-lock','tsconfig.json':b'{}','scripts/bank-import-runner.ts':b'// fixture only','node_modules/.pnpm/tsx/node_modules/tsx/package.json':b'{"name":"tsx"}'}
        entries={}
        for path,data in self.payload.items():
            entries[path]={'path':path,'type':'file','size':len(data),'sha256':fmt.digest(data),'mode':0o644}
            for parent in Path(path).parents:
                if str(parent)!='.': entries[str(parent)]={'path':str(parent),'type':'directory'}
        entries['node_modules/tsx']={'path':'node_modules/tsx','type':'symlink','target':'.pnpm/tsx/node_modules/tsx'}
        self.manifest={'format':1,'kind':'bank-import-worker-package-v1','source':SOURCE,'runtime':fmt.RUNTIME.copy(),'packageSha256':fmt.digest(self.payload['package.json']),'lockSha256':fmt.digest(self.payload['pnpm-lock.yaml']),'entries':[entries[p] for p in sorted(entries)]}
    def tearDown(self): self.temp.cleanup()
    def packet(self,manifest=None,payload=None,extra=None):
        path=self.root/'worker.zip'
        with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('worker-manifest.json',fmt.canonical(manifest or self.manifest))
            for name,data in (payload or self.payload).items(): archive.writestr('payload/'+name,data)
            if extra:
                for name,data in extra: archive.writestr(name,data)
        return path
    def changed(self,mutate):
        result=copy.deepcopy(self.manifest);mutate(result);return result
    def test_extracts_exact_closed_tree_and_resolves_pnpm_link(self):
        packet=self.packet();target=self.root/'out';target.mkdir()
        actual=fmt.extract_archive(packet,target,SOURCE,self.manifest['lockSha256'],self.manifest['packageSha256'])
        self.assertEqual(actual,self.manifest)
        for path,data in self.payload.items(): self.assertEqual((target/path).read_bytes(),data)
        self.assertEqual((target/'node_modules/tsx/package.json').read_bytes(),self.payload['node_modules/.pnpm/tsx/node_modules/tsx/package.json'])
    def test_refuses_file_content_change_even_with_matching_size(self):
        payload=self.payload.copy();payload['tsconfig.json']=b'[]';packet=self.packet(payload=payload);target=self.root/'out';target.mkdir()
        with self.assertRaisesRegex(ValueError,'bytes differ'): fmt.extract_archive(packet,target,SOURCE)
    def test_refuses_extra_or_duplicate_zip_members(self):
        with self.assertRaisesRegex(ValueError,'closed ZIP'): fmt.inspect_archive(self.packet(extra=[('extra',b'x')]),SOURCE)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            with self.assertRaisesRegex(ValueError,'duplicate ZIP'): fmt.inspect_archive(self.packet(extra=[('payload/package.json',b'bad')]),SOURCE)
    def test_refuses_escape_cycle_and_dangling_links(self):
        for target in ['/etc/passwd','../../outside','.','missing','tsx']:
            def mutate(m): next(r for r in m['entries'] if r['path']=='node_modules/tsx')['target']=target
            with self.assertRaises(ValueError): fmt.validate_manifest(self.changed(mutate),SOURCE)
    def test_refuses_symlink_ancestor_for_any_payload_file(self):
        def mutate(m):
            m['entries'] += [{'path':'node_modules/tsx/injected.js','type':'file','size':0,'sha256':fmt.digest(b''),'mode':0o644}]
            m['entries'].sort(key=lambda r:r['path'])
        with self.assertRaisesRegex(ValueError,'ancestor'): fmt.validate_manifest(self.changed(mutate),SOURCE)
    def test_refuses_source_runtime_lock_and_package_mismatch(self):
        for kwargs in [{'source':'2'*40},{'source':SOURCE,'lock_hash':'0'*64},{'source':SOURCE,'package_hash':'0'*64}]:
            with self.assertRaises(ValueError): fmt.validate_manifest(self.manifest,**kwargs)
        with self.assertRaisesRegex(ValueError,'runtime'): fmt.validate_manifest(self.changed(lambda m:m['runtime'].update(node='0.0.0')),SOURCE)
    def test_refuses_private_paths_and_duplicate_manifest_entries(self):
        for path in ['../escape','/etc/passwd','core/../escape','core/.env.production','core/scratchpad/secret','other/unreviewed']:
            with self.assertRaises(ValueError): fmt.safe_path(path)
        with self.assertRaisesRegex(ValueError,'duplicate entry'): fmt.validate_manifest(self.changed(lambda m:m['entries'].append(m['entries'][0])),SOURCE)
    def test_refuses_nonempty_or_symlink_destination(self):
        packet=self.packet();target=self.root/'out';target.mkdir();(target/'existing').write_text('preserve')
        with self.assertRaises(ValueError): fmt.extract_archive(packet,target,SOURCE)
        link=self.root/'link';link.symlink_to(target,target_is_directory=True)
        with self.assertRaises(ValueError): fmt.extract_archive(packet,link,SOURCE)
        self.assertEqual((target/'existing').read_text(),'preserve')
    def test_refuses_size_bomb_and_invalid_modes_before_extraction(self):
        with self.assertRaisesRegex(ValueError,'file entry'): fmt.validate_manifest(self.changed(lambda m:next(r for r in m['entries'] if r['type']=='file').update(size=fmt.MAX_FILE+1)),SOURCE)
        with self.assertRaisesRegex(ValueError,'file entry'): fmt.validate_manifest(self.changed(lambda m:next(r for r in m['entries'] if r['type']=='file').update(mode=0o4755)),SOURCE)
    def corrected_manifest(self):
        result=self.changed(lambda m:m.update(format=2,kind='bank-import-worker-package-v2',controllerSource='2'*40,producerSha256='3'*64,formatSha256='4'*64))
        for path in ['localization/registry.ts','i18n/config.ts']:
            result['entries'].append({'path':path,'type':'file','size':0,'sha256':fmt.digest(b''),'mode':0o644})
            parent=path.split('/')[0];result['entries'].append({'path':parent,'type':'directory'})
        result['entries'].sort(key=lambda row:row['path']);return result
    def test_corrected_activation_binds_controller_and_required_country_and_language_roots(self):
        manifest=self.corrected_manifest();fmt.require_activation_manifest(manifest,'2'*40)
        with self.assertRaisesRegex(ValueError,'controller differs'): fmt.require_activation_manifest(manifest,'5'*40)
        for missing in ['localization/registry.ts','i18n/config.ts']:
            broken=copy.deepcopy(manifest);broken['entries']=[row for row in broken['entries'] if row['path']!=missing]
            with self.assertRaisesRegex(ValueError,'closure missing'): fmt.require_activation_manifest(broken,'2'*40)
    def test_original_v1_is_byte_evidence_only_and_keeps_its_original_root_policy(self):
        fmt.validate_manifest(self.manifest,SOURCE)
        with self.assertRaisesRegex(ValueError,'not an activation'): fmt.require_activation_manifest(self.manifest)
        forged=self.corrected_manifest();forged.update(format=1,kind='bank-import-worker-package-v1')
        for key in ['controllerSource','producerSha256','formatSha256']: del forged[key]
        with self.assertRaisesRegex(ValueError,'v1 payload root'): fmt.validate_manifest(forged,SOURCE)

unittest.main()
