#!/usr/bin/env python3
"""Reserve a complete local resource set, or wait holding none. Not installed automatically."""
from __future__ import annotations

import argparse
import fcntl
import itertools
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import uuid


class Refused(RuntimeError):
    pass


def ancestors() -> set[int]:
    # Metadata only: do not inspect command lines or business data.
    rows = subprocess.check_output(["ps", "-Ao", "pid=,ppid="], text=True, timeout=5)
    parents = {int(a): int(b) for a, b in (line.split() for line in rows.splitlines())}
    result: set[int] = set()
    pid = os.getppid()
    while pid > 1 and pid not in result:
        result.add(pid)
        if pid not in parents:
            raise Refused("Cannot establish the complete ancestor chain")
        pid = parents[pid]
    return result


def atomic_text(path: Path, text: str, token: str) -> None:
    temporary = path.with_name("." + path.name + "-" + token)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class Reservation:
    def __init__(self, root: Path, slots: int, database: bool, name: str):
        self.root, self.slots, self.database, self.name = root, slots, database, name
        existing = root
        while not existing.exists() and not existing.is_symlink():
            existing = existing.parent
        if existing.is_symlink() or existing.resolve() != existing:
            raise Refused("Resource root ancestors must be canonical nonsymlink directories")
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if root.is_symlink() or root.resolve() != root:
            raise Refused("Resource root must be a canonical nonsymlink directory")
        self.test = root / "locks"
        self.db = root / "devdb-locks"
        for directory in (self.test, self.db):
            directory.mkdir(mode=0o700, exist_ok=True)
            if directory.is_symlink() or not directory.is_dir():
                raise Refused("Resource directory must not be a symlink or non-directory")
        self.token = uuid.uuid4().hex
        self.held: list[tuple[Path, int, int]] = []
        self.ancestors = ancestors()
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        self.mutex = os.open(root / "atomic-resource-admission.lock", flags, 0o600)
        if not stat.S_ISREG(os.fstat(self.mutex).st_mode):
            os.close(self.mutex)
            raise Refused("Admission lock must be a regular file")

    def _all_paths(self):
        return [self.test / "slot.1", self.test / "slot.2", self.db / "slot.1"]

    def _check_nested(self):
        for path in self._all_paths():
            try:
                pid = int((path / "pid").read_text().strip())
            except (FileNotFoundError, ValueError, OSError):
                continue
            if pid in self.ancestors:
                raise Refused("Partial/nested resource acquisition is forbidden; release the outer lease and request the complete set in one call")

    def try_acquire(self) -> bool:
        self._check_nested()
        try:
            fcntl.flock(self.mutex, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        try:
            self._check_nested()
            choices = itertools.combinations([self.test / "slot.1", self.test / "slot.2"], self.slots)
            for test_paths in choices:
                paths = list(test_paths) + ([self.db / "slot.1"] if self.database else [])
                if any(path.exists() or path.is_symlink() for path in paths):
                    continue
                try:
                    for path in paths:
                        # Legacy mkdir users may race this admission lock. Roll back immediately
                        # if any member becomes occupied; never wait with a partial reservation.
                        path.mkdir(mode=0o700)
                        identity = path.stat()
                        self.held.append((path, identity.st_dev, identity.st_ino))
                        atomic_text(path / "lease.json", json.dumps({"schema": 1, "pid": os.getpid(), "token": self.token, "name": self.name}) + "\n", self.token)
                        atomic_text(path / "name", self.name + "\n", self.token)
                        atomic_text(path / "since", str(int(time.time())) + "\n", self.token)
                        # Publish pid last and atomically: legacy reapers must never observe an
                        # empty pid file and mistake this live reservation for a dead owner.
                        atomic_text(path / "pid", str(os.getpid()) + "\n", self.token)
                    return True
                except FileExistsError:
                    self.release()
                except BaseException:
                    self.release()
                    raise
            return False
        finally:
            fcntl.flock(self.mutex, fcntl.LOCK_UN)

    def release(self):
        errors = []
        for path, device, inode in reversed(self.held):
            try:
                current = path.lstat()
                if stat.S_ISLNK(current.st_mode) or (current.st_dev, current.st_ino) != (device, inode):
                    raise Refused("Lease path identity changed: " + str(path))
                record = path / "lease.json"
                if record.exists() and json.loads(record.read_text()).get("token") != self.token:
                    raise Refused("Lease token changed: " + str(path))
                if (path / "pid").exists() and (path / "pid").read_text().strip() != str(os.getpid()):
                    raise Refused("Lease pid changed: " + str(path))
                for name in ("pid", "name", "since", "lease.json"):
                    file = path / name
                    if file.is_symlink():
                        raise Refused("Lease metadata became a symlink")
                    file.unlink(missing_ok=True)
                path.rmdir()  # Never recursively delete another process's files.
            except BaseException as error:
                errors.append(str(error))
        self.held = []
        if errors:
            raise Refused("Owned lease cleanup needs attention: " + "; ".join(errors))

    def close(self):
        os.close(self.mutex)


def group_live(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    # An already-exited zombie must not retain a capacity lease forever.
    rows = subprocess.check_output(["ps", "-Ao", "pgid=,stat="], text=True, timeout=5)
    return any(int(group) == pgid and not state.startswith("Z") for group, state in (line.split() for line in rows.splitlines()))


def stop_group(pgid: int, grace: float) -> bool:
    if not group_live(pgid):
        return True
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    deadline = time.monotonic() + grace
    while group_live(pgid) and time.monotonic() < deadline:
        time.sleep(0.05)
    if group_live(pgid):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 5
        while group_live(pgid) and time.monotonic() < deadline:
            time.sleep(0.05)
    return not group_live(pgid)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-root", type=Path, default=Path.home() / ".aihr-gate-state")
    parser.add_argument("--test-slots", type=int, choices=(0, 1, 2), default=2)
    parser.add_argument("--database", action="store_true")
    parser.add_argument("--wait-seconds", type=float, default=3600)
    parser.add_argument("--poll-seconds", type=float, default=0.25)
    parser.add_argument("--terminate-grace", type=float, default=75)
    parser.add_argument("name")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if not args.command or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", args.name):
        parser.error("A safe name and command after -- are required")
    if args.test_slots == 0 and not args.database:
        parser.error("At least one resource must be requested")
    if not all(math.isfinite(n) and n >= 0 for n in (args.wait_seconds, args.terminate_grace)) or not math.isfinite(args.poll_seconds) or args.poll_seconds <= 0:
        parser.error("Wait/grace must be finite nonnegative durations; poll must be positive")
    requested_signal = 0

    def signal_requested(signum, frame):
        nonlocal requested_signal
        requested_signal = requested_signal or signum

    for number in (signal.SIGINT, signal.SIGTERM):
        signal.signal(number, signal_requested)
    reservation = None
    child = None
    release_safe = True
    try:
        reservation = Reservation(args.state_root.absolute(), args.test_slots, args.database, args.name)
        started = time.monotonic()
        while not reservation.try_acquire():
            if requested_signal:
                return 128 + requested_signal
            if time.monotonic() - started >= args.wait_seconds:
                print("resource-lock: timed out holding no slots; occupied/uncertain legacy leases were preserved", file=sys.stderr)
                return 75
            time.sleep(min(args.poll_seconds, max(0, args.wait_seconds - (time.monotonic() - started))))
        print(f"resource-lock: {args.name} acquired complete set after {time.monotonic()-started:.3f}s", file=sys.stderr, flush=True)
        if requested_signal:
            return 128 + requested_signal
        child = subprocess.Popen(args.command, start_new_session=True, env={**os.environ, "AIHR_LOCK_DIR": str(reservation.test), "AIHR_TEST_SLOTS": "2"})
        forwarded_at = None
        while child.poll() is None:
            if requested_signal and forwarded_at is None:
                os.killpg(child.pid, requested_signal)
                forwarded_at = time.monotonic()
            if forwarded_at is not None and time.monotonic() - forwarded_at >= args.terminate_grace:
                os.killpg(child.pid, signal.SIGKILL)
                break
            time.sleep(0.05)
        code = child.wait()
        leftovers = group_live(child.pid)
        if leftovers:
            release_safe = stop_group(child.pid, args.terminate_grace)
        if not release_safe:
            raise Refused("Child group termination unconfirmed; leases retained for explicit recovery")
        if requested_signal:
            return 128 + requested_signal
        return 125 if leftovers and code == 0 else (code if code >= 0 else 128 - code)
    except FileNotFoundError as error:
        print("resource-lock: " + str(error), file=sys.stderr)
        return 127
    except (Refused, OSError, subprocess.SubprocessError) as error:
        print("resource-lock: " + str(error), file=sys.stderr)
        return 78
    finally:
        if child is not None and child.poll() is None:
            release_safe = stop_group(child.pid, args.terminate_grace)
            child.wait()
        if reservation is not None:
            try:
                if release_safe:
                    reservation.release()
            finally:
                reservation.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Refused as error:
        print("resource-lock: " + str(error), file=sys.stderr)
        sys.exit(78)
