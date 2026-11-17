"""Actual temporary files and deterministic filesystem races; standard hosted Linux, no live target."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fences',ROOT/'deploy/systemd/bank_import_worker_fences_v1.py')
fences=importlib.util.module_from_spec(spec);spec.loader.exec_module(fences)

class FencesTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(sys.platform,'linux','Descriptor metadata fixture requires standard Linux hosted runner')
        self.tmp=tempfile.TemporaryDirectory(prefix='aihr-worker-fences-',dir='/tmp');self.root=Path(self.tmp.name)
        self.tree=self.root/'source';self.tree.mkdir();self.file=self.tree/'pay.dat';self.file.write_bytes(b'paid')
        self.targets=self.root/'dependencies';self.targets.mkdir();(self.targets/'target').write_bytes(b'dependency')
    def tearDown(self):self.tmp.cleanup()
    def capture(self,excluded=lambda path:False,roots=None,deadline=None):
        return fences.capture_tree(self.tree,excluded,roots or [self.tree,self.targets],time.monotonic()+15 if deadline is None else deadline)
    def between(self,change):
        original=fences.enumerate_tree;count=0
        def call(*args):
            nonlocal count
            result=original(*args);count+=1
            if count==1:change()
            return result
        with patch.object(fences,'enumerate_tree',side_effect=call):
            with self.assertRaises((ValueError,OSError)):self.capture()
    def test_stable_complete_metadata_hash_and_actual_identity(self):
        (self.tree/'empty').mkdir();result=self.capture();info=self.file.stat()
        self.assertEqual(result['format'],1);self.assertEqual(result['nodes'],3);self.assertEqual(result['links'],0)
        self.assertEqual([r['path']for r in result['entries']],['','empty','pay.dat'])
        row=result['entries'][2];self.assertEqual(row['kind'],'file')
        expected={name:str(getattr(info,key))for name,key in zip(fences.METADATA_NAMES,fences.METADATA_FIELDS)}
        self.assertEqual(row['metadata'],expected);self.assertEqual(result['root']['inode'],str(self.tree.stat().st_ino))
        encoded=json.dumps(result['entries'],sort_keys=True,separators=(',',':'),ensure_ascii=True).encode('ascii')
        self.assertEqual(result['metadataSha256'],hashlib.sha256(encoded).hexdigest())
    def test_link_literal_and_real_resolved_target_metadata_without_implicit_traversal(self):
        (self.tree/'alias').symlink_to(self.targets/'target');r=self.capture()
        self.assertEqual(r['nodes'],3);self.assertEqual(r['links'],1)
        link=next(x for x in r['entries']if x['kind']=='link')
        self.assertEqual(link['linkTarget'],str(self.targets/'target'));self.assertEqual(link['resolvedTarget']['path'],str(self.targets/'target'))
        self.assertEqual(link['resolvedTarget']['metadata']['inode'],str((self.targets/'target').stat().st_ino))
        self.assertFalse(any(x['path'].endswith('target')for x in r['entries']))
    def test_escape_and_dangling_targets_refuse(self):
        link=self.tree/'alias';link.symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError,'escapes'):self.capture()
        link.unlink();link.symlink_to(self.targets/'missing')
        with self.assertRaises(FileNotFoundError):self.capture()
    def test_relative_link_and_internal_chain_are_bounded_and_recorded(self):
        (self.targets/'second').symlink_to('target');(self.tree/'alias').symlink_to('../dependencies/second')
        r=self.capture();link=next(x for x in r['entries']if x['kind']=='link')
        self.assertEqual(link['resolvedTarget']['path'],str(self.targets/'target'))
        self.assertEqual([x['linkTarget']for x in link['resolvedTarget']['resolution']],['target'])
    def test_link_cycle_refuses_with_finite_edge_bound(self):
        (self.targets/'a').symlink_to('b');(self.targets/'b').symlink_to('a');(self.tree/'alias').symlink_to(self.targets/'a')
        with self.assertRaisesRegex(ValueError,'resolution exceeds bound'):self.capture()
    def test_added_and_deleted_files_between_enumerations_refuse(self):
        self.between(lambda:(self.tree/'added').write_bytes(b'extra'))
        (self.tree/'added').unlink();self.between(lambda:self.file.unlink())
    def test_empty_directory_added_or_removed_refuses(self):
        self.between(lambda:(self.tree/'empty').mkdir())
        self.between(lambda:(self.tree/'empty').rmdir())
    def test_same_size_edit_with_restored_mtime_refuses(self):
        original=self.file.stat()
        def change():
            self.file.write_bytes(b'edit');os.utime(self.file,ns=(original.st_atime_ns,original.st_mtime_ns))
        self.between(change)
    def test_inode_replacement_and_mode_change_refuse(self):
        def replace():
            other=self.tree/'new';other.write_bytes(b'paid');os.replace(other,self.file)
        self.between(replace);self.between(lambda:self.file.chmod(0o600))
    def test_link_retarget_between_enumerations_refuses(self):
        (self.targets/'other').write_bytes(b'other');link=self.tree/'alias';link.symlink_to(self.targets/'target')
        def swap():link.unlink();link.symlink_to(self.targets/'other')
        self.between(swap)
    def test_link_target_edit_without_alias_change_refuses(self):
        (self.tree/'alias').symlink_to(self.targets/'target');self.between(lambda:(self.targets/'target').write_bytes(b'changed'))
    def test_directory_membership_race_during_enumeration_refuses(self):
        original=fences.os.listdir;changed=False;inode=self.tree.stat().st_ino
        def listing(fd):
            nonlocal changed
            rows=original(fd)
            if not changed and os.fstat(fd).st_ino==inode:changed=True;(self.tree/'new').write_bytes(b'appeared')
            return rows
        with patch.object(fences.os,'listdir',side_effect=listing):
            with self.assertRaisesRegex(ValueError,'membership'):self.capture()
    def test_named_file_swapped_after_lstat_before_open_refuses(self):
        original=fences.os.open;changed=False
        def opening(path,flags,*args,**kwargs):
            nonlocal changed
            if path=='pay.dat' and kwargs.get('dir_fd')is not None and not changed:
                changed=True;self.file.unlink();self.file.write_bytes(b'paid')
            return original(path,flags,*args,**kwargs)
        with patch.object(fences.os,'open',side_effect=opening):
            with self.assertRaisesRegex(ValueError,'named/descriptor'):self.capture()
    def test_directory_swap_to_symlink_before_descriptor_open_refuses(self):
        child=self.tree/'dir';child.mkdir();original=fences.os.open;changed=False
        def opening(path,flags,*args,**kwargs):
            nonlocal changed
            if path=='dir' and kwargs.get('dir_fd')is not None and not changed:
                changed=True;child.rmdir();child.symlink_to(self.targets,target_is_directory=True)
            return original(path,flags,*args,**kwargs)
        with patch.object(fences.os,'open',side_effect=opening):
            with self.assertRaises(OSError):self.capture()
    def test_link_swap_during_readlink_is_rejected_by_open_descriptor_identity(self):
        link=self.tree/'alias';link.symlink_to(self.targets/'target');(self.targets/'other').write_bytes(b'other')
        original=fences.os.readlink;changed=False
        def reading(path,*args,**kwargs):
            nonlocal changed
            text=original(path,*args,**kwargs)
            if path=='alias' and kwargs.get('dir_fd')is not None and not changed:
                changed=True;link.unlink();link.symlink_to(self.targets/'other')
            return text
        with patch.object(fences.os,'readlink',side_effect=reading):
            with self.assertRaisesRegex(ValueError,'link changed'):self.capture()
    def test_refused_capture_does_not_leak_held_descriptors(self):
        link=self.tree/'alias';link.symlink_to('/etc/passwd');before=len(os.listdir('/proc/self/fd'))
        for _ in range(5):
            with self.assertRaisesRegex(ValueError,'escapes'):self.capture()
        self.assertEqual(len(os.listdir('/proc/self/fd')),before)
    def test_root_and_approved_root_symlinks_are_not_followed(self):
        alias=self.root/'alias';alias.symlink_to(self.tree,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'real directory'):fences.capture_tree(alias,lambda p:False,[self.tree],time.monotonic()+10)
        with self.assertRaisesRegex(ValueError,'real directory'):self.capture(roots=[alias])
    def test_excluded_cache_policy_is_owned_by_caller_and_no_extra_exclusion(self):
        cache=self.tree/'cache';cache.mkdir();(cache/'volatile').write_bytes(b'dynamic');(self.tree/'cache-other').write_bytes(b'included')
        r=self.capture(excluded=lambda path:path=='cache')
        self.assertEqual([x['path']for x in r['entries']],['','cache-other','pay.dat'])
    def test_expired_deadline_and_mid_walk_deadline_return_no_partial_result(self):
        with self.assertRaisesRegex(ValueError,'deadline'):self.capture(deadline=time.monotonic()-1)
        original=fences.time.monotonic;calls=0;end=original()+10
        def clock():
            nonlocal calls
            calls+=1;return end+1 if calls>10 else end-1
        with patch.object(fences.time,'monotonic',side_effect=clock):
            with self.assertRaisesRegex(ValueError,'deadline'):self.capture(deadline=end)
    def test_node_bound_and_special_nodes_refuse(self):
        with patch.object(fences,'MAX_NODES',1):
            with self.assertRaisesRegex(ValueError,'node bound'):self.capture()
        os.mkfifo(self.tree/'pipe')
        with self.assertRaisesRegex(ValueError,'special node'):self.capture()
    def test_hardlink_count_change_is_observed(self):self.between(lambda:os.link(self.file,self.targets/'hardlink'))
    def test_invalid_path_and_root_contract_refuse(self):
        for roots in [[],[self.tree,self.tree],[self.tree]*17]:
            with self.assertRaises(ValueError):fences.capture_tree(self.tree,lambda p:False,roots,time.monotonic()+10)
        with self.assertRaises(ValueError):self.capture(deadline=float('inf'))
        with self.assertRaises(ValueError):fences.capture_tree(str(self.tree)+'/../source',lambda p:False,[self.tree],time.monotonic()+10)


def uid_race(uid):
    assert os.geteuid()==0 and uid>0 and sys.platform=='linux'
    with tempfile.TemporaryDirectory(prefix='aihr-worker-fences-uid-',dir='/tmp')as tmp:
        root=Path(tmp);assert root.parent==Path('/tmp') and root.name.startswith('aihr-worker-fences-uid-') and not root.is_symlink()
        inode=root.stat().st_ino;file=root/'row';file.write_bytes(b'fixed');original=fences.enumerate_tree;count=0
        def changed(*args):
            nonlocal count
            result=original(*args);count+=1
            if count==1:os.chown(file,uid,-1)
            return result
        with patch.object(fences,'enumerate_tree',side_effect=changed):
            try:fences.capture_tree(root,lambda p:False,[root],time.monotonic()+10)
            except ValueError as error:assert 'enumerations differ' in str(error)
            else:raise AssertionError('Actual UID change must refuse')
        assert root.stat().st_ino==inode and file.stat().st_uid==uid
        print(json.dumps({'kind':'ACTUAL_UID_METADATA_DRIFT_REFUSED','uid':uid,'ownedTemporaryFilesOnly':True,'releaseAuthorized':False}))

if __name__=='__main__':
    if sys.argv[1:2]==['--uid-race']:uid_race(int(sys.argv[2]))
    else:unittest.main()
