"""Unprivileged test-only direct-child signal capability. No app, DB or root work."""
import os
import pathlib
import signal
import sys


def require(value):
    if not value:
        raise ValueError('Closed owned-child pidfd refused')


def identity(pid):
    with pathlib.Path('/proc/' + str(pid) + '/stat').open('rb') as stream:
        raw = stream.read(4097)
    require(0 < len(raw) <= 4096 and raw.startswith((str(pid) + ' (').encode()))
    end = raw.rfind(b') ')
    require(end > 0)
    fields = raw[end + 2:].split()
    require(len(fields) >= 20 and all(fields[index].isdigit() for index in (1, 2, 3, 19)))
    return tuple(int(fields[index]) for index in (1, 2, 3, 19))


def main():
    require(sys.platform == 'linux' and os.geteuid() > 0 and len(sys.argv) == 4)
    require(all(value.isascii() and value.isdigit() and 0 < len(value) <= 20 for value in sys.argv[1:]))
    pid, parent, start = map(int, sys.argv[1:])
    require(pid > 1 and parent == os.getppid() and start > 0)
    # A held pidfd names the original process even after numeric PID reuse.
    # Matching both before and after open refuses an observed replacement.
    expected = (parent, pid, pid, start)
    require(identity(pid) == expected)
    descriptor = os.pidfd_open(pid, 0)
    try:
        require(identity(pid) == expected)
        sys.stdout.write('BOUND\n')
        sys.stdout.flush()
        command = sys.stdin.buffer.readline(16)
        require(command in (b'', b'KILL\n'))
        if command:
            require(sys.stdin.buffer.read(1) == b'')  # One closed request, then EOF.
            try:
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            except ProcessLookupError:
                pass  # The bound original is already dead; never signal a new PID.
            sys.stdout.write('SIGNALLED\n')
            sys.stdout.flush()
    finally:
        os.close(descriptor)


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, AttributeError, OSError, ValueError):
        sys.stderr.write('Owned child binding refused\n')
        sys.exit(1)
