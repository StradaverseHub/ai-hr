#!/usr/bin/env python3
"""Staging scheduling only: durable SQLite queue, non-expiring fenced lease, operation lock.
No queue record is a gate receipt or human acceptance certificate.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import subprocess
import sys
import time
import uuid

ROOT = Path('/var/tmp/aihr-deploy/staging-release-queue')
APP = Path('/opt/ai-hr')
PROTOCOL = 'aihr-staging-queue/v1'
SHA = re.compile(r'[0-9a-f]{40}')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(value):
    require(isinstance(value, str) and SHA.fullmatch(value), 'Exact full source SHA required')
    return value


def text(value, limit=240):
    require(isinstance(value, str) and 0 < len(value) <= limit and all(ord(c) >= 32 for c in value), 'Bounded nonempty text required')
    return value


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def private(path, directory=False):
    st = path.lstat()
    require(not stat.S_ISLNK(st.st_mode) and path.resolve() == path.absolute() and st.st_uid == os.getuid(), 'Owned canonical private path required')
    require(stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode) and st.st_nlink == 1, 'Unexpected private path kind')
    require(stat.S_IMODE(st.st_mode) == (0o700 if directory else 0o600), 'Private path mode differs')


class Coordinator:
    def __init__(self, root=ROOT, probe=None):
        self.root = Path(root)
        private(self.root, True)
        self.probe = probe or live_state
        for name in ('queue.sqlite3', 'operations.lock'):
            p = self.root / name
            fd = os.open(p, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            private(p)
        self.db = sqlite3.connect(self.root / 'queue.sqlite3', timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS tickets (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT UNIQUE NOT NULL, spec TEXT NOT NULL, state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS batches (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT UNIQUE NOT NULL, plan TEXT NOT NULL, state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            epoch INTEGER NOT NULL, batch TEXT, token_hash TEXT, phase TEXT, build TEXT);
          INSERT OR IGNORE INTO lease(singleton,epoch) VALUES(1,0);
          CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            at REAL NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
        ''')

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    @contextlib.contextmanager
    def operations(self, exclusive=False):
        fd = os.open(self.root / 'operations.lock', os.O_RDWR | os.O_NOFOLLOW)
        try:
            private(self.root / 'operations.lock')
            fcntl.flock(fd, (fcntl.LOCK_EX | fcntl.LOCK_NB) if exclusive else fcntl.LOCK_SH)
            yield fd
        finally:
            os.close(fd)

    def event(self, actor, action, detail):
        self.db.execute('INSERT INTO events(at,actor,action,detail) VALUES(?,?,?,?)', (time.time(), actor, action, canonical(detail)))

    def row(self, table, key):
        require(table in ('tickets', 'batches'), 'Unknown table')
        row = self.db.execute('SELECT * FROM ' + table + ' WHERE id=?', (key,)).fetchone()
        require(row is not None, 'Unknown queue identity')
        return dict(row)

    def lease(self, r):
        lease = dict(self.db.execute('SELECT * FROM lease').fetchone())
        require(lease['batch'] is not None and lease['epoch'] == r.get('epoch') and lease['batch'] == r.get('batch'), 'Lease identity/fencing epoch differs')
        token = r.get('token', '')
        require(isinstance(token, str) and secrets.compare_digest(lease['token_hash'], hashlib.sha256(token.encode()).hexdigest()), 'Lease credential differs')
        plan = json.loads(self.row('batches', lease['batch'])['plan'])
        require(plan['candidate'] == r.get('candidate'), 'Lease source differs')
        return lease, plan

    def ready(self, baseline, build):
        s = self.probe()
        require(s.get('state') == 'ok' and s.get('stale_build') == '0' and s.get('ref') == s.get('built_ref') == baseline and s.get('build_id') == s.get('built_build_id') == build, 'Live source/build baseline is not healthy and exact')
        return s

    def request(self, r):
        require(isinstance(r, dict) and r.get('protocol') == PROTOCOL, 'Queue protocol differs')
        action = r.get('action')
        actor = text(r.get('actor'))
        lock = self.operations(exclusive=True) if action in ('finish', 'abort', 'recover') else contextlib.nullcontext()
        with lock, self.transaction():
            result = self.apply(action, actor, r)
        return {'protocol': PROTOCOL, 'releaseAuthorized': False, **result}

    def apply(self, action, actor, r):
        if action == 'status':
            l = dict(self.db.execute('SELECT * FROM lease').fetchone()); l.pop('token_hash')
            return {'lease': l, 'tickets': [dict(x) for x in self.db.execute('SELECT * FROM tickets ORDER BY sequence')], 'batches': [dict(x) for x in self.db.execute('SELECT * FROM batches ORDER BY sequence')], 'events': [dict(x) for x in self.db.execute('SELECT * FROM events ORDER BY sequence DESC LIMIT 100')]}
        if action == 'submit':
            spec = r['spec']; require(set(spec) == {'id', 'source', 'base', 'dependencies', 'risk', 'migrations', 'acceptance', 'evidence'}, 'Exact ticket fields required')
            require(str(uuid.UUID(spec['id'])) == spec['id'], 'UUID ticket required')
            sha(spec['source']); sha(spec['base'])
            require(spec['risk'] in ('ordinary', 'isolated') and isinstance(spec['migrations'], list) and len(spec['migrations']) <= 100, 'Risk/migration inventory required')
            for value in spec['migrations']: text(value)
            for name in ('acceptance', 'evidence'): text(spec[name], 2000)
            deps = spec['dependencies']; require(isinstance(deps, list) and len(set(deps)) == len(deps) and len(deps) <= 20 and spec['id'] not in deps, 'Invalid dependencies')
            for dep in deps: self.row('tickets', dep)
            old = self.db.execute('SELECT * FROM tickets WHERE id=?', (spec['id'],)).fetchone()
            if old:
                require(old['spec'] == canonical(spec), 'Ticket identity already binds different bytes')
                return {'id': spec['id'], 'state': old['state']}
            self.db.execute('INSERT INTO tickets(id,spec,state) VALUES(?,?,?)', (spec['id'], canonical(spec), 'queued'))
            self.event(actor, action, spec)
            return {'id': spec['id'], 'state': 'queued'}
        if action in ('block', 'unblock', 'cancel'):
            t = self.row('tickets', r['id']); reason = text(r['reason'])
            require(t['state'] in ('queued', 'blocked'), 'Frozen or terminal ticket cannot change')
            state = {'block': 'blocked', 'unblock': 'queued', 'cancel': 'cancelled'}[action]
            self.db.execute('UPDATE tickets SET state=? WHERE id=?', (state, t['id']))
            self.event(actor, action, {'id': t['id'], 'reason': reason})
            return {'id': t['id'], 'state': state}
        if action == 'prepare':
            ids = r['tickets']; require(isinstance(ids, list) and 1 <= len(ids) <= 3 and len(set(ids)) == len(ids), 'Batches contain one to three unique tickets')
            ts = [self.row('tickets', i) for i in ids]; specs = [json.loads(t['spec']) for t in ts]
            require(all(t['state'] == 'queued' for t in ts), 'Every member must be queued')
            require(len(ids) == 1 or all(s['risk'] == 'ordinary' and not s['migrations'] for s in specs), 'Migration or isolated-risk changes release alone')
            for s in specs:
                for dep in s['dependencies']:
                    require(dep in ids or self.row('tickets', dep)['state'] == 'complete', 'Dependency is not included or complete')
            candidate = sha(r['candidate']); baseline = sha(r['baseline']); build = text(r['baselineBuild'])
            self.ready(baseline, build)
            plan = {'candidate': candidate, 'baseline': baseline, 'baselineBuild': build, 'tickets': ids, 'members': [s['source'] for s in specs]}
            key = str(uuid.uuid4())
            self.db.execute('INSERT INTO batches(id,plan,state) VALUES(?,?,?)', (key, canonical(plan), 'prepared'))
            for i in ids: self.db.execute("UPDATE tickets SET state='prepared' WHERE id=?", (i,))
            self.event(actor, action, {'batch': key, **plan})
            return {'batch': key, 'plan': plan}
        if action == 'claim':
            l = dict(self.db.execute('SELECT * FROM lease').fetchone())
            require(l['batch'] is None, 'Staging lease already held; no timeout or automatic takeover')
            b = self.row('batches', r['batch']); require(b['state'] == 'prepared', 'Prepared batch required')
            first = self.db.execute("SELECT id FROM batches WHERE state='prepared' ORDER BY sequence LIMIT 1").fetchone()
            require(first['id'] == b['id'], 'An earlier prepared batch has priority; block/requeue it explicitly')
            p = json.loads(b['plan']); self.ready(p['baseline'], p['baselineBuild'])
            token = secrets.token_hex(32); epoch = l['epoch'] + 1
            self.db.execute("UPDATE lease SET epoch=?,batch=?,token_hash=?,phase='claimed',build=NULL", (epoch, b['id'], hashlib.sha256(token.encode()).hexdigest()))
            self.db.execute("UPDATE batches SET state='leased' WHERE id=?", (b['id'],))
            self.event(actor, action, {'batch': b['id'], 'epoch': epoch})
            return {'batch': b['id'], 'epoch': epoch, 'token': token, 'candidate': p['candidate']}
        if action == 'requeue':
            b = self.row('batches', r['batch']); require(b['state'] == 'prepared', 'Only unclaimed batches can be requeued')
            reason = text(r['reason']); self.db.execute("UPDATE batches SET state='superseded' WHERE id=?", (b['id'],))
            for i in json.loads(b['plan'])['tickets']: self.db.execute("UPDATE tickets SET state='queued' WHERE id=?", (i,))
            self.event(actor, action, {'batch': b['id'], 'reason': reason})
            return {'state': 'superseded'}
        if action == 'recover':
            require(r.get('acknowledgeUncertainAttempt') is True, 'Explicit operator recovery acknowledgement required')
            l = dict(self.db.execute('SELECT * FROM lease').fetchone())
            require(l['batch'] is not None and l['batch'] == r.get('batch') and l['epoch'] == r.get('epoch'), 'Recovery must name the exact abandoned lease')
            p = json.loads(self.row('batches', l['batch'])['plan'])
            require(p['candidate'] == r.get('candidate'), 'Recovery source differs')
        else:
            l, p = self.lease(r)
        if action == 'assert': return {'batch': l['batch'], 'epoch': l['epoch'], 'candidate': p['candidate'], 'phase': l['phase']}
        if action == 'phase':
            phases = ['claimed', 'installing', 'arrived', 'accepting', 'capturing']
            phase = r['phase']; require(phase in phases and phases.index(l['phase']) <= phases.index(phase) <= phases.index(l['phase']) + 1, 'Lease phases cannot skip arrival or go backwards')
            build = r.get('build') or l['build']
            if phases.index(phase) >= 2:
                text(build); self.ready(p['candidate'], build)
            self.db.execute('UPDATE lease SET phase=?,build=?', (phase, build))
            self.event(actor, action, {'batch': l['batch'], 'phase': phase, 'build': build})
            return {'phase': phase}
        if action in ('finish', 'abort', 'recover'):
            reason = text(r['reason'], 2000)
            if action == 'finish':
                require(l['phase'] in ('accepting', 'capturing'), 'Arrival, acceptance and optional capture must finish before handback')
                self.ready(p['candidate'], l['build'])
                state = 'complete'
            elif action == 'abort':
                require(l['phase'] == 'claimed', 'Mutated or uncertain attempt needs explicit recovery')
                self.ready(p['baseline'], p['baselineBuild']); state = 'failed'
            else:
                require(r.get('acknowledgeUncertainAttempt') is True, 'Explicit uncertain-attempt acknowledgement required')
                self.ready(sha(r['observedSource']), text(r['observedBuild']))
                state = 'failed'
            self.db.execute('UPDATE batches SET state=? WHERE id=?', (state, l['batch']))
            for i in p['tickets']: self.db.execute('UPDATE tickets SET state=? WHERE id=?', (state, i))
            self.event(actor, action, {'batch': l['batch'], 'epoch': l['epoch'], 'reason': reason})
            self.db.execute('UPDATE lease SET batch=NULL,token_hash=NULL,phase=NULL,build=NULL')
            return {'state': state}
        raise ValueError('Unknown operation')


def live_state():
    require(APP.is_dir() and APP.resolve() == APP, 'Canonical staging application missing')
    out = subprocess.run(['bash', 'deploy/deploy-state.sh', 'status'], cwd=APP, check=True, capture_output=True, text=True, timeout=15).stdout
    subprocess.run(['systemctl', 'is-active', '--quiet', 'aihr'], check=True, timeout=15)
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


def environment_request(action='assert'):
    return {'protocol': PROTOCOL, 'action': action, 'actor': 'guard', 'batch': os.environ.get('AIHR_STAGING_BATCH'), 'epoch': int(os.environ.get('AIHR_STAGING_EPOCH', '0')), 'token': os.environ.get('AIHR_STAGING_TOKEN', ''), 'candidate': os.environ.get('AIHR_STAGING_CANDIDATE')}


def main(root=ROOT):
    os.umask(0o077)
    c = Coordinator(root)
    if len(sys.argv) > 1:
        require(sys.argv[1] in ('guard', 'assert-env'), 'Unknown guard mode')
        r = environment_request()
        # Keep the kernel lock for the actual operation, not just the check.
        with c.operations(), c.transaction():
            c.lease(r)
            if sys.argv[1] == 'assert-env': return
        if sys.argv[1] == 'guard':
            require(sys.argv[2:3] == ['--'] and len(sys.argv) > 3, 'Guard requires command after --')
            with c.operations() as operation_fd:
                with c.transaction(): c.lease(r)
                # The command inherits the lock: even SIGKILL of this guard cannot make a still
                # running child disappear from admission. Detached deploys also acquire their own lock.
                raise SystemExit(subprocess.call(sys.argv[3:], pass_fds=(operation_fd,)))
    else:
        raw = sys.stdin.buffer.read(64 * 1024 + 1); require(len(raw) <= 64 * 1024, 'Request too large')
        print(canonical(c.request(json.loads(raw))))


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        print('Staging coordinator refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
