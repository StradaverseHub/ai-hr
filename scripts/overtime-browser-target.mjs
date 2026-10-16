/** Closed local acceptance targets. An attempt is selected explicitly by the parent, never retried. */
/** @param {readonly string[]} args @param {{allowWorker?: boolean, allowResume?: boolean}} [options] */
export function overtimeBrowserTarget(args, {allowWorker = false, allowResume = false} = {}) {
  let attempt;
  let heldLockWorker = false;
  let resume = false;
  let deferPayroll = false;
  for (const arg of args) {
    if (allowWorker && arg === '--held-lock-worker' && !heldLockWorker) {
      heldLockWorker = true;
    } else if (allowResume && arg === '--resume' && !resume) {
      resume = true;
    } else if (arg === '--defer-payroll' && !deferPayroll) {
      deferPayroll = true;
    } else if (/^--attempt=b[1-9][0-9]?$/.test(arg) && attempt === undefined) {
      attempt = arg.slice('--attempt='.length);
    } else {
      throw new Error('Use one bounded --attempt=b1 through b99 and at most one --defer-payroll; resume and worker flags require their explicit coordinator permission.');
    }
  }
  if (deferPayroll && attempt === undefined) throw new Error('Deferred Payroll preparation requires an explicitly allocated bounded attempt.');
  return Object.freeze({
    attempt,
    heldLockWorker,
    resume,
    deferPayroll,
    childArgs: [...(attempt === undefined ? [] : ['--attempt=' + attempt]), ...(deferPayroll ? ['--defer-payroll'] : [])],
    database: attempt === undefined ? 'ai_hr_board16_overtime_browser' : 'ai_hr_board16_ot_' + attempt,
    namespace: attempt === undefined ? 'board16overtimebrowser' : 'board16ot_' + attempt,
    scratchpad: attempt === undefined ? 'scratchpad/board16-overtime-browser' : 'scratchpad/board16-overtime-' + attempt,
    port: '3210',
  });
}

/** Missing mode means the original prepared-Payroll receipt, never deferred preparation. */
export function overtimePayrollPreparationMode(receipt) {
  if (receipt.payrollPreparation === undefined) return 'prepared';
  if (receipt.payrollPreparation === 'deferred' || receipt.payrollPreparation === 'prepared') return receipt.payrollPreparation;
  throw new Error('Unknown Payroll preparation receipt; preserve this target.');
}
/** Validate original preparation facts, not the later state of its actual UI journey. */
export function validateOvertimePayrollPreparation(fixture, target) {
  if (overtimePayrollPreparationMode(fixture) !== (target.deferPayroll ? 'deferred' : 'prepared')) throw new Error('Payroll preparation mode differs from the original fixture; preserve this target.');
  const batch = fixture.batch;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (!batch || typeof batch !== 'object' || Array.isArray(batch) || !Array.isArray(batch.employmentIds) || !batch.employmentIds.length || batch.employmentIds.some(id => !uuid(id)) || new Set(batch.employmentIds).size !== batch.employmentIds.length) throw new Error('Original planned Payroll scope is missing or invalid.');
  if (target.deferPayroll ? batch.status !== 'not-created' || Object.prototype.hasOwnProperty.call(batch, 'id') : batch.status !== 'draft' || !uuid(batch.id)) throw new Error('Payroll preparation state does not match its declared mode.');
}
