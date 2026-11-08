"""Fixed disposable-fixture gate; production controller admission remains authoritative."""
import os
import pathlib
import re
import sys
import time

assert os.geteuid() == 0 and len(sys.argv) == 2
unit = sys.argv[1]
assert re.fullmatch(r'aihr-web@[12]\.service', unit)
gate = pathlib.Path('/run/aihr-admission', 'permit-' + unit)
deadline = time.monotonic() + 60
while not gate.exists():
    assert time.monotonic() < deadline, 'Native cold admission gate expired'
    time.sleep(0.025)
info = gate.lstat()
assert not gate.is_symlink() and gate.is_file() and info.st_uid == 0 and info.st_nlink == 1
assert info.st_mode & 0o777 == 0o600
os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-B',
          '/usr/local/lib/aihr-admission/controller.py', 'admit', unit],
          {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
           'INVOCATION_ID': os.environ['INVOCATION_ID']})
