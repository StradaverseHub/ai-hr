"""Case-bound staging worker cutover following a terminal worker-check failure."""
import fcntl
import json
import os
from pathlib import Path
import re
import pwd
import stat
import sys
import time
from types import SimpleNamespace

POLICY = 'aihr-worker-late-staging-recovery/v1'
PREPARE = 'prepare-late-ci-worker'
DRAIN = 'drain-late-ci-worker'
ACTIVATE = 'activate-late-ci-worker'
KINDS = {
    PREPARE: 'ADMIN_REVIEWED_LATE_STAGING_WORKER_PREPARATION',
    DRAIN: 'ADMIN_AUTHORIZED_LATE_STAGING_WORKER_DRAIN',
    ACTIVATE: 'ADMIN_AUTHORIZED_LATE_STAGING_WORKER_ACTIVATION',
}
INITIAL_SECONDS = {PREPARE: 600, DRAIN: 600, ACTIVATE: 30}
AUTHORITY_SECONDS = {PREPARE: 600, DRAIN: 600, ACTIVATE: 900}
CASE = {
    'source': 'f27f355c89530c994a084bfddaa38823425fcd4d',
    'build_id': 'FNSo4OxtTa2iozhLk1Ljy',
    'previous_web_source': 'b08925ba1eedc828b9f2023d026e7e972bbdb90e',
    'previous_web_build': 'wyqqq8u73hlxwd_X8OOqn',
    'previous_worker_source': 'd6bfd00891e4db5d25d5f0027d0b14b0383ef6fd',
    'archive_sha256': '3a4628a7005a1f4fd63f526eec03688cff9d1be7175d4b5a003b4a7d32a103fb',
    'lock_sha256': 'ce60a856128c643245fb5f530beb4fc2853af666bd893032111871ed389a4a09',
    'package_sha256': 'a0ff6a1ff5347c75a0db41346a472017d82665836d030b4f9b154ddbbce495ab',
}
CURRENT_SHA256 = 'fa0bc7c249eeeac4e13f87797b6407d5d29a7e6eeb57608de3a3284da0e2e6ca'
LAST_OK_SHA256 = '1aa176c7728775945ad5f5396200fe73392e141fccbbd7663b72b86968751716'
ADMIN = Path('/root/aihr-late-worker-137')
SOURCE_MANIFEST_SHA256 = 'cb422cfea54d0a183e7a4d7fb6cd3e6be44684ead7fd91f5a7346b153be88694'
INSTALL_ID = 'b8b1e385-1244-4709-a17c-ba9ce9544ad4'
BUILD_RECORD_ID = '424938b1-ffa2-4645-9b41-3eb670e77891'
RUN_ID = 44750610971
GATE_FIELDS = {'source', 'controller', 'runId', 'build', 'artifact', 'witnessFingerprint', 'policyVersion'}
FAILURE_FIELDS = {'failureCurrentSha256', 'failureLastOkSha256', 'failureLog', 'failureLogSha256', 'failureFinishedAt'}


def fields(ci, stage):
    live = ci.ACTIVATION_FIELDS | {'lateFailure', 'nativeActivation'}
    if stage == ACTIVATE:
        return live | {'preparedWorker'}
    early = live - {'drainSha256', 'firstStageApproval', 'firstStageApprovalSha256'}
    return early | {'gate'} | ({'preparedWorker'} if stage == DRAIN else set())


def authority(base, ci, stage, a):
    identity = a['identity']
    base.check(all(identity[k] == value for k, value in CASE.items()), 'exact approved staging worker case required')
    base.check(a['lease'] == {'candidate': CASE['source'], 'batch': '8a8394a6-bca2-46f9-a082-e9b2157406b6',
                            'epoch': 137}, 'exact interrupted staging lease required')
    base.check(a['sourceManifestSha256'] == SOURCE_MANIFEST_SHA256, 'exact reviewed source inventory required')
    i = a['install']
    base.check(i['id'] == INSTALL_ID and i['buildRecordId'] == BUILD_RECORD_ID and i['runId'] == RUN_ID,
               'exact interrupted web installation required')
    base.check(set(a['launch']) == {'current'} and set(a['launch']['current']) ==
               {'ref', 'pid', 'log', 'started_at', 'phase', 'build_id', 'built_at'},
               'exact terminal launch record required')
    base.check(set(a['lateFailure']) == FAILURE_FIELDS and a['lateFailure']['failureFinishedAt'] == '1795188886',
               'exact original terminal failure pins required')
    base.check(a['lateFailure']['failureCurrentSha256'] == CURRENT_SHA256 and
               a['priorLastOkSha256'] == a['lateFailure']['failureLastOkSha256'] == LAST_OK_SHA256,
               'original last-success digest differs')
    base.check(ci.epoch(a['issuedAt']) <= time.time() < ci.epoch(a['expiresAt']) <=
               ci.epoch(a['issuedAt']) + AUTHORITY_SECONDS[stage], 'finite late worker authority required')


