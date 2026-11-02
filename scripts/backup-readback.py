#!/usr/bin/env python3
"""Bound and independently hash a destination reader's raw bytes; never trust its success message."""
import hashlib
import os
import selectors
import signal
import subprocess
import sys
import time


def main(args):
    if len(args) < 6 or args[4] != '--':
        raise ValueError('invalid readback arguments')
    expected_size, expected_hash, output, timeout = int(args[0]), args[1], args[2], int(args[3])
    if expected_size < 0 or len(expected_hash) != 64 or not 1 <= timeout <= 3600:
        raise ValueError('invalid readback bounds')
    child = subprocess.Popen(args[5:], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    digest, count, deadline = hashlib.sha256(), 0, time.monotonic() + timeout
    try:
        with open(output, 'xb') as target, selectors.DefaultSelector() as poll:
            os.chmod(output, 0o600)
            poll.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError('readback deadline')
                if not poll.select(remaining):
                    raise ValueError('readback deadline')
                block = os.read(child.stdout.fileno(), min(1024 * 1024, expected_size - count + 1))
                if not block:
                    break
                count += len(block)
                if count > expected_size:
                    raise ValueError('readback exceeds expected bytes')
                digest.update(block)
                target.write(block)
            remaining = deadline - time.monotonic()
            if remaining <= 0 or child.wait(timeout=remaining) != 0:
                raise ValueError('reader failed')
        if count != expected_size or digest.hexdigest() != expected_hash:
            raise ValueError('readback bytes differ')
    finally:
        # A reader may fork a descendant that outlives its stdout/leader. Terminate only this owned group.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        if child.stdout:
            child.stdout.close()


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, subprocess.SubprocessError):
        print('Destination readback failed: no retention or local deletion is permitted.', file=sys.stderr)
        sys.exit(1)
