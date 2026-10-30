#!/usr/bin/env python3
"""AI-neutral staging queue CLI. Requests and credentials stay in private files, never stdout."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from coordinator import PROTOCOL, canonical, require, private, sha

REMOTE = '/var/tmp/aihr-deploy/staging-release-queue/coordinator.py'


def command(args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['status', 'submit', 'prepare', 'claim', 'block', 'unblock', 'cancel', 'requeue', 'phase', 'finish', 'abort', 'recover'])
    p.add_argument('--request', type=Path, help='Private JSON request; see docs/STAGING-RELEASE-QUEUE.md')
    p.add_argument('--actor', required=True, help='Stable session/operator identity; model name is advisory')
    p.add_argument('--ssh-config', type=Path, default=os.environ.get('AIHR_SSH_CONFIG'))
    p.add_argument('--lease-file', type=Path, default=os.environ.get('AIHR_STAGING_LEASE_FILE'))
    p.add_argument('--worktree', type=Path, default=Path.cwd())
    a = p.parse_args()
    r = json.loads(a.request.read_text()) if a.request else {}
    require(isinstance(r, dict), 'JSON object request required')
    r.update(protocol=PROTOCOL, action=a.action, actor=a.actor)
    # A claim/terminal operation never prints a secret; callers share the private lease file explicitly.
    if a.action in ('phase', 'finish', 'abort') or (a.action == 'recover' and a.lease_file):
        require(a.lease_file is not None, 'Private --lease-file required')
        private(a.lease_file)
        grant = json.loads(a.lease_file.read_text())
        require(grant['protocol'] == PROTOCOL, 'Lease file protocol differs')
        for field in ('batch', 'epoch', 'token', 'candidate'): r[field] = grant[field]
    if a.action == 'claim':
        require(a.lease_file is not None and not a.lease_file.exists(), 'Choose a new private --lease-file before claiming')
        require(a.lease_file.parent.is_dir() and a.lease_file.parent.resolve() == a.lease_file.parent.absolute(), 'Canonical lease file parent required')
    if a.action == 'prepare':
        worktree = a.worktree.resolve()
        require(command(['git', 'status', '--porcelain', '--untracked-files=normal'], worktree) == '', 'Freeze a clean candidate before batch preparation')
        require(command(['git', 'rev-parse', 'HEAD'], worktree) == sha(r['candidate']), 'Candidate must equal clean HEAD')
        # Read exact ticket identities from authoritative service, not a caller-provided member list.
        inventory = request(a, {'protocol': PROTOCOL, 'action': 'status', 'actor': a.actor})
        members = [json.loads(t['spec']) for t in inventory['tickets'] if t['id'] in r['tickets']]
        require(len(members) == len(r['tickets']), 'Unknown member ticket')
        for commit in [r['baseline'], *[s['source'] for s in members], *[s['base'] for s in members]]:
            subprocess.run(['git', 'merge-base', '--is-ancestor', sha(commit), r['candidate']], cwd=worktree, check=True)
    # Reserve the credential destination before a remote claim, preventing lost credentials on local races.
    fd = None
    if a.action == 'claim': fd = os.open(a.lease_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        result = request(a, r)
        if fd is not None:
            with os.fdopen(fd, 'w') as stream:
                fd = None; stream.write(canonical(result) + '\n'); stream.flush(); os.fsync(stream.fileno())
            result = {k: v for k, v in result.items() if k != 'token'}
        print(json.dumps(result, indent=2))
    finally:
        if fd is not None: os.close(fd)  # Preserve uncertain empty file; never automatically retry a claim.


def request(a, r):
    args = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=12']
    if a.ssh_config:
        config = a.ssh_config.resolve(); private(config)
        args += ['-F', str(config)]
    args += ['aihr-staging', 'python3 ' + shlex.quote(REMOTE)]
    reply = subprocess.run(args, input=canonical(r), capture_output=True, text=True, timeout=45)
    require(reply.returncode == 0, reply.stderr.strip() or 'Coordinator request failed; inspect authoritative status before retrying')
    value = json.loads(reply.stdout)
    require(value.get('protocol') == PROTOCOL and value.get('releaseAuthorized') is False, 'Coordinator reply differs')
    return value


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, subprocess.SubprocessError, KeyError) as error:
        print('Staging queue refused: ' + str(error), file=sys.stderr); sys.exit(1)
