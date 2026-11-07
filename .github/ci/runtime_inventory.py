"""Bounded immutable byte/link inventory. No principal, release or installation authority.

Build payload selection/wire and release acceptance remain caller-owned. The only
link purposes here are bounded in-root dependency links and exact Next sharp/fontkit aliases.
"""
from __future__ import annotations
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import tarfile

EXTERNAL_PACKAGES = {"sharp", "fontkit"}
MAX_PACKAGE = 32 * 1024**2
MAX_LINK_HOPS = 100
MAX_TREE_DEPTH = 128
MAX_PACKAGE_FILES = 2000
MAX_PACKAGE_ENTRIES = 20000
BUILD_ALIAS = re.compile(r'\.next/node_modules/(sharp|fontkit)-[a-f0-9]{8,64}')

def require(ok, message):
    if not ok:
        raise ValueError(message)

def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode()

def identity(st):
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns

def regular_metadata(st, limit, context, relative, check=require):
    if not (stat.S_ISREG(st.st_mode) and st.st_size <= limit):
        kind = {stat.S_IFREG: 'regular', stat.S_IFDIR: 'directory', stat.S_IFLNK: 'symlink',
                stat.S_IFIFO: 'fifo', stat.S_IFSOCK: 'socket', stat.S_IFCHR: 'character-device',
                stat.S_IFBLK: 'block-device'}.get(stat.S_IFMT(st.st_mode), 'unknown')
        details = {'context': context, 'path': relative, 'type': kind, 'sizeBytes': st.st_size, 'limitBytes': limit}
        check(False, 'nonregular or oversized file; ' + json.dumps(details, sort_keys=True, ensure_ascii=True))
    return st


