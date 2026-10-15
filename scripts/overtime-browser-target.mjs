/** Closed local acceptance targets. An attempt is selected explicitly by the parent, never retried. */
/** @param {readonly string[]} args @param {{allowWorker?: boolean, allowResume?: boolean}} [options] */
export function overtimeBrowserTarget(args, {allowWorker = false, allowResume = false} = {}) {
  let attempt;
  let heldLockWorker = false;
  let resume = false;
  for (const arg of args) {
    if (allowWorker && arg === '--held-lock-worker' && !heldLockWorker) {
      heldLockWorker = true;
    } else if (allowResume && arg === '--resume' && !resume) {
      resume = true;
    } else if (/^--attempt=b[1-9][0-9]?$/.test(arg) && attempt === undefined) {
      attempt = arg.slice('--attempt='.length);
    } else {
      throw new Error('Use one bounded --attempt=b1 through b99; resume and worker flags require their explicit coordinator permission.');
    }
  }
  return Object.freeze({
    attempt,
    heldLockWorker,
    resume,
    childArgs: attempt === undefined ? [] : ['--attempt=' + attempt],
    database: attempt === undefined ? 'ai_hr_board16_overtime_browser' : 'ai_hr_board16_ot_' + attempt,
    namespace: attempt === undefined ? 'board16overtimebrowser' : 'board16ot_' + attempt,
    scratchpad: attempt === undefined ? 'scratchpad/board16-overtime-browser' : 'scratchpad/board16-overtime-' + attempt,
    port: '3210',
  });
}
