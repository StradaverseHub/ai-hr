import {overtimePayrollPreparationMode,validateOvertimePayrollPreparation} from './overtime-browser-target.mjs';
/** Read-only receipt validation. Preparation provenance belongs to its original candidate. */
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = () => { throw new Error('Resume requires exact original preparation and current owned stopped receipts; preserve this target.'); };
export function overtimeResumeReceiptName(name, candidate) {
  return sha(candidate) && typeof name === 'string' && /^browser-resume-[0-9a-f]{40}-[0-9]{13}\.json$/.test(name) && name.startsWith('browser-resume-' + candidate + '-');
}
/** Inputs are parsed local receipts, never application business facts or authorization.
 * @param {{fixture: Record<string, unknown>, browser: Record<string, unknown>, stopped: Record<string, unknown>, resumeRecords?: Record<string, Record<string, unknown>>, target: {database: string, namespace: string, port: string, deferPayroll?: boolean}, root: string, today: string}} receipts
 */
export function validateOvertimeResumeReceipts({fixture, browser, stopped, resumeRecords = {}, target, root, today}) {
  if (![fixture, browser, stopped, resumeRecords].every(record)) refuse();
  validateOvertimePayrollPreparation(fixture,target);
  const modeMatches = value => overtimePayrollPreparationMode(value) === (target.deferPayroll ? 'deferred' : 'prepared');
  const bound = value => modeMatches(value) && value.root === root && value.database === target.database && value.namespace === target.namespace && value.port === Number(target.port);
  if (!bound(fixture) || !bound(browser) || fixture.date !== today || fixture.setupOnly !== true || browser.fixtureRuns !== 2 || !sha(browser.candidate) || JSON.stringify(browser.fixture) !== JSON.stringify(fixture)) refuse();
  if (!uuid(fixture.tenantId) || !record(fixture.foreignTenant) || !uuid(fixture.foreignTenant.id) || fixture.tenantId === fixture.foreignTenant.id || fixture.foreignTenant.name !== 'Overtime16 fictional foreign tenant') refuse();
  if (!record(fixture.people) || !record(fixture.people.HR) || !uuid(fixture.people.HR.userId) || fixture.people.HR.tenantId !== fixture.tenantId) refuse();
  const visited = new Set(), names = Object.keys(resumeRecords);
  if (names.length > 64) refuse();
  const visitStop = stop => {
    if (!record(stop) || !modeMatches(stop) || !sha(stop.candidate) || stop.database !== target.database || stop.port !== Number(target.port) || stop.ownedServerStopped !== true || typeof stop.stoppedAt !== 'string' || !Number.isFinite(Date.parse(stop.stoppedAt))) refuse();
    // Earlier preparation receipts bind these through the original browser manifest; new ones include them.
    for (const [key, expected] of [['root', root], ['namespace', target.namespace], ['date', today], ['preparationCandidate', browser.candidate]]) if (stop[key] !== undefined && stop[key] !== expected) refuse();
    if (stop.outcome !== undefined && (!['stopped', 'failed'].includes(stop.outcome) || stop.cleanupSucceeded !== true || stop.exitCode !== (stop.outcome === 'failed' ? 1 : 0))) refuse();
    if (stop.serverPid !== undefined && (!Number.isSafeInteger(stop.serverPid) || stop.serverPid <= 1)) refuse();
    if (stop.resumeReceipt === undefined) { if (stop.candidate !== browser.candidate) refuse(); return; }
    if (!bound(stop) || stop.date !== today || stop.preparationCandidate !== browser.candidate || stop.outcome === undefined || stop.serverPid === undefined) refuse();
    const name = stop.resumeReceipt;
    if (!overtimeResumeReceiptName(name, stop.candidate) || visited.has(name)) refuse();
    const previousResume = resumeRecords[name];
    if (!record(previousResume) || !bound(previousResume) || previousResume.date !== today || previousResume.candidate !== stop.candidate || previousResume.preparationCandidate !== browser.candidate || !record(previousResume.priorStoppedReceipt) || previousResume.resumedFromCandidate !== previousResume.priorStoppedReceipt.candidate || previousResume.fixtureRunsThisCandidate !== 0 || previousResume.preparationManifest !== 'browser-manifest.json') refuse();
    visited.add(name);
    visitStop(previousResume.priorStoppedReceipt);
  };
  visitStop(stopped);
  // Every attempted resume must belong to the stopped chain. An orphan means a newer/failed run
  // was not accounted for, even if an older stop receipt and a now-dead browser.pid remain.
  if (names.some(name => !visited.has(name))) refuse();
  return {preparationCandidate: browser.candidate, resumedFromCandidate: stopped.candidate, date: today};
}
