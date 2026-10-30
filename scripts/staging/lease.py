"""Private staging lease credential reader for Python operator tools."""
import json
import os
from pathlib import Path
import re
import shlex
from coordinator import PROTOCOL, private, require

COORDINATOR = '/var/tmp/aihr-deploy/staging-release-queue/coordinator.py'


def load_lease(candidate):
    path = Path(os.environ.get('AIHR_STAGING_LEASE_FILE', ''))
    require(path.is_absolute(), 'Set AIHR_STAGING_LEASE_FILE to the private lease credential')
    private(path)
    require(path.stat().st_size <= 4096, 'Lease credential exceeds bound')
    g = json.loads(path.read_text())
    require(g.get('protocol') == PROTOCOL and g.get('candidate') == candidate and g.get('releaseAuthorized') is False, 'Lease source/protocol differs')
    require(type(g.get('epoch')) is int and g['epoch'] > 0 and re.fullmatch('[a-f0-9]{64}', g.get('token','')) and re.fullmatch('[a-f0-9-]{36}', g.get('batch','')), 'Lease identity invalid')
    return g


def guard_command(g, command):
    env = dict(AIHR_STAGING_BATCH=g['batch'], AIHR_STAGING_EPOCH=str(g['epoch']), AIHR_STAGING_TOKEN=g['token'], AIHR_STAGING_CANDIDATE=g['candidate'])
    return 'env ' + ' '.join(k+'='+shlex.quote(v) for k,v in env.items()) + ' python3 ' + COORDINATOR + ' guard -- bash -c ' + shlex.quote(command)


def guard_server_cli():
    """Protect direct Python mutation CLIs on commissioned staging, including operation lifetime."""
    import sys
    import subprocess
    if Path.cwd() != Path('/opt/ai-hr') or not Path(COORDINATOR).is_file():
        return
    if os.environ.get('AIHR_STAGING_PYTHON_GUARDED') != '1':
        env = dict(os.environ, AIHR_STAGING_PYTHON_GUARDED='1')
        os.execvpe('python3', ['python3', COORDINATOR, 'guard', '--', sys.executable, *sys.argv], env)
    subprocess.run(['python3', COORDINATOR, 'assert-env'], check=True)
