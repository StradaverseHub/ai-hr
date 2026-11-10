/** Authenticate a full development preflight archive. Browser semantics have a separate owner. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadCiArchives, readCiArchive } from './archive-downloads.mjs';
import { inspectMeasuredPreflightProviderMetadata, inspectMeasuredWorkerDispatch } from './measured-browser-worker-contract.mjs';

const repository = 'StradaverseHub/ai-hr';
const repositoryId = 1333414856;
const workflowId = 395862645;
const workflowPath = '.github/workflows/alpha-focused-checks.yml';
const branch = 'codex/architecture-five-item-browser-convergence-20261109';
const ancestry = 'f919bef2deff9bfc56448a63fb5d17d8bd42ec2a';
const controllerRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const maximumArchiveBytes = 64 * 1024 ** 2;
const maximumMemberBytes = 4 * 1024 ** 2;
const maximumReceiptBytes = 8192;
const members = [
  'browser-preflight-measurement.json', 'navigation-browser-capture.json', 'development-rendered-route-union.json',
  'fixture.json', 'actor-tenancy.json', 'postgres-lock-failures.json', 'server-native-failures.json',
];
const environment = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
const authenticated = new WeakMap();
const archiveRefusals = new WeakMap();
const archiveStages = new Set([
  'runner-directory', 'event-custody', 'dispatch-contract', 'controller-before', 'read-credential', 'private-directory',
  'current-run-read', 'current-run-contract', 'repository-read', 'workflow-read', 'upstream-run-read', 'upstream-jobs-read',
  'upstream-artifacts-read', 'upstream-contract', 'archive-transfer', 'archive-file', 'archive-envelope', 'controller-after',
  'result-deadline',
]);

const extract = String.raw`
import io, json, math, stat, struct, sys, zipfile, zlib

archive_cap = 64 * 1024**2
member_cap = 4 * 1024**2
receipt_cap = 8192
required = (
    'browser-preflight-measurement.json', 'navigation-browser-capture.json',
    'development-rendered-route-union.json', 'fixture.json', 'actor-tenancy.json',
    'postgres-lock-failures.json', 'server-native-failures.json',
)
allowed = set(required) | {'fixture-phases.json'}

def require(ok):
    if not ok:
        raise ValueError('Measured preflight ZIP refused')

def unique(pairs):
    result = dict(pairs)
    require(len(result) == len(pairs))
    return result

def finite(value):
    result = float(value)
    require(math.isfinite(result))
    return result

def constant(_):
    raise ValueError('Nonfinite JSON refused')

def read():
    raw = sys.stdin.buffer.read(archive_cap + 1)
    require(22 < len(raw) <= archive_cap)
    end, disk, directory_disk, this_count, total, directory_size, directory_start, comment = struct.unpack_from('<4s4H2IH', raw, len(raw) - 22)
    require(end == b'PK\x05\x06' and disk == directory_disk == comment == 0
            and len(required) <= total == this_count <= len(allowed)
            and directory_start + directory_size == len(raw) - 22)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        names = {row.filename for row in infos}
        require(len(infos) == len(names) == total and set(required) <= names <= allowed)
        cursor = 0
        selected = {}
        for member in sorted(infos, key=lambda row: row.header_offset):
            name = member.filename
            limit = receipt_cap if name == required[0] else member_cap
            require(member.orig_filename == name and not member.is_dir() and not member.external_attr & 0x10
                    and stat.S_IFMT(member.external_attr >> 16) in (0, stat.S_IFREG)
                    and member.header_offset == cursor and not member.extra and not member.comment
                    and not member.flag_bits & ~0x808 and 0 < member.file_size <= limit
                    and member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED))
            local = struct.unpack_from('<4s5H3I2H', raw, cursor)
            signature, _, flags, method, _, _, crc, compressed, size, name_size, extra_size = local
            start = cursor + 30 + name_size
            finish = start + member.compress_size
            require(signature == b'PK\x03\x04' and flags == member.flag_bits and method == member.compress_type
                    and raw[cursor + 30:start] == name.encode('ascii') and extra_size == 0
                    and start <= finish <= directory_start)
            expected = (member.CRC, member.compress_size, member.file_size)
            if flags & 8:
                require((crc, compressed, size) == (0, 0, 0)
                        and struct.unpack_from('<4s3I', raw, finish) == (b'PK\x07\x08', *expected))
                cursor = finish + 16
            else:
                require((crc, compressed, size) == expected)
                cursor = finish
            if method == zipfile.ZIP_STORED:
                require(member.compress_size == member.file_size)
            else:
                stream = zlib.decompressobj(-15)
                decoded = stream.decompress(raw[start:finish], limit + 1)
                require(len(decoded) == member.file_size and stream.eof and not stream.unused_data and not stream.unconsumed_tail)
            with archive.open(member) as entry:
                payload = entry.read(limit + 1)
                require(len(payload) == member.file_size and not entry.read(1))
            value = json.loads(payload.decode('utf-8'), object_pairs_hook=unique, parse_float=finite, parse_constant=constant)
            if name in ('server-native-failures.json', 'postgres-lock-failures.json'):
                require(type(value) is dict and value.get('failures') == [])
            elif name == 'fixture-phases.json':
                require(type(value) is list and value and all(type(row) is dict and row.get('status') == 'passed' for row in value))
            if name in required:
                selected[name] = payload
        require(cursor == directory_start)
    for name in required:
        payload = selected[name]
        sys.stdout.buffer.write(struct.pack('>I', len(payload)))
        sys.stdout.buffer.write(payload)

try:
    read()
except (OSError, ValueError, KeyError, RuntimeError, RecursionError, struct.error, zipfile.BadZipFile, zlib.error):
    raise SystemExit('Measured preflight ZIP refused') from None
`;

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = raw => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
const hash = raw => createHash('sha256').update(raw).digest('hex');
const closed = (row, keys) => object(row) && Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));

function sameSource(row, source, runId) {
  return row?.candidateSha === source && row.controllerSha === source && row.runId === runId && row.runAttempt === 1;
}

function sealMatches(value, raw, keys) {
  return closed(value, keys) && value.bytes === raw.length && value.sha256 === hash(raw);
}

/** Exact byte and envelope model. Calling this does not authenticate a provider run. */
export function inspectMeasuredPreflightArchiveBytes(bytes, { source, runId }, timeoutMs = 15000) {
  assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximumArchiveBytes
    && sha(source) && id(runId) && id(timeoutMs) && timeoutMs <= 15000, 'Measured preflight archive input refused');
  let raw;
  try {
    raw = execFileSync('/usr/bin/python3', ['-I', '-B', '-c', extract], {
      input: bytes, timeout: timeoutMs, killSignal: 'SIGKILL', env: environment, cwd: '/',
      maxBuffer: (members.length - 1) * maximumMemberBytes + maximumReceiptBytes + 4 * members.length, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw Error('Measured preflight ZIP refused');
  }
  let offset = 0;
  const [receiptBytes, captureBytes, unionBytes, fixtureBytes, actorBytes, postgresBytes, workerBytes] = members.map((_, index) => {
    assert(offset + 4 <= raw.length, 'Measured preflight ZIP frame refused');
    const size = raw.readUInt32BE(offset);
    offset += 4;
    assert(size > 0 && size <= (index === 0 ? maximumReceiptBytes : maximumMemberBytes)
      && offset + size <= raw.length, 'Measured preflight ZIP frame refused');
    const member = raw.subarray(offset, offset + size);
    offset += size;
    return member;
  });
  assert(offset === raw.length, 'Unexpected measured preflight ZIP frame');
  const [measurement, capture, renderedUnion, fixture, actors, postgresFailures, workerFailures] =
    [receiptBytes, captureBytes, unionBytes, fixtureBytes, actorBytes, postgresBytes, workerBytes].map(json);
  assert(measurement?.kind === 'DEVELOPMENT_BROWSER_MEASURED_COURSE_V2' && measurement.version === 2
    && measurement.course === 'preflight-2' && measurement.suite === 'workflow-preflight'
    && measurement.complete === true && measurement.releaseEligible === false
    && measurement.courseOutcome === 'success' && measurement.terminalReceipt === 'observed' && measurement.driverReceipt === 'observed'
    && closed(measurement.source, ['candidateSha', 'controllerSha', 'runId', 'runAttempt'])
    && sameSource(measurement.source, source, runId), 'Measured preflight terminal receipt refused');
  const log = measurement.postgresWaitLogCoverage;
  assert(closed(log, ['kind', 'thresholdMs', 'retainedFailures', 'databaseBackendsSettled'])
    && log.kind === 'development-heavyweight-lock-log' && log.thresholdMs === 100
    && log.retainedFailures === 0 && log.databaseBackendsSettled === true, 'Measured preflight log envelope refused');
  const captureSeal = measurement.capture;
  assert(sealMatches(captureSeal, captureBytes, ['sha256', 'bytes', 'harnessSha256', 'scenarioSha256'])
    && digest(captureSeal.harnessSha256) && digest(captureSeal.scenarioSha256)
    && sealMatches(measurement.renderedUnion, unionBytes, ['sha256', 'bytes']), 'Measured preflight capture byte seal refused');
  assert(closed(capture, ['schemaVersion', 'protocol', 'releaseAuthorized', 'baseline'])
    && capture.schemaVersion === 1 && capture.protocol === 'aihr-navigation-development/v2' && capture.releaseAuthorized === false
    && capture.baseline?.schemaVersion === 1 && capture.baseline.protocol === capture.protocol
    && capture.baseline.releaseAuthorized === false && capture.baseline.phase === 'baseline' && capture.baseline.complete === true
    && capture.baseline.engine === 'chromium' && capture.baseline.fixture === 'system-load-v1'
    && Array.isArray(capture.baseline.observations) && capture.baseline.observations.length > 0
    && renderedUnion?.kind === 'DEVELOPMENT_RENDERED_ROUTE_UNION_V1' && renderedUnion.complete === true
    && renderedUnion.releaseEligible === false && renderedUnion.protectedNative === false
    && renderedUnion.dynamicNavigationComplete === false && Array.isArray(renderedUnion.observations)
    && renderedUnion.observations.length > 0, 'Measured preflight baseline and union envelope refused');
  for (const row of [capture.baseline, renderedUnion]) {
    assert(sameSource(row, source, runId) && row.harnessSha256 === captureSeal.harnessSha256
      && row.scenarioSha256 === captureSeal.scenarioSha256, 'Mixed measured preflight capture source refused');
  }
  assert(fixture?.fictional === true && fixture.claimsPerEmployee === 200 && fixture.counts?.claims === 100000
    && actors?.fictional === true && actors.trafficActors === 500 && actors.nativeSelectedRows === 500
    && actors.nativeGrants === 544, 'Measured preflight fictional fixture envelope refused');
  return { measurement, capture, renderedUnion, fixture, actors, postgresFailures, workerFailures };
}

function remaining(deadline, maximum = 15000) {
  const milliseconds = Math.min(maximum, Math.floor(deadline - performance.now()));
  assert(milliseconds > 0, 'Measured preflight resolver deadline closed');
  return milliseconds;
}

function command(executable, args, deadline, env = environment, cwd = controllerRoot) {
  try {
    return execFileSync(executable, args, {
      env, cwd, timeout: remaining(deadline), killSignal: 'SIGKILL', maxBuffer: 1024 ** 2,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw Error('Measured preflight resolver read refused');
  }
}

function controllerHead(source, deadline) {
  const git = (...args) => command('/usr/bin/git', ['--no-optional-locks', '-C', controllerRoot, ...args], deadline).toString('utf8').trim();
  assert(realpathSync(controllerRoot) === controllerRoot && git('rev-parse', 'HEAD') === source
    && git('status', '--porcelain') === '' && ['https://github.com/' + repository, 'https://github.com/' + repository + '.git']
      .includes(git('remote', 'get-url', 'origin')), 'Measured preflight exact automation checkout refused');
  git('merge-base', '--is-ancestor', ancestry, source);
}

const statFields = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const sameStat = (left, right) => statFields.every(key => left[key] === right[key]);

function hostedEvent(temp) {
  const path = join(temp, '_github_workflow', 'event.json');
  assert(process.env.GITHUB_EVENT_PATH === path && realpathSync(path) === path, 'Measured preflight event path refused');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    assert(before.isFile() && before.uid === BigInt(process.getuid()) && before.nlink === 1n && !(before.mode & 0o022n)
      && before.size > 0n && before.size <= 65536n && sameStat(before, lstatSync(path, { bigint: true })), 'Measured preflight event metadata refused');
    const raw = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < raw.length) {
      const count = readSync(fd, raw, size, raw.length - size, null);
      if (!count) break;
      size += count;
    }
    assert(BigInt(size) === before.size && sameStat(before, fstatSync(fd, { bigint: true }))
      && sameStat(before, lstatSync(path, { bigint: true })) && realpathSync(path) === path, 'Measured preflight event changed');
    return json(raw.subarray(0, size));
  } finally {
    closeSync(fd);
  }
}

function freeze(value) {
  if (object(value) || Array.isArray(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** Fixed trusted resolver only. No options permit an alternate API, token, transport or byte source. */
export async function authenticateMeasuredPreflightArchive() {
  let stage = 'runner-directory';
  try {
    return await collectMeasuredPreflightArchive(next => { stage = next; });
  } catch {
    const refusal = new Error('Measured preflight provider archive refused');
    if (archiveStages.has(stage)) archiveRefusals.set(refusal, stage);
    throw refusal;
  }
}

/** Diagnostic only. Raw errors and caller-supplied labels are never returned. */
export function readMeasuredPreflightArchiveRefusalStage(reason) {
  return archiveRefusals.get(reason) ?? null;
}

async function collectMeasuredPreflightArchive(mark) {
  const deadline = performance.now() + 150000;
  const temp = process.env.RUNNER_TEMP;
  assert(typeof temp === 'string' && temp !== controllerRoot && !temp.startsWith(controllerRoot + '/')
    && realpathSync(temp) === temp && lstatSync(temp).isDirectory()
    && lstatSync(temp).uid === process.getuid(), 'Measured preflight runner directory refused');
  mark('event-custody');
  const event = hostedEvent(temp);
  mark('dispatch-contract');
  const dispatch = inspectMeasuredWorkerDispatch(process.env, event);
  const { source, currentRunId, profile } = dispatch;
  const upstreamRunId = profile.upstreamRunId;
  assert((profile.course === 'serial-2-4-8' || profile.course === 'parallel-2-4-8') && id(upstreamRunId),
    'The serial and parallel comparison courses require a prior preflight');
  mark('controller-before');
  controllerHead(source, deadline);

  mark('read-credential');
  const token = process.env.GH_TOKEN;
  assert(typeof token === 'string' && token.length > 0 && token.length <= 4096, 'Measured preflight read credential unavailable');
  mark('private-directory');
  const privateDirectory = mkdtempSync(join(temp, 'measured-preflight-archive-'));
  const configDirectory = join(privateDirectory, 'gh');
  mkdirSync(configDirectory, { mode: 0o700 });
  // Provider tools may keep local state. Never run them inside the checkout they must authenticate.
  const github = { ...environment, HOME: privateDirectory, GH_TOKEN: token, GH_CONFIG_DIR: configDirectory, GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' };
  const root = 'repos/' + repository;
  const ghArgs = endpoint => ['api', '--hostname', 'github.com', '--method', 'GET', endpoint];
  const get = (stage, endpoint) => {
    mark(stage);
    return json(command('/usr/bin/gh', ghArgs(endpoint), deadline, github, privateDirectory));
  };
  const current = get('current-run-read', root + '/actions/runs/' + currentRunId);
  mark('current-run-contract');
  assert(current?.id === currentRunId && current.repository?.id === repositoryId && current.repository.full_name === repository
    && current.head_repository?.id === repositoryId && current.head_repository.full_name === repository
    && current.workflow_id === workflowId && current.path === workflowPath && current.head_sha === source && current.head_branch === branch
    && current.event === 'workflow_dispatch' && current.run_attempt === 1 && current.status === 'in_progress' && current.conclusion === null,
  'Measured preflight current provider run refused');
  const upstream = root + '/actions/runs/' + upstreamRunId;
  const values = {
    repository: get('repository-read', root),
    workflow: get('workflow-read', root + '/actions/workflows/' + workflowId),
    run: get('upstream-run-read', upstream),
    jobInventory: get('upstream-jobs-read', upstream + '/jobs?filter=all&per_page=16&page=1'),
    artifactInventory: get('upstream-artifacts-read', upstream + '/artifacts?per_page=2&page=1'),
  };
  mark('upstream-contract');
  const metadata = inspectMeasuredPreflightProviderMetadata(values, {
    source, upstreamRunId, currentRunId, currentRunStartedAt: current.run_started_at, nowMs: Date.now(),
  });
  const artifact = values.artifactInventory.artifacts[0];
  mark('archive-transfer');
  try {
    await downloadCiArchives([artifact], privateDirectory, {
      concurrency: 1, timeoutMs: remaining(deadline - 20000, 100000),
      start: () => spawn('/usr/bin/gh', ghArgs(root + '/actions/artifacts/' + metadata.artifactId + '/zip'), {
        env: github, cwd: privateDirectory, stdio: ['ignore', 'pipe', 'pipe'],
      }),
    });
  } catch {
    throw Error('Measured preflight authenticated archive transfer refused');
  }
  mark('archive-file');
  const bytes = readCiArchive(artifact, join(privateDirectory, artifact.name + '.zip'));
  mark('archive-envelope');
  const evidence = inspectMeasuredPreflightArchiveBytes(bytes, { source, runId: upstreamRunId }, remaining(deadline));
  mark('controller-after');
  controllerHead(source, deadline);
  const archive = freeze({
    kind: 'AUTHENTICATED_MEASURED_PREFLIGHT_ARCHIVE_BYTES_ONLY',
    source, runId: metadata.runId, resolveJobId: metadata.resolveJobId, selectedJobId: metadata.selectedJobId,
    artifactId: metadata.artifactId, archiveSha256: metadata.archiveSha256, archiveBytes: metadata.archiveBytes,
    captureSha256: evidence.measurement.capture.sha256, renderedUnionSha256: evidence.measurement.renderedUnion.sha256,
    harnessSha256: evidence.measurement.capture.harnessSha256, scenarioSha256: evidence.measurement.capture.scenarioSha256,
    evidence,
  });
  mark('result-deadline');
  remaining(deadline);
  const handle = Object.freeze({});
  authenticated.set(handle, { archive, deadline });
  return handle;
}

/** Only the actual provider path above can mint this byte-custody handle. */
export function readAuthenticatedMeasuredPreflightArchive(handle) {
  const retained = authenticated.get(handle);
  return retained && performance.now() < retained.deadline ? retained.archive : undefined;
}