def snapshot(base, ci, a):
    return ci.RECOVERY.terminal_failure_snapshot(base, ci, a['lateFailure'], a['identity'], a['launch'])


def failed_snapshot(observer):
    return snapshot(observer.base, observer.guard.ci, observer.auth)


def require_native_failure(guard, base, ci, *, audit_active_build):
    a = guard.a
    owner = guard.owner
    i = a['install']
    directory = Path(owner.pw_dir) / '.aihr-ci-builds' / i['id']
    base.check(str(directory) == i['directory'] and owner.pw_uid == i['uid'] and owner.pw_gid == i['gid'],
               'original private install owner differs')
    ci.private_install(base, directory.parent, owner.pw_uid, True)
    st = ci.private_install(base, directory, owner.pw_uid, True)
    base.check((st.st_dev, st.st_ino) == (i['device'], i['inode']), 'original private install inode differs')
    originals = {}
    for name, key in [('authorization.json', 'grantSha256'), ('activated.json', 'activatedSha256'),
                      ('runtime.json', 'runtimeSha256')]:
        ci.private_install(base, directory / name, owner.pw_uid)
        raw = base.read_bounded(directory / name, 1024**2)
        base.check(ci.sha(raw) == a[key], 'original private installation record differs')
        originals[name] = json.loads(raw)
    grant = originals['authorization.json']
    base.check(a['gate'] == {key: grant[key] for key in GATE_FIELDS} and
               grant['environmentSha256'] == a['environmentSha256'] and
               grant['controller'] == i['controller'] and grant['runId'] == i['runId'] and
               grant['build']['nextBuildId'] == CASE['build_id'] and
               grant['baseline'] == CASE['previous_web_source'] and grant['baselineBuildId'] == CASE['previous_web_build'],
               'original gate or baseline differs')
    base.check(ci.sha(base.read_bounded(ci.BOOT_ID, 4096)) == a['bootIdSha256'], 'boot identity changed')
    for name, digest in a['nativeActivation'].items():
        base.check(name in ('activate-intent.json', 'activate-result.json') and
                   ci.sha(base.read_bounded(directory / name, 65536)) == digest,
                   'immutable native activation record differs')
    base.check(set(a['nativeActivation']) == {'activate-intent.json', 'activate-result.json'}, 'native activation pins required')
    guard.before_mutation()
    before = snapshot(base, ci, a)
    failure = ci.child([str(base.NODE), '--env-file=.env.production', '--input-type=module', '-e',
                        ci.RECOVERY.FAILED_NATIVE_PROBE, str(directory)], owner, guard.environment, timeout=30)
    base.check(failure['kind'] == 'EXACT_FAILED_NATIVE_WORKER_CHECK_INSTALL' and
               failure['installId'] == i['id'] and failure['source'] == CASE['source'] and
               failure['build'] == CASE['build_id'] and failure['active'] == originals['runtime.json'],
               'original terminal worker-only failure differs')
    if not audit_active_build:
        base.check(snapshot(base, ci, a) == before, 'native failure changed during preparation proof')
        return
    native = ci.child([str(base.NODE), '--env-file=.env.production', '--import', 'tsx',
                       '.github/ci/staging-build-install.mjs', 'resume-status', CASE['source'],
                       i['id'], i['buildRecordId']], owner, guard.environment, timeout=180)
    now = time.time()
    issued = ci.epoch(grant['issuedAt'])
    stable = ci.runtime_identity(base, native['runtime'], issued, now, fresh=True)
    base.check(native['authorizationSha256'] == a['grantSha256'] and
               native['activated'] == originals['activated.json'] and
               native['runtime']['pid'] == a['webPid'] and native['runtime']['healthStatus'] == 200 and
               native['runtime']['startedMonotonicUs'] == a['webStartedMonotonicUs'] and
               stable['migrationLedger'] == a['ledger'] and
               stable == ci.runtime_identity(base, originals['runtime.json'], issued, now),
               'fresh native web build and full ledger identity differ')
    base.check(snapshot(base, ci, a) == before, 'native install changed during preparation or drain proof')


