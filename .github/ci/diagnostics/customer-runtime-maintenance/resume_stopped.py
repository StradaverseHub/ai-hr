"""Continue one genuinely stopped, restored-active operation; preserve original authority."""
import argparse
import base64
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import stat
import pwd
import re

AGENT_SHA = 'dabc877431893ba363bb77ef318fc2a8cdeb962dec19b17a92d10b368585429c'
CGROUP = '/system.slice/aihr.service'


def comparable_snapshot(snapshot):
    value = copy.deepcopy(snapshot)
    value.pop('observedAt', None)
    for key in ('pid', 'startedTicks'):
        value['baseline'].pop(key)
    for key in ('activeProcessEnvironmentSha256', 'unitPropertiesSha256'):
        value['configuration'].pop(key)
    return value


def environment_map(encoded):
    pairs = base64.b64decode(encoded).split(b'\0')
    result = {}
    for item in pairs:
        if not item:
            continue
        key, value = item.split(b'=', 1)
        if key in result:
            raise ValueError('Duplicate process environment')
        result[key] = value
    return result


def same_restored_environment(before, after):
    # systemd generates these per invocation. Every other effective byte must match.
    ignored = {b'INVOCATION_ID', b'JOURNAL_STREAM', b'SYSTEMD_EXEC_PID'}
    return {k: v for k, v in before.items() if k not in ignored} == {
        k: v for k, v in after.items() if k not in ignored}


