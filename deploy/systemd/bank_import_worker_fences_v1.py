"""Bounded read-only metadata observation. No release authority, policy, command or target writes.
Callers own canonical exclusions and explicit dependency/runtime roots. Linux descriptor semantics only.
"""
from collections import deque
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import time

MAX_NODES=200000
MAX_PATH_BYTES=65536
MAX_LINKS_PER_RESOLUTION=64
MAX_APPROVED_ROOTS=16
METADATA_FIELDS=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
METADATA_NAMES=('device','inode','mode','uid','gid','nlink','size','mtimeNs','ctimeNs')


def require(ok,message):
    if not ok:raise ValueError('Complete metadata fence refused: '+message)


def clock(deadline):
    require(time.monotonic()<deadline,'absolute monotonic deadline exceeded')


def bounded_path(value):
    require(isinstance(value,str) and '\0' not in value and len(os.fsencode(value))<=MAX_PATH_BYTES,'path/link exceeds bound')
    return value


def metadata(info):
    return dict(zip(METADATA_NAMES,(str(getattr(info,key))for key in METADATA_FIELDS)))


def same(left,right):
    # Compare exact native integers; decimal serialization belongs only to emitted rows.
    return (left.st_dev,left.st_ino,left.st_mode,left.st_uid,left.st_gid,left.st_nlink,left.st_size,left.st_mtime_ns,left.st_ctime_ns)==(right.st_dev,right.st_ino,right.st_mode,right.st_uid,right.st_gid,right.st_nlink,right.st_size,right.st_mtime_ns,right.st_ctime_ns)


def canonical_directory(value,deadline):
    """Open every ancestor relative to a held descriptor, rejecting all symbolic-link ancestors."""
    raw=bounded_path(os.fspath(value));path=Path(raw)
    require(path.is_absolute() and str(path)==raw and '..' not in path.parts,'canonical absolute root required')
    clock(deadline);fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        for name in path.parts[1:]:
            clock(deadline);before=os.stat(name,dir_fd=fd,follow_symlinks=False)
            require(stat.S_ISDIR(before.st_mode),'root ancestor is not a real directory')
            opened=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            try:
                require(same(before,os.fstat(opened)) and same(before,os.stat(name,dir_fd=fd,follow_symlinks=False)),'root ancestor changed while opening')
            except BaseException:os.close(opened);raise
            os.close(fd);fd=opened;clock(deadline)
        return path,fd
    except BaseException:os.close(fd);raise


