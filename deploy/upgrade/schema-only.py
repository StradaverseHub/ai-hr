#!/usr/bin/env python3
"""Queue and automatically install an authenticated schema-only staging packet."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

from coordinator import APP, PROTOCOL, ROOT, Coordinator, canonical, private, require, sha
from staging import open_staging

PACKETS = ROOT / 'schema-only'
ACTOR = 'staging-schema-only-worker'
JOURNAL = 'db/migrations/meta/_journal.json'
PROOF_FILES = {'.github/workflows/staging-schema-only.yml', 'deploy/upgrade/schema-only.test.mjs'}
NODE = ['/opt/node22/bin/node', '--env-file=.env.production']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic(path, data, mode=0o600):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        pending = Path(stream.name)
        try:
            stream.write(data)
            os.fchmod(stream.fileno(), mode)
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(pending, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            pending.unlink(missing_ok=True)


def read_record(path):
    private(path)
    return json.loads(path.read_bytes())


def record(path, data):
    atomic(path, canonical(data).encode() + b'\n')


def request(queue, action, **fields):
    return queue.request({'protocol': PROTOCOL, 'action': action, 'actor': ACTOR, **fields})


def migration(packet, manifest, action):
    node = ROOT / 'upgrade-engine/deploy/upgrade/schema-only-host.mjs'
    result = subprocess.run([*NODE, str(node), action, str(packet), manifest['sqlSha256']],
                            cwd=APP, check=True, capture_output=True, text=True, timeout=25)
    state = json.loads(result.stdout)
    require(state['tag'] == manifest['tag'], 'Migration receipt tag differs')
    return state


def regular_bytes(path):
    require(path.resolve() == path and path.is_file() and path.stat().st_size <= 2**20,
            'Expected a bounded regular source file')
    return path.read_bytes()


def verify_manifest(manifest):
    require(set(manifest) == {'candidate','baseline','build','tag','run','smoke','sqlSha256','files'},
            'Schema-only packet fields differ')
    sha(manifest['baseline']); sha(manifest['candidate'])
    require(manifest['baseline'] != manifest['candidate'], 'Schema-only revision must differ')
    require(re.fullmatch(r'[a-z0-9_]{8,80}', manifest['tag']), 'Migration tag differs')
    require(re.fullmatch(r'[a-f0-9]{64}', manifest['sqlSha256']), 'Expected exact SQL digest')
    require(re.fullmatch(r'[A-Za-z0-9_-]{1,128}', manifest['build']), 'Expected exact installed build')
    require(type(manifest['run']) is int and manifest['run'] > 0, 'Expected exact rehearsal run')
    require(re.fullmatch(r'/[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*', manifest['smoke']), 'Expected read-only smoke route')
    sql = 'db/migrations/' + manifest['tag'] + '.sql'
    allowed = {sql, JOURNAL, 'docs/MIGRATION-ALLOCATION.md'} | PROOF_FILES
    files = manifest['files']
    require(isinstance(files, dict) and {sql,JOURNAL} <= files.keys() <= allowed, 'Runtime source changes require a build')
    for name, entry in files.items():
        require(set(entry) == {'before','text'}, 'Malformed source change')
        require(isinstance(entry['text'], str) and len(entry['text'].encode()) <= 2**20, 'Bounded UTF-8 source required')
        require(entry['before'] is None or re.fullmatch(r'[a-f0-9]{64}', entry['before']), 'Expected exact prior hash')
    require(files[sql]['before'] is None and digest(files[sql]['text'].encode()) == manifest['sqlSha256'],
            'Expected one new SQL migration')
    require(files[JOURNAL]['before'] is not None, 'Missing previous journal identity')


def source_file(path, entry, apply=False):
    require(path.resolve() == path, 'Symlink source path refused')
    exists = path.exists()
    data = entry['text'].encode()
    before = digest(regular_bytes(path)) if exists else None
    if apply and exists and before == digest(data):
        return
    require(before == entry['before'], 'Staging source bytes differ: ' + str(path))
    if apply:
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic(path, data, mode=0o644)


def register(queue, manifest):
    verify_manifest(manifest)
    seen = queue.ready(manifest['baseline'], manifest['build'])
    require(seen.get('backend') == 'canonical', 'Expected canonical staging')
    for name, entry in manifest['files'].items():
        source_file(APP / name, entry)
    ticket = str(uuid.uuid4())
    packet = PACKETS / ticket
    packet.mkdir(mode=0o700)
    record(packet / 'manifest.json', manifest)
    old = packet / 'baseline/db/migrations'
    new = packet / 'expanded/db/migrations'
    shutil.copytree(APP / 'db/migrations', old)
    shutil.copytree(old, new)
    for name, entry in manifest['files'].items():
        if name.startswith('db/migrations/'):
            source_file(packet / 'expanded' / name, entry, apply=True)
    require(migration(packet, manifest, 'inspect')['state'] == 'baseline', 'Expected an unexpanded baseline')
    request(queue, 'submit', spec={'id':ticket,'source':manifest['candidate'],'base':manifest['baseline'],
        'dependencies':[],'risk':'isolated','migrations':[manifest['tag']],
        'acceptance':'Protected route and signed-in walkthrough '+manifest['smoke'],
        'evidence':'Exact PostgreSQL rehearsal '+str(manifest['run'])+'; same authenticated build '+manifest['build']})
    with queue.transaction():
        prepared = queue.apply('prepare', ACTOR, {'tickets':[ticket], 'candidate':manifest['candidate'],
            'baseline':manifest['baseline'],'baselineBuild':manifest['build'],'strategy':'index-expansion'})
        record(packet / 'batch.json', {'batch':prepared['batch']})
    return {'ticket':ticket,'batch':prepared['batch'],'buildReused':manifest['build']}


def packet_for(queue):
    lease = queue.db.execute('SELECT * FROM lease').fetchone()
    if lease['batch'] is not None:
        batch = queue.row('batches', lease['batch'])
    else:
        batch = queue.db.execute("SELECT * FROM batches WHERE state='prepared' ORDER BY sequence LIMIT 1").fetchone()
        if batch is None:
            return None
    plan = json.loads(batch['plan'])
    if plan.get('lane') != 'index-expansion' or len(plan['tickets']) != 1:
        return None
    packet = PACKETS / str(uuid.UUID(plan['tickets'][0]))
    if not (packet / 'batch.json').exists():
        return None
    private(packet, directory=True)
    if read_record(packet / 'batch.json')['batch'] != batch['id']:
        return None
    if batch['state'] == 'leased' and not (packet / 'lease.json').exists():
        return None
    return packet, dict(batch), dict(lease)


def install(queue, cutover, packet, manifest, lease):
    with queue.operations():
        held, _ = queue.lease(lease)
        if held['phase'] == 'claimed':
            baseline = queue.ready(manifest['baseline'],manifest['build'])
            require(baseline.get('backend')=='canonical', 'Baseline moved off canonical')
            for name, entry in manifest['files'].items():
                source_file(APP / name, entry)
            request(queue, 'phase', phase='installing', **lease)
        else:
            require(held['phase']=='installing', 'Unexpected schema-only installation phase')
        require(cutover.pointer.resolve(strict=True)==cutover.canonical_socket, 'Canonical ingress moved')
        cutover.prove_outcome(cutover.ingress, {'path':manifest['smoke'],'status':307})
        applied = migration(packet, manifest, 'apply')
        for name, entry in manifest['files'].items():
            source_file(APP / name, entry, apply=True)
        subprocess.run([*NODE,'.github/ci/staging-migration-ledger.mjs'],cwd=APP,check=True,
                       capture_output=True,timeout=25)
        subprocess.run([*NODE,'--import','tsx','scripts/check-import-worker.ts'],cwd=APP,check=True,
                       capture_output=True,timeout=25)
        env = dict(os.environ, AIHR_STAGING_BATCH=lease['batch'], AIHR_STAGING_EPOCH=str(lease['epoch']),
                   AIHR_STAGING_TOKEN=lease['token'], AIHR_STAGING_CANDIDATE=manifest['candidate'],
                   AIHR_STAGING_STATE_GUARDED='1')
        for args in [('begin',manifest['candidate'],str(os.getpid()),str(packet/'arrival.json')),
                     ('phase','schema-only-reused-build'),('built',),('finish','0')]:
            subprocess.run(['bash','deploy/deploy-state.sh',*args],cwd=APP,env=env,check=True,timeout=15)
        require(queue.ready(manifest['candidate'],manifest['build']).get('backend')=='canonical',
                'Reused canonical build could not be verified')
        cutover.prove_outcome(cutover.ingress, {'path':manifest['smoke'],'status':307})
        record(packet/'arrival.json', {'migration':applied,'build':manifest['build'],
            'reusedFrom':manifest['baseline'],'candidate':manifest['candidate'],'rehearsal':manifest['run']})
        with queue.transaction():
            active, _ = queue.lease(lease)
            require(active['phase']=='installing','Stale installation lease')
            queue.db.execute("UPDATE lease SET phase='arrived',build=?", (manifest['build'],))
            queue.event(ACTOR,'phase',{'batch':lease['batch'],'epoch':lease['epoch'],
                        'phase':'arrived','build':manifest['build']})


def pickup(queue, cutover):
    with (PACKETS / 'worker.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        selected = packet_for(queue)
        if selected is None:
            return
        packet, batch, held = selected
        manifest = read_record(packet/'manifest.json')
        verify_manifest(manifest)
        if held['batch'] is None:
            with queue.transaction():
                lease = queue.apply('claim',ACTOR,{'batch':batch['id']})
                record(packet/'lease.json',lease)
        else:
            if held['phase'] in ('arrived','accepting','capturing'):
                return
            lease = read_record(packet/'lease.json')
        install(queue,cutover,packet,manifest,lease)
        print(canonical({'arrived':batch['id'],'build':manifest['build']}))


def main():
    os.umask(0o077)
    private(ROOT, directory=True)
    PACKETS.mkdir(mode=0o700, exist_ok=True)
    private(PACKETS, directory=True)
    cutover=open_staging(ROOT/'cutover.json')
    queue=Coordinator(probe=cutover.queue_state)
    with contextlib.closing(queue.db):
        if sys.argv[1:] == ['register']:
            raw=sys.stdin.buffer.read(4*2**20+1)
            require(len(raw)<=4*2**20,'Schema-only packet exceeds size limit')
            print(canonical(register(queue,json.loads(raw))))
        elif sys.argv[1:] == ['pickup']:
            pickup(queue,cutover)
        elif len(sys.argv)==3 and sys.argv[1]=='finish':
            packet=PACKETS/str(uuid.UUID(sys.argv[2]))
            private(packet,directory=True)
            manifest=read_record(packet/'manifest.json')
            lease=read_record(packet/'lease.json')
            require((packet/'arrival.json').is_file(),'No verified arrival')
            reason=json.load(sys.stdin)['reason']
            request(queue,'phase',phase='accepting',build=manifest['build'],**lease)
            print(canonical(request(queue,'finish',reason=reason,**lease)))
        else:
            raise ValueError('Expected register, pickup or finish')


if __name__=='__main__':
    main()