def load_preparation(base, ci, fmt, a, operation, deadline):
    selected = a['preparedWorker']
    proof = operation / 'late-prepared.json'
    base.check(set(selected) == {'path', 'sha256'} and selected['path'] == str(proof), 'exact late preparation path required')
    ci.protected_private(base, proof)
    raw = base.read_bounded(proof, 65536)
    base.check(ci.sha(raw) == selected['sha256'], 'late preparation proof hash differs')
    data = json.loads(raw)
    directory = operation / 'prepared-release'
    archive = operation / 'authenticated-worker.zip'
    base.root_protected(archive, regular=True)
    manifest = fmt.inspect_archive(archive, CASE['source'], CASE['lock_sha256'], CASE['package_sha256'])
    base.check(data == {'kind': 'ROOT_AUTHENTICATED_LATE_WORKER_BYTES', 'policy': POLICY, 'identity': a['identity'],
                        'lateFailure': a['lateFailure'], 'grantSha256': a['grantSha256'],
                        'manifestSha256': fmt.digest(fmt.canonical(manifest)),
                        'tree': ci.RECOVERY.tree_identity(directory, manifest, deadline=deadline)},
               'late preparation proof or protected tree differs')
    return data, directory


def check_history(observer, first):
    base, ci, a = observer.base, observer.guard.ci, observer.auth
    shared = fields(ci, DRAIN) - {'kind', 'gate', 'issuedAt', 'expiresAt'}
    base.check(all(first[key] == a[key] for key in shared), 'late drain and activation pins differ')
    drain = json.loads(base.read_bounded(observer.operation / 'drained.json', 65536))
    base.check(drain.get('kind') == 'ACTUAL_POST_FAILURE_WORKER_DRAIN' and drain.get('lateFailure') == a['lateFailure']
               and drain.get('drain', {}).get('state') == 'drained' and drain.get('drain', {}).get('forcedKill') is False
               and drain.get('preparedWorker') == a['preparedWorker']
               and drain.get('approvalSha256') == a['firstStageApprovalSha256'],
               'real protected late drain receipt required')
    failed_snapshot(observer)


def admit_mutation(observer):
    b, ci = observer.base, observer.guard.ci
    b.check(observer.fence_count == 3 and len(observer.audits) == 1 and len(observer.content_proofs) == 1,
            'complete late recovery pre-mutation proof graph required')
    b.check(observer.overall_deadline - time.monotonic() >= 537 and
            ci.epoch(observer.auth['expiresAt']) - time.time() >= 567,
            'insufficient late recovery time after native proofs')
    failed_snapshot(observer)


def prepare(guard, base, ci, fmt, update, operation):
    a = guard.a
    require_native_failure(guard, base, ci, audit_active_build=False)
    update.validate_existing(base, CASE['previous_worker_source'], a['identity']['unit_sha256'],
                             a['identity']['worker_env_sha256'])
    base.check(not operation.exists() and not operation.is_symlink(), 'prior worker upgrade attempt requires independent review')
    guard.file_mutation()
    operation.mkdir(mode=0o700)
    archive = operation / 'authenticated-worker.zip'
    guard.file_mutation()
    base.snapshot_archive(a['identity']['archive'], archive, CASE['archive_sha256'], fmt.MAX_ARCHIVE)
    directory = operation / 'prepared-release'
    guard.file_mutation()
    directory.mkdir(mode=0o700)
    manifest = fmt.extract_archive(archive, directory, CASE['source'], CASE['lock_sha256'], CASE['package_sha256'])
    entries = {row['path']: row for row in manifest['entries']}
    for path in directory.rglob('*'):
        base.check(time.monotonic() < ci.SLOT_DEADLINE, 'late worker preparation deadline expired')
        if not path.is_symlink():
            os.chmod(path, 0o755 if path.is_dir() else entries[path.relative_to(directory).as_posix()]['mode'])
    os.chmod(directory, 0o755)
    tree = ci.RECOVERY.tree_identity(directory, manifest, deadline=ci.SLOT_DEADLINE, content=True)
    proof = {'kind': 'ROOT_AUTHENTICATED_LATE_WORKER_BYTES', 'policy': POLICY, 'identity': a['identity'],
             'lateFailure': a['lateFailure'], 'grantSha256': a['grantSha256'],
             'manifestSha256': fmt.digest(fmt.canonical(manifest)), 'tree': tree}
    snapshot(base, ci, a)
    update.publish(base, operation / 'late-prepared.json', fmt.canonical(proof), 0o400)
    print(json.dumps({'kind': proof['kind'], 'sha256': ci.sha(fmt.canonical(proof)), 'serviceMutation': False}))


