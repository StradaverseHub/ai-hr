/** Full development preflight scope only. No dispatch, credential, or runtime authority. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { nativePreflightRoutePlan, requireNativeRenderedUnion } from '../../scripts/performance/system-route-manifest.mjs';
import { readAuthenticatedMeasuredPreflightArchive } from './measured-browser-preflight-archive.mjs';
import { hasMeasuredSampledZeroShape } from './measured-browser-worker-contract.mjs';

const root = new URL('../../', import.meta.url);
const rootPath = fileURLToPath(root);
const modulePath = fileURLToPath(import.meta.url);
const protocol = new URL('scripts/performance/navigation-protocol.ts', root);
const sourceOwner = new URL('scripts/performance/navigation-source.ts', root);
const entry = new URL('scripts/performance/navigation-entry.ts', root);
const centre = new URL('lib/ai-centre/centre-nav.ts', root);
const edges = new Map([
  [sourceOwner.href, new Map([['./navigation-protocol', protocol.href]])],
  [protocol.href, new Map([['./navigation-entry', entry.href]])],
  [entry.href, new Map([['../../lib/ai-centre/centre-nav', centre.href]])],
]);
let navigation;

function navigationContracts() {
  navigation ??= (async () => {
    // The pinned Node 22 resolver strips these type-only sources. Only their three reviewed
    // extensionless edges are mapped, and the hook is removed after loading this graph.
    const hook = registerHooks({
      resolve(specifier, context, next) {
        return next(edges.get(context.parentURL)?.get(specifier) ?? specifier, context);
      },
    });
    try {
      const policy = await import(protocol.href);
      const source = await import(sourceOwner.href);
      return { ...policy, ...source };
    } finally {
      hook.deregister();
    }
  })();
  return navigation;
}

const routeDigest = '369e09c260c30de51be51f2de04a1467ca63682bd5ed0ecc48754b0cb80eb393';
const hiddenDigest = '36b86d2561088d2063db0431652b3418c8dee1ec558eeadc5a970bccc9a9fa74';
const count = { total: 191, urls: 93, usable: 17, scopedDenials: 1, renderedOnly: 173 };
const roles = { employee: 460, manager: 20, companyHR: 18, groupHR: 2 };
const actorCounts = { fictional: true, globalPopulationAsserted: false, trafficActors: 500, tenants: 2, companies: 10,
  actorsPerTenant: 250, actorsPerCompany: 50, nativeSelectedRows: 500, nativeGrants: 544, roles };
const lifecycle = [
  { phase: 'baseline', role: 'companyHR', open: 1, pending: 1 },
  { phase: 'baseline', role: 'groupHR', open: 2, pending: 1 },
];
const closed = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixtureEvidence(fixture, actors, postgres, workers) {
  assert.deepEqual(actors, actorCounts, 'Measured preflight traffic actor census differs');
  assert(fixture?.fictional === true && fixture.fixtureVolumeKind === 'workflow-preflight-only'
    && fixture.tenants === 2 && fixture.companies === 10 && fixture.users === 500 && fixture.returningUsers === 500
    && fixture.claimsPerEmployee === 200 && fixture.attendanceDays === 180, 'Measured preflight fixture scope differs');
  assert.deepEqual(fixture.roles, roles, 'Measured preflight fixture role census differs');
  assert.deepEqual(fixture.counts, { claims: 100000, attendance: 90000, payslips: 500 }, 'Measured preflight fixture counts differ');
  assert.deepEqual(fixture.attendanceBounds, { current_rows: 500, before_hire: 0 }, 'Measured preflight attendance bounds differ');
  assert(closed(postgres, ['scope', 'runtimeFrom', 'failures'])
    && postgres.scope === 'Owned PostgreSQL log observations without native identifiers'
    && typeof postgres.runtimeFrom === 'string' && Number.isFinite(Date.parse(postgres.runtimeFrom))
    && new Date(postgres.runtimeFrom).toISOString() === postgres.runtimeFrom, 'Measured preflight runtime log window differs');
  assert.deepEqual(postgres.failures, [], 'Measured preflight PostgreSQL failures observed');
  assert.deepEqual(workers, { scope: 'Closed worker diagnostics without raw logs or references', failures: [] },
    'Measured preflight worker failures observed or unknown');
}

function terminalEvidence(measurement, identity) {
  assert(closed(measurement, ['kind', 'version', 'course', 'suite', 'complete', 'releaseEligible', 'source',
    'courseOutcome', 'runnerReport', 'terminalReceipt', 'driverReceipt', 'capture', 'legacyEvidence', 'settlement',
    'workCompleted', 'busyResponses', 'pageEvents', 'locks', 'poolEvidence', 'renderedUnion', 'postgresWaitLogCoverage'])
    && measurement.kind === 'DEVELOPMENT_BROWSER_MEASURED_COURSE_V2' && measurement.version === 2
    && measurement.course === 'preflight-2' && measurement.suite === 'workflow-preflight'
    && measurement.complete === true && measurement.releaseEligible === false && measurement.courseOutcome === 'success'
    && measurement.runnerReport === 'observed' && measurement.terminalReceipt === 'observed' && measurement.driverReceipt === 'observed'
    && measurement.workCompleted === true && measurement.busyResponses === 0
    && measurement.poolEvidence === 'postgres-js-end-api-acknowledgement', 'Measured preflight V2 terminal scope differs');
  assert.deepEqual(measurement.source, {
    candidateSha: identity.candidateSha, controllerSha: identity.controllerSha, runId: identity.runId, runAttempt: 1,
  }, 'Measured preflight terminal source differs');
  assert(closed(measurement.capture, ['sha256', 'bytes', 'harnessSha256', 'scenarioSha256'])
    && closed(measurement.renderedUnion, ['sha256', 'bytes'])
    && [measurement.capture, measurement.renderedUnion].every(seal => digest(seal.sha256)
      && Number.isSafeInteger(seal.bytes) && seal.bytes > 0 && seal.bytes <= 4 * 1024 ** 2)
    && measurement.capture.harnessSha256 === identity.harnessSha256
    && measurement.capture.scenarioSha256 === identity.scenarioSha256, 'Measured preflight receipt seal identities differ');
  const requiredLegacy = ['fixture.json', 'actor-tenancy.json', 'postgres-lock-failures.json', 'server-native-failures.json'];
  assert(closed(measurement.legacyEvidence, [...requiredLegacy, 'fixture-phases.json'])
    && requiredLegacy.every(name => measurement.legacyEvidence[name] === 'observed')
    && ['observed', 'absent', 'refused'].includes(measurement.legacyEvidence['fixture-phases.json']),
  'Measured preflight required legacy projections were not observed');
  assert.deepEqual(measurement.settlement, {
    runner: { driver: 'settled', proxy: 'settled', workers: 'settled', postgres: 'settled',
      postgresReset: 'settled', postgresRemoveApi: 'settled', postgresAbsent: true },
    driver: { browser: 'settled', https: 'settled', diagnostics: 'settled', auditPool: 'settled', observerPool: 'settled' },
  }, 'Measured preflight terminal settlement differs');
  const pages = measurement.pageEvents;
  assert(closed(pages, ['censusComplete', 'observedPages', 'closedPages', 'observedCrashes', 'qualifiedCrashes',
    'aborted', 'transport', 'http5xx', 'pageError', 'consoleError'])
    && pages.censusComplete === true && Number.isSafeInteger(pages.observedPages) && pages.observedPages > 0
    && pages.observedPages <= 4096 && pages.closedPages === pages.observedPages
    && Number.isSafeInteger(pages.aborted) && pages.aborted >= 0 && pages.aborted <= 1000000
    && ['observedCrashes', 'qualifiedCrashes', 'transport', 'http5xx', 'pageError', 'consoleError'].every(key => pages[key] === 0),
  'Measured preflight Page census differs');
  assert(closed(measurement.locks, ['preflight', 'loaded']) && hasMeasuredSampledZeroShape(measurement.locks.preflight, 'preflight'),
    'Measured preflight sampled window refused');
  assert.deepEqual(measurement.locks.loaded, { phase: 'loaded', intervalMs: 1000, maxGapUs: 2000000,
    state: 'not-applicable', reason: null, coveragePass: false, pass: false, blockingSamples: null,
    observedBlockingSamples: null, qualifiedSamples: null, openingGapUs: null, interiorGapUs: null, tailGapUs: null },
  'Measured preflight must have no loaded window');
  assert.deepEqual(measurement.postgresWaitLogCoverage, { kind: 'development-heavyweight-lock-log', thresholdMs: 100,
    retainedFailures: 0, databaseBackendsSettled: true }, 'Measured preflight owned logged window refused');
}

function unionEvidence(union, identity, policy) {
  assert(closed(union, ['kind', 'complete', 'releaseEligible', 'protectedNative', 'dynamicNavigationComplete',
    'candidateSha', 'controllerSha', 'runId', 'runAttempt', 'harnessSha256', 'scenarioSha256',
    'counts', 'observations', 'primaryRetirement', 'lifecycleStaffTiles', 'hiddenShell'])
    && union.kind === 'DEVELOPMENT_RENDERED_ROUTE_UNION_V1' && union.complete === true
    && union.releaseEligible === false && union.protectedNative === false && union.dynamicNavigationComplete === false
    && union.runAttempt === 1 && Object.entries(identity).every(([key, value]) => union[key] === value),
  'Measured preflight rendered-union identity differs');
  const routes = nativePreflightRoutePlan();
  const checked = requireNativeRenderedUnion(union.observations);
  const tuples = union.observations.map(({ role, actorIndex, requested, final, redirectStatus, view, witness }) =>
    [role, actorIndex, requested, final, redirectStatus, view, witness]);
  assert(hash(tuples) === routeDigest && new Set(routes.map(row => row.requested)).size === 93, 'Measured preflight exact rendered route order differs');
  assert.deepEqual({ ...checked, urls: 93 }, count);
  assert.deepEqual(union.counts, count, 'Measured preflight rendered-route counts differ');
  assert.deepEqual(union.primaryRetirement, [0, 1, 2, 4].map(actorIndex => {
    const documents = routes.filter(row => row.actorIndex === actorIndex).length;
    return { actorIndex, admitted: documents, retired: documents, pageFailures: 0, refusals: 0, finalBlank: true,
      markerDocuments: { busy: 0, unavailable: 0, alerts: 0 } };
  }), 'Measured preflight primary document retirement differs');
  assert.deepEqual(union.lifecycleStaffTiles, lifecycle, 'Measured preflight scoped Lifecycle tiles differ');
  const hidden = union.hiddenShell;
  assert(closed(hidden, ['count', 'retiredDocuments', 'extensionSha256', 'observations'])
    && hidden.count === 4 && hidden.retiredDocuments === 8 && hidden.extensionSha256 === hiddenDigest,
  'Measured preflight hidden-shell scope differs');
  policy.validateNativeShellBaseline({
    schemaVersion: 1, protocol: policy.NATIVE_SHELL_BASELINE_VERSION, releaseAuthorized: false,
    ...identity, runAttempt: 1, legacyCases: 48, nativeCases: 52, retiredDocuments: hidden.retiredDocuments,
    extensionSha256: hidden.extensionSha256, complete: true, observations: hidden.observations,
  }, identity);
}

/** Model validator only. A supplied plan cannot mint an authenticated scope. */
export async function validateMeasuredPreflightSemanticModel(evidence, identity, plan) {
  const policy = await navigationContracts();
  assert(sha(identity.candidateSha) && identity.controllerSha === identity.candidateSha
    && Number.isSafeInteger(identity.runId) && identity.runId > 0 && digest(identity.harnessSha256)
    && identity.scenarioSha256 === policy.NATIVE_SHELL_LEGACY_SCENARIO_SHA256, 'Measured preflight source policy refused');
  const checkedPlan = policy.validateNavigationScenarioPlan(plan);
  assert(checkedPlan.scenarios.length === 48, 'Measured preflight baseline plan differs');
  assert(closed(evidence.capture, ['schemaVersion', 'protocol', 'releaseAuthorized', 'baseline'])
    && evidence.capture.schemaVersion === 1 && evidence.capture.protocol === policy.NAVIGATION_CAPTURE_VERSION
    && evidence.capture.releaseAuthorized === false, 'Measured preflight baseline bundle differs');
  policy.validateNavigationCapture(evidence.capture.baseline, checkedPlan, { ...identity, phase: 'baseline' });
  assert(evidence.capture.baseline.observations.every(row => !Object.hasOwn(row, 'startedWith') && !Object.hasOwn(row, 'usableWith')),
    'Measured preflight baseline cannot claim loaded observations');
  unionEvidence(evidence.renderedUnion, identity, policy);
  terminalEvidence(evidence.measurement, identity);
  fixtureEvidence(evidence.fixture, evidence.actors, evidence.postgresFailures, evidence.workerFailures);
}