class PinnedTree:
    """Read through pinned directory descriptors, never through an unchecked ancestor.

    This is a read-only inventory, not an installer or an ownership policy. Callers
    still supply their purpose-specific path, byte and member limits. No recursive
    OS symlink following occurs; explicit resolution is limited to this root.
    """
    def __init__(self, root, check=require):
        self.path, self.check = Path(root), check
        self.chain, self.directories, self.links, self.files = [], {}, {}, {}
        self.fd = None
        check(self.path.is_absolute() and self.path.as_posix() == str(root)
              and '..' not in self.path.parts and len(str(root).encode()) <= 4096,
              'canonical inventory root required')
        current = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for name in self.path.parts[1:]:
                before = os.stat(name, dir_fd=current, follow_symlinks=False)
                check(stat.S_ISDIR(before.st_mode), 'symlink or non-directory inventory ancestor')
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                try:
                    check(identity(os.fstat(child)) == identity(before), 'inventory ancestor changed while opening')
                except BaseException:
                    os.close(child)
                    raise
                self.chain.append((current, name, child, (before.st_dev, before.st_ino)))
                current = child
            self.fd = current
        except BaseException:
            for parent, _, _, _ in self.chain:
                os.close(parent)
            os.close(current)
            raise

    def _parts(self, relative):
        self.check(isinstance(relative, str) and len(relative.encode()) <= 4096
                   and not relative.startswith('/') and '\\' not in relative
                   and len(relative.split('/')) <= MAX_TREE_DEPTH
                   and (not relative or all(p not in {'', '.', '..'} for p in relative.split('/'))),
                   'unsafe descriptor-relative inventory path')
        return relative.split('/') if relative else []

    def _pins(self):
        for parent, name, child, wanted in self.chain:
            found = os.stat(name, dir_fd=parent, follow_symlinks=False)
            held = os.fstat(child)
            self.check(stat.S_ISDIR(found.st_mode) and (found.st_dev, found.st_ino) == wanted
                       and (held.st_dev, held.st_ino) == wanted, 'inventory root or ancestor replaced')

    @contextmanager
    def directory(self, relative='', record=True):
        self._pins()
        current, prefix = os.dup(self.fd), []
        try:
            for name in self._parts(relative):
                before = os.stat(name, dir_fd=current, follow_symlinks=False)
                self.check(stat.S_ISDIR(before.st_mode), 'symlink or non-directory inventory parent')
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                try:
                    self.check(identity(os.fstat(child)) == identity(before), 'inventory parent changed while opening')
                except BaseException:
                    os.close(child)
                    raise
                os.close(current); current = child; prefix.append(name)
                if record:
                    key = '/'.join(prefix)
                    self.check(self.directories.setdefault(key, identity(before)) == identity(before),
                               'inventory directory changed')
            if record:
                found = identity(os.fstat(current))
                self.check(self.directories.setdefault(relative, found) == found, 'inventory directory changed')
            yield current
        finally:
            os.close(current)

    def metadata(self, relative):
        parts = self._parts(relative)
        self.check(bool(parts), 'inventory member required')
        with self.directory('/'.join(parts[:-1])) as parent:
            return os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)

    def readlink(self, relative):
        parts = self._parts(relative)
        self.check(bool(parts), 'inventory link required')
        with self.directory('/'.join(parts[:-1])) as parent:
            before = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            self.check(stat.S_ISLNK(before.st_mode), 'inventory link changed type')
            value = os.readlink(parts[-1], dir_fd=parent)
            self.check(len(value.encode()) <= 4096 and identity(os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)) == identity(before),
                       'inventory link changed while reading')
            self.check(self.links.setdefault(relative, (identity(before), value)) == (identity(before), value),
                       'inventory link changed')
            return value

    def resolve(self, relative, allow_absolute=True):
        """Resolve existing dependency links inside the pinned node_modules root.

        Absolute in-root links remain compatible with existing format2 fixtures;
        callers may disable them. They never authorize another filesystem root.
        """
        self.check(isinstance(relative, str) and relative and not relative.startswith('/') and len(relative.encode()) <= 4096
                   and '\\' not in relative, 'invalid dependency link target')
        pending, resolved, visited = relative.split('/'), [], set()
        while pending:
            name, *pending = pending
            if name in {'', '.'}:
                continue
            if name == '..':
                self.check(bool(resolved), 'dependency link escapes runtime dependencies')
                resolved.pop(); continue
            key = '/'.join(resolved + [name])
            found = self.metadata(key)
            if stat.S_ISLNK(found.st_mode):
                self.check(key not in visited and len(visited) < MAX_LINK_HOPS, 'cyclic or excessive dependency link chain')
                visited.add(key); target = self.readlink(key)
                if target.startswith('/'):
                    prefix = str(self.path) + '/'
                    self.check(allow_absolute and target.startswith(prefix), 'dependency link escapes runtime dependencies')
                    target, resolved = target[len(prefix):], []
                pending = target.split('/') + pending
            else:
                self.check(not pending or stat.S_ISDIR(found.st_mode), 'non-directory dependency link ancestor')
                resolved.append(name)
        result = '/'.join(resolved)
        self.check(bool(result), 'dependency link resolves to inventory root')
        return result

    def entries(self, relative='', *, maximum, excluded=frozenset()):
        rows = []
        def visit(base):
            with self.directory(base) as parent:
                names = []
                with os.scandir(parent) as current:
                    for entry in current:
                        self.check(len(names) < maximum + len(excluded), 'inventory directory entry count exceeds bound')
                        names.append(entry.name)
                for name in sorted(names):
                    self.check(name not in {'.', '..'} and '/' not in name and '\\' not in name, 'invalid inventory entry name')
                    found = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if not base and name in excluded and stat.S_ISDIR(found.st_mode):
                        continue
                    key = base + '/' + name if base else name
                    self._parts(key)
                    self.check(len(rows) < maximum, 'inventory entry count exceeds bound')
                    rows.append((key, found))
                    if stat.S_ISDIR(found.st_mode):
                        visit(key)
        visit(relative)
        self.assert_unchanged()
        return rows

    @contextmanager
    def open_regular(self, relative, limit, *, expected=None, context='file', display=None):
        parts = self._parts(relative)
        self.check(bool(parts), 'inventory file required')
        with self.directory('/'.join(parts[:-1])) as parent:
            before = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            regular_metadata(before, limit, context, display if display is not None else relative, self.check)
            if expected is not None:
                self.check(identity(before) == expected, 'inventory file changed before opening')
            self.check(self.files.setdefault(relative, identity(before)) == identity(before),
                       'inventory file changed between reads')
            # NONBLOCK refuses a raced FIFO without waiting. O_NOFOLLOW refuses a
            # raced symlink; fstat proves the opened regular inode before reading.
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            with os.fdopen(fd, 'rb') as stream:
                self.check(identity(os.fstat(stream.fileno())) == identity(before), 'inventory file changed while opening')
                yield stream, before
                self.check(identity(os.fstat(stream.fileno())) == identity(before)
                           and identity(os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)) == identity(before),
                           'inventory file changed while reading')
        self._pins()

    def read_bytes(self, relative, limit, **options):
        with self.open_regular(relative, limit, **options) as (stream, before):
            data = stream.read(limit + 1)
            self.check(len(data) == before.st_size and len(data) <= limit and not stream.read(1),
                       'inventory file changed size while reading')
            return data

    def assert_unchanged(self):
        self._pins()
        for relative, wanted in list(self.directories.items()):
            with self.directory(relative, record=False) as current:
                self.check(identity(os.fstat(current)) == wanted, 'inventory directory changed')
        for relative, wanted in list(self.links.items()):
            self.check((identity(self.metadata(relative)), self.readlink(relative)) == wanted, 'inventory link changed')
        for relative, wanted in list(self.files.items()):
            self.check(identity(self.metadata(relative)) == wanted, 'inventory file changed after reading')

    def close(self):
        if self.fd is not None:
            for parent, _, _, _ in self.chain:
                os.close(parent)
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, kind, error, traceback):
        try:
            self.assert_unchanged()
        except (OSError, ValueError) as secondary:
            if error is None:
                raise
            error.add_note('Inventory final identity proof refused: ' + type(secondary).__name__)
        finally:
            self.close()