def drain(guard, base, ci, fmt, update, operation):
    a = guard.a
    require_native_failure(guard, base, ci, audit_active_build=True)
    load_preparation(base, ci, fmt, a, operation, ci.SLOT_DEADLINE)
    base.check(not (operation / 'late-drain-started.json').exists() and
               not (operation / 'drained.json').exists(), 'previous late drain attempt requires independent review')
    base.check(min(ci.SLOT_DEADLINE - time.monotonic(), ci.epoch(a['expiresAt']) - time.time()) >= 345,
               'insufficient late worker drain time')
    report = update.validate_existing(base, CASE['previous_worker_source'], a['identity']['unit_sha256'],
                                      a['identity']['worker_env_sha256'])
    update.publish(base, operation / 'late-drain-started.json', fmt.canonical({'approvalSha256': ci.sha(guard.bytes)}), 0o400)
    snapshot(base, ci, a)
    result = update.drain(base, report, CASE['previous_worker_source'])
    snapshot(base, ci, a)
    proof = {'kind': 'ACTUAL_POST_FAILURE_WORKER_DRAIN', 'identity': a['identity'], 'drain': result,
             'lateFailure': a['lateFailure'], 'preparedWorker': a['preparedWorker'],
             'approvalSha256': ci.sha(guard.bytes)}
    update.publish(base, operation / 'drained.json', fmt.canonical(proof), 0o400)
    print(json.dumps({'kind': proof['kind'], 'sha256': ci.sha(fmt.canonical(proof))}))


def activate(guard, base, ci, fmt, update, operation):
    a = guard.a
    worker, directory = load_preparation(base, ci, fmt, a, operation, ci.SLOT_DEADLINE)
    base.check(not (operation / 'ci-runtime-started.json').exists(), 'existing activation attempt requires independent review')
    args = SimpleNamespace(**a['identity'], ci_runtime_authorization=str(guard.path),
                           ci_runtime_authorization_sha256=ci.sha(guard.bytes))
    observer = ci.RuntimeObservation(base, fmt, args, operation, base.read_bounded(operation / 'drained.json', 65536),
                                     recovery=a['lateFailure'], prepared=a['preparedWorker'])
    ci.RECOVERY.clean_prior(base, update, a['identity'])
    update.publish(base, operation / 'ci-runtime-started.json',
                   fmt.canonical({'authorizationSha256': ci.sha(guard.bytes), 'journeyVerified': False}), 0o400)
    observer.complete_fence()
    observer.content_audit()
    observer.complete_fence()
    observer.full_audit()
    observer.complete_fence()
    observer.admit_mutation()
    release = base.ROOT / 'releases' / CASE['source']
    base.root_protected(release.parent)

    def publish_prepared():
        guard.file_mutation()
        ci.RECOVERY.clean_prior(base, update, a['identity'])
        checked, path = load_preparation(base, ci, fmt, a, operation, ci.SLOT_DEADLINE)
        base.check(checked == worker and path == directory and not release.exists() and not release.is_symlink(),
                   'late prepared publication identity differs')
        guard.file_mutation()
        os.rename(directory, release)
        return release

    return update.replace_and_start(
        base, fmt, args, operation, release, None, args.unit_sha256,
        {'manifestSha256': worker['manifestSha256'], 'preparedProofSha256': a['preparedWorker']['sha256'],
         'previousWebSource': args.previous_web_source, 'previousWebBuildId': args.previous_web_build,
         'previousWorkerSource': args.previous_worker_source, 'originalInstallationGrantExpiresAt': observer.grant['expiresAt'],
         'workerRecoveryOnly': True}, observer, prepare_release=publish_prepared,
    )


