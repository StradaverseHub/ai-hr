import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { nativePreflightReadiness, nativePreflightRoutePlan } from '../../scripts/performance/system-route-manifest.mjs';
import { validateAuthenticatedMeasuredPreflight, validateMeasuredPreflightSemanticModel } from './measured-browser-preflight-semantics.mjs';

const plan = JSON.parse(readFileSync(new URL('../../scripts/performance/navigation-scenarios.json', import.meta.url), 'utf8'));
const identity = {
  candidateSha: 'a'.repeat(40), controllerSha: 'a'.repeat(40), runId: 100, harnessSha256: 'b'.repeat(64),
  scenarioSha256: 'c450f4f611cdf2fcb3f4757871b1bb09d85d18347ef56a8a5b148098bc9ca329',
};
const protocol = 'aihr-navigation-development/v2';
const roles = { employee: 460, manager: 20, companyHR: 18, groupHR: 2 };

function model() {
  const actorFor = { employee: 4, manager: 2, companyHR: 1, groupHR: 0 };
  const routes = nativePreflightRoutePlan();
  const hidden = [
    ['shell.payrollProcess', '/payroll', 'employee', 4], ['shell.payrollProcess', '/payroll', 'manager', 2],
    ['shell.analytics', '/analytics', 'employee', 4], ['shell.analytics', '/analytics', 'manager', 2],
  ].map(([destinationId, href, role, actorIndex]) => ({
    id: destinationId + '.' + role + '.hidden-denied', destinationId, role, actorIndex, entry: 'shell-menu',
    shellVisibility: 'hidden', originHref: '/', href, outcome: 'denied', originStatus: 200, redirectStatus: 307,
    finalStatus: 200, finalHref: '/', internalSessionObserved: true, fixtureIdentityObserved: true,
    privateDestinationAbsent: true, elapsedMs: 100,
  }));
  return {
    capture: {
      schemaVersion: 1, protocol, releaseAuthorized: false,
      baseline: { schemaVersion: 1, protocol, releaseAuthorized: false, fixture: 'system-load-v1', engine: 'chromium',
        ...identity, runAttempt: 1, phase: 'baseline', complete: true,
        observations: plan.scenarios.map(row => ({
          entry: row.entry ?? 'canonical-link', scenarioId: row.id, destinationId: row.destinationId,
          role: row.role, actorIndex: actorFor[row.role], href: row.href, outcome: row.outcome, readiness: row.readiness,
          status: 200, finalPath: row.outcome === 'denied' ? '/' : new URL(row.href, 'https://localhost:3443').pathname,
          internalSessionObserved: true, fixtureIdentityObserved: true, elapsedMs: 100,
          checks: row.checks.map(check => ({ id: check.id, passed: true, observedCount: check.minimum ?? 1 })),
          failures: { busy: 0, unavailable: 0, alerts: 0, http500: 0, pageErrors: 0 },
        })),
      },
    },
    renderedUnion: {
      kind: 'DEVELOPMENT_RENDERED_ROUTE_UNION_V1', ...identity, runAttempt: 1, complete: true,
      releaseEligible: false, protectedNative: false, dynamicNavigationComplete: false,
      counts: { total: 191, urls: 93, usable: 16, scopedDenials: 1, renderedOnly: 174 },
      observations: routes.map(row => ({ ...row, status: 200, accountObserved: true, elapsedMs: 100,
        failureCount: 0, readiness: nativePreflightReadiness(row.witness) })),
      primaryRetirement: [0, 1, 2, 4].map(actorIndex => {
        const count = routes.filter(row => row.actorIndex === actorIndex).length;
        return { actorIndex, admitted: count, retired: count, pageFailures: 0, refusals: 0, finalBlank: true,
          markerDocuments: { busy: 0, unavailable: 0, alerts: 0 } };
      }),
      lifecycleStaffTiles: [{ phase: 'baseline', role: 'companyHR', open: 1, pending: 1 },
        { phase: 'baseline', role: 'groupHR', open: 2, pending: 1 }],
      hiddenShell: { count: 4, retiredDocuments: 8, extensionSha256: '36b86d2561088d2063db0431652b3418c8dee1ec558eeadc5a970bccc9a9fa74', observations: hidden },
    },
    measurement: {
      kind: 'DEVELOPMENT_BROWSER_MEASURED_COURSE_V2', version: 2, course: 'preflight-2', suite: 'workflow-preflight',
      complete: true, releaseEligible: false, courseOutcome: 'success', runnerReport: 'observed', terminalReceipt: 'observed', driverReceipt: 'observed',
      source: { candidateSha: identity.candidateSha, controllerSha: identity.controllerSha, runId: identity.runId, runAttempt: 1 },
      capture: { sha256: 'c'.repeat(64), bytes: 100, harnessSha256: identity.harnessSha256, scenarioSha256: identity.scenarioSha256 },
      renderedUnion: { sha256: 'd'.repeat(64), bytes: 200 },
      legacyEvidence: { 'fixture.json': 'observed', 'actor-tenancy.json': 'observed', 'fixture-phases.json': 'absent',
        'postgres-lock-failures.json': 'observed', 'server-native-failures.json': 'observed' },
      settlement: {
        runner: { driver: 'settled', proxy: 'settled', workers: 'settled', postgres: 'settled',
          postgresReset: 'settled', postgresRemoveApi: 'settled', postgresAbsent: true },
        driver: { browser: 'settled', https: 'settled', diagnostics: 'settled', auditPool: 'settled', observerPool: 'settled' },
      },
      workCompleted: true, busyResponses: 0, poolEvidence: 'postgres-js-end-api-acknowledgement',
      pageEvents: { censusComplete: true, observedPages: 10, closedPages: 10, observedCrashes: 0, qualifiedCrashes: 0,
        aborted: 1, transport: 0, http5xx: 0, pageError: 0, consoleError: 0 },
      locks: {
        preflight: { phase: 'preflight', intervalMs: 250, maxGapUs: 500000, state: 'complete', reason: null,
          coveragePass: true, pass: true, blockingSamples: 0, observedBlockingSamples: 0, qualifiedSamples: 3,
          openingGapUs: 100000, interiorGapUs: 250000, tailGapUs: 150000 },
        loaded: { phase: 'loaded', intervalMs: 1000, maxGapUs: 2000000, state: 'not-applicable', reason: null,
          coveragePass: false, pass: false, blockingSamples: null, observedBlockingSamples: null,
          qualifiedSamples: null, openingGapUs: null, interiorGapUs: null, tailGapUs: null },
      },
      postgresWaitLogCoverage: { kind: 'development-heavyweight-lock-log', thresholdMs: 100, retainedFailures: 0, databaseBackendsSettled: true },
    },
    fixture: { fictional: true, fixtureVolumeKind: 'workflow-preflight-only', tenants: 2, companies: 10, users: 500, returningUsers: 500,
      claimsPerEmployee: 200, attendanceDays: 180, roles: { ...roles }, counts: { claims: 100000, attendance: 90000, payslips: 500 },
      attendanceBounds: { current_rows: 500, before_hire: 0 } },
    actors: { fictional: true, globalPopulationAsserted: false, trafficActors: 500, tenants: 2, companies: 10,
      actorsPerTenant: 250, actorsPerCompany: 50, nativeSelectedRows: 500, nativeGrants: 544, roles: { ...roles } },
    postgresFailures: { scope: 'Owned PostgreSQL log observations without native identifiers', runtimeFrom: '2026-11-09T00:00:00.000Z', failures: [] },
    workerFailures: { scope: 'Closed worker diagnostics without raw logs or references', failures: [] },
  };
}