def prove_restored_process(host, private, authority, m):
    pid = private['snapshot']['baseline']['pid']
    m.require(pid == authority['restoredPid'], 'Restored PID binding differs')
    account = pwd.getpwnam(host.plan['snapshot']['configuration']['serviceUser'])
    proc = Path('/proc') / pid
    m.require(proc.stat().st_uid == account.pw_uid and account.pw_uid > 0
              and os.readlink(proc / 'exe') == '/opt/node20/bin/node'
              and os.readlink(proc / 'root') == '/', 'Restored process principal/runtime differs')
    active = environment_map(private['activeEnvironment'])
    m.require(active.get(b'INVOCATION_ID', b'').decode() == authority['restoredInvocationId']
              and host.command(['/usr/bin/systemctl', 'show', 'aihr.service', '--property=InvocationID', '--value']).decode().strip() == authority['restoredInvocationId'],
              'Restored invocation provenance differs')
    if b'SYSTEMD_EXEC_PID' in active:
        m.require(active[b'SYSTEMD_EXEC_PID'] == pid.encode(), 'Generated process identity differs')
    if b'JOURNAL_STREAM' in active:
        descriptors = [os.stat(proc / 'fd' / str(fd)) for fd in (1, 2)]
        m.require(active[b'JOURNAL_STREAM'] in [f'{s.st_dev}:{s.st_ino}'.encode() for s in descriptors],
                  'Generated journal stream provenance differs')
    actual = host.unit_properties()
    m.require(actual['MainPID'] == pid and actual['ActiveState'] == 'active', 'Restored unit invocation changed')
    argv = re.findall(r'argv\[\]=([^;]+?)\s*;', actual['ExecStart'])
    m.require(len(argv) == 1, 'Original argument descriptor differs')
    expected = argv[0].replace('${PORT}', active[b'PORT'].decode()).split()
    m.require((proc / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0') == [x.encode() for x in expected],
              'Restored command line differs')
    ticks = (proc / 'stat').read_text().rsplit(')', 1)[1].split()[19]
    m.require(ticks == authority['restoredStartedTicks'], 'Restored process changed during provenance proof')


def terminal_stop_allowed(values, cgroup_empty):
    if (values['MainPID'] != '0' or values['ControlPID'] != '0' or not cgroup_empty
            or values['KillMode'] != 'control-group'
            or values['ControlGroup'] not in ('', CGROUP)):
        return False
    if values['ActiveState'] == 'inactive' and values['SubState'] == 'dead':
        return values['Result'] == 'success'
    return (values['ActiveState'] == 'failed' and values['SubState'] == 'failed'
            and values['Result'] == 'exit-code' and values['ExecMainCode'] == '1'
            and values['ExecMainStatus'] == '143')


def cgroup_empty(root=Path('/sys/fs/cgroup')):
    path = root / CGROUP.lstrip('/')
    # Fixed systemd cgroup only. A removed service cgroup has no remaining members.
    for parent in (root, root / 'system.slice'):
        s = parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or parent.is_symlink():
            return False
    if not os.path.lexists(path):
        return True
    pending = [path]
    checked = 0
    while pending:
        directory = pending.pop()
        s = directory.lstat()
        if not stat.S_ISDIR(s.st_mode) or directory.is_symlink():
            return False
        checked += 1
        if checked > 256:
            return False
        procs = directory / 'cgroup.procs'
        fd = os.open(procs, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            if os.read(fd, 65537).strip():
                return False
        finally:
            os.close(fd)
        for entry in directory.iterdir():
            if entry.is_symlink():
                return False
            if entry.is_dir():
                pending.append(entry)
    return True


def stopped_values(host):
    keys = ('ActiveState', 'SubState', 'MainPID', 'ControlPID', 'ControlGroup',
            'Result', 'ExecMainCode', 'ExecMainStatus', 'KillMode')
    return {k: host.command(['/usr/bin/systemctl', 'show', 'aihr.service',
                            '--property=' + k, '--value']).decode().strip() for k in keys}


def prove_stopped(host, require):
    before = stopped_values(host)
    require(terminal_stop_allowed(before, cgroup_empty()),
            'Owned service is not quiescent in an allowed terminal state')
    require(stopped_values(host) == before, 'Service state changed during quiescence proof')
    if before['ActiveState'] == 'failed':
        host.command(['/usr/bin/systemctl', 'reset-failed', 'aihr.service'])
    host.require_inactive()
    require(cgroup_empty(), 'Owned service cgroup became populated')
    return before


def continue_cutover(host, plan, authority, m):
    m.require(host.phase() == 'stopped', 'Only the retained stopped operation may continue')
    host.fresh_source_guard()
    host.assert_baseline_custody()
    original, identity = m.read_regular(host.env_path)
    record = host._records()[0]
    m.require(m.sha(original) == record['sha256'] and m.file_identity(identity) == record['identity'],
              'Original private environment changed')
    m.require(not os.path.lexists(host.dropin), 'Unexpected runtime drop-in')
    private = host.proposals()
    current = private['snapshot']
    m.require(current['baseline']['pid'] == authority['restoredPid']
              and current['baseline']['startedTicks'] == authority['restoredStartedTicks'],
              'Restored service invocation changed')
    m.require(comparable_snapshot(current) == comparable_snapshot(plan['snapshot']),
              'Restored baseline/configuration differs')
    before_env = environment_map(base64.b64encode(m.read_regular(host.root / 'active-environment.private')[0]))
    m.require(same_restored_environment(before_env, environment_map(private['activeEnvironment'])),
              'Unrelated restored process environment changed')
    prior = json.loads(m.read_regular(host.root / 'unit-properties.private.json')[0])
    actual = host.unit_properties()
    m.require({k: v for k, v in prior.items() if k not in ('ActiveState', 'MainPID')} ==
              {k: v for k, v in actual.items() if k not in ('ActiveState', 'MainPID')},
              'Original effective unit properties changed')
    m.require(host.database() == plan['database'], 'Database custody changed')
    host.verify_node_and_package_manager()
    prove_restored_process(host, private, authority, m)
    # Distinct append-only reconciliation evidence, never reset the phase to prepared.
    m.exclusive(host.root / 'restored-active-continuation.json', m.encoded({
        'oldPhase': 'stopped', 'restoredPid': authority['restoredPid'],
        'restoredStartedTicks': authority['restoredStartedTicks'], 'applicationReleaseAccepted': False}))
    host.save_phase('stopping')
    host.stop()
    host.save_phase('stopped')
    stopped = prove_stopped(host, m.require)
    m.exclusive(host.root / 'continuation-quiescence.json', m.encoded(stopped))
    m.require(host.database() == plan['database'], 'Database changed during service stop')
    host.write_environment(private)
    host.save_phase('environment-written')
    host.write_unit(private)
    host.save_phase('unit-written')
    host.reload()
    host.save_phase('reloaded')
    host.actual_preflight()
    host.require_inactive()
    host.save_phase('ready-for-release')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['cutover'])
    for key in ('plan', 'plan-sha256', 'human-approval', 'archive', 'source-proof-sha256'):
        parser.add_argument('--' + key, required=True)
    args = parser.parse_args()
    root = Path(__file__).parent
    agent = root / 'maintenance_agent.py'
    import hashlib
    assert os.geteuid() == 0 and os.path.realpath(__file__) == __file__
    for path in (Path(__file__), agent, root / 'continuation-approval.json'):
        s = path.lstat()
        assert stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1 and stat.S_IMODE(s.st_mode) == 0o600
    assert hashlib.sha256(agent.read_bytes()).hexdigest() == AGENT_SHA
    spec = importlib.util.spec_from_file_location('reviewed_original_agent', agent)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    plan_raw, pi = m.read_regular(args.plan)
    m.require(pi.st_uid == 0 and stat.S_IMODE(pi.st_mode) == 0o600 and m.sha(plan_raw) == args.plan_sha256,
              'Original root-private approved plan required')
    plan = m.validate_plan(json.loads(plan_raw))
    grant_raw, gi = m.read_regular(args.human_approval)
    grant = json.loads(grant_raw)
    authority_raw, _ = m.read_regular(root / 'continuation-approval.json')
    authority = json.loads(authority_raw)
    m.require(gi.st_uid == 0 and stat.S_IMODE(gi.st_mode) == 0o600
              and grant['planSha256'] == m.sha(plan_raw) and grant['agentSha256'] == AGENT_SHA
              and grant['scope'] == 'staging-node22-config-and-app-release' and grant['humanApprovalReference']
              and authority['originalPlanSha256'] == m.sha(plan_raw)
              and authority['supplementSha256'] == m.sha(m.read_regular(__file__)[0])
              and authority['operation'] == plan['operation']
              and authority['scope'] == 'continue-stopped-original-staging-cutover', 'Continuation binding differs')
    host = m.RealHost(plan, str(root), args.archive, args.source_proof_sha256)
    lock = os.open(root / 'operation.lock', os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        continue_cutover(host, plan, authority, m)
        print(json.dumps({'phase': host.phase(), 'applicationReleaseAccepted': False}))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'maintenanceRefused': True, 'reason': 'Stopped-operation continuation refused; retain private evidence',
                          'newReleaseAccepted': False, 'automaticDatabaseRollback': False}))
        raise SystemExit(1)
