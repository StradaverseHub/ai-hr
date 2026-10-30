"""Atomic build directory activation only. No test/build/deployment or service-health authority."""
import ctypes
import errno
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

BUILD_ID = re.compile(r"[A-Za-z0-9_-]{1,512}")
EXCHANGES_EXECUTED = 0

def require(value, message):
    if not value:
        raise ValueError("Build activation refused: " + message)

def identity(st):
    return {"device": st.st_dev, "inode": st.st_ino}

def directory(path, private=False):
    path = Path(path)
    st = path.lstat()
    require(path.is_absolute() and path.resolve() == path and stat.S_ISDIR(st.st_mode)
            and not stat.S_ISLNK(st.st_mode) and st.st_uid == os.getuid(), "owned canonical directory required")
    require(path != Path("/"), "filesystem root is not an activation target")
    require(stat.S_IMODE(st.st_mode) & 0o022 == 0, "directory must not be writable by other principals")
    if private:
        require(stat.S_IMODE(st.st_mode) == 0o700, "staged build parent must be private")
    return st

def build_id(fd):
    member = os.open("BUILD_ID", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        before = os.fstat(member)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= 513,
                "bounded regular BUILD_ID required")
        value = os.read(member, 514).decode("ascii").strip()
        after = os.fstat(member)
        require(identity(before) == identity(after) and before.st_size == after.st_size
                and before.st_mtime_ns == after.st_mtime_ns, "BUILD_ID changed during read")
        require(BUILD_ID.fullmatch(value), "invalid BUILD_ID")
        return value
    finally:
        os.close(member)

def child_directory(parent_fd, name):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        st = os.fstat(fd)
        require(st.st_uid == os.getuid(), "build directory owner differs")
        return fd, st
    except BaseException:
        os.close(fd)
        raise

def publish_json(parent_fd, name, value):
    data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
    try:
        with os.fdopen(fd, "wb", closefd=False) as output:
            output.write(data)
            output.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    os.fsync(parent_fd)

def activate(staged, source, expected_new, expected_old, action="activate"):
    """Exchange two existing owned directories. Keep the old build; never silently retry.
    An explicit rollback swaps the retained directory back with reversed expected IDs.
    The caller must already have authenticated all source, build and runtime bytes.
    """
    require(sys.platform == "linux", "Linux renameat2 is required; no non-atomic fallback")
    require(action in {"activate", "rollback"} and BUILD_ID.fullmatch(expected_new)
            and BUILD_ID.fullmatch(expected_old) and expected_new != expected_old, "explicit distinct build identities required")
    staged, source = Path(staged), Path(source)
    require(staged.name == "next", "fixed staged next directory required")
    parent = staged.parent
    parent_st, source_st = directory(parent, private=True), directory(source)
    require(parent_st.st_dev == source_st.st_dev, "activation must stay on one filesystem")
    # A stage in or above the runtime tree would collide with source synchronization.
    require(not staged.is_relative_to(source) and not source.is_relative_to(staged)
            and not parent.is_relative_to(source), "stage must remain outside source")
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    require(rename is not None, "renameat2 unavailable")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    parent_fd = source_fd = new_fd = old_fd = None
    try:
        parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        require(identity(os.fstat(parent_fd)) == identity(parent_st) and identity(os.fstat(source_fd)) == identity(source_st),
                "activation parent changed")
        new_fd, new_st = child_directory(parent_fd, "next")
        old_fd, old_st = child_directory(source_fd, ".next")
        require(new_st.st_dev == old_st.st_dev == parent_st.st_dev, "build directories cross filesystems")
        require(build_id(new_fd) == expected_new and build_id(old_fd) == expected_old, "expected old/new build identity differs")
        require(identity(os.stat("next", dir_fd=parent_fd, follow_symlinks=False)) == identity(new_st)
                and identity(os.stat(".next", dir_fd=source_fd, follow_symlinks=False)) == identity(old_st),
                "build directory changed before activation")
        intent_name, result_name = action + "-intent.json", action + "-result.json"
        intent = {"format": 1, "kind": "BUILD_DIRECTORY_EXCHANGE_INTENT_NOT_RELEASE", "action": action,
                  "source": str(source), "staged": str(staged), "expectedNewBuildId": expected_new,
                  "expectedOldBuildId": expected_old, "newDirectory": identity(new_st),
                  "oldDirectory": identity(old_st), "createdUnixNs": time.time_ns(), "releaseAuthorized": False}
        publish_json(parent_fd, intent_name, intent)
        # Public runtime directory readability is set while it is still enclosed by a private parent.
        os.fchmod(new_fd, 0o755)
        require(identity(directory(parent, private=True)) == identity(parent_st) and identity(directory(source)) == identity(source_st), "activation root changed before exchange")
        require(identity(os.stat("next", dir_fd=parent_fd, follow_symlinks=False)) == identity(new_st)
                and identity(os.stat(".next", dir_fd=source_fd, follow_symlinks=False)) == identity(old_st), "build changed before exchange")
        if rename(parent_fd, b"next", source_fd, b".next", 2) != 0:  # RENAME_EXCHANGE
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        global EXCHANGES_EXECUTED
        EXCHANGES_EXECUTED += 1
        os.fsync(parent_fd)
        os.fsync(source_fd)
        require(identity(os.stat(".next", dir_fd=source_fd, follow_symlinks=False)) == identity(new_st)
                and identity(os.stat("next", dir_fd=parent_fd, follow_symlinks=False)) == identity(old_st),
                "post-exchange directory identity differs; retain both for operator recovery")
        require(identity(directory(parent, private=True)) == identity(parent_st) and identity(directory(source)) == identity(source_st), "activation root changed after exchange")
        # These FDs stay bound to their original inode across the exchange.
        require(build_id(new_fd) == expected_new and build_id(old_fd) == expected_old,
                "post-exchange BUILD_ID differs; retain both for operator recovery")
        result = {"format": 1, "kind": "BUILD_DIRECTORIES_EXCHANGED_NOT_SERVICE_OR_RELEASE",
                  "action": action, "source": str(source), "staged": str(staged),
                  "activeBuildId": expected_new, "retainedBuildId": expected_old,
                  "activeDirectory": identity(new_st), "retainedDirectory": identity(old_st),
                  "releaseAuthorized": False, "serviceRestarted": False, "activeServiceVerified": False}
        publish_json(parent_fd, result_name, result)
        return result
    finally:
        for fd in [old_fd, new_fd, source_fd, parent_fd]:
            if fd is not None:
                os.close(fd)

if __name__ == "__main__":
    # Only the CLI on commissioned staging is guarded; isolated fixture functions stay pure.
    import pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'scripts/staging'))
    from lease import guard_server_cli
    guard_server_cli()
    try:
        require(len(sys.argv) == 6, "usage: build-activate.py activate|rollback STAGED_NEXT SOURCE EXPECTED_NEW_ID EXPECTED_OLD_ID")
        action, staged, source, expected_new, expected_old = sys.argv[1:]
        print(json.dumps(activate(staged, source, expected_new, expected_old, action), sort_keys=True))
    except (OSError, ValueError, UnicodeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
