"""Materialize only exact committed bytes for the closed protected Next experiment."""
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath

SOURCE = "6c05efc24242b8a5f50933e7cbb6709a276b286d"
TREE = "0b01a61737fd330d4cbdbc219e4f50c5f2b209e9"
MANIFEST = "0011cb6333246ef7b391361d2825a648570a4864d237d3f58ca6574e3f17be23"
ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C", "LC_ALL": "C",
       "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0"}


def project(checkout, destination):
    assert checkout.is_absolute() and checkout.resolve() == checkout
    assert destination.is_absolute() and destination.parent.resolve() == destination.parent
    assert not destination.exists() and not destination.is_symlink()
    git = ["/usr/bin/git", "-C", str(checkout)]
    head = subprocess.check_output([*git, "rev-parse", "HEAD"], env=ENV, timeout=8)
    assert head.decode().strip() == SOURCE
    assert not subprocess.check_output([*git, "status", "--porcelain", "--untracked-files=all"], env=ENV, timeout=8)
    tree = subprocess.check_output([*git, "rev-parse", SOURCE + "^{tree}"], env=ENV, timeout=8)
    assert tree.decode().strip() == TREE
    inventory = subprocess.check_output([*git, "ls-tree", "-r", "-z", SOURCE], env=ENV, timeout=8)
    assert len(inventory) < 2 * 1024**2 and hashlib.sha256(inventory).hexdigest() == MANIFEST
    assert inventory.endswith(b"\0")
    files = {}
    for raw in inventory[:-1].split(b"\0"):
        identity, path = raw.split(b"\t", 1)
        mode, kind, blob = identity.split()
        name = os.fsdecode(path)
        parts = PurePosixPath(name).parts
        assert parts and name == "/".join(parts) and all(part not in (".", "..", ".git") for part in parts)
        assert "\\" not in name and name not in files and not name.startswith("/")
        assert parts[0] not in ("node_modules", ".next", "next-env.d.ts", ".env", ".env.local", ".env.production", ".env.production.local")
        assert kind == b"blob" and mode in (b"100644", b"100755") and re.fullmatch(b"[0-9a-f]{40}", blob)
        files[name] = (int(mode[-3:], 8), blob.decode())
    assert len(files) == 12968 and len({name.split("/")[0] for name in files}) == 48
    directories = {str(parent) for name in files for parent in PurePosixPath(name).parents if str(parent) != '.'}
    destination.mkdir(mode=0o700)
    count = 0
    size = 0
    with subprocess.Popen([*git, "archive", "--format=tar", SOURCE], env=ENV, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL) as child:
        try:
            with tarfile.open(fileobj=child.stdout, mode="r|") as archive:
                for member in archive:
                    name = member.name.rstrip("/")
                    parts = PurePosixPath(name).parts
                    assert parts and name == "/".join(parts) and all(part not in (".", "..", ".git") for part in parts)
                    target = destination.joinpath(*parts)
                    if member.isdir():
                        # Git tree controls file membership. A directory can only lead to a tracked leaf.
                        assert name in directories
                        target.mkdir(mode=0o700, parents=True, exist_ok=True)
                        continue
                    assert member.isfile() and name in files and 0 <= member.size <= 64 * 1024**2
                    mode, blob = files.pop(name)
                    assert (member.mode & 0o111 != 0) == (mode & 0o111 != 0)
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    digest = hashlib.sha1(f"blob {member.size}\0".encode())
                    length = 0
                    with archive.extractfile(member) as reader, target.open("xb") as output:
                        while block := reader.read(1024**2):
                            length += len(block)
                            assert length <= member.size
                            digest.update(block)
                            output.write(block)
                    assert length == member.size and digest.hexdigest() == blob
                    target.chmod(mode)
                    count += 1
                    size += length
                    assert size <= 334867242
            assert child.wait(timeout=4) == 0
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=4)
    assert not files and count == 12968 and size == 334867242
    for name in (".next", "node_modules"):
        (destination / name).mkdir(mode=0o700)
    (destination / "next-env.d.ts").touch(mode=0o600, exist_ok=False)
    return {"source": SOURCE, "tree": TREE, "manifestSha256": MANIFEST, "files": count, "bytes": size}


if __name__ == "__main__":
    assert len(sys.argv) == 3
    print(json.dumps(project(Path(sys.argv[1]), Path(sys.argv[2])), sort_keys=True))
