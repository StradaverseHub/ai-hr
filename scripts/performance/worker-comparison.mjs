/** Dormant serial scheduling model. Actual runner ownership and admission are separate. */
import assert from 'node:assert/strict';

const second = 1000;
const profile = Object.freeze({ totalHeapMiB: 4096, totalPool: 16, waiterLimit: 2048, fixtureActors: 500,
  attendanceDays: 180, thinkMs: 1000, fixtureMs: 600 * second, helperMs: 180 * second, driverSettlementMs: 10 * second });
const course = Object.freeze([
  Object.freeze({ ...profile, ordinal: 1, name: 'steady-2', suite: 'whole-system', scope: 'steady-500',
    workers: 2, heapMiBPerWorker: 2048, poolPerWorker: 8, claimsPerActor: 2000, activeMinimumMs: 2560 * second,
    buildMode: 'comparison-first', buildMs: 900 * second, driverMs: 870 * second, rampMs: 10 * second, holdMs: 300 * second, oversubscribed: false }),
  Object.freeze({ ...profile, ordinal: 2, name: 'steady-4', suite: 'whole-system', scope: 'steady-500',
    workers: 4, heapMiBPerWorker: 1024, poolPerWorker: 4, claimsPerActor: 2000, activeMinimumMs: 1660 * second,
    buildMode: 'comparison-copy', buildMs: null, driverMs: 870 * second, rampMs: 10 * second, holdMs: 300 * second, oversubscribed: false }),
  Object.freeze({ ...profile, ordinal: 3, name: 'functional-8', suite: 'workflow-preflight', scope: 'functional-diagnostic-only',
    workers: 8, heapMiBPerWorker: 512, poolPerWorker: 2, claimsPerActor: 200, activeMinimumMs: 1390 * second,
    buildMode: 'comparison-copy', buildMs: null, driverMs: 600 * second, rampMs: null, holdMs: 30 * second, oversubscribed: true }),
]);
const sameIdentity = (left, right) => left?.candidateSha === right.candidateSha && left.controllerSha === right.controllerSha
  && left.runId === right.runId && left.runAttempt === 1;
const closed = (row, keys) => row !== null && typeof row === 'object' && !Array.isArray(row)
  && Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
const id = value => Number.isSafeInteger(value) && value > 0;
const hex = (value, size) => typeof value === 'string' && value.length === size && /^[a-f0-9]+(?![\s\S])/.test(value);
const decimal = (value, zero = false) => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})(?![\s\S])/.test(value)
  && (zero || value !== '0');
const sameSeal = (left, right) => left.buildId === right.buildId && left.entries === right.entries
  && left.bytes === right.bytes && left.sha256 === right.sha256;
const sealFields = ['buildId', 'entries', 'bytes', 'sha256'];
const identityFields = ['candidateSha', 'controllerSha', 'runId', 'runAttempt'];

function prerequisiteFor(identity, prerequisite, host) {
  assert(closed(identity, identityFields) && hex(identity.candidateSha, 40) && identity.controllerSha === identity.candidateSha
    && id(identity.runId) && identity.runAttempt === 1, 'Worker comparison identity refused');
  const ids = ['runId', 'resolveJobId', 'selectedJobId', 'artifactId'];
  const hashes = ['archiveSha256', 'captureSha256', 'renderedUnionSha256', 'harnessSha256', 'scenarioSha256'];
  assert(closed(prerequisite, ['kind', 'releaseEligible', 'source', ...ids, ...hashes])
    && prerequisite.kind === 'AUTHENTICATED_FULL_DEVELOPMENT_PREFLIGHT_SCOPE_ONLY' && prerequisite.releaseEligible === false
    && prerequisite.source === identity.candidateSha && ids.every(key => id(prerequisite[key]))
    && prerequisite.runId !== identity.runId && prerequisite.resolveJobId !== prerequisite.selectedJobId
    && hashes.every(key => hex(prerequisite[key], 64)), 'Worker comparison same-source full preflight required');
  assert(closed(host, ['effectiveCpus', 'memoryBytes', 'nodeVersion', 'postgresProfile'])
    && host.effectiveCpus === 4 && Number.isSafeInteger(host.memoryBytes)
    && host.memoryBytes >= 15 * 1024 ** 3 && host.memoryBytes <= 17 * 1024 ** 3
    && host.nodeVersion === 'v24.22.1' && host.postgresProfile === 2, 'Worker comparison host profile refused');
}

