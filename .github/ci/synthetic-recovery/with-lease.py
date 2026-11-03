"""Run one synthetic operation through the original coordinator's kernel guard."""
import json
import os
from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path.cwd() / 'scripts/staging'))
from coordinator import Coordinator, PROTOCOL, main

root = Path(sys.argv[1])
if sys.argv[2] == 'assert':
    sys.argv = [sys.argv[0], 'assert-env']
    main(root)
    raise SystemExit(0)

base, candidate = 'a' * 40, 'b' * 40
build = 'synthetic-recovery'
queue = Coordinator(root, lambda: dict(state='ok', stale_build='0', ref=base, built_ref=base, build_id='old', built_build_id='old'))
def request(action, **fields):
    return queue.request(dict(protocol=PROTOCOL, actor='synthetic-rehearsal', action=action, **fields))
ticket = str(uuid.uuid4())
request('submit', spec=dict(id=ticket, source=candidate, base=base, dependencies=[], risk='ordinary', migrations=[], acceptance='Synthetic health and ledger', evidence='Synthetic recovery runner'))
batch = request('prepare', tickets=[ticket], candidate=candidate, baseline=base, baselineBuild='old')['batch']
lease = request('claim', batch=batch)
request('phase', phase='installing', **{k: lease[k] for k in ('batch','epoch','candidate','token')})
queue.db.close()
for key in ('batch','epoch','candidate','token'):
    os.environ['AIHR_STAGING_'+key.upper()] = str(lease[key])
os.environ['FIXTURE_QUEUE'] = str(root)
sys.argv = [sys.argv[0], 'guard', '--', *sys.argv[3:]]
main(root)