const check = evidence => validateMeasuredPreflightSemanticModel(evidence, identity, plan);
async function refuses(mutations) {
  for (const mutate of mutations) {
    const evidence = model();
    mutate(evidence);
    await assert.rejects(check(evidence));
  }
}

test('validates the complete modeled scope without minting archive authority', async () => {
  assert.equal(await check(model()), undefined);
  await assert.rejects(validateAuthenticatedMeasuredPreflight(model()), /authentic archive handle/);
});

test('refuses a missing, duplicate, reordered or mis-scoped rendered route', async () => {
  await refuses([
    e => { e.renderedUnion.observations.pop(); },
    e => { e.renderedUnion.observations[0] = e.renderedUnion.observations[1]; },
    e => { e.renderedUnion.observations.reverse(); },
    e => { e.renderedUnion.observations[0].actorIndex = 0; },
    e => { e.renderedUnion.observations[0].readiness = 'usable-content'; },
  ]);
});

test('checks all baseline cases and the hidden and primary retirement boundaries', async () => {
  await refuses([
    e => { e.capture.baseline.observations[0].scenarioId = 'unknown'; },
    e => { e.capture.baseline.observations[0].startedWith = { active: 500, inSteadyWindow: true }; },
    e => { e.renderedUnion.hiddenShell.extensionSha256 = 'e'.repeat(64); },
    e => { e.renderedUnion.hiddenShell.observations[0].privateDestinationAbsent = false; },
    e => { e.renderedUnion.primaryRetirement[0].retired--; },
    e => { e.renderedUnion.lifecycleStaffTiles[0].open = 2; },
  ]);
});

test('refuses unknown, late or positive sampled and owned-log results separately', async () => {
  await refuses([
    e => { e.measurement.locks.preflight.openingGapUs = 500001; },
    e => { e.measurement.locks.preflight.observedBlockingSamples = 1; },
    e => { e.measurement.locks.preflight.blockingSamples = null; },
    e => { e.measurement.postgresWaitLogCoverage.thresholdMs = 1000; },
    e => { e.measurement.postgresWaitLogCoverage.databaseBackendsSettled = false; },
    e => { e.postgresFailures.runtimeFrom = null; },
    e => { e.postgresFailures.failures.push({ kind: 'observed heavyweight lock wait' }); },
  ]);
});

test('requires exact fixture scope, observed clean workers and real settled Page scope', async () => {
  await refuses([
    e => { e.fixture.counts.attendance = 89999; },
    e => { e.fixture.returningUsers = 499; },
    e => { delete e.fixture.returningUsers; },
    e => { e.actors.nativeGrants = 543; },
    e => { e.workerFailures = null; },
    e => { e.measurement.legacyEvidence['server-native-failures.json'] = 'absent'; },
    e => { e.measurement.pageEvents.closedPages = 9; },
    e => { e.measurement.settlement.runner.postgresAbsent = false; },
    e => { e.measurement.source.runAttempt = 2; },
  ]);
});