function validSeal(seal) {
  return closed(seal, sealFields) && typeof seal.buildId === 'string' && /^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(seal.buildId)
    && id(seal.entries) && seal.entries <= 100000 && id(seal.bytes) && seal.bytes <= 3 * 1024 ** 3 && hex(seal.sha256, 64);
}

function buildBirth(view, identity) {
  if (!closed(view, ['identity', 'seal', 'directory']) || !closed(view.identity, identityFields) || !sameIdentity(view.identity, identity)
    || !validSeal(view.seal) || !closed(view.directory, ['device', 'inode'])
    || !decimal(view.directory.device, true) || !decimal(view.directory.inode)) return null;
  return view.directory.device + ':' + view.directory.inode;
}

function validFixture(value, cell) {
  return closed(value, ['day', 'actors', 'tenants', 'companies', 'nativeGrants', 'claims', 'attendance', 'payslips'])
    && typeof value.day === 'string' && /^\d{4}-\d{2}-\d{2}(?![\s\S])/.test(value.day)
    && Number.isFinite(Date.parse(value.day)) && new Date(value.day).toISOString().slice(0, 10) === value.day
    && value.actors === 500 && value.tenants === 2 && value.companies === 10 && value.nativeGrants === 544
    && value.claims === cell.claimsPerActor * 500 && value.attendance === 90000 && value.payslips === 500;
}

const settledFields = ['settledForReuse', 'directChildrenClosed', 'processFamilyEmpty', 'postgresBirthAbsent',
  'portsAbsent', 'runtimeBuildRetired', 'focusedDirectoryRetired'];
function settled(row, identity, ordinal) {
  return closed(row, ['kind', ...identityFields, 'ordinal', ...settledFields])
    && row.kind === 'WORKER_COMPARISON_CELL_SETTLEMENT_V1' && sameIdentity(row, identity)
    && row.ordinal === ordinal && settledFields.every(field => row[field] === true);
}

function seedRetired(row, identity) {
  return closed(row, ['kind', ...identityFields, 'retired', 'privateDirectoryRetired'])
    && row.kind === 'WORKER_COMPARISON_SEED_RETIREMENT_V1' && sameIdentity(row, identity)
    && row.retired === true && row.privateDirectoryRetired === true;
}

