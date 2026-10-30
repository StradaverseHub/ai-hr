"""Byte-bundle fixtures only: no Next compilation, app, database, network or release."""
import gzip
from contextlib import redirect_stderr
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock
import sys
sys.dont_write_bytecode=True

path=Path(__file__).with_name('build-bundle.py')
if not path.exists():path=Path(__file__).with_name('aihr-build-bundle.py')
spec=importlib.util.spec_from_file_location('bundle',path);bundle=importlib.util.module_from_spec(spec);spec.loader.exec_module(bundle)

class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='aihr-build-bundle-')
        self.root=Path(self.temporary.name).resolve();self.source=self.root/'source';self.source.mkdir()
        self.dependencies(self.source)
        build=self.source/'.next'
        for name in ['server/app','static/chunks','node_modules','types','cache/turbopack','dev']:(build/name).mkdir(parents=True)
        for name,data in {'BUILD_ID':b'fixture-build\n','server/app/page.js':b'module.exports=1;','static/chunks/app.js':b'fixture browser code','cache/turbopack/large.sst':b'not runtime output','dev/source.js':b'not production output'}.items():(build/name).write_bytes(data)
        for name in ['sharp','fontkit']:(build/'node_modules'/f'{name}-aaaaaaaa').symlink_to(self.source/'node_modules'/name,target_is_directory=True)
        self.output=self.root/'bundle';self.destination=self.root/'received';self.target=self.root/'runtime';self.target.mkdir();self.dependencies(self.target)

    def tearDown(self):self.temporary.cleanup()

    def dependencies(self,source):
        modules=source/'node_modules';modules.mkdir()
        for name in ['sharp','fontkit']:
            package=modules/'.store'/name;package.mkdir(parents=True)
            (package/'package.json').write_text(json.dumps({'name':name,'version':'1.2.3'}))
            (package/'index.js').write_text('module.exports='+repr(name)+';')
            (modules/name).symlink_to(package,target_is_directory=True)

    def packed(self):
        m=bundle.pack(self.source,self.output)
        return m,self.output/'build-bundle.tar.gz',self.output/'build-bundle-files.json'

    def save(self,m,path):path.write_bytes(bundle.canonical(m))

    def rewritten(self,m,archive,manifest,members):
        with archive.open('wb') as raw,gzip.GzipFile(filename='',fileobj=raw,mode='wb',compresslevel=6,mtime=0) as gz,tarfile.open(fileobj=gz,mode='w',format=tarfile.USTAR_FORMAT) as tar:
            for info,data in members:tar.addfile(info,io.BytesIO(data))
        m['archiveBytes']=archive.stat().st_size;m['archiveSha256']=bundle.digest_file(archive);self.save(m,manifest)

    def members(self,m):
        result=[]
        for row in m['files']:
            info=tarfile.TarInfo(row['path']);info.size=row['size'];info.mode=row['mode']
            result.append((info,(self.source/'.next'/row['path']).read_bytes()))
        return result

    def refuses_extract(self,archive,manifest):
        with self.assertRaises((ValueError,OSError,tarfile.TarError,EOFError,UnicodeError)):
            bundle.unpack(archive,manifest,self.destination,self.target)
        self.assertFalse(self.destination.exists())

    def refusal_details(self, error):
        prefix='Build bundle refused: nonregular or oversized file; '
        self.assertTrue(str(error).startswith(prefix))
        self.assertNotIn(str(self.root),str(error))
        self.assertNotIn('\n',str(error))
        return json.loads(str(error)[len(prefix):])

    def test_oversized_member_refusal_identifies_exact_bound_without_reading_payload(self):
        file=self.source/'.next/server/oversized.js'
        with file.open('wb') as stream:stream.truncate(bundle.MAX_FILE+1)
        with self.assertRaises(ValueError) as caught:bundle.pack(self.source,self.output)
        self.assertEqual(self.refusal_details(caught.exception),{
            'context':'build-payload-member','path':'server/oversized.js','type':'regular',
            'sizeBytes':bundle.MAX_FILE+1,'limitBytes':bundle.MAX_FILE})
        self.assertFalse(self.output.exists())

    def test_compressed_archive_refusal_reports_actual_size_and_preserves_owned_cleanup(self):
        # Isolate the archive boundary with a smaller test-only limit; production limits never change.
        with mock.patch.object(bundle,'MAX_ARCHIVE',1):
            with self.assertRaises(ValueError) as caught:bundle.pack(self.source,self.output)
        details=self.refusal_details(caught.exception)
        self.assertEqual({k:details[k] for k in ['context','path','type','limitBytes']},{
            'context':'compressed-build-archive','path':'build-bundle.tar.gz','type':'regular','limitBytes':1})
        self.assertGreater(details['sizeBytes'],1)
        self.assertFalse(self.output.exists())

    def test_external_package_and_manifest_refusals_identify_their_distinct_bounds(self):
        file=self.source/'node_modules/.store/sharp/package.json'
        with file.open('wb') as stream:stream.truncate(256*1024+1)
        with self.assertRaises(ValueError) as caught:bundle.package_identity(self.source,'sharp')
        self.assertEqual(self.refusal_details(caught.exception),{
            'context':'external-package-manifest:sharp','path':'package.json','type':'regular',
            'sizeBytes':256*1024+1,'limitBytes':256*1024})
        file=self.root/'manifest.json'
        with file.open('wb') as stream:stream.truncate(bundle.MAX_MANIFEST+1)
        with self.assertRaises(ValueError) as caught:bundle.read_manifest(file)
        self.assertEqual(self.refusal_details(caught.exception),{
            'context':'build-manifest','path':'manifest.json','type':'regular',
            'sizeBytes':bundle.MAX_MANIFEST+1,'limitBytes':bundle.MAX_MANIFEST})

    def test_external_package_member_refusal_reports_its_distinct_size_boundary(self):
        file=self.source/'node_modules/.store/fontkit/index.js'
        with file.open('wb') as stream:stream.truncate(bundle.MAX_PACKAGE+1)
        with self.assertRaises(ValueError) as caught:bundle.package_identity(self.source,'fontkit')
        self.assertEqual(self.refusal_details(caught.exception),{
            'context':'external-package-file:fontkit','path':'index.js','type':'regular',
            'sizeBytes':bundle.MAX_PACKAGE+1,'limitBytes':bundle.MAX_PACKAGE})

    def test_nonregular_and_escaped_path_diagnostics_do_not_follow_or_read_objects(self):
        file=self.root/'blocked-fifo';os.mkfifo(file)
        with self.assertRaises(ValueError) as caught:bundle.regular(file,context='fixture',root=self.root)
        details=self.refusal_details(caught.exception);self.assertEqual(details['type'],'fifo')
        self.assertEqual(details['path'],'blocked-fifo')
        file=self.root/'escaped\nname';file.write_text('PRIVATE_CONTENT_MUST_STAY_LOCAL')
        with self.assertRaises(ValueError) as caught:bundle.regular(file,0,context='fixture',root=self.root)
        self.assertNotIn('PRIVATE_CONTENT_MUST_STAY_LOCAL',str(caught.exception))
        self.assertEqual(self.refusal_details(caught.exception)['path'],'escaped\nname')

    def test_cli_pack_measurement_is_separate_from_the_unchanged_byte_manifest(self):
        child=subprocess.run([sys.executable,str(path),'pack',str(self.source),str(self.output)],
                             capture_output=True,text=True,check=True)
        summary=json.loads(child.stdout);diagnostic,measurement=[json.loads(line) for line in child.stderr.splitlines()]
        self.assertEqual(diagnostic["kind"],"BUILD_BUNDLE_INVENTORY_DIAGNOSTIC_NOT_ADMISSION")
        self.assertFalse(diagnostic["releaseAuthorized"]);self.assertTrue(diagnostic["capacityCheckPending"])
        self.assertEqual(diagnostic["archiveBytes"],summary["archiveBytes"])
        self.assertEqual(set(summary),{'format','capacityProfile','kind','files','archiveBytes','unpackedBytes','releaseAuthorized'})
        self.assertEqual(summary['format'],2);self.assertEqual(summary['capacityProfile'],bundle.CAPACITY_PROFILE)
        self.assertEqual(set(measurement),{'kind','compressionLevel','cpuSeconds','elapsedSeconds','releaseAuthorized'})
        self.assertEqual(measurement['kind'],'BUILD_BUNDLE_PACK_MEASUREMENT_NOT_RELEASE')
        self.assertEqual(measurement['compressionLevel'],9);self.assertFalse(measurement['releaseAuthorized'])
        self.assertGreater(measurement['cpuSeconds'],0);self.assertGreater(measurement['elapsedSeconds'],0)
        manifest=self.output/'build-bundle-files.json';archive=self.output/'build-bundle.tar.gz'
        actual=bundle.unpack(archive,manifest,self.destination,self.target)
        self.assertEqual(summary['archiveBytes'],actual['archiveBytes'])
        self.assertEqual(summary['files'],len(actual['files']))
        for row in actual['files']:
            self.assertEqual((self.destination/row['path']).read_bytes(),(self.source/'.next'/row['path']).read_bytes())

    def test_round_trip_preserves_all_production_bytes_and_rebuilds_only_known_aliases(self):
        m,archive,manifest=self.packed();actual=bundle.unpack(archive,manifest,self.destination,self.target)
        self.assertEqual(m,actual);self.assertNotIn('result',m)
        self.assertEqual(m['kind'],'next-build-byte-bundle')
        self.assertEqual(archive.read_bytes()[8],2)  # Actual gzip header identifies maximum DEFLATE compression.
        for row in m['files']:self.assertEqual((self.destination/row['path']).read_bytes(),(self.source/'.next'/row['path']).read_bytes())
        self.assertTrue((self.destination/'types').is_dir())
        self.assertFalse((self.destination/'cache').exists());self.assertFalse((self.destination/'dev').exists())
        for alias in m['aliases']:
            target=(self.target/'node_modules'/alias['package']).resolve()
            self.assertEqual((self.destination/alias['path']).resolve(),target)
            self.assertNotIn(str(self.source),os.readlink(self.destination/alias['path']))
        with gzip.open(archive,'rb') as stream:
            with tarfile.open(fileobj=stream,mode='r:') as tar:
                self.assertTrue(all(t.type==tarfile.REGTYPE for t in tar));self.assertEqual(tar.pax_headers,{})

    def test_hardlinked_dependency_and_output_files_are_transported_as_regular_bytes(self):
        os.link(self.source/'node_modules/.store/sharp/index.js',self.root/'shared-store-file')
        os.link(self.source/'.next/server/app/page.js',self.root/'shared-build-file')
        m,archive,manifest=self.packed();bundle.unpack(archive,manifest,self.destination,self.target)
        self.assertEqual((self.destination/'server/app/page.js').stat().st_nlink,1)

    def test_changed_runtime_package_code_refuses_even_with_unchanged_package_json(self):
        m,archive,manifest=self.packed();(self.target/'node_modules/.store/fontkit/index.js').write_text('changed runtime code')
        self.refuses_extract(archive,manifest)

    def test_changed_runtime_package_version_refuses(self):
        m,archive,manifest=self.packed();(self.target/'node_modules/.store/sharp/package.json').write_text(json.dumps({'name':'sharp','version':'9.9.9'}))
        self.refuses_extract(archive,manifest)

    def test_arbitrary_build_symlink_refuses_without_following_it(self):
        secret=self.root/'private';secret.write_text('must not be bundled')
        (self.source/'.next/server/escape.js').symlink_to(secret)
        with self.assertRaises(ValueError):bundle.pack(self.source,self.output)
        self.assertFalse(self.output.exists())

    def test_known_alias_cannot_point_to_another_package(self):
        alias=self.source/'.next/node_modules/fontkit-aaaaaaaa';alias.unlink();alias.symlink_to(self.source/'node_modules/sharp')
        with self.assertRaises(ValueError):bundle.pack(self.source,self.output)

    def test_missing_runtime_alias_refuses(self):
        (self.source/'.next/node_modules/fontkit-aaaaaaaa').unlink()
        with self.assertRaises(ValueError):bundle.pack(self.source,self.output)

    def test_environment_file_in_build_refuses_instead_of_silently_bundling(self):
        (self.source/'.next/.env.production').write_text('fixture private data')
        with self.assertRaises(ValueError):bundle.pack(self.source,self.output)
        self.assertFalse(self.output.exists())

    def test_missing_production_id_refuses(self):
        (self.source/'.next/BUILD_ID').unlink()
        with self.assertRaises(ValueError):bundle.pack(self.source,self.output)

    def test_existing_output_directory_is_never_removed(self):
        self.output.mkdir();sentinel=self.output/'owned-by-other-attempt';sentinel.touch()
        with self.assertRaises(FileExistsError):bundle.pack(self.source,self.output)
        self.assertTrue(sentinel.exists())

    def test_existing_receiver_is_never_merged_or_removed(self):
        m,archive,manifest=self.packed();self.destination.mkdir();sentinel=self.destination/'previous';sentinel.touch()
        with self.assertRaises(FileExistsError):bundle.unpack(archive,manifest,self.destination,self.target)
        self.assertTrue(sentinel.exists())

    def test_corrupt_archive_binding_refuses_before_extraction(self):
        m,archive,manifest=self.packed()
        with archive.open('ab') as stream:stream.write(b'corruption')
        self.refuses_extract(archive,manifest)

    def test_changed_member_content_refuses_and_removes_only_new_receiver(self):
        m,archive,manifest=self.packed();members=self.members(m);info,data=members[0];members[0]=(info,b'X'+data[1:])
        self.rewritten(m,archive,manifest,members);self.refuses_extract(archive,manifest)

    def test_missing_member_refuses_complete_coverage(self):
        m,archive,manifest=self.packed();self.rewritten(m,archive,manifest,self.members(m)[:-1]);self.refuses_extract(archive,manifest)

    def test_duplicate_member_refuses(self):
        m,archive,manifest=self.packed();members=self.members(m);self.rewritten(m,archive,manifest,[members[0],*members]);self.refuses_extract(archive,manifest)

    def test_traversal_link_device_and_pax_headers_refuse_before_body_parsing(self):
        for name,typeflag in [('../escape',tarfile.REGTYPE),('BUILD_ID',tarfile.SYMTYPE),('BUILD_ID',tarfile.LNKTYPE),('BUILD_ID',tarfile.CHRTYPE),('extended',tarfile.XHDTYPE)]:
            if self.output.exists():shutil.rmtree(self.output)
            m,archive,manifest=self.packed();info=tarfile.TarInfo(name);info.type=typeflag;info.mode=0o644
            if typeflag in {tarfile.SYMTYPE,tarfile.LNKTYPE}:info.linkname='../../outside'
            self.rewritten(m,archive,manifest,[(info,b'')]);self.refuses_extract(archive,manifest)
        self.assertFalse((self.root/'escape').exists())

    def test_trailing_data_and_gzip_header_extensions_refuse(self):
        for mutate in ['tail','header']:
            if self.output.exists():shutil.rmtree(self.output)
            m,archive,manifest=self.packed()
            if mutate=='tail':
                with archive.open('ab') as stream:stream.write(gzip.compress(b'not tar padding',mtime=0))
            else:
                data=bytearray(archive.read_bytes());data[3]=8;archive.write_bytes(data)
            m['archiveBytes']=archive.stat().st_size;m['archiveSha256']=bundle.digest_file(archive);self.save(m,manifest)
            self.refuses_extract(archive,manifest)

    def test_invalid_manifest_paths_duplicates_bounds_types_and_unknown_fields_refuse(self):
        m,archive,manifest=self.packed()
        mutations=[lambda d:d.update(extra='untrusted'),lambda d:d.update(format=True),lambda d:d.update(archiveBytes=bundle.MAX_ARCHIVE+1),lambda d:d.update(unpackedBytes=bundle.MAX_UNPACKED+1),lambda d:d['files'][0].update(path='../escape'),lambda d:d['files'][0].update(mode=True),lambda d:d['files'].append(d['files'][0]),lambda d:d['aliases'][0].update(package='arbitrary'),lambda d:d['directories'].append('cache')]
        for mutate in mutations:
            value=json.loads(json.dumps(m));mutate(value);self.save(value,manifest);self.refuses_extract(archive,manifest)

    def test_pack_failure_preserves_replacement_output_and_original_error(self):
        original=bundle.scan; calls=0; moved=self.root/'owned-pack-moved'
        def replace_during_rescan(source):
            nonlocal calls
            calls+=1
            if calls==2:
                self.output.rename(moved);self.output.mkdir();(self.output/'foreign').write_text('preserve')
                raise ValueError('original pack failure')
            return original(source)
        with mock.patch.object(bundle,'scan',side_effect=replace_during_rescan):
            with self.assertRaisesRegex(ValueError,'original pack failure'):
                bundle.pack(self.source,self.output)
        self.assertEqual((self.output/'foreign').read_text(),'preserve')
        self.assertTrue((moved/'build-bundle.tar.gz').exists())

    def test_unpack_failure_preserves_replacement_destination_and_original_error(self):
        m,archive,manifest=self.packed();original=bundle.package_identity;calls=0;moved=self.root/'owned-unpack-moved'
        def replace_at_final_package_check(source,name):
            nonlocal calls
            calls+=1
            if calls==3:
                self.destination.rename(moved);self.destination.mkdir();(self.destination/'foreign').write_text('preserve')
                raise ValueError('original unpack failure')
            return original(source,name)
        with mock.patch.object(bundle,'package_identity',side_effect=replace_at_final_package_check):
            with self.assertRaisesRegex(ValueError,'original unpack failure'):
                bundle.unpack(archive,manifest,self.destination,self.target)
        self.assertEqual((self.destination/'foreign').read_text(),'preserve')
        self.assertTrue((moved/'BUILD_ID').exists())

    def test_pack_cleanup_refuses_replaced_parent_and_preserves_both_trees(self):
        parent=self.root/'selected-parent';parent.mkdir(mode=0o700);self.output=parent/'bundle'
        moved=self.root/'moved-parent';original=bundle.scan;calls=0
        def replace_parent_during_rescan(source):
            nonlocal calls
            calls+=1
            if calls==2:
                parent.rename(moved);parent.mkdir(mode=0o700);self.output.mkdir();(self.output/'foreign').write_text('preserve')
                raise ValueError('original parent failure')
            return original(source)
        with mock.patch.object(bundle,'scan',side_effect=replace_parent_during_rescan):
            with self.assertRaisesRegex(ValueError,'original parent failure') as failure:
                bundle.pack(self.source,self.output)
        self.assertIn('output parent replaced',' '.join(failure.exception.__notes__))
        self.assertEqual((self.output/'foreign').read_text(),'preserve')
        self.assertTrue((moved/'bundle/build-bundle.tar.gz').exists())

    def test_pack_refuses_shared_output_parent_before_creating_output(self):
        shared=self.root/'shared';shared.mkdir(mode=0o755)
        with self.assertRaisesRegex(ValueError,'private canonical output parent'):
            bundle.pack(self.source,shared/'output')
        self.assertFalse((shared/'output').exists())

    def test_noncanonical_duplicate_json_keys_refuse(self):
        m,archive,manifest=self.packed();data=manifest.read_bytes();manifest.write_bytes(b'{"format":2,'+data[1:])
        self.refuses_extract(archive,manifest)


    def test_verify_installed_inventory_is_read_only_and_preserves_origin(self):
        m,archive,manifest=self.packed();bundle.unpack(archive,manifest,self.destination,self.target)
        before={str(p.relative_to(self.destination)):(p.lstat().st_ino,p.lstat().st_mtime_ns,os.readlink(p) if p.is_symlink() else None if p.is_dir() else p.read_bytes()) for p in self.destination.rglob('*')}
        self.assertEqual(bundle.verify_directory(self.destination,manifest,self.target,str(self.source)),m)
        after={str(p.relative_to(self.destination)):(p.lstat().st_ino,p.lstat().st_mtime_ns,os.readlink(p) if p.is_symlink() else None if p.is_dir() else p.read_bytes()) for p in self.destination.rglob('*')}
        self.assertEqual(before,after)

    def test_verify_refuses_tampering_without_deleting_or_changing_selected_tree(self):
        m,archive,manifest=self.packed()
        def alias_change(root):
            p=root/'node_modules/fontkit-aaaaaaaa';p.unlink();p.symlink_to(self.target/'node_modules/sharp')
        mutations=[
            lambda root:(root/'server/app/page.js').write_bytes(b'changed compiled output'),
            lambda root:(root/'extra').write_text('unexpected'),
            lambda root:(root/'static/chunks/app.js').unlink(),
            lambda root:(root/'extra-directory').mkdir(),
            lambda root:(root/'server').chmod(0o777),
            lambda root:root.chmod(0o777),
            lambda root:(root/'BUILD_ID').write_text('another-build\n'),
            alias_change
        ]
        for i,mutate in enumerate(mutations):
            with self.subTest(mutation=i):
                target=self.root/f'received-{i}';bundle.unpack(archive,manifest,target,self.target);mutate(target)
                before={str(p.relative_to(target)):p.lstat().st_ino for p in target.rglob('*')}
                with self.assertRaises((ValueError,OSError)):
                    bundle.verify_directory(target,manifest,self.target,str(self.source))
                self.assertTrue(target.exists())
                self.assertEqual(before,{str(p.relative_to(target)):p.lstat().st_ino for p in target.rglob('*')})

    def test_verify_rechecks_external_packages_and_refuses_changed_runtime_code(self):
        m,archive,manifest=self.packed();bundle.unpack(archive,manifest,self.destination,self.target)
        (self.target/'node_modules/.store/sharp/index.js').write_text('changed actual package code')
        with self.assertRaisesRegex(ValueError,'external package differs'):
            bundle.verify_directory(self.destination,manifest,self.target,str(self.source))
        self.assertTrue((self.destination/'BUILD_ID').exists())

    def test_verify_refuses_an_alias_of_the_selected_directory(self):
        m,archive,manifest=self.packed();bundle.unpack(archive,manifest,self.destination,self.target)
        alias=self.root/'destination-alias';alias.symlink_to(self.destination,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'canonical installed'):
            bundle.verify_directory(alias,manifest,self.target,str(self.source))
        self.assertTrue(self.destination.exists())

    def test_verify_replacement_during_read_refuses_without_removing_either_tree(self):
        m,archive,manifest=self.packed();bundle.unpack(archive,manifest,self.destination,self.target)
        original=bundle.package_identity;calls=0;moved=self.root/'moved-verified'
        def replace_on_final_check(*args,**kwargs):
            nonlocal calls
            calls+=1
            if calls==3:
                self.destination.rename(moved);self.destination.mkdir(mode=0o700)
                (self.destination/'foreign').write_text('preserve')
            return original(*args,**kwargs)
        with mock.patch.object(bundle,'package_identity',side_effect=replace_on_final_check):
            with self.assertRaisesRegex(ValueError,'installed root changed'):
                bundle.verify_directory(self.destination,manifest,self.target,str(self.source))
        self.assertEqual((self.destination/'foreign').read_text(),'preserve')
        self.assertTrue((moved/'BUILD_ID').exists())


    def test_active_inventory_allows_only_real_generated_cache_and_still_hashes_every_compiled_byte(self):
        m,archive,manifest=self.packed();bundle.unpack(archive,manifest,self.destination,self.target)
        (self.destination/'cache').mkdir(mode=0o700);(self.destination/'cache/generated').write_text('runtime cache is not immutable build output')
        with self.assertRaises(ValueError):bundle.verify_directory(self.destination,manifest,self.target,str(self.source))
        self.assertEqual(bundle.verify_directory(self.destination,manifest,self.target,str(self.source),allow_runtime_cache=True),m)
        (self.destination/'server/app/page.js').write_text('changed compiled code')
        with self.assertRaises(ValueError):bundle.verify_directory(self.destination,manifest,self.target,str(self.source),allow_runtime_cache=True)

    def test_active_inventory_does_not_follow_a_generated_cache_symlink(self):
        m,archive,manifest=self.packed();bundle.unpack(archive,manifest,self.destination,self.target)
        outside=self.root/'outside-cache';outside.mkdir();(outside/'preserve').write_text('private')
        (self.destination/'cache').symlink_to(outside,target_is_directory=True)
        with self.assertRaises(ValueError):bundle.verify_directory(self.destination,manifest,self.target,str(self.source),allow_runtime_cache=True)
        self.assertEqual((outside/'preserve').read_text(),'private')

    def test_current_capacity_contract_matches_actual_javascript_export(self):
        javascript=Path(__file__).with_name('build-production.mjs').resolve().as_uri()
        script='import {BUILD_CAPACITY_PROFILE} from '+json.dumps(javascript)+';console.log(JSON.stringify(BUILD_CAPACITY_PROFILE));'
        actual=json.loads(subprocess.run(['node','--input-type=module','-e',script],capture_output=True,text=True,check=True).stdout)
        self.assertEqual(actual,bundle.CAPACITY_PROFILE)
        self.assertEqual(bundle.CAPACITY_PROFILE,{'profileVersion':2,'archiveMaxBytes':276824064,'zipMaxBytes':293601280})
        self.assertEqual((bundle.MAX_ARCHIVE,bundle.MAX_ZIP),(276824064,293601280))
        self.assertEqual((bundle.MAX_FILE,bundle.MAX_PACKAGE,bundle.MAX_MANIFEST,bundle.MAX_UNPACKED,bundle.MAX_FILES),
                         (256*1024**2,32*1024**2,16*1024**2,2*1024**3,40000))

    def test_manifest_accepts_new_archive_range_but_only_exact_current_profile(self):
        original,archive,manifest=self.packed()
        for size in [256*1024**2+1,bundle.MAX_ARCHIVE]:
            current=json.loads(json.dumps(original));current['archiveBytes']=size
            self.assertIs(bundle.validate_manifest(current),current)
        mutations=[lambda d:d.update(format=1),lambda d:d.update(format=True),lambda d:d.pop('capacityProfile'),
            lambda d:d['capacityProfile'].update(profileVersion=True),lambda d:d['capacityProfile'].update(profileVersion=1),
            lambda d:d['capacityProfile'].update(archiveMaxBytes=256*1024**2),
            lambda d:d['capacityProfile'].update(archiveMaxBytes=float(bundle.MAX_ARCHIVE)),
            lambda d:d['capacityProfile'].update(zipMaxBytes=bundle.MAX_ZIP+1),
            lambda d:d['capacityProfile'].pop('zipMaxBytes'),lambda d:d['capacityProfile'].update(extra=1),
            lambda d:d.update(archiveBytes=bundle.MAX_ARCHIVE+1),lambda d:d['files'][0].update(size=bundle.MAX_FILE+1),
            lambda d:d.update(directories=['empty-%05d'%i for i in range(bundle.MAX_FILES)])]
        for mutate in mutations:
            current=json.loads(json.dumps(original));mutate(current)
            with self.subTest(manifest=current.get('capacityProfile'),format=current.get('format')):
                with self.assertRaises(ValueError):bundle.validate_manifest(current)

    def test_old_baseline_manifest_is_opaque_immutable_and_never_a_current_fallback(self):
        current,archive,manifest=self.packed();bundle.unpack(archive,manifest,self.destination,self.target)
        baseline=json.loads(json.dumps(current));baseline['format']=1;baseline.pop('capacityProfile')
        retained=self.root/'retained-baseline-format1.json';self.save(baseline,retained)
        before=retained.read_bytes();build_before=(self.destination/'BUILD_ID').read_bytes()
        for admit in [lambda:bundle.validate_manifest(baseline),lambda:bundle.read_manifest(retained),
                      lambda:bundle.unpack(archive,retained,self.root/'rejected-candidate',self.target),
                      lambda:bundle.verify_directory(self.destination,retained,self.target,str(self.source))]:
            with self.assertRaises(ValueError):admit()
            self.assertEqual(retained.read_bytes(),before)
            self.assertEqual((self.destination/'BUILD_ID').read_bytes(),build_before)
            self.assertFalse((self.root/'rejected-candidate').exists())
        self.assertEqual(bundle.read_manifest(manifest),current)
        self.assertEqual(bundle.verify_directory(self.destination,manifest,self.target,str(self.source)),current)

    def test_actual_oversized_archive_refuses_before_hash_or_output(self):
        current,archive,manifest=self.packed()
        current['archiveBytes']=bundle.MAX_ARCHIVE;self.save(current,manifest)
        with archive.open('wb') as stream:stream.truncate(bundle.MAX_ARCHIVE+1)
        with mock.patch.object(bundle,'digest_file',side_effect=AssertionError('oversized bytes must not be hashed')):
            with self.assertRaisesRegex(ValueError,'compressed-build-archive'):
                bundle.unpack(archive,manifest,self.destination,self.target)
        self.assertFalse(self.destination.exists())

    def test_unpack_and_verification_cli_results_bind_current_format_and_capacity(self):
        current,archive,manifest=self.packed()
        commands=[['unpack',str(archive),str(manifest),str(self.destination),str(self.target)],
                  ['verify-directory',str(self.destination),str(manifest),str(self.target),str(self.source)],
                  ['verify-active-directory',str(self.destination),str(manifest),str(self.target),str(self.source)]]
        for arguments in commands:
            result=subprocess.run([sys.executable,str(path),*arguments],capture_output=True,text=True,check=True)
            summary=json.loads(result.stdout)
            self.assertEqual(summary['format'],2);self.assertEqual(summary['capacityProfile'],bundle.CAPACITY_PROFILE)
            self.assertEqual(summary['archiveBytes'],current['archiveBytes']);self.assertFalse(summary['releaseAuthorized'])


    def test_pack_inventory_uses_actual_rows_and_never_discloses_content_or_excluded_tree(self):
        chunks=self.source/'.next/server/chunks';chunks.mkdir()
        secret=b'PRIVATE_SOURCE_CONTENT_MUST_NOT_APPEAR_IN_DIAGNOSTIC'
        (chunks/'observed.js').write_bytes(secret)
        (chunks/'observed.js.map').write_bytes(b'x'*123)
        (self.source/'.next/cache/turbopack/excluded-private.sst').write_bytes(b'CACHE_CONTENT_NOT_IN_PAYLOAD')
        log=io.StringIO()
        with redirect_stderr(log):manifest,archive,metadata=self.packed()
        lines=log.getvalue().splitlines();self.assertEqual(len(lines),1)
        actual=json.loads(lines[0])
        self.assertEqual(set(actual),{'kind','diagnosticVersion','releaseAuthorized','capacityCheckPending','capacityProfile',
            'compressionLevel','archiveBytes','archiveLimitBytes','files','directories','externalAliases','unpackedBytes',
            'directoryTotals','extensionTotals','memberListDigestFormat','memberListSha256','largestMembers'})
        self.assertEqual(actual['files'],len(manifest['files']))
        self.assertEqual(actual['directories'],len(manifest['directories']))
        self.assertEqual(actual['externalAliases'],2)
        self.assertEqual(actual['unpackedBytes'],sum(row['size'] for row in manifest['files']))
        self.assertEqual(actual['archiveBytes'],archive.stat().st_size)
        self.assertEqual(actual['archiveLimitBytes'],276824064)
        self.assertEqual(actual['capacityProfile'],bundle.CAPACITY_PROFILE)
        self.assertEqual(actual['compressionLevel'],9)
        expected_digest=hashlib.sha256()
        for row in manifest['files']:
            expected_digest.update((json.dumps(row,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False)+'\n').encode())
        self.assertEqual(actual['memberListSha256'],expected_digest.hexdigest())
        self.assertEqual(actual['directoryTotals']['server/chunks'],{'files':2,'bytes':len(secret)+123})
        self.assertEqual(actual['extensionTotals']['.map'],{'files':1,'bytes':123})
        self.assertEqual(sum(row['bytes'] for row in actual['directoryTotals'].values()),manifest['unpackedBytes'])
        self.assertEqual(sum(row['files'] for row in actual['extensionTotals'].values()),len(manifest['files']))
        self.assertEqual(actual['largestMembers'],sorted(manifest['files'],key=lambda row:(-row['size'],row['path']))[:20])
        self.assertNotIn(secret.decode(),log.getvalue());self.assertNotIn(str(self.root),log.getvalue())
        self.assertNotIn('excluded-private.sst',log.getvalue());self.assertNotIn('CACHE_CONTENT_NOT_IN_PAYLOAD',log.getvalue())
        self.assertFalse(actual['releaseAuthorized']);self.assertTrue(actual['capacityCheckPending'])
        self.assertLessEqual(len(log.getvalue().encode()),32768)

    def test_pack_inventory_is_deterministic_capped_and_does_not_change_archived_bytes_or_manifest(self):
        for i in range(60):
            (self.source/'.next/server/app'/('bounded-%02d.js'%i)).write_bytes(b'x'*(i+1))
        first_log=io.StringIO();second_log=io.StringIO()
        with redirect_stderr(first_log):first,archive,metadata=self.packed()
        with redirect_stderr(second_log):second=bundle.pack(self.source,self.root/'second-output')
        self.assertEqual(first_log.getvalue(),second_log.getvalue())
        self.assertEqual(first,second)
        actual=json.loads(first_log.getvalue())
        self.assertEqual(len(actual['largestMembers']),20)
        self.assertEqual(actual['files'],63)
        self.assertEqual(set(actual['directoryTotals']),set(bundle.PACK_DIAGNOSTIC_DIRECTORIES))
        self.assertEqual(set(actual['extensionTotals']),set(bundle.PACK_DIAGNOSTIC_EXTENSIONS))
        self.assertLessEqual(len(first_log.getvalue().encode()),32768)
        # Disabling metadata emission changes neither the deterministic gzip stream nor canonical manifest.
        with mock.patch.object(bundle,'emit_pack_inventory_diagnostic') as emission:
            unchanged=bundle.pack(self.source,self.root/'metadata-disabled-output')
        emission.assert_called_once();self.assertEqual(first,unchanged)
        self.assertEqual(archive.read_bytes(),(self.root/'metadata-disabled-output/build-bundle.tar.gz').read_bytes())
        self.assertEqual(metadata.read_bytes(),(self.root/'metadata-disabled-output/build-bundle-files.json').read_bytes())

    def test_oversized_archive_still_fails_after_diagnostic_before_hash_manifest_and_cleans_everything(self):
        output=io.StringIO();original_digest=bundle.digest_file
        def reject_archive_hash(file):
            if Path(file).name=='build-bundle.tar.gz':raise AssertionError('oversized archive must not be hashed')
            return original_digest(file)
        with redirect_stderr(output),mock.patch.object(bundle,'MAX_ARCHIVE',1),mock.patch.object(bundle,'digest_file',side_effect=reject_archive_hash):
            with self.assertRaises(ValueError) as caught:bundle.pack(self.source,self.output)
        details=self.refusal_details(caught.exception)
        self.assertEqual(details['context'],'compressed-build-archive');self.assertEqual(details['limitBytes'],1)
        actual=json.loads(output.getvalue())
        self.assertEqual(actual['archiveBytes'],details['sizeBytes']);self.assertGreater(actual['archiveBytes'],1)
        self.assertTrue(actual['capacityCheckPending']);self.assertFalse(actual['releaseAuthorized'])
        self.assertFalse(self.output.exists());self.assertFalse((self.output/'build-bundle-files.json').exists())


if __name__=='__main__':unittest.main()
