"""Static assembly only. Generated helper is private, root-staged and independently hash-pinned.
Never invoke root against imports loaded from the web checkout.
Reviewed command surface: production-first-install only (see deploy/systemd/BANK-IMPORT.md). The staging
drain/activate/adopt-stopped phases are not reachable from this helper. It grants no production authority.
"""
import hashlib
import json
from pathlib import Path
import sys

root=Path(__file__).resolve().parents[1]
output=Path(sys.argv[1]).absolute()
PHASES=['production-first-install']
modules=[('fmt','deploy/systemd/bank_import_worker_format.py'),('base','deploy/systemd/bank_import_worker_installer_v2.py'),('update','deploy/systemd/bank_import_worker_upgrade_v1.py'),('production','deploy/systemd/bank_import_worker_production_v1.py')]
body='import sys,types\nsys.dont_write_bytecode=True\n'
for name,path in modules:
    text=(root/path).read_text()
    body+=name+'=types.ModuleType('+repr(name)+')\nexec('+repr(text)+','+name+'.__dict__)\n'
body+='production.first_install(sys.argv[1:],fmt,base,update)\n'
with output.open('x') as stream: stream.write(body)
output.chmod(0o600)
print(json.dumps({'helperSha256':hashlib.sha256(body.encode()).hexdigest(),'bytes':len(body),'sourceFiles':{path:hashlib.sha256((root/path).read_bytes()).hexdigest() for _,path in modules},'phases':PHASES,'releaseAuthorized':False,'productionAuthorized':False}))
