"""Fixed component probes. Never calls adapter.main or fabricates CI authority."""
import hashlib
import json
import os
import select
import signal
import stat
import sys
import tempfile
import time
from pathlib import Path
from types import ModuleType

SOURCE = Path(__file__).with_name('adapter.py')
MODES = {'shape', 'normal', 'eof', 'byte', 'late', 'foreign', 'invalid', 'parent-death'}


def emit(value):
    data = (json.dumps(value, separators=(',', ':')) + '\n').encode()
    if os.write(1, data) != len(data):
        raise ValueError('Fixed probe short write')


def main():
    A = ModuleType('actual_ipc_adapter');A.__file__ = str(SOURCE)
    exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec', dont_inherit=True), A.__dict__)
    A.kernel.require(len(sys.argv) == 2 and sys.argv[1] in MODES)
    mode = sys.argv[1]
    node = Path(os.environ['IPC_TEST_NODE'])
    parent = Path(__file__).with_name('input-parent.mjs')
    guard = None
    try:
        try:
            guard = A.NativeInput(0, node, parent, hashlib.sha256(parent.read_bytes()).hexdigest(), A.ROOT)
        except A.InputRefused as error:
            reasons = {'descriptor-kind', 'socket-domain', 'socket-type', 'socket-listener', 'socket-address', 'socket-connected', 'socket-peer', 'native-platform', 'parent-metadata', 'parent-live', 'parent-identity', 'parent-credentials', 'parent-executable', 'parent-cwd', 'parent-argv', 'parent-entry', 'parent-source', 'descriptor-changed', 'socket-changed'}
            A.kernel.require(str(error) in reasons)
            emit({'kind': 'refused', 'reason': str(error), 'workStarted': False})
            if mode not in ('foreign', 'invalid'):
                raise ValueError('Positive native input refused')
            return
        A.kernel.require(mode not in ('foreign', 'invalid'))
        if mode == 'shape':
            guard.check()
            emit({'kind': 'shape', 'socket': stat.S_ISSOCK(os.fstat(0).st_mode),
                  'fifo': stat.S_ISFIFO(os.fstat(0).st_mode), 'anonymousUnixStream': True,
                  'nativePeerIsLiveParent': True, 'stableDescriptor': True})
            return
        if mode == 'parent-death':
            emit({'kind': 'parent-ready'})
            A.kernel.require(os.write(2, b'READY\n') == 6)
            A.kernel.require(select.select([guard.pidfd], [], [], 2)[0] == [guard.pidfd])
            try:
                guard.check()
            except A.InputRefused as error:
                A.kernel.require(str(error) == 'parent-live')
            else:
                raise AssertionError('Parent disappearance did not refuse')
            emit({'kind': 'parent-refused', 'workStarted': False, 'childrenAbsent': A.kernel.own_children() == []})
            return
        if mode in ('eof', 'byte'):
            # Parent closes/writes before requesting a session; this is actual fd0.
            A.kernel.require(select.select([0], [], [], 2)[0] == [0])
        with tempfile.TemporaryDirectory(prefix='replay-ipc-probe-') as directory:
            marker = Path(directory) / 'work'
            body = 'from pathlib import Path;Path(' + repr(str(marker)) + ').write_text("started");'
            if mode == 'late':
                body += 'import os,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);os.fork();print("WORKER",flush=True);time.sleep(10)'
            else:
                body += 'pass'
            before = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
            events, late_eof = [], False
            def verification():
                nonlocal late_eof
                guard.check()
                if mode == 'late' and select.select([0], [], [], 0)[0]:
                    # EOF is idempotent: the real Cancellation.poll immediately
                    # reads the same EOF. A byte cannot satisfy this witness.
                    A.kernel.require(os.read(0, 1) == b'')
                    late_eof = True
            control = A.Cancellation(0, time.monotonic() + 5, events.append, verify=verification)
            try:
                receipt = A.kernel.supervise([sys.executable, '-I', '-B', '-c', body], 2,
                                            control.event, clock=control.clock, mandatory=False)
            finally:
                control.disable()
            completed = control.completed(receipt)
            A.kernel.require(receipt['reaped'] and receipt['groupQuiescent'] and not receipt['escapedSession'])
            A.kernel.require(A.kernel.own_children() == [] and all(signal.getsignal(sig) is value for sig, value in before.items()))
            if mode == 'normal':
                A.kernel.require(completed and marker.exists() and receipt['commandExit'] == 0)
            elif mode == 'late':
                A.kernel.require(not completed and marker.exists() and control.cancelled and control.requested
                                 and late_eof and receipt['reason'] == 'owner-interrupted')
            else:
                A.kernel.require(not completed and not marker.exists() and control.cancelled)
                A.kernel.require(not any(e['kind'] == 'session-admitted' for e in events))
            emit({'kind': 'settled', 'mode': mode, 'completed': completed, 'workStarted': marker.exists(),
                  'reaped': True, 'quiescent': True, 'escaped': False, 'handlerRestored': True})
    finally:
        if guard is not None:
            guard.close(sys.exception())


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        sys.stderr.write('Fixed native IPC probe refused\n')
        sys.exit(1)