/** One invocation per model instance. Its callbacks supply observations, never a live grant. */
export function createWorkerComparisonModel({ identity, prerequisite, host, anchorMs, now, observeCell, settledForReuse, verifySeed, retireSeed }) {
  prerequisiteFor(identity, prerequisite, host);
  assert(Number.isFinite(anchorMs) && anchorMs >= 0 && anchorMs <= Number.MAX_SAFE_INTEGER - 7200 * second
    && [now, observeCell, settledForReuse, verifySeed, retireSeed].every(callback => typeof callback === 'function'),
  'Worker comparison clock or observation owner refused');
  const source = Object.freeze({ ...identity });
  const upstream = Object.freeze({ ...prerequisite });
  const frontiers = Object.freeze({ anchorMs, activeEndMs: anchorMs + 6600 * second,
    settlementEndMs: anchorMs + 6960 * second, finalEndMs: anchorMs + 7080 * second, outerEndMs: anchorMs + 7200 * second });
  let used = false;
  let lastTime = anchorMs;
  let clockUsable = true;

  function remaining(frontier) {
    if (!clockUsable) return 0;
    let sampled;
    try {
      sampled = now();
    } catch {
      clockUsable = false;
      return 0;
    }
    if (!Number.isFinite(sampled) || sampled < lastTime) {
      clockUsable = false;
      return 0;
    }
    lastTime = sampled;
    return Math.max(0, frontier - sampled);
  }

  async function observed(callback, input) {
    try {
      return await callback(input);
    } catch {
      return null;
    }
  }

  return Object.freeze({
    async run() {
      assert(!used, 'Worker comparison model cannot reopen');
      used = true;
      const cells = [];
      const births = new Set();
      let seal = null;
      let steadyDay = null;
      let heldReason = null;
      let lastSettled = false;
      let seedUncertain = false;
      for (const cell of course) {
        if (!heldReason && remaining(frontiers.activeEndMs) < cell.activeMinimumMs) heldReason = clockUsable ? 'budget' : 'clock';
        if (heldReason) {
          cells.push({ name: cell.name, scope: cell.scope, state: 'not-entered', reason: heldReason, settlement: null });
          continue;
        }

        lastSettled = false;
        const request = Object.freeze({ cell, identity: source, prerequisite: upstream, frontiers });
        const result = await observed(observeCell, request);
        const withinActive = remaining(frontiers.activeEndMs) > 0;
        const resultShape = closed(result, ['kind', 'scope', 'passed', 'build', 'fixture'])
          && result.kind === 'WORKER_COMPARISON_CELL_V1' && result.scope === cell.scope && typeof result.passed === 'boolean';
        const passed = resultShape && result.passed;
        const birth = resultShape ? buildBirth(result.build, source) : null;
        const buildKnown = birth !== null && !births.has(birth) && (seal === null || sameSeal(seal, result.build.seal));
        if (buildKnown) {
          births.add(birth);
          seal ??= Object.freeze({ ...result.build.seal });
        }
        const fixtureKnown = resultShape && validFixture(result.fixture, cell);
        const day = fixtureKnown ? result.fixture.day : null;
        if (cell.ordinal === 1) steadyDay = day;

        if (remaining(frontiers.settlementEndMs) > 0) {
          const reuse = await observed(settledForReuse, request);
          lastSettled = remaining(frontiers.settlementEndMs) > 0 && settled(reuse, source, cell.ordinal);
        }
        let reason = !withinActive ? 'active-overrun' : !resultShape ? 'unknown-cell' : !buildKnown ? 'build-proof'
          : !fixtureKnown ? 'fixture-proof' : cell.ordinal === 2 && day !== steadyDay ? 'fixture-day'
            : passed ? null : 'measurement';
        if (!lastSettled) reason ??= 'settlement';
        cells.push({ name: cell.name, scope: cell.scope, state: reason === null ? 'passed' : 'failed',
          reason, fixtureDay: day, settlement: lastSettled ? 'settled' : 'unknown' });

        if (!lastSettled) heldReason = 'settlement';
        else if (!withinActive || !buildKnown || !fixtureKnown) heldReason = reason;
        if (!heldReason && cell.ordinal < course.length) {
          if (remaining(frontiers.activeEndMs) === 0) {
            heldReason = 'budget';
          } else {
            const seed = await observed(verifySeed, Object.freeze({ identity: source, seal, deadlineMs: frontiers.activeEndMs }));
            if (!validSeal(seed) || !sameSeal(seed, seal)) {
              seedUncertain = true;
              heldReason = 'seed-proof';
            } else if (remaining(frontiers.activeEndMs) === 0) {
              heldReason = 'budget';
            }
          }
        }
      }
      let seedSettlement = seal ? 'unknown' : null;
      if (seal && !seedUncertain && lastSettled && remaining(frontiers.finalEndMs) > 0) {
        const input = Object.freeze({ identity: source, seal, deadlineMs: frontiers.finalEndMs });
        const seed = await observed(verifySeed, input);
        if (remaining(frontiers.finalEndMs) > 0 && validSeal(seed) && sameSeal(seed, seal)) {
          const removal = await observed(retireSeed, input);
          if (remaining(frontiers.finalEndMs) > 0 && seedRetired(removal, source)) seedSettlement = 'settled';
        }
      }
      const steadyPairPassed = cells.slice(0, 2).every(row => row.state === 'passed');
      return Object.freeze({
        kind: 'WORKER_COMPARISON_SCHEDULING_MODEL_ONLY', releaseEligible: false, identity: source, prerequisite: upstream,
        frontiers, buildSeal: seal, seedSettlement, cells: Object.freeze(cells.map(row => Object.freeze(row))),
        complete: seedSettlement === 'settled' && cells.every(row => row.state === 'passed'),
        steadyPairPassed: seedSettlement === 'settled' && steadyPairPassed,
      });
    },
  });
}
