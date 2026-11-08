"""Fixed bad-descriptor constructors for native tests only; never app/CI inputs."""
import os
import pty
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

KINDS = {'foreign', 'regular', 'fifo', 'tty', 'tcp', 'datagram', 'seqpacket', 'named', 'abstract', 'listener', 'disconnected'}

def main():
    if len(sys.argv) != 3 or sys.argv[1] not in KINDS:
        raise ValueError('Unknown fixed descriptor control')
    kind, node = sys.argv[1:]
    source = Path(__file__).with_name('input-parent.mjs')
    with tempfile.TemporaryDirectory(prefix='replay-ipc-kind-') as directory:
        held = []
        try:
            if kind == 'regular':
                stream = open(Path(directory) / 'empty', 'w+b');held.append(stream);descriptor = stream.fileno()
            elif kind in ('fifo', 'tty'):
                pair = os.pipe() if kind == 'fifo' else pty.openpty()
                held.extend(pair);descriptor = pair[0]
            elif kind in ('foreign', 'datagram', 'seqpacket'):
                pair = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM if kind == 'foreign' else socket.SOCK_DGRAM if kind == 'datagram' else socket.SOCK_SEQPACKET)
                held.extend(pair);descriptor = pair[0].fileno()
            else:
                stream = socket.socket(socket.AF_INET if kind == 'tcp' else socket.AF_UNIX, socket.SOCK_STREAM)
                held.append(stream);descriptor = stream.fileno()
                if kind in ('named', 'abstract', 'listener'):
                    stream.bind('\0replay-ipc-' + str(os.getpid()) if kind == 'abstract' else str(Path(directory) / 'socket'))
                    if kind == 'listener':stream.listen(1)
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'IPC_TEST_MODE': 'foreign' if kind == 'foreign' else 'invalid'}
            child = subprocess.Popen([node, str(source)], stdin=descriptor, env=env)
            # Own direct child, no polling/reaping of kernel monitor identities.
            try:
                result = child.wait(timeout=4)
                if result != 0:raise ValueError('Descriptor component refused')
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=3)
        finally:
            for item in held:
                if isinstance(item, int):os.close(item)
                else:item.close()

if __name__ == '__main__':
    try:main()
    except BaseException:
        sys.stderr.write('Fixed descriptor control refused\n');sys.exit(1)
