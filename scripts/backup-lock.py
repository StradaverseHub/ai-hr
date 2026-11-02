#!/usr/bin/env python3
"""Private backup lock ownership. Never reclaim a foreign/stale lock or recursively delete it."""
import os
import secrets
import stat
import sys


def acquire(path, pid):
    os.mkdir(path, 0o700)  # Existing locks, including stale or symlink paths, refuse.
    info = os.lstat(path)
    token = f"{info.st_dev}:{info.st_ino}:{secrets.token_hex(24)}"
    # A failure after mkdir deliberately leaves a recoverable incomplete lock rather than guessing.
    for name, value in (("pid", pid), ("owner", token)):
        fd = os.open(os.path.join(path, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(value + "\n")
    print(token)


def release(path, token, pid):
    device, inode, _ = token.split(":")
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (info.st_dev, info.st_ino, info.st_uid) != (int(device), int(inode), os.getuid()):
            raise ValueError("backup lock identity changed")
        if set(os.listdir(fd)) != {"pid", "owner"}:
            raise ValueError("backup lock contains unknown recovery data")
        for name, expected in (("pid", pid), ("owner", token)):
            child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            with os.fdopen(child) as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode) or stream.read(4096) != expected + "\n":
                    raise ValueError("backup lock ownership changed")
        current = os.lstat(path)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("backup lock path replaced")
        os.unlink("owner", dir_fd=fd)
        os.unlink("pid", dir_fd=fd)
        current = os.lstat(path)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("backup lock path replaced during cleanup")
        os.rmdir(path)
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "acquire":
            acquire(sys.argv[2], sys.argv[3])
        elif len(sys.argv) == 5 and sys.argv[1] == "release":
            release(sys.argv[2], sys.argv[3], sys.argv[4])
        else:
            raise ValueError("invalid backup lock operation")
    except (OSError, ValueError):
        print("Backup lock operation refused; preserve the owned recovery directory for inspection.", file=sys.stderr)
        sys.exit(1)