def rebase_installer_shim(data, source, producer_source, check=require):
    """Compare one known pnpm wrapper at its authenticated original path; do not rewrite a file."""
    original = Path(producer_source)
    check(original.is_absolute() and str(original) == str(producer_source) and original.absolute().as_posix() == str(original)
            and ".." not in original.parts and "." not in original.parts
            and str(original) != str(source) and len(str(original).encode()) <= 4096,
            "canonical distinct producer source required for installer comparison")
    current = str(source / "node_modules").encode()
    prior = str(original / "node_modules").encode()
    check(len(data) <= 16384 and data.startswith(b"#!/bin/sh\nbasedir=")
            and b"/semver/bin/semver.js" in data and b' "$@"' in data,
            "unsupported generated semver wrapper")
    check(current in data, "generated semver wrapper does not belong to this runtime source")
    out = []
    for line in data.splitlines(keepends=True):
        if current in line:
            check(line.lstrip().startswith(b'export NODE_PATH="') and line.endswith(b'"\n'),
                    "runtime prefix outside generated NODE_PATH")
            line = line.replace(current, prior)
        out.append(line)
    return b"".join(out)

SHIM_EXEC = re.compile(rb'^(\s*exec (?:"\$basedir/node"|node)\s+)"\$basedir/([^"\n]+)"( "\$@"\n)$')

def resolve_installer_exec(data, shim, modules, *, tree=None, check=require):
    """Keep the existing semver comparison spelling, resolving only pinned dependencies."""
    if tree is None:
        with PinnedTree(modules, check) as pinned:
            return resolve_installer_exec(data, shim, modules, tree=pinned, check=check)
    out = []; targets = set()
    for line in data.splitlines(keepends=True):
        match = SHIM_EXEC.match(line)
        if match:
            relative = match.group(2).decode('utf-8')
            check(not relative.startswith('/') and '\\' not in relative, 'generated semver wrapper target must be relative')
            base = shim.parent.relative_to(tree.path).as_posix()
            key = tree.resolve(base + '/' + relative)
            check(stat.S_ISREG(tree.metadata(key).st_mode), 'generated semver wrapper target must be a regular file')
            targets.add(key)
            line = match.group(1) + b'"$basedir/@node_modules/' + key.encode() + b'"' + match.group(3)
        out.append(line)
    check(len(targets) == 1, 'generated semver wrapper must name exactly one target')
    return b''.join(out)