const localEnv = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });

async function deriveSource(source) {
  assert(sha(source), 'Measured preflight source SHA refused');
  const git = (...args) => execFileSync('/usr/bin/git', ['--no-optional-locks', '-C', rootPath, ...args],
    { env: localEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const clean = () => git('rev-parse', 'HEAD') === source && git('status', '--porcelain') === '';
  assert(clean(), 'Measured preflight source checkout changed');
  const { navigationSourceIdentity } = await navigationContracts();
  const { harnessSha256, scenarioSha256, plan } = navigationSourceIdentity(rootPath, source);
  assert(clean(), 'Measured preflight source checkout changed');
  return { harnessSha256, scenarioSha256, plan };
}

/** Joins only an authentic byte handle with the exact clean source in the trusted resolver. */
export async function validateAuthenticatedMeasuredPreflight(handle) {
  const archive = readAuthenticatedMeasuredPreflightArchive(handle);
  assert(archive, 'Measured preflight authentic archive handle required');
  let source;
  try {
    source = JSON.parse(execFileSync(process.execPath, [modulePath, '--derive-source', archive.source], {
      env: localEnv, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch {
    throw Error('Measured preflight trusted source derivation refused');
  }
  const { harnessSha256, scenarioSha256 } = source;
  assert(harnessSha256 === archive.harnessSha256 && scenarioSha256 === archive.scenarioSha256,
    'Measured preflight checked source differs from archive');
  const identity = { candidateSha: archive.source, controllerSha: archive.source, runId: archive.runId, harnessSha256, scenarioSha256 };
  await validateMeasuredPreflightSemanticModel(archive.evidence, identity, source.plan);
  assert(readAuthenticatedMeasuredPreflightArchive(handle) === archive, 'Measured preflight archive deadline closed');
  return Object.freeze({
    kind: 'AUTHENTICATED_FULL_DEVELOPMENT_PREFLIGHT_SCOPE_ONLY', releaseEligible: false,
    source: archive.source, runId: archive.runId, resolveJobId: archive.resolveJobId, selectedJobId: archive.selectedJobId,
    artifactId: archive.artifactId, archiveSha256: archive.archiveSha256, captureSha256: archive.captureSha256,
    renderedUnionSha256: archive.renderedUnionSha256, harnessSha256, scenarioSha256,
  });
}

// Fixed source-only child. The trusted archive capability never leaves its parent.
if (process.argv[1] === modulePath) {
  assert(process.argv.length === 4 && process.argv[2] === '--derive-source', 'Measured preflight source-only child refused');
  const result = await deriveSource(process.argv[3]);
  process.stdout.write(JSON.stringify(result) + '\n');
}
