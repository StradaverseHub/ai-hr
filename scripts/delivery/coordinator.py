#!/usr/bin/env python3
"""Private durable delivery controller. Builders propose; one controller owns installation.

No credentials, HR data, model calls or arbitrary shell commands live here. Host mutation is
performed only by the configured operator adapter, retaining the existing host lease.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import time
import uuid

POLICY = 'aihr-delivery/v1'
KINDS = ('verify', 'build', 'prepare', 'install', 'observe')
HEX = re.compile(r'^[a-f0-9]{64}$')
SHA = re.compile(r'^[a-f0-9]{40}$')

def require(ok, message):
    if not ok: raise ValueError(message)

def canonical(v): return json.dumps(v, sort_keys=True, separators=(',', ':'))
def digest(v): return hashlib.sha256(canonical(v).encode()).hexdigest()
def closed(v, keys): require(isinstance(v, dict) and set(v) == set(keys), 'Closed request shape required')

def open_store(path):
    path = Path(path).absolute()
    require(path.parent.resolve() == path.parent and path.parent.is_dir(), 'Canonical private state directory required')
    require(stat.S_IMODE(path.parent.stat().st_mode) == 0o700 and path.parent.stat().st_uid == os.getuid(), 'State directory must be owned mode0700')
    if path.exists():
        st = path.lstat(); require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.getuid() and stat.S_IMODE(st.st_mode) == 0o600, 'Private regular state file required')
    else:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600); os.close(fd)
    db = sqlite3.connect(path, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.executescript('''
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=DELETE;
    CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY, spec TEXT NOT NULL, state TEXT NOT NULL, artifact TEXT, created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES releases(id), kind TEXT NOT NULL, state TEXT NOT NULL,
      epoch INTEGER NOT NULL DEFAULT 0, token TEXT, owner TEXT, lease_until REAL, receipt TEXT, UNIQUE(release_id,kind));
    CREATE TABLE IF NOT EXISTS targets(name TEXT PRIMARY KEY, release_id TEXT REFERENCES releases(id), epoch INTEGER NOT NULL DEFAULT 0, token TEXT,
      baseline TEXT, installed TEXT, state TEXT NOT NULL DEFAULT 'idle');
    CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, request TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, action TEXT NOT NULL,
      payload TEXT NOT NULL, response TEXT NOT NULL, at REAL NOT NULL);
    ''')
    return db

class Coordinator:
    def __init__(self, db, now=time.time): self.db, self.now = db, now
    def handle(self, r):
        closed(r, ('id', 'actor', 'action', 'payload'))
        require(isinstance(r['id'], str) and str(uuid.UUID(r['id'])) == r['id'], 'Stable request UUID required')
        require(isinstance(r['actor'], str) and 0 < len(r['actor']) <= 120, 'Bounded actor required')
        require(r['action'] in ('submit', 'claim', 'finish', 'acquire', 'accept', 'recover', 'supersede', 'status'), 'Unknown delivery action')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            prior = self.db.execute('SELECT * FROM events WHERE request=?', (r['id'],)).fetchone()
            if prior:
                require(prior['actor'] == r['actor'] and prior['action'] == r['action'] and prior['payload'] == canonical(r['payload']), 'Request identity reused with different intent')
                self.db.commit(); return json.loads(prior['response'])
            result = getattr(self, r['action'])(r['payload'], r['actor'])
            # Claim credentials exist only in private replies/store. Status redacts them.
            self.db.execute('INSERT INTO events(request,actor,action,payload,response,at) VALUES(?,?,?,?,?,?)', (r['id'],r['actor'],r['action'],canonical(r['payload']),canonical(result),self.now()))
            self.db.commit(); return result
        except BaseException:
            self.db.rollback(); raise
    def submit(self, p, actor):
        closed(p, ('source', 'base', 'contract', 'target'))
        require(SHA.fullmatch(p['source']) and SHA.fullmatch(p['base']) and HEX.fullmatch(p['contract']), 'Exact source/base/approved contract digest required')
        require(p['target'] in ('staging', 'production'), 'Explicit installation target required')
        identity = digest({'policy':POLICY, **p})
        prior = self.db.execute('SELECT id FROM releases WHERE id=?', (identity,)).fetchone()
        if prior: return {'release':identity, 'duplicate':True}
        self.db.execute('INSERT INTO releases VALUES(?,?,?,?,?)', (identity,canonical(p),'verifying',None,self.now()))
        for kind in KINDS:
            self.db.execute('INSERT INTO jobs(id,release_id,kind,state) VALUES(?,?,?,?)', (digest([identity,kind]),identity,kind,'queued'))
        self.db.execute('INSERT OR IGNORE INTO targets(name) VALUES(?)', (p['target'],))
        return {'release':identity, 'duplicate':False}
    def claim(self, p, actor):
        closed(p, ('kinds', 'seconds'))
        require(isinstance(p['kinds'],list) and p['kinds'] and len(set(p['kinds']))==len(p['kinds']) and all(k in KINDS for k in p['kinds']), 'Known worker responsibilities required')
        require(type(p['seconds']) is int and 5 <= p['seconds'] <= 900, 'Bounded verification/preparation lease required')
        jobs = self.db.execute("SELECT j.*,r.state AS release_state,r.spec,r.artifact FROM jobs j JOIN releases r ON r.id=j.release_id WHERE r.state NOT IN ('accepted','failed','repair_required','superseded') AND (j.state='queued' OR (j.state='running' AND j.lease_until<=? AND j.kind NOT IN ('install','observe'))) ORDER BY r.created,j.rowid", (self.now(),)).fetchall()
        for j in jobs:
            if j['kind'] not in p['kinds']: continue
            prior = KINDS[:KINDS.index(j['kind'])]
            if any(self.db.execute('SELECT state FROM jobs WHERE release_id=? AND kind=?',(j['release_id'],k)).fetchone()['state'] != 'passed' for k in prior): continue
            spec = json.loads(j['spec'])
            if j['kind'] in ('install','observe'):
                target = self.db.execute('SELECT * FROM targets WHERE name=?', (spec['target'],)).fetchone()
                if target['release_id'] != j['release_id'] or target['state'] != 'held': continue
            token = secrets.token_hex(32); epoch = j['epoch'] + 1
            self.db.execute("UPDATE jobs SET state='running',epoch=?,token=?,owner=?,lease_until=? WHERE id=?", (epoch,token,actor,self.now()+p['seconds'],j['id']))
            if j['kind'] in ('install','observe'): self.db.execute('UPDATE releases SET state=? WHERE id=?',('installing' if j['kind']=='install' else 'observing',j['release_id']))
            return {'job':j['id'],'release':j['release_id'],'kind':j['kind'],'epoch':epoch,'token':token,'spec':spec,'artifact':json.loads(j['artifact']) if j['artifact'] else None}
        return {'job':None}
    def finish(self, p, actor):
        closed(p, ('job','epoch','token','result','receipt'))
        require(p['result'] in ('passed','failed'), 'Passed/failed execution result required')
        j=self.db.execute('SELECT * FROM jobs WHERE id=?',(p['job'],)).fetchone();require(j is not None,'Unknown job')
        require(j['epoch']==p['epoch'] and secrets.compare_digest(j['token'] or '',p['token']) and j['owner']==actor,'Stale or foreign worker')
        receipt=canonical(p['receipt']);require(len(receipt)<=262144 and isinstance(p['receipt'],dict),'Bounded execution receipt required')
        if j['state'] in ('passed','failed'):
            require(j['state']==p['result'] and j['receipt']==receipt,'Settled job intent differs');return {'state':j['state'],'duplicate':True}
        require(j['state']=='running' and j['lease_until']>self.now(),'Expired worker completion refused')
        require(p['receipt'].get('source')==json.loads(self.db.execute('SELECT spec FROM releases WHERE id=?',(j['release_id'],)).fetchone()['spec'])['source'],'Receipt source differs')
        self.db.execute('UPDATE jobs SET state=?,receipt=? WHERE id=?',(p['result'],receipt,j['id']))
        if p['result']=='failed':
            state='repair_required' if j['kind'] in ('install','observe') else 'failed'
        else:
            state={'verify':'building','build':'preparing','prepare':'ready','install':'observing','observe':'observed'}[j['kind']]
            if j['kind']=='build':
                require(HEX.fullmatch(p['receipt'].get('artifactDigest','')),'Immutable artifact digest required')
                self.db.execute('UPDATE releases SET artifact=? WHERE id=?',(receipt,j['release_id']))
        self.db.execute('UPDATE releases SET state=? WHERE id=?',(state,j['release_id']))
        return {'state':state,'duplicate':False}
    def acquire(self, p, actor):
        closed(p, ('release','baseline','authorization'))
        r=self.db.execute('SELECT * FROM releases WHERE id=?',(p['release'],)).fetchone();require(r and r['state']=='ready','Prepare and authenticate bytes before reserving the environment')
        spec=json.loads(r['spec']);t=self.db.execute('SELECT * FROM targets WHERE name=?',(spec['target'],)).fetchone()
        require(t['release_id'] is None,'Foreign or uncertain environment lease retained')
        require(p['baseline']==t['installed'],'Installed baseline changed; re-plan compatible upgrade')
        # Production authorization is an authenticated protected-environment receipt supplied by the adapter,
        # not a user-provided boolean or a reporter approval. No default production authority.
        auth=p['authorization'];closed(auth,('artifactDigest','target','receiptDigest'))
        require(auth['artifactDigest']==json.loads(r['artifact'])['artifactDigest'] and auth['target']==spec['target'] and HEX.fullmatch(auth['receiptDigest']),'Exact target/artifact authorization required')
        token=secrets.token_hex(32);epoch=t['epoch']+1
        self.db.execute("UPDATE targets SET release_id=?,epoch=?,token=?,baseline=?,state='held' WHERE name=?",(r['id'],epoch,token,p['baseline'],spec['target']))
        return {'target':spec['target'],'release':r['id'],'epoch':epoch,'token':token,'baseline':p['baseline']}
    def accept(self,p,actor):
        closed(p,('target','release','epoch','token','source','artifactDigest','receiptDigest'))
        t=self.db.execute('SELECT * FROM targets WHERE name=?',(p['target'],)).fetchone()
        require(t and t['release_id']==p['release'] and t['epoch']==p['epoch'] and secrets.compare_digest(t['token'] or '',p['token']),'Foreign/stale environment handback')
        r=self.db.execute('SELECT * FROM releases WHERE id=?',(p['release'],)).fetchone()
        require(r['state']=='observed' and p['source']==json.loads(r['spec'])['source'] and p['artifactDigest']==json.loads(r['artifact'])['artifactDigest'] and HEX.fullmatch(p['receiptDigest']),'Actual source/build/operational acceptance required')
        self.db.execute("UPDATE targets SET release_id=NULL,token=NULL,baseline=NULL,installed=?,state='idle' WHERE name=?",(p['source'],p['target']))
        self.db.execute("UPDATE releases SET state='accepted' WHERE id=?",(p['release'],));return {'state':'accepted','target':p['target'],'source':p['source']}
    def recover(self,p,actor):
        closed(p,('target','epoch','token','release','receiptDigest'))
        t=self.db.execute('SELECT * FROM targets WHERE name=?',(p['target'],)).fetchone()
        require(t and t['release_id']==p['release'] and t['epoch']==p['epoch'] and secrets.compare_digest(t['token'] or '',p['token']) and HEX.fullmatch(p['receiptDigest']),'Explicit exact-owner recovery proof required')
        r=self.db.execute('SELECT state FROM releases WHERE id=?',(p['release'],)).fetchone();require(r['state']=='repair_required' or (r['state'] in ('installing','observing') and self.db.execute("SELECT id FROM jobs WHERE release_id=? AND state='running' AND lease_until<=?",(p['release'],self.now())).fetchone()),'Only recorded failed or expired uncertain mutation can recover')
        # Recovery never clears the target lease or invents success. The operator adapter must inspect
        # actual source/ledger/process and record a fresh operation with a new job epoch.
        self.db.execute("UPDATE jobs SET state='queued',token=NULL,owner=NULL,lease_until=NULL WHERE release_id=? AND state IN ('failed','running')",(p['release'],))
        self.db.execute("UPDATE releases SET state='recovering' WHERE id=?",(p['release'],));return {'state':'recovering','leaseRetained':True}
    def supersede(self,p,actor):
        closed(p,('release','replacement'))
        require(p['release']!=p['replacement'] and self.db.execute('SELECT id FROM releases WHERE id=?',(p['replacement'],)).fetchone(),'Existing distinct replacement required')
        require(not self.db.execute('SELECT name FROM targets WHERE release_id=?',(p['release'],)).fetchone(),'Never supersede an installing/uncertain release')
        r=self.db.execute('SELECT state FROM releases WHERE id=?',(p['release'],)).fetchone();require(r and r['state']!='accepted','Cannot supersede accepted history')
        self.db.execute("UPDATE releases SET state='superseded' WHERE id=?",(p['release'],));self.db.execute("UPDATE jobs SET token=NULL,state='cancelled' WHERE release_id=? AND state IN ('queued','running')",(p['release'],));return {'state':'superseded'}
    def status(self,p,actor):
        closed(p,())
        return {'policy':POLICY,'releases':[dict(r) for r in self.db.execute('SELECT id,spec,state,artifact,created FROM releases ORDER BY created')], 'targets':[dict(r) for r in self.db.execute('SELECT name,release_id,epoch,baseline,installed,state FROM targets')], 'jobs':[dict(r) for r in self.db.execute('SELECT id,release_id,kind,state,epoch,owner,lease_until FROM jobs')], 'releaseAuthorized':False}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--state',required=True);args=parser.parse_args()
    raw=os.read(0,1048577);require(len(raw)<=1048576,'Bounded private request required')
    request=json.loads(raw);print(canonical(Coordinator(open_store(args.state)).handle(request)))

if __name__=='__main__':
    try: main()
    except (ValueError,KeyError,sqlite3.Error,OSError) as e: raise SystemExit('Delivery controller refused: '+str(e))
