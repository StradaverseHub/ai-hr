"""Root-owned disposable native fixture gate; never a production drop-in.

Allows the harness to stop/timeout a real systemd start-post before admission,
and to interrupt the separate actual-controller ADD. No controller test mode.
"""
import os
import pathlib
import sys
import time

assert os.geteuid() == 0 and sys.argv[1] in ('1', '2')
slot = sys.argv[1]
gate = pathlib.Path('/run/aihr-admission/ports/post-' + slot)
deadline = time.monotonic() + 10
while not gate.exists():
    if time.monotonic() >= deadline:
        raise SystemExit(1)
    time.sleep(0.01)
environment = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
               'INVOCATION_ID': os.environ['INVOCATION_ID']}
os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '/usr/local/lib/aihr-admission/controller.py',
                             'admit', 'aihr-web@' + slot + '.service'], environment)
