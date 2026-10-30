"""Bounded Next build byte transport. This primitive grants no CI/release/deployment authority."""
from __future__ import annotations
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile
import time

MAX_FILES = 40000
MAX_UNPACKED = 2 * 1024**3
MAX_ARCHIVE = 256 * 1024**2
MAX_FILE = 256 * 1024**2
MAX_MANIFEST = 16 * 1024**2
MAX_PACKAGE = 32 * 1024**2
COMPRESSION_LEVEL = 9
EXCLUDED = {"cache", "dev"}
EXTERNAL_PACKAGES = {"sharp", "fontkit"}

def require(ok, message):
    if not ok:
        raise ValueError("Build bundle refused: " + message)

def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode()

def digest_file(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def safe_path(value):
    require(isinstance(value, str) and value and len(value.encode()) <= 255 and "\\" not in value and not any(ord(c) < 32 or ord(c) == 127 for c in value), "invalid payload path")
    path = PurePosixPath(value)
    require(not path.is_absolute() and path.as_posix() == value and all(p not in {"", ".", ".."} for p in value.split("/")), "unsafe payload path")
    require(path.parts[0] not in EXCLUDED and not any(p == ".env" or p.startswith(".env.") for p in path.parts), "cache/dev/environment file in payload")
    try:
        tarfile.TarInfo(value).tobuf(format=tarfile.USTAR_FORMAT, encoding="utf-8", errors="strict")
    except (ValueError, UnicodeError) as error:
        raise ValueError("Build bundle refused: unsupported bounded USTAR path") from error
    return value

def regular(path, limit=MAX_FILE, *, context="file", root=None):
    st = path.lstat()
    if not (stat.S_ISREG(st.st_mode) and not path.is_symlink() and st.st_size <= limit):
        # Refusal metadata only: never open the rejected object or disclose its contents or absolute root.
        kind = {stat.S_IFREG: "regular", stat.S_IFDIR: "directory", stat.S_IFLNK: "symlink",
                stat.S_IFIFO: "fifo", stat.S_IFSOCK: "socket", stat.S_IFCHR: "character-device",
                stat.S_IFBLK: "block-device"}.get(stat.S_IFMT(st.st_mode), "unknown")
        details = {"context": context, "path": path.relative_to(root).as_posix() if root is not None else path.name,
                   "type": kind, "sizeBytes": st.st_size, "limitBytes": limit}
        require(False, "nonregular or oversized file; " + json.dumps(details, sort_keys=True, ensure_ascii=True))
    return st

def identity(st):
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns


def rebase_installer_shim(data, source, producer_source):
    """Compare one known pnpm wrapper at its authenticated original path; do not rewrite a file."""
    original = Path(producer_source)
    require(original.is_absolute() and str(original) == str(producer_source) and original.absolute().as_posix() == str(original)
            and ".." not in original.parts and "." not in original.parts
            and str(original) != str(source) and len(str(original).encode()) <= 4096,
            "canonical distinct producer source required for installer comparison")
    current = str(source / "node_modules").encode()
    prior = str(original / "node_modules").encode()
    require(len(data) <= 16384 and data.startswith(b"#!/bin/sh\nbasedir=")
            and b"/semver/bin/semver.js" in data and b' "$@"' in data,
            "unsupported generated semver wrapper")
    require(current in data, "generated semver wrapper does not belong to this runtime source")
    out = []
    for line in data.splitlines(keepends=True):
        if current in line:
            require(line.lstrip().startswith(b'export NODE_PATH="') and line.endswith(b'"\n'),
                    "runtime prefix outside generated NODE_PATH")
            line = line.replace(current, prior)
        out.append(line)
    return b"".join(out)

SHIM_EXEC = re.compile(rb'^(\s*exec (?:"\$basedir/node"|node)\s+)"\$basedir/([^"\n]+)"( "\$@"\n)$')

def resolve_installer_exec(data, shim, modules):
    """pnpm spells the same wrapper target two ways (a fresh install writes the target's store path, an incremental
    relink writes it through the sibling symlink). Compare the RESOLVED target, as a path under this runtime's
    node_modules, so both spellings hash alike and a wrapper aimed anywhere else still differs. Nothing is rewritten
    on disk; every exec line must resolve to the same regular file inside node_modules."""
    root = Path(os.path.realpath(modules))
    out = []; targets = set()
    for line in data.splitlines(keepends=True):
        match = SHIM_EXEC.match(line)
        if match:
            relative = match.group(2).decode("utf-8")
            require(not relative.startswith("/") and "\\" not in relative, "generated semver wrapper target must be relative")
            resolved = Path(os.path.realpath(shim.parent / relative))
            require(resolved.is_relative_to(root), "generated semver wrapper target escapes runtime dependencies")
            require(resolved.is_file() and not resolved.is_symlink(), "generated semver wrapper target must be a regular file")
            key = resolved.relative_to(root).as_posix(); targets.add(key)
            line = match.group(1) + b'"$basedir/@node_modules/' + key.encode() + b'"' + match.group(3)
        out.append(line)
    require(len(targets) == 1, "generated semver wrapper must name exactly one target")
    return b"".join(out)

def package_identity(source, name, producer_source=None):
    require(name in EXTERNAL_PACKAGES, "unsupported external package")
    modules = source / "node_modules"
    require(modules.is_dir() and not modules.is_symlink() and modules.resolve() == modules, "runtime node_modules must be canonical")
    target = (modules / name).resolve(strict=True)
    require(target.is_dir() and target.is_relative_to(modules), "external package escapes runtime dependencies")
    file = target / "package.json"; regular(file, 256 * 1024, context="external-package-manifest:" + name, root=target)
    data = file.read_bytes(); value = json.loads(data)
    require(isinstance(value,dict) and value.get("name") == name and isinstance(value.get("version"), str) and re.fullmatch(r"[0-9A-Za-z.+_-]{1,80}", value["version"]), "external package identity differs")
    rows=[];total=0
    for base,dirs,files in os.walk(target,followlinks=False):
        for child in list(dirs)+files:
            require(not (Path(base)/child).is_symlink(),'unsupported symlink inside external package')
        for child in files:
            path=Path(base)/child;before=regular(path,MAX_PACKAGE,context="external-package-file:" + name,root=target);total+=before.st_size
            require(total<=MAX_PACKAGE and len(rows)<2000,'external package exceeds comparison bound')
            relative=path.relative_to(target).as_posix();size=before.st_size
            if name=='sharp' and value['version']=='0.35.5' and relative=='node_modules/.bin/semver':
                # The producer (producer_source None) and the receiver hash the same normalised form: the receiver's
                # NODE_PATH rebased to the producer's origin, and the exec target compared by where it resolves.
                require(before.st_size<=16384,'oversized generated installer shim')
                raw=path.read_bytes()
                compared=rebase_installer_shim(raw,source,producer_source) if producer_source is not None else raw
                compared=resolve_installer_exec(compared,path,modules)
                digest=hashlib.sha256(compared).hexdigest();size=len(compared)
            else:
                digest=digest_file(path)
            require(identity(path.stat())==identity(before),'external package changed while hashing')
            rows.append({'path':relative,'size':size,'sha256':digest})
    tree=hashlib.sha256(canonical(sorted(rows,key=lambda r:r['path']))).hexdigest()
    return {"package": name, "version": value["version"], "packageJsonSha256": hashlib.sha256(data).hexdigest(),"packageTreeSha256":tree}, target

def scan(source):
    source = source.absolute()
    require(source.resolve() == source and source.is_dir(), "canonical source directory required")
    root = source / ".next"
    require(root.is_dir() and not root.is_symlink(), "regular production build directory required")
    files, directories, aliases = [], [], []
    for base, dirs, names in os.walk(root, followlinks=False):
        base = Path(base)
        if base == root:
            dirs[:] = [d for d in dirs if d not in EXCLUDED]
        for name in sorted(list(dirs) + names):
            path = base / name; rel = safe_path(path.relative_to(root).as_posix())
            if path.is_symlink():
                match = re.fullmatch(r"node_modules/(sharp|fontkit)-[a-f0-9]{8,64}", rel)
                require(match is not None, "unexpected build symlink")
                entry, expected = package_identity(source, match[1])
                require(path.resolve(strict=True) == expected, "build alias points at another dependency")
                aliases.append({"path": rel, **entry})
            elif path.is_dir():
                require(rel == "node_modules" or not rel.startswith("node_modules/"), "unexpected dependency directory in payload")
                directories.append(rel)
            else:
                require(rel.split("/")[0] != "node_modules", "unexpected dependency file in payload")
                st = regular(path, context="build-payload-member", root=root); files.append((rel, identity(st), stat.S_IMODE(st.st_mode)))
        # Never follow the external aliases, even if os.walk classified them as directories.
        dirs[:] = sorted(d for d in dirs if not (base / d).is_symlink())
    require(0 < len(files) <= MAX_FILES and len(files) + len(directories) <= MAX_FILES and sum(x[1][2] for x in files) <= MAX_UNPACKED, "build file count/size exceeds bound")
    require({a["package"] for a in aliases} == EXTERNAL_PACKAGES and len(aliases) == 2, "both supported runtime aliases are required")
    require(any(f[0] == "BUILD_ID" for f in files), "production BUILD_ID missing")
    return sorted(files), sorted(directories), sorted(aliases, key=lambda a: a["path"])

class HashReader:
    def __init__(self, stream):
        self.stream, self.hash, self.count = stream, hashlib.sha256(), 0
    def read(self, size=-1):
        data = self.stream.read(size); self.hash.update(data); self.count += len(data)
        return data

class OwnedOutput:
    """Pin a new directory and its private parent; refuse observed replacements."""
    def __init__(self, path):
        self.path=path
        require(path.parent.resolve()==path.parent, 'private canonical output parent required')
        self.parent_fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            parent=os.fstat(self.parent_fd)
            require(parent.st_uid==os.getuid() and stat.S_IMODE(parent.st_mode)&0o077==0,
                    'private canonical output parent required')
            require(shutil.rmtree.avoids_symlink_attacks,'descriptor-relative cleanup unavailable')
            os.mkdir(path.name,mode=0o700,dir_fd=self.parent_fd)
            self.created=os.stat(path.name,dir_fd=self.parent_fd,follow_symlinks=False)
            require(stat.S_ISDIR(self.created.st_mode),'new output is not a directory')
        except BaseException:
            os.close(self.parent_fd)
            raise

    def assert_owned(self):
        parent=os.stat(self.path.parent,follow_symlinks=False)
        pinned=os.fstat(self.parent_fd)
        require(stat.S_ISDIR(parent.st_mode) and (parent.st_dev,parent.st_ino)==(pinned.st_dev,pinned.st_ino)
                and parent.st_uid==os.getuid() and stat.S_IMODE(parent.st_mode)&0o077==0,
                'output parent replaced or no longer private')
        current=os.stat(self.path.name,dir_fd=self.parent_fd,follow_symlinks=False)
        require(stat.S_ISDIR(current.st_mode) and (current.st_dev,current.st_ino)==(self.created.st_dev,self.created.st_ino),
                'owned output directory replaced')

    def cleanup_after_failure(self, original):
        try:
            self.assert_owned()
            shutil.rmtree(self.path.name,dir_fd=self.parent_fd)
        except (OSError,ValueError) as cleanup_error:
            # Preserve the original failure. A moved/replaced output requires inspection,
            # not recursive deletion of whatever now occupies its old pathname.
            original.add_note('Owned output cleanup refused: '+str(cleanup_error))

    def close(self):
        os.close(self.parent_fd)

def pack(source, output):
    source, output = Path(source).absolute(), Path(output).absolute()
    require(output.parent.resolve() == output.parent and not output.is_relative_to(source / ".next"), "unsafe bundle output directory")
    files, dirs, aliases = scan(source)
    owned=OwnedOutput(output)  # Never overwrite or merge output from another attempt.
    archive = output / "build-bundle.tar.gz"; rows = []
    try:
        with archive.open("xb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=COMPRESSION_LEVEL, mtime=0) as gz, tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT, encoding="utf-8") as tar:
            for path, expected, mode in files:
                file = source / ".next" / path
                fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                with os.fdopen(fd, "rb") as stream:
                    require(identity(os.fstat(stream.fileno())) == expected, "build changed before packaging")
                    info = tarfile.TarInfo(path); info.size = expected[2]; info.mode = 0o755 if mode & 0o111 else 0o644
                    reader = HashReader(stream); tar.addfile(info, reader)
                    require(reader.count == info.size and identity(os.fstat(stream.fileno())) == expected, "build changed during packaging")
                    rows.append({"path": path, "size": info.size, "sha256": reader.hash.hexdigest(), "mode": info.mode})
        require(scan(source) == (files, dirs, aliases), "build inventory changed during packaging")
        regular(archive, MAX_ARCHIVE, context="compressed-build-archive", root=output)
        build_id = (source / ".next/BUILD_ID").read_text().strip()
        require(build_id and len(build_id.encode()) <= 512 and not any(ord(c) < 32 or ord(c) == 127 for c in build_id), "invalid production build ID")
        manifest = {"format": 1, "kind": "next-build-byte-bundle", "platform": sys.platform, "nextBuildId": build_id,
            "files": rows, "directories": dirs, "aliases": aliases, "unpackedBytes": sum(r["size"] for r in rows),
            "archiveBytes": archive.stat().st_size, "archiveSha256": digest_file(archive)}
        validate_manifest(manifest)
        data = canonical(manifest); require(len(data) <= MAX_MANIFEST, "manifest exceeds bound")
        with (output / "build-bundle-files.json").open("xb") as stream:stream.write(data)
        owned.assert_owned()
        return manifest
    except BaseException as error:
        owned.cleanup_after_failure(error)
        raise
    finally:
        owned.close()

def validate_manifest(m):
    require(isinstance(m, dict) and set(m) == {"format", "kind", "platform", "nextBuildId", "files", "directories", "aliases", "unpackedBytes", "archiveBytes", "archiveSha256"}, "manifest shape differs")
    require(type(m["format"]) is int and m["format"] == 1 and m["kind"] == "next-build-byte-bundle" and m["platform"] in {"linux", "darwin"}, "manifest kind/platform differs")
    require(isinstance(m["nextBuildId"], str) and 0 < len(m["nextBuildId"].encode()) <= 512 and not any(ord(c)<32 or ord(c)==127 for c in m["nextBuildId"]), "invalid manifest build ID")
    require(type(m["archiveBytes"]) is int and 0 < m["archiveBytes"] <= MAX_ARCHIVE and isinstance(m['archiveSha256'],str) and re.fullmatch('[a-f0-9]{64}',m["archiveSha256"]) is not None, "invalid archive binding")
    files, dirs, aliases = m["files"], m["directories"], m["aliases"]
    require(isinstance(files, list) and isinstance(dirs, list) and isinstance(aliases, list) and 0 < len(files) <= MAX_FILES and len(files)+len(dirs) <= MAX_FILES, "manifest count bound")
    paths=[]; total=0
    for row in files:
        require(isinstance(row,dict) and set(row)=={"path","size","sha256","mode"}, "file metadata shape")
        path=safe_path(row["path"]); require(path.split('/')[0]!='node_modules', "dependency payload file")
        require(type(row["size"]) is int and 0<=row["size"]<=MAX_FILE and type(row["mode"]) is int and row["mode"] in {0o644,0o755} and isinstance(row["sha256"],str) and re.fullmatch('[a-f0-9]{64}',row["sha256"]), "file metadata invalid")
        paths.append(path); total+=row["size"]
    require(paths==sorted(set(paths)) and "BUILD_ID" in paths and type(m["unpackedBytes"]) is int and m["unpackedBytes"]==total<=MAX_UNPACKED, "file coverage/total differs")
    require(all(isinstance(d,str) and safe_path(d)==d and (d=='node_modules' or not d.startswith('node_modules/')) for d in dirs) and dirs==sorted(set(dirs)), "directory inventory differs")
    require(not set(paths)&set(dirs), "file/directory collision")
    for path in paths+dirs:
        require(all('/'.join(path.split('/')[:i]) in dirs for i in range(1,len(path.split('/')))), "missing declared parent directory")
    require(len(aliases)==2, "runtime aliases missing")
    names=[]; alias_paths=[]
    for a in aliases:
        require(isinstance(a,dict) and set(a)=={"path","package","version","packageJsonSha256","packageTreeSha256"}, "alias metadata shape")
        require(a["package"] in EXTERNAL_PACKAGES and re.fullmatch(r'node_modules/'+a['package']+r'-[a-f0-9]{8,64}',safe_path(a['path'])) and 'node_modules' in dirs, "unsupported alias")
        require(isinstance(a['version'],str) and re.fullmatch(r'[0-9A-Za-z.+_-]{1,80}',a['version']) and all(isinstance(a[k],str) and re.fullmatch('[a-f0-9]{64}',a[k]) for k in ['packageJsonSha256','packageTreeSha256']), "alias identity invalid")
        names.append(a['package']);alias_paths.append(a['path'])
    require(set(names)==EXTERNAL_PACKAGES and len(set(names))==2 and alias_paths==sorted(set(alias_paths)) and not set(alias_paths)&(set(paths)|set(dirs)), "duplicate or colliding alias")
    return m

def read_manifest(path):
    regular(path,MAX_MANIFEST,context="build-manifest",root=path.parent);data=path.read_bytes();m=json.loads(data)
    require(data==canonical(m),'noncanonical/duplicate manifest JSON')
    return validate_manifest(m)

def unpack(archive, manifest_path, destination, runtime_source, producer_source=None):
    archive, manifest_path, destination, runtime_source=map(lambda p:Path(p).absolute(),[archive,manifest_path,destination,runtime_source])
    m=read_manifest(manifest_path);st=regular(archive,MAX_ARCHIVE,context="compressed-build-archive",root=archive.parent)
    require(st.st_size==m['archiveBytes'] and digest_file(archive)==m['archiveSha256'],'archive bytes differ')
    require(destination.parent.resolve()==destination.parent and stat.S_IMODE(destination.parent.stat().st_mode)&0o077==0 and destination.parent.stat().st_uid==os.getuid(),'private canonical destination parent required')
    require(runtime_source.resolve()==runtime_source and runtime_source.is_dir(),'canonical runtime source required')
    targets={}
    for alias in m['aliases']:
        actual,target=(package_identity(runtime_source,alias['package']) if producer_source is None else package_identity(runtime_source,alias['package'],producer_source=producer_source))
        require(actual=={k:alias[k] for k in actual},'installed external package differs: '+alias['package']+' actual='+json.dumps(actual,sort_keys=True))
        targets[alias['path']]=target
    owned=OwnedOutput(destination)  # Existing/symlink destinations refuse before any cleanup.
    try:
        for directory in m['directories']:(destination/directory).mkdir(mode=0o755)
        expected={r['path']:r for r in m['files']};seen=set()
        with archive.open('rb') as raw:
            require(identity(os.fstat(raw.fileno()))==identity(st),'archive changed before extraction')
            header=raw.read(10);require(len(header)==10 and header[:4]==b'\x1f\x8b\x08\x00' and header[4:8]==b'\0'*4,'unsupported gzip header')
            raw.seek(0)
            gz=gzip.GzipFile(fileobj=raw,mode='rb')
            while True:
                header=gz.read(512);require(len(header)==512,'truncated archive header')
                if header==b'\0'*512:
                    require(gz.read(512)==b'\0'*512,'missing archive terminator')
                    padding=gz.read(10241);require(len(padding)<=10240 and not any(padding),'trailing archive data')
                    break
                require(header[257:263]==b'ustar\0' and header[263:265]==b'00','unsupported tar format')
                info=tarfile.TarInfo.frombuf(header,'utf-8','strict')
                # Inspect each raw header before allowing tarfile to parse any PAX/long-name body.
                require(info.type==tarfile.REGTYPE and not info.linkname and info.uid==info.gid==0 and info.mtime==0 and not info.uname and not info.gname,'nonregular or extended archive member')
                name=safe_path(info.name);require(name in expected and name not in seen,'unexpected or duplicated archive member')
                row=expected[name];require(info.size==row['size'] and info.mode==row['mode'],'archive member metadata differs')
                h=hashlib.sha256();remaining=info.size
                with (destination/name).open('xb') as out:
                    while remaining:
                        data=gz.read(min(remaining,1024*1024));require(data,'truncated file body');out.write(data);h.update(data);remaining-=len(data)
                require(h.hexdigest()==row['sha256'],'archive member digest differs')
                os.chmod(destination/name,row['mode']);padding=gz.read((-info.size)%512);require(len(padding)==(-info.size)%512 and not any(padding),'invalid file padding')
                seen.add(name)
            require(identity(os.fstat(raw.fileno()))==identity(st),'archive changed during extraction')
            gz.close()
        require(seen==set(expected),'missing build files')
        require((destination/'BUILD_ID').read_text().strip()==m['nextBuildId'],'installed build ID differs')
        for alias in m['aliases']:
            actual,target=(package_identity(runtime_source,alias['package']) if producer_source is None else package_identity(runtime_source,alias['package'],producer_source=producer_source))
            require(actual=={k:alias[k] for k in actual} and target==targets[alias['path']],'external package changed during extraction')
            (destination/alias['path']).symlink_to(target,target_is_directory=True)
        owned.assert_owned()
        return m
    except BaseException as error:
        owned.cleanup_after_failure(error)
        raise
    finally:
        owned.close()


def verify_directory(destination, manifest_path, runtime_source, producer_source=None, allow_runtime_cache=False):
    """Read-only full installed inventory/package verification; no cached PASS or activation."""
    destination, manifest_path, runtime_source = map(lambda p:Path(p).absolute(), [destination,manifest_path,runtime_source])
    require(destination.resolve()==destination and destination.is_dir() and not destination.is_symlink(), "canonical installed build required")
    root_before=destination.lstat()
    require(root_before.st_uid==os.getuid() and stat.S_IMODE(root_before.st_mode)&0o022==0, "private owned installed root required")
    m=read_manifest(manifest_path)
    targets={}
    for alias in m['aliases']:
        actual,target=package_identity(runtime_source,alias['package'],producer_source=producer_source)
        require(actual=={key:alias[key] for key in actual}, "installed external package differs")
        targets[alias['path']]=target
    files={row['path']:row for row in m['files']}
    directories=set(m['directories'])
    seen_files=set();seen_dirs=set();seen_aliases=set()
    def walk(base):
        for path in sorted(base.iterdir()):
            relative=path.relative_to(destination).as_posix()
            before=path.lstat()
            if stat.S_ISLNK(before.st_mode):
                require(relative in targets and path.resolve(strict=True)==targets[relative], "unexpected or changed installed alias")
                seen_aliases.add(relative)
            elif stat.S_ISDIR(before.st_mode):
                if allow_runtime_cache and relative=="cache":
                    require(stat.S_IMODE(before.st_mode)&0o022==0,"unsafe runtime-generated cache directory")
                    continue
                require(relative in directories and before.st_uid==os.getuid() and stat.S_IMODE(before.st_mode)&0o022==0, "unexpected installed directory")
                seen_dirs.add(relative);walk(path)
            else:
                require(relative in files, "unexpected installed file")
                row=files[relative];regular(path,context="installed-build-payload-member",root=destination)
                require(before.st_size==row['size'] and stat.S_IMODE(before.st_mode)==row['mode'] and digest_file(path)==row['sha256'], "installed file bytes or mode differ")
                require(identity(path.stat())==identity(before), "installed file changed while hashing")
                seen_files.add(relative)
    walk(destination)
    require(seen_files==set(files) and seen_dirs==directories and seen_aliases==set(targets), "installed build inventory differs")
    require((destination/'BUILD_ID').read_text().strip()==m['nextBuildId'], "installed build ID differs")
    # Reopen package trees after the complete read, just as unpack does.
    for alias in m['aliases']:
        actual,target=package_identity(runtime_source,alias['package'],producer_source=producer_source)
        require(actual=={key:alias[key] for key in actual} and target==targets[alias['path']], "runtime package changed while verifying")
    require(identity(destination.lstat())==identity(root_before), "installed root changed while verifying")
    return m

if __name__=='__main__':
    pack_started = pack_cpu_started = None
    try:
        mode,*args=sys.argv[1:]
        require((mode=='pack' and len(args)==2) or (mode=='unpack' and len(args)==4) or (mode=='unpack-with-origin' and len(args)==5) or (mode in {'verify-directory','verify-active-directory'} and len(args)==4),'usage: build-bundle.py pack SOURCE OUTPUT | unpack ARCHIVE MANIFEST DESTINATION RUNTIME_SOURCE | unpack-with-origin ARCHIVE MANIFEST DESTINATION RUNTIME_SOURCE PRODUCER_SOURCE | verify-directory|verify-active-directory NEXT_DIRECTORY MANIFEST RUNTIME_SOURCE PRODUCER_SOURCE')
        if mode == 'pack':
            pack_started = time.monotonic(); pack_cpu_started = time.process_time()
        result=pack(*args) if mode=='pack' else verify_directory(*args,allow_runtime_cache=mode=='verify-active-directory') if mode in {'verify-directory','verify-active-directory'} else unpack(*args)
        print(json.dumps({'kind':result['kind'],'files':len(result['files']),'archiveBytes':result['archiveBytes'],'unpackedBytes':result['unpackedBytes'],'releaseAuthorized':False,**({'runtimeCacheExcluded':True} if mode=='verify-active-directory' else {})}))
    except (ValueError,OSError,KeyError,TypeError,json.JSONDecodeError,tarfile.TarError,EOFError) as error:
        print(str(error),file=sys.stderr);sys.exit(1)
    finally:
        if pack_started is not None:
            print(json.dumps({"kind": "BUILD_BUNDLE_PACK_MEASUREMENT_NOT_RELEASE", "compressionLevel": COMPRESSION_LEVEL,
                              "cpuSeconds": time.process_time() - pack_cpu_started,
                              "elapsedSeconds": time.monotonic() - pack_started, "releaseAuthorized": False}), file=sys.stderr)
