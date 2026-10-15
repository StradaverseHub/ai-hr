/** Read-only receipt validation. Preparation provenance belongs to its original candidate. */
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = () => { throw new Error('Resume requires exact original preparation and owned stopped receipts; preserve this target.'); };
export function overtimeResumeReceiptName(name, candidate) {
  return sha(candidate) && typeof name === 'string' && /^browser-resume-[0-9a-f]{40}-[0-9]{13}\.json$/.test(name) && name.startsWith('browser-resume-' + candidate + '-');
}
/** Inputs are parsed local receipts, never application business facts or authorization.
 * @param {{fixture: Record<string, unknown>, browser: Record<string, unknown>, stopped: Record<string, unknown>, previousResume?: Record<string, unknown>, target: {database: string, namespace: string, port: string}, root: string, today: string}} receipts
 */
export function validateOvertimeResumeReceipts({fixture, browser, stopped, previousResume = undefined, target, root, today}) {
  if (![fixture, browser, stopped].every(record)) refuse();
  const bound = value => value.root === root && value.database === target.database && value.namespace === target.namespace && value.port === Number(target.port);
  if (!bound(fixture) || !bound(browser) || fixture.date !== today || fixture.setupOnly !== true || browser.fixtureRuns !== 2 || !sha(browser.candidate) || JSON.stringify(browser.fixture) !== JSON.stringify(fixture)) refuse();
  if (!uuid(fixture.tenantId) || !record(fixture.foreignTenant) || !uuid(fixture.foreignTenant.id) || fixture.tenantId === fixture.foreignTenant.id || fixture.foreignTenant.name !== 'Overtime16 fictional foreign tenant') refuse();
  if (!record(fixture.people) || !record(fixture.people.HR) || !uuid(fixture.people.HR.userId) || fixture.people.HR.tenantId !== fixture.tenantId) refuse();
  if (!sha(stopped.candidate) || stopped.database !== target.database || stopped.port !== Number(target.port) || stopped.ownedServerStopped !== true || typeof stopped.stoppedAt !== 'string' || !Number.isFinite(Date.parse(stopped.stoppedAt))) refuse();
  // Earlier coordinator receipts bind these through the original browser manifest; new ones include them.
  for (const [key, expected] of [['root', root], ['namespace', target.namespace], ['date', today], ['preparationCandidate', browser.candidate]]) if (stopped[key] !== undefined && stopped[key] !== expected) refuse();
  if (stopped.resumeReceipt !== undefined) {
    if (!overtimeResumeReceiptName(stopped.resumeReceipt, stopped.candidate) || !record(previousResume) || !bound(previousResume) || previousResume.date !== today || previousResume.candidate !== stopped.candidate || previousResume.preparationCandidate !== browser.candidate || !sha(previousResume.resumedFromCandidate) || previousResume.fixtureRunsThisCandidate !== 0 || previousResume.preparationManifest !== 'browser-manifest.json') refuse();
  } else if (stopped.candidate !== browser.candidate) refuse();
  return {preparationCandidate: browser.candidate, resumedFromCandidate: stopped.candidate, date: today};
}
