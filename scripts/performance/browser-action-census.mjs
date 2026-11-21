import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const lanes = ['approvals', 'payroll', 'shell', 'workforce'];
const roles = ['companyHR', 'employee', 'groupHR', 'manager'];

export function actionCensusIdentity(registrations) {
  const entries = [...registrations.keys()].sort().map(id => [id, [...registrations.get(id)].sort()]);
  return {
    identity: {registryDigest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), registered: entries.length},
    ordinals: new Map(entries.map(([id], index) => [id, index + 1])),
  };
}

/** These are matched response observations inside successful journeys.
 * A journey may issue incidental actions, and a POST response is not a persistence witness. */
export function mergeActionCensus(reports) {
  assert(reports.length > 0, 'No action audit lanes supplied');
  const {sourceSha, buildId, serverActionCensus} = reports[0];
  assert(/^[a-f0-9]{40}$/.test(sourceSha) && typeof buildId === 'string' && buildId);
  assert(/^[a-f0-9]{64}$/.test(serverActionCensus?.registryDigest)
    && Number.isSafeInteger(serverActionCensus.registered) && serverActionCensus.registered > 0, 'Missing compiled action identity');
  const seen = new Set();
  const actions = new Set();
  const bindings = new Set();
  const byPageRole = new Map();
  for (const report of reports) {
    assert.equal(report.sourceSha, sourceSha, 'Action lanes use different source revisions');
    assert.equal(report.buildId, buildId, 'Action lanes use different builds');
    assert.deepEqual(report.serverActionCensus, serverActionCensus, 'Action lanes use different registries');
    assert(lanes.includes(report.actionLane) && !seen.has(report.actionLane), 'Unknown or duplicate action lane');
    seen.add(report.actionLane);
    const laneActions = new Set();
    const laneBindings = new Set();
    for (const journey of report.journeys) {
      for (const response of journey.serverActionResponses ?? []) {
        if (journey.status !== 'observed' || response.matchedWorker !== true || !(response.status >= 200 && response.status < 400)) continue;
        const {actionOrdinal, elapsedMs, page} = response;
        assert(Number.isSafeInteger(actionOrdinal) && actionOrdinal >= 1 && actionOrdinal <= serverActionCensus.registered,
          'Matched action response has no valid build ordinal');
        assert(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 && roles.includes(journey.role) && typeof page === 'string'
          && page.startsWith('/') && !/[?#]/.test(page), 'Invalid matched action observation');
        actions.add(actionOrdinal);
        laneActions.add(actionOrdinal);
        const binding = JSON.stringify([actionOrdinal, page]);
        bindings.add(binding);
        laneBindings.add(binding);
        const key = JSON.stringify([page, journey.role]);
        const row = byPageRole.get(key) ?? {page, role: journey.role, actions: new Set(), observations: 0, maxResponseMs: 0};
        row.actions.add(actionOrdinal);
        row.observations++;
        row.maxResponseMs = Math.max(row.maxResponseMs, elapsedMs);
        byPageRole.set(key, row);
      }
    }
    assert.equal(laneActions.size, report.serverActionInventory.withMatchingPageEvidence, 'Lane action count differs from its observed responses');
    assert.equal(laneBindings.size, report.serverActionInventory.matchedPageRegistrations, 'Lane page count differs from its observed responses');
  }
  return {
    sourceSha, buildId, registered: serverActionCensus.registered,
    matchedActions: actions.size, matchedPageRegistrations: bindings.size,
    lanes: [...seen].sort(), missingLanes: lanes.filter(lane => !seen.has(lane)),
    byPageRole: [...byPageRole.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([, row]) => ({...row, actions: row.actions.size})),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = mergeActionCensus(process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8'))));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