def package_identity(source, name, producer_source=None, *, check=require):
    check(name in EXTERNAL_PACKAGES, 'unsupported external package')
    modules = source / 'node_modules'
    with PinnedTree(modules, check) as tree:
        relative = tree.resolve(name)
        check(stat.S_ISDIR(tree.metadata(relative).st_mode), 'external package escapes runtime dependencies')
        target = modules / relative
        data = tree.read_bytes(relative + '/package.json', 256 * 1024,
                               context='external-package-manifest:' + name, display='package.json')
        value = json.loads(data)
        check(isinstance(value, dict) and value.get('name') == name and isinstance(value.get('version'), str)
              and re.fullmatch(r'[0-9A-Za-z.+_-]{1,80}', value['version']), 'external package identity differs')
        rows = []; total = 0
        # The original package contract permits at most2000 files/32MiB and no
        # internal links. Bound directories too, before allocating a full tree.
        for key, before in tree.entries(relative, maximum=MAX_PACKAGE_ENTRIES):
            check(not stat.S_ISLNK(before.st_mode), 'unsupported symlink inside external package')
            if stat.S_ISDIR(before.st_mode):
                continue
            display = key[len(relative) + 1:]
            regular_metadata(before, MAX_PACKAGE, 'external-package-file:' + name, display, check)
            total += before.st_size
            check(total <= MAX_PACKAGE and len(rows) < MAX_PACKAGE_FILES, 'external package exceeds comparison bound')
            raw = tree.read_bytes(key, MAX_PACKAGE, expected=identity(before), context='external-package-file:' + name, display=display)
            size = before.st_size
            if name == 'sharp' and value['version'] == '0.35.5' and display == 'node_modules/.bin/semver':
                check(size <= 16384, 'oversized generated installer shim')
                compared = rebase_installer_shim(raw, source, producer_source, check) if producer_source is not None else raw
                compared = resolve_installer_exec(compared, modules / key, modules, tree=tree, check=check)
                digest = hashlib.sha256(compared).hexdigest(); size = len(compared)
            else:
                digest = hashlib.sha256(raw).hexdigest()
            rows.append({'path': display, 'size': size, 'sha256': digest})
        digest = hashlib.sha256(canonical(sorted(rows, key=lambda row: row['path']))).hexdigest()
        return {'package': name, 'version': value['version'], 'packageJsonSha256': hashlib.sha256(data).hexdigest(),
                'packageTreeSha256': digest}, target


def build_alias_target(source, relative, target, *, check=require):
    """Only a known Next alias may enter this canonical node_modules namespace.

    Do not normpath an unresolved dependency suffix: `pkg/..` has different
    semantics when pkg is a symlink. Resolve that suffix with pinned descriptors.
    """
    check(BUILD_ALIAS.fullmatch(relative) is not None, 'unexpected build symlink')
    modules = source / 'node_modules'
    if target.startswith('/'):
        prefix = str(modules) + '/'
        check(target.startswith(prefix), 'build alias escapes runtime dependencies')
        dependency = target[len(prefix):]
    else:
        location, pending = ['.next', 'node_modules'], target.split('/')
        dependency = None
        for index, part in enumerate(pending):
            if part in {'', '.'}:
                continue
            if part == '..':
                check(bool(location), 'build alias escapes runtime dependencies')
                location.pop()
            else:
                location.append(part)
            if location == ['node_modules']:
                dependency = '/'.join(pending[index + 1:])
                break
            check(not location or location in [['.next'], ['.next', 'node_modules']],
                  'build alias must target runtime dependencies')
        check(dependency is not None, 'build alias must target runtime dependencies')
    with PinnedTree(modules, check) as tree:
        resolved = tree.resolve(dependency)
        check(stat.S_ISDIR(tree.metadata(resolved).st_mode), 'build alias target must be a directory')
        return modules / resolved


def private_path(name):
    p = PurePosixPath(name)
    return (any(x in {'.git', '.ssh', '.improve'} for x in p.parts)
            or p.name in {'runtime.env', 'deploy.env', 'provision.env', 'installation-secrets.json', '.npmrc'}
            or (p.name.startswith('.env') and not p.name.endswith(('.example', '.sample', '.template'))))


