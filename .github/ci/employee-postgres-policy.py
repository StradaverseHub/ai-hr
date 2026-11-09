"""Pure native Docker custody predicates. No Docker/process/filesystem actions."""
import hashlib
import re
import calendar
import datetime

IMAGE = 'postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97'
MEMORY = 2113929216
PROFILE = {'profileVersion': 2, 'configuredCapBytes': MEMORY, 'peakBudgetBytes': 2147483648, 'jit': 'on'}
COMMAND = ['-c', 'listen_addresses=127.0.0.1', '-c', 'port=5433', '-c', 'max_wal_senders=0',
           '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
           '-c', 'wal_level=minimal', '-c', 'jit=on', '-c', 'shared_buffers=128MB',
           '-c', 'max_connections=100', '-c', 'max_locks_per_transaction=256']


def require(value):
    if not value:
        raise ValueError('Closed employee PostgreSQL custody refused')


def sha(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def name(context):
    require(re.fullmatch(r'[1-9][0-9]{0,19}', context['run']) is not None)
    require(context['attempt'] == '1' and re.fullmatch(r'db-[0-9a-f]{16}', context['unit']) is not None)
    return 'aihr-ci-%s-%s-%s' % (context['run'], context['attempt'], context['unit'])


def labels(context):
    require(digest(context['resourceNonce']))
    return {'aihr-owner': name(context), 'aihr-lifecycle': 'employee-normal-v1',
            **{'aihr-' + key: context[key] for key in ('source', 'controller', 'run', 'attempt', 'unit', 'resourceNonce')}}


def container(value, context, *, cid=None, image_id=None, created=None):
    """Validate actual inspect content, never a name or caller receipt alone.

    Anonymous image-declared PGDATA is permitted; external bind mounts/volumes,
    privilege/namespace changes and arbitrary commands are forbidden.
    """
    require(isinstance(value, dict) and digest(value.get('Id')))
    if cid is not None:
        require(value['Id'] == cid)
    require(value.get('Name') == '/' + name(context))
    config, host = value['Config'], value['HostConfig']
    require(config['Image'] == IMAGE and config['Labels'] == labels(context))
    require(config['Cmd'] == COMMAND and config['Entrypoint'] == ['docker-entrypoint.sh'])
    require(config.get('User', '') == '' and not config.get('Tty') and not config.get('OpenStdin'))
    env = config['Env']
    require(isinstance(env, list) and len(env) == len(set(row.split('=', 1)[0] for row in env)))
    require('POSTGRES_HOST_AUTH_METHOD=trust' in env and 'TZ=Asia/Kuala_Lumpur' in env)
    require(not any(row.startswith(('POSTGRES_PASSWORD=', 'POSTGRES_PASSWORD_FILE=', 'PGPASSWORD=')) for row in env))
    require(not any(row.split('=', 1)[0] in ('PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE') for row in env))
    require(host['NetworkMode'] == 'host' and host['Memory'] == host['MemorySwap'] == MEMORY
            and host['ShmSize'] == 134217728 and not host['Privileged'] and not host.get('AutoRemove'))
    require(not host.get('Binds') and not host.get('Mounts') and not host.get('VolumesFrom')
            and not host.get('CapAdd') and not host.get('Devices') and not host.get('SecurityOpt')
            and not host.get('PidMode') and host.get('IpcMode') == 'private')
    require(config.get('Volumes') == {'/var/lib/postgresql/data': {}})
    mounts = value.get('Mounts')
    require(isinstance(mounts, list) and len(mounts) == 1)
    mount = mounts[0]
    require(mount['Type'] == 'volume' and mount['Destination'] == '/var/lib/postgresql/data'
            and mount['RW'] is True and re.fullmatch(r'[0-9a-f]{64}', mount['Name']) is not None)
    require(isinstance(value.get('Created'), str) and value['Created'].endswith('Z'))
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', value.get('Image', '')) is not None)
    if image_id is not None:
        require(value['Image'] == image_id)
    if created is not None:
        require(value['Created'] == created)
    return {'cid': value['Id'], 'imageId': value['Image'], 'created': value['Created'], 'volume': mount['Name']}


def started(value):
    state = value['State']
    require(state['Running'] is True and state['Dead'] is False and state['Restarting'] is False
            and state['OOMKilled'] is False and state['Error'] == '' and state['Status'] == 'running'
            and type(state['Pid']) is int and state['Pid'] > 1 and state['StartedAt'].endswith('Z'))
    return {'pid': state['Pid'], 'startedAt': state['StartedAt']}


def same_birth(value, birth):
    require(started(value) == {key: birth[key] for key in ('pid', 'startedAt')})


def cleanup_target(actual, context, receipt, intent, known_cid=None):
    """A lost CREATE reply permits cleanup only; it never admits a test.

    A known CID cannot be replaced even by an otherwise identical container.
    No intent or an absent response/container leaves custody uncertain.
    """
    require(intent is not None)
    expected = {} if receipt is None else {key: receipt[key] for key in ('cid', 'imageId', 'created')}
    target = container(actual, context, cid=expected.get('cid'), image_id=expected.get('imageId'), created=expected.get('created'))
    if known_cid is not None:
        require(digest(known_cid) and target['cid'] == known_cid)
    match = re.fullmatch(r'([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?Z', target['created'])
    require(match is not None)
    created_ns = calendar.timegm(datetime.datetime.strptime(match[1], '%Y-%m-%dT%H:%M:%S').timetuple()) * 10**9 + int((match[2] or '').ljust(9, '0'))
    require(created_ns >= int(intent['wallTimeNs']))
    return target
