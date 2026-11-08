"""Fixed 20s native test driver under the existing unchanged process kernel.

No CI/replay authority, command broker, SQL, new process loop or copied kernel.
"""
import os
import signal
import sys
import time
from pathlib import Path
from types import ModuleType

SOURCE = Path(__file__).with_name('adapter.py')


def main():
    A = ModuleType('actual_input_test_owner');A.__file__ = str(SOURCE)
    exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec', dont_inherit=True), A.__dict__)
    began = time.monotonic()
    A.kernel.require(len(sys.argv) == 1 and set(os.environ) == {'PATH', 'LANG', 'IPC_TEST_NODE'})
    node = Path(os.environ['IPC_TEST_NODE'])
    A.kernel.require(node.is_absolute() and node.resolve() == node
                     and os.path.samefile(node, '/proc/' + str(os.getppid()) + '/exe'))
    A.kernel.require(Path.cwd() == A.ROOT)
    events, previous = [], {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    os.environ.clear();os.environ.update({'PATH': '/usr/bin:/bin', 'LANG': 'C'})
    receipt = A.kernel.supervise([str(node), str(SOURCE.with_name('input-controls.mjs'))], 20, events.append)
    A.kernel.require(receipt == {'reason': 'complete', 'commandExit': 0, 'admitted': True,
        'reaped': True, 'groupQuiescent': True, 'escapedSession': False, 'releaseAuthorized': False})
    A.kernel.require(A.kernel.own_children() == [] and all(signal.getsignal(sig) is value for sig, value in previous.items()))
    A.kernel.require(time.monotonic() - began < 28)
    sys.stdout.write('Original replay native input supervised complete:8\n')


if __name__ == '__main__':
    try:main()
    except BaseException:
        sys.stderr.write('Fixed native input test ownership refused\n');sys.exit(1)