def run(stage, guard, fmt, base, ci, update):
    authority(base, ci, stage, guard.a)
    lock = ci.RECOVERY.INSTALL_LOCK
    base.root_protected(lock, regular=True)
    fd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        guard.bind_install(fd, lock)
        base.root_protected(base.ROOT / 'upgrades')
        operation = base.ROOT / 'upgrades' / CASE['source']
        if stage != PREPARE:
            base.root_protected(operation)
        # This case keeps the current worker environment and validates one installed unit.
        base.check('previous_worker_env_sha256' not in guard.identity and
                   all(re.fullmatch('[a-f0-9]{64}', guard.identity[key])
                       for key in ('unit_sha256', 'worker_env_sha256')), 'exact prior unit/environment pins required')
        return {PREPARE: prepare, DRAIN: drain, ACTIVATE: activate}[stage](guard, base, ci, fmt, update, operation)
    finally:
        os.close(fd)


def draft(stage, fmt, base, ci, operation_guard):
    """Collect observed pins as a proposal. Only a human may independently approve its hash."""
    base.check(os.geteuid() == 0 and stage in KINDS, 'fixed staging administrator draft command required')
    base.root_protected(ADMIN)
    base.root_protected(Path(sys.argv[0]), regular=True)
    raw_current = base.read_bounded(ci.STATE / 'current', 65536)
    raw_prior = base.read_bounded(ci.STATE / 'last-ok', 65536)
    base.check(ci.sha(raw_current) == CURRENT_SHA256 and ci.sha(raw_prior) == LAST_OK_SHA256,
               'original terminal deploy records differ')
    current = ci.record(raw_current)
    failed_log = Path(current['log'])
    base.check(failed_log.is_absolute() and failed_log.parent == ci.STATE, 'unexpected original log path')
    lock = operation_guard.LOCK.lstat()
    queue = operation_guard.QUEUE.lstat()
    owner = pwd.getpwuid(lock.st_uid)
    base.check(owner.pw_uid != 0 and queue.st_uid == owner.pw_uid, 'exact non-root staging install owner required')
    directory = Path(owner.pw_dir) / '.aihr-ci-builds' / INSTALL_ID
    ci.private_install(base, directory.parent, owner.pw_uid, True)
    installed = ci.private_install(base, directory, owner.pw_uid, True)
    records = {}
    for name in ('authorization.json', 'activated.json', 'runtime.json', 'activate-intent.json', 'activate-result.json'):
        ci.private_install(base, directory / name, owner.pw_uid)
        records[name] = base.read_bounded(directory / name, 1024**2)
    grant = json.loads(records['authorization.json'])
    runtime = json.loads(records['runtime.json'])
    lease_file = ADMIN / 'lease.json'
    ci.protected_private(base, lease_file)
    lease_raw = base.read_bounded(lease_file, 4096)
    lease = json.loads(lease_raw)
    manifest = ADMIN / 'canonical-source-inventory.json'
    archive = ADMIN / 'worker-package.zip'
    base.root_protected(manifest, regular=True)
    base.root_protected(archive, regular=True)
    manifest_sha = ci.bounded_file_sha256(base, manifest, ci.MAX_MANIFEST)
    environment = {'PATH': '/opt/node22/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': owner.pw_dir}
    base.root_protected(base.NODE, regular=True)
    loader = ci.child([str(base.NODE), '--input-type=module', '-e', ci.LOADER_PROBE], owner, environment, timeout=15)
    base.check(loader['safe'] is True and loader['caPresent'] is False, 'unsafe staging loader inputs')
    node_options = {key: loader['nodeOptions'][key] for key in ('policy', 'sha256')}
    native_environment = ci.child([str(base.NODE), '--env-file=.env.production', '--input-type=module', '-e',
                                   operation_guard.DRAIN_ENVIRONMENT_PROBE], owner, environment,
                                  timeout=30, node_options=node_options)
    base.check(native_environment['environmentSha256'] == grant['environmentSha256'],
               'current staging environment differs from grant')
    python = Path('/usr/bin/python3').resolve(strict=True)
    now = time.time()
    a = {
        'format': 1, 'kind': KINDS[stage], 'policy': ci.POLICY, 'target': 'alpha-staging',
        'issuedAt': ci.datetime.fromtimestamp(now, ci.timezone.utc).isoformat(),
        'expiresAt': ci.datetime.fromtimestamp(now + AUTHORITY_SECONDS[stage], ci.timezone.utc).isoformat(),
        'identity': {**CASE, 'archive': str(archive), 'unit_sha256': ci.sha(base.read_bounded(base.UNIT, 65536)),
                     'worker_env_sha256': ci.sha(base.read_bounded(base.ENV, 1024**2))},
        'helperSha256': ci.sha(base.read_bounded(Path(sys.argv[0]), 16*1024**2)),
        'nodeSha256': ci.bounded_file_sha256(base, base.NODE, 128*1024**2),
        'python': {'path': str(python), 'sha256': ci.bounded_file_sha256(base, python, 128*1024**2),
                   'version': '.'.join(map(str, sys.version_info[:3]))},
        'nodeOptions': node_options,
        'install': {'id': INSTALL_ID, 'buildRecordId': BUILD_RECORD_ID, 'runId': RUN_ID,
                    'controller': grant['controller'], 'directory': str(directory), 'uid': owner.pw_uid,
                    'gid': owner.pw_gid, 'device': installed.st_dev, 'inode': installed.st_ino},
        'grantSha256': ci.sha(records['authorization.json']), 'activatedSha256': ci.sha(records['activated.json']),
        'runtimeSha256': ci.sha(records['runtime.json']), 'environmentSha256': grant['environmentSha256'],
        'dotenvSha256': loader['sha256'],
        'ledger': {key: value for key, value in runtime['migrationLedger'].items() if key != 'verifiedAt'},
        'bootIdSha256': ci.sha(base.read_bounded(ci.BOOT_ID, 4096)), 'webPid': runtime['pid'],
        'webStartedMonotonicUs': runtime['startedMonotonicUs'],
        'lease': {key: lease[key] for key in ('batch', 'epoch', 'candidate')}, 'leaseFile': str(lease_file),
        'leaseFileSha256': ci.sha(lease_raw), 'coordinatorSha256': ci.sha(base.read_bounded(ci.COORDINATOR, 1024**2)),
        'sourceManifest': str(manifest), 'sourceManifestSha256': manifest_sha,
        'priorLastOkSha256': LAST_OK_SHA256, 'releaseAuthorized': False,
        'launch': {'current': {key: current[key] for key in ('ref', 'pid', 'log', 'started_at', 'phase', 'build_id', 'built_at')}},
        'readiness': native_environment['readiness'],
        'operationsLock': {'policy': operation_guard.GUARD_POLICY, 'queueDirectory': str(operation_guard.QUEUE),
                           'lockPath': str(operation_guard.LOCK), 'uid': lock.st_uid, 'gid': lock.st_gid,
                           'mode': stat.S_IMODE(lock.st_mode), 'device': lock.st_dev, 'inode': lock.st_ino,
                           'queueMode': stat.S_IMODE(queue.st_mode), 'queueDevice': queue.st_dev, 'queueInode': queue.st_ino},
        'nativeActivation': {name: ci.sha(records[name]) for name in ('activate-intent.json', 'activate-result.json')},
        'lateFailure': {'failureCurrentSha256': CURRENT_SHA256, 'failureLastOkSha256': LAST_OK_SHA256,
                        'failureLog': str(failed_log), 'failureLogSha256': ci.sha(base.read_bounded(failed_log, 4*1024**2)),
                        'failureFinishedAt': current['finished_at']},
    }
    operation = base.ROOT / 'upgrades' / CASE['source']
    if stage != PREPARE:
        proof = operation / 'late-prepared.json'
        ci.protected_private(base, proof)
        a['preparedWorker'] = {'path': str(proof), 'sha256': ci.sha(base.read_bounded(proof, 65536))}
    if stage == ACTIVATE:
        first = ADMIN / 'drain.json'
        ci.protected_private(base, first)
        a.update(firstStageApproval=str(first), firstStageApprovalSha256=ci.sha(base.read_bounded(first, 65536)),
                 drainSha256=ci.sha(base.read_bounded(operation / 'drained.json', 65536)))
    else:
        a['gate'] = {key: grant[key] for key in GATE_FIELDS}
    authority(base, ci, stage, a)
    snapshot(base, ci, a)
    base.check(set(a) == fields(ci, stage), 'draft field inventory differs')
    sys.stdout.buffer.write(fmt.canonical(a))
