"""Descriptor-only package preparation for the owned native Next fixture.

No Git, shell, application import, DB, installer or process activation. The
caller authenticates source/build capability before selecting these inputs.
Read-side link traversal remains the canonical runtime_inventory owner.
"""
import contextlib
import hashlib
import os
import pathlib
import stat

MAX_ENTRIES = 500000
MAX_FILE = 256 * 1024 * 1024
MAX_BYTES = 4 * 1024 * 1024 * 1024
MAX_METADATA = 64 * 1024 * 1024
DEPENDENCY_NORMALIZATION = 'ROOT_COPY_DEPENDENCIES_V1'


class OwnedPackage:
    """Writes only below one newly root-owned, app-inaccessible package inode."""
    def __init__(self, directory, require):
        self.root, self.require, self.bytes, self.entries = pathlib.Path(directory), require, 0, 0
        info = self.root.lstat()
        require(os.geteuid() == 0 and stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and stat.S_IMODE(info.st_mode) == 0o700 and not os.listdir(self.root),
                'New private native package directory required')
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.identity = (info.st_dev, info.st_ino)
        self.current()

    def current(self):
        named, held = self.root.lstat(), os.fstat(self.fd)
        self.require((named.st_dev, named.st_ino) == self.identity == (held.st_dev, held.st_ino)
                and stat.S_ISDIR(named.st_mode) and named.st_uid == 0 and stat.S_IMODE(named.st_mode) == 0o700,
                'Owned native package root changed')

    @contextlib.contextmanager
    def parent(self, name):
        parts = name.split('/')
        self.require(0 < len(parts) <= 128 and len(name.encode()) <= 4096
                and all(part not in ('', '.', '..') and '\\' not in part for part in parts),
                'Unsafe owned package output')
        self.current()
        current = os.dup(self.fd)
        try:
            for part in parts[:-1]:
                created = False
                try:
                    os.mkdir(part, 0o755, dir_fd=current)
                    created = True
                except FileExistsError:
                    pass
                before = os.stat(part, dir_fd=current, follow_symlinks=False)
                self.require(stat.S_ISDIR(before.st_mode) and before.st_uid == 0
                        and (created or stat.S_IMODE(before.st_mode) == 0o755), 'Unsafe owned package parent')
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                held = os.fstat(child)
                self.require((held.st_dev, held.st_ino) == (before.st_dev, before.st_ino), 'Owned package parent changed')
                if created:
                    os.fchmod(child, 0o755)  # Preserve a private outer umask without changing it globally.
                os.close(current)
                current = child
            yield current, parts[-1]
            self.current()
        finally:
            os.close(current)

    def file(self, name, stream, before, mode, expected_blob=None):
        self.require(mode in (0o644, 0o755) and stat.S_ISREG(before.st_mode)
                and 0 <= before.st_size <= MAX_FILE, 'Unsafe native package payload')
        self.entries += 1
        self.bytes += before.st_size
        self.require(self.entries <= MAX_ENTRIES and self.bytes <= MAX_BYTES, 'Native package exceeds bound')
        with self.parent(name) as (directory, leaf):
            fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory)
            try:
                blob = hashlib.sha1(b'blob ' + str(before.st_size).encode() + b'\0', usedforsecurity=False)
                total = 0
                while True:
                    block = stream.read(1024 * 1024)
                    if not block:
                        break
                    total += len(block)
                    self.require(total <= before.st_size, 'Native payload grew during copy')
                    blob.update(block)
                    view = memoryview(block)
                    while view:
                        written = os.write(fd, view)
                        self.require(written > 0, 'Native package copy did not advance')
                        view = view[written:]
                self.require(total == before.st_size and (expected_blob is None or blob.hexdigest() == expected_blob),
                        'Native source blob differs from authenticated Git tree')
                os.fchmod(fd, mode)
                os.fsync(fd)
                after = os.fstat(fd)
                self.require(after.st_uid == 0 and after.st_nlink == 1 and after.st_size == total,
                        'Native copied payload identity differs')
            finally:
                os.close(fd)

    def directory(self, name):
        self.entries += 1
        self.require(self.entries <= MAX_ENTRIES, 'Native package exceeds entry bound')
        with self.parent(name) as (directory, leaf):
            try:
                os.mkdir(leaf, 0o755, dir_fd=directory)
            except FileExistsError:
                info = os.stat(leaf, dir_fd=directory, follow_symlinks=False)
                self.require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                        and stat.S_IMODE(info.st_mode) == 0o755, 'Native package directory collision')
            else:
                fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                try:
                    self.require(os.fstat(fd).st_uid == 0, 'Native package directory owner differs')
                    os.fchmod(fd, 0o755)
                finally:
                    os.close(fd)

    def link(self, name, target):
        self.entries += 1
        self.require(self.entries <= MAX_ENTRIES and isinstance(target, str)
                and 0 < len(target.encode()) <= 4096 and not target.startswith('/'),
                'Unsafe native dependency link')
        with self.parent(name) as (directory, leaf):
            os.symlink(target, leaf, dir_fd=directory)

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def copy_tracked_source(source, expected_files, output, inventory, runner_uid, require):
    """Only independently Merkle-derived regular source files enter the package."""
    require(isinstance(expected_files, list) and 0 < len(expected_files) <= MAX_ENTRIES,
            'Bounded authenticated source inventory required')
    with inventory.PinnedTree(source, require) as tree:
        for row in expected_files:
            name = row['path']
            require(not inventory.private_path(name) and not name.startswith(('node_modules/', '.next/'))
                    and name not in ('node_modules', '.next'), 'Private or generated tracked source is unsupported')
            before = tree.metadata(name)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == runner_uid and before.st_nlink == 1
                    and stat.S_IMODE(before.st_mode) == row['mode'], 'Tracked source metadata differs')
            with tree.open_regular(name, MAX_FILE, expected=inventory.identity(before)) as (stream, _):
                output.file(name, stream, before, row['mode'], expected_blob=row['blob'])
        tree.assert_unchanged()