def audit_archive(path, runtime=False, build=None, lock=None):
    """Inspect without extraction; pnpm relative links must stay inside allowed roots."""
    names, files, links, special = set(), {}, [], {}
    total = 0
    path = Path(path).absolute()
    with PinnedTree(path.parent) as pinned, pinned.open_regular(path.name, 9 * 1024**3, context='runtime-archive') as (raw, _), tarfile.open(fileobj=raw, mode='r:gz') as archive:
        for item in archive:
            name = item.name.rstrip('/')
            require(name and not name.startswith('/') and '..' not in PurePosixPath(name).parts,
                    'Unsafe archive path')
            require(name not in names, 'Duplicate archive path: ' + name)
            names.add(name)
            require(len(names) <= 500000, 'Archive exceeds entry bound')
            require(not private_path(name), 'Private configuration in package: ' + name)
            if runtime:
                require(PurePosixPath(name).parts[0] in {'.next', 'node_modules'}, 'Unexpected runtime root')
                require(not any(name == p or name.startswith(p + '/') for p in
                                ('.next/cache', '.next/dev', '.next/trace', 'node_modules/.cache')),
                        'Application cache in runtime')
            require(item.isdir() or item.isfile() or item.issym() or item.islnk(), 'Special archive entry')
            if item.issym() or item.islnk():
                require(not item.linkname.startswith('/'), 'Absolute archive link')
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), item.linkname)
                                           if item.issym() else item.linkname)
                require(target != '..' and not target.startswith('../'), 'Escaping archive link')
                if runtime:
                    require(target.split('/')[0] in {'.next', 'node_modules'}, 'Escaping runtime link')
                require(not private_path(target), 'Private archive link')
                links.append((name, target))
            elif item.isfile():
                total += item.size
                require(total <= 8 * 1024**3 and len(names) <= 500000, 'Archive exceeds inventory bound')
                stream = archive.extractfile(item)
                h = hashlib.sha256()
                collect = name in {'.next/BUILD_ID', 'node_modules/.deploy-lockfile-sha', '.next/prerender-manifest.json'}
                require(not collect or item.size <= 4 * 1024**2, 'Oversized runtime identity')
                content = bytearray()
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(block)
                    if collect:
                        content.extend(block)
                files[name] = h.hexdigest()
                if collect:
                    special[name] = bytes(content)
        # Links through another symlink could escape even if each textual target looks safe.
        link_map = dict(links)
        for name, target in links:
            visited = {name}
            for _ in range(MAX_LINK_HOPS):
                parts = target.split('/')
                prefix = next(('/'.join(parts[:i]) for i in range(1, len(parts)+1)
                               if '/'.join(parts[:i]) in link_map), None)
                if prefix is None:
                    break
                require(prefix not in visited, 'Cyclic archive link')
                visited.add(prefix)
                target = posixpath.normpath(link_map[prefix] + target[len(prefix):])
            else:
                raise ValueError('Archive link depth exceeded')
            require(target != '..' and not target.startswith('../') and not target.startswith('/'), 'Escaping link chain')
            require(not private_path(target), 'Private link chain')
            if runtime:
                require(target.split('/')[0] in {'.next', 'node_modules'}, 'Escaping runtime link chain')
    if runtime:
        require(special.get('.next/BUILD_ID', b'').decode().strip() == build, 'Runtime build ID mismatch')
        require(special.get('node_modules/.deploy-lockfile-sha', b'').decode().strip() == lock, 'Runtime lockfile mismatch')
        prerender = json.loads(special.get('.next/prerender-manifest.json', b'{}'))
        require('routes' in prerender and 'dynamicRoutes' in prerender, 'Missing prerender inventory')
        require(set(prerender['routes']) <= {'/_not-found', '/_global-error', '/404', '/500'},
                'Runtime contains prerendered application data; review before publication')
        require(not prerender['dynamicRoutes'], 'Runtime contains dynamic prerender data')
    require(files, 'Empty archive')
    return files


def relativize_build_aliases(source, destination, directory):
    """CI-installed builds (.github/ci/build-bundle.py) link Next's two external-package aliases to
    absolute dependency paths under the installation directory. Repoint only those aliases to the same
    dependency relative to the package; every other link, and any alias aimed elsewhere, is left for
    audit_archive to refuse."""
    prefix = posixpath.normpath(directory) + '/node_modules/'
    rewritten = []
    with tarfile.open(source, 'r:gz') as captured, \
            tarfile.open(destination, 'w:gz', compresslevel=1, format=captured.format) as output:
        for item in captured:
            name = item.name.rstrip('/')
            target = posixpath.normpath(item.linkname) if item.issym() else ''
            if BUILD_ALIAS.fullmatch(name) and target.startswith(prefix):
                item.linkname = posixpath.relpath('node_modules/' + target[len(prefix):], posixpath.dirname(name))
                rewritten.append(name)
            output.addfile(item, captured.extractfile(item) if item.isfile() else None)
    return rewritten
