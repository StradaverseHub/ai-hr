"""Static assembly only. Generated helper is private, root-staged and independently hash-pinned.
Never invoke root against imports loaded from the web checkout.
"""
import hashlib
import json
from pathlib import Path
import sys

root=Path(__file__).resolve().parents[1]
output=Path(sys.argv[1]).absolute()
modules=[('fmt','deploy/systemd/bank_import_worker_format.py'),('base','deploy/systemd/bank_import_worker_installer_v2.py'),('update','deploy/systemd/bank_import_worker_upgrade_v1.py')]
body='import sys,types\nsys.dont_write_bytecode=True\n'
for name,path in modules:
    text=(root/path).read_text()
    body+=name+'=types.ModuleType('+repr(name)+')\nexec('+repr(text)+','+name+'.__dict__)\n'
body+='update.upgrade(sys.argv[1:],fmt,base)\n'
with output.open('x') as stream: stream.write(body)
output.chmod(0o600)
print(json.dumps({'helperSha256':hashlib.sha256(body.encode()).hexdigest(),'bytes':len(body),'sourceFiles':{path:hashlib.sha256((root/path).read_bytes()).hexdigest() for _,path in modules},'releaseAuthorized':False}))