def dependency_entries(tree, inventory, expected_uid, require):
    """One source-admission/normalization owner for trusted capture and copying."""
    require(type(expected_uid) is int and expected_uid >= 0, 'Exact dependency reader principal required')
    with tree.directory('') as directory:
        root = os.fstat(directory)
        require(root.st_uid in (0, expected_uid) and not stat.S_IMODE(root.st_mode) & 0o022,
                'Unsafe installed dependency root')
    for name, before in tree.entries(maximum=MAX_ENTRIES):
        require(not inventory.private_path(name) and before.st_uid in (0, expected_uid),
                'Private or foreign installed dependency')
        if stat.S_ISLNK(before.st_mode):
            target = tree.readlink(name)
            tree.resolve(name, allow_absolute=False)
            yield name, before, 'link', target
        elif stat.S_ISDIR(before.st_mode):
            require(not stat.S_IMODE(before.st_mode) & 0o022, 'Writable dependency directory')
            yield name, before, 'directory', None
        else:
            require(stat.S_ISREG(before.st_mode) and stat.S_IMODE(before.st_mode) in (0o644, 0o755)
                    and 0 <= before.st_size <= MAX_FILE, 'Special, writable or oversized dependency payload')
            yield name, before, 'file', None


def semantic_dependency_inventory(source, inventory, expected_uid, require):
    """Bind the actual pre-candidate install to its normalized immutable copy.

    Paths are ONLY descendants relative to node_modules; its root is excluded.
    Directories normalize0755, regular modes/bytes and relative links stay exact.
    Source UID/inode/store-hardlink metadata do not become copied byte identity.
    No application, Git, Node, DB, subprocess or privilege operation is invoked.
    """
    rows, total, metadata = [], 0, 2
    with inventory.PinnedTree(pathlib.Path(source) / 'node_modules', require) as tree:
        for name, before, kind, target in dependency_entries(tree, inventory, expected_uid, require):
            row = {'path': name, 'kind': kind, 'mode': 0o755 if kind == 'directory' else 0o777 if kind == 'link' else stat.S_IMODE(before.st_mode)}
            if kind == 'link':
                row['target'] = target
            elif kind == 'file':
                total += before.st_size
                require(total <= MAX_BYTES, 'Installed dependency byte total exceeds bound')
                with tree.open_regular(name, MAX_FILE, expected=inventory.identity(before)) as (stream, _):
                    row.update(size=before.st_size, sha256=hashlib.file_digest(stream, 'sha256').hexdigest())
            metadata += len(inventory.canonical(row))
            require(metadata <= MAX_METADATA, 'Dependency inventory metadata exceeds bound')
            rows.append(row)
        tree.assert_unchanged()
    require(rows, 'Nonempty installed dependency closure required')
    raw = inventory.canonical(sorted(rows, key=lambda row: row['path']))
    require(len(raw) <= MAX_METADATA, 'Dependency inventory metadata exceeds bound')
    return {'normalization': DEPENDENCY_NORMALIZATION, 'sha256': hashlib.sha256(raw).hexdigest(),
            'entries': len(rows), 'bytes': total}


def copy_installed_dependencies(source, output, inventory, runner_uid, require):
    """Hosted-install provenance, not a claim that the build packet covers it.

    Store hardlinks are read with pinned identities and become independent
    root-owned regular files. Every relative link must resolve within this exact
    node_modules namespace through the unchanged canonical resolver.
    """
    output.directory('node_modules')
    with inventory.PinnedTree(pathlib.Path(source) / 'node_modules', require) as tree:
        for name, before, kind, target in dependency_entries(tree, inventory, runner_uid, require):
            destination = 'node_modules/' + name
            if kind == 'link':
                output.link(destination, target)
            elif kind == 'directory':
                output.directory(destination)
            else:
                with tree.open_regular(name, MAX_FILE, expected=inventory.identity(before)) as (stream, _):
                    output.file(destination, stream, before, stat.S_IMODE(before.st_mode))
        tree.assert_unchanged()