def target_identity(parent,literal,approved,deadline):
    """Resolve at most64 link edges without enumerating any target directory or reading file bytes."""
    literal=bounded_path(literal)
    combined=literal if literal.startswith('/')else str(parent)+'/'+literal
    pending=deque(combined.split('/'));parts=[];stack=[];resolution=[]
    clock(deadline);stack.append(os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC))
    try:
        while pending:
            clock(deadline);name=pending.popleft()
            if name in ('','.'):continue
            if name=='..':
                if parts:parts.pop();os.close(stack.pop())
                continue
            bounded_path('/'+'/'.join([*parts,name]));directory=stack[-1]
            before=os.stat(name,dir_fd=directory,follow_symlinks=False)
            if stat.S_ISLNK(before.st_mode):
                require(len(resolution)<MAX_LINKS_PER_RESOLUTION,'link resolution exceeds bound')
                link_fd=os.open(name,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
                try:
                    require(same(before,os.fstat(link_fd)),'resolved link named/descriptor identity differs')
                    text=bounded_path(os.readlink(name,dir_fd=directory))
                    require(same(before,os.fstat(link_fd)) and same(before,os.stat(name,dir_fd=directory,follow_symlinks=False)),'link changed during target resolution')
                finally:os.close(link_fd)
                resolution.append({'path':'/'+'/'.join([*parts,name]),'metadata':metadata(before),'linkTarget':text})
                if text.startswith('/'):
                    while len(stack)>1:os.close(stack.pop())
                    parts=[]
                pending.extendleft(reversed(text.split('/')));continue
            if stat.S_ISDIR(before.st_mode):
                child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
            else:
                require(stat.S_ISREG(before.st_mode) and not any(p not in ('','.')for p in pending),'link target is not a regular file or directory')
                child=os.open(name,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
            try:
                require(same(before,os.fstat(child)) and same(before,os.stat(name,dir_fd=directory,follow_symlinks=False)),'resolved target changed while opening')
            except BaseException:os.close(child);raise
            parts.append(name);stack.append(child);clock(deadline)
        canonical=Path('/').joinpath(*parts)
        require(any(canonical.is_relative_to(root)for root in approved),'resolved link target escapes explicit approved roots')
        info=os.fstat(stack[-1]);require(stat.S_ISDIR(info.st_mode)or stat.S_ISREG(info.st_mode),'unsupported resolved target')
        # Independently reopen the resolved canonical name without following a swapped ancestor.
        if stat.S_ISDIR(info.st_mode):
            _,check_fd=canonical_directory(str(canonical),deadline)
            try:require(same(info,os.fstat(check_fd)),'resolved target named identity changed')
            finally:os.close(check_fd)
        else:
            _,check_parent=canonical_directory(str(canonical.parent),deadline)
            try:require(same(info,os.stat(canonical.name,dir_fd=check_parent,follow_symlinks=False)),'resolved target named identity changed')
            finally:os.close(check_parent)
        clock(deadline)
        return {'path':str(canonical),'metadata':metadata(info),'resolution':resolution}
    finally:
        for fd in reversed(stack):os.close(fd)


def enumerate_tree(root,excluded,approved,deadline):
    rows=[];links=0
    canonical,root_fd=canonical_directory(root,deadline)
    def add(relative,kind,info,**extra):
        require(len(rows)<MAX_NODES,'tree exceeds node bound')
        rows.append({'path':relative,'kind':kind,'metadata':metadata(info),**extra})
    def walk(fd,relative):
        nonlocal links
        clock(deadline);before=os.fstat(fd)
        require(stat.S_ISDIR(before.st_mode),'opened directory changed type')
        add(relative,'directory',before)
        names=sorted(os.listdir(fd));clock(deadline)
        for name in names:
            clock(deadline);child=bounded_path(relative+'/'+name if relative else name)
            if excluded(child):continue
            original=os.stat(name,dir_fd=fd,follow_symlinks=False)
            if stat.S_ISDIR(original.st_mode):
                opened=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                try:
                    require(same(original,os.fstat(opened)),'directory named/descriptor identity differs')
                    walk(opened,child)
                    require(same(original,os.fstat(opened)) and same(original,os.stat(name,dir_fd=fd,follow_symlinks=False)),'directory changed during enumeration')
                finally:os.close(opened)
            elif stat.S_ISREG(original.st_mode):
                # Metadata only: no regular-file object is read, hashed or executed here.
                # Two fresh names anchored to the held parent plus full directory/two-walk
                # brackets preserve finite observations. Content consumers still need FDs.
                observed=os.stat(name,dir_fd=fd,follow_symlinks=False)
                require(stat.S_ISREG(observed.st_mode) and same(original,observed),'regular metadata changed between anchored name observations')
                add(child,'file',original)
            elif stat.S_ISLNK(original.st_mode):
                opened=os.open(name,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                try:
                    require(same(original,os.fstat(opened)),'link named/descriptor identity differs')
                    text=bounded_path(os.readlink(name,dir_fd=fd))
                    resolved=target_identity(canonical/Path(child).parent,text,approved,deadline)
                    require(same(original,os.fstat(opened)) and same(original,os.stat(name,dir_fd=fd,follow_symlinks=False)),'link changed during enumeration')
                    add(child,'link',original,linkTarget=text,resolvedTarget=resolved);links+=1
                finally:os.close(opened)
            else:raise ValueError('Complete metadata fence refused: unsupported special node')
            clock(deadline)
        clock(deadline);after_names=sorted(os.listdir(fd));clock(deadline)
        require(names==after_names and same(before,os.fstat(fd)),'directory membership or metadata changed during enumeration')
    try:
        original=os.fstat(root_fd);walk(root_fd,'')
        _,named_fd=canonical_directory(str(canonical),deadline)
        try:require(same(original,os.fstat(root_fd)) and same(original,os.fstat(named_fd)),'root named/descriptor identity changed')
        finally:os.close(named_fd)
        rows.sort(key=lambda row:row['path']);clock(deadline)
        return rows,links,original
    finally:os.close(root_fd)


def capture_tree(root,excluded,approved_link_roots,deadline):
    """Two complete stable ordered metadata enumerations or refusal. No authority or policy decisions."""
    require(type(deadline)in(int,float) and math.isfinite(deadline),'finite absolute monotonic deadline required')
    clock(deadline);require(callable(excluded),'internal canonical exclusion callback required')
    require(isinstance(approved_link_roots,(list,tuple)) and 0<len(approved_link_roots)<=MAX_APPROVED_ROOTS,'bounded explicit approved roots required')
    approved=[];root_pins=[]
    for value in approved_link_roots:
        path,fd=canonical_directory(value,deadline)
        try:approved.append(path);root_pins.append((path,metadata(os.fstat(fd))))
        finally:os.close(fd)
    require(len(set(approved))==len(approved),'duplicate approved roots')
    first,links,info=enumerate_tree(root,excluded,approved,deadline)
    second,second_links,second_info=enumerate_tree(root,excluded,approved,deadline)
    require(first==second and links==second_links and same(info,second_info),'complete enumerations differ')
    for path,pinned in root_pins:
        _,fd=canonical_directory(path,deadline)
        try:require(metadata(os.fstat(fd))==pinned,'approved target root changed during capture')
        finally:os.close(fd)
    clock(deadline)
    encoded=json.dumps(first,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode('ascii')
    digest=hashlib.sha256(encoded).hexdigest();clock(deadline)
    return {'format':1,'root':{'canonicalpath':str(Path(root)),'device':str(info.st_dev),'inode':str(info.st_ino)},'nodes':len(first),'links':links,'metadataSha256':digest,'entries':first}
