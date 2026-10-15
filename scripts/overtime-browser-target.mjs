/** Closed local acceptance targets. An attempt is selected explicitly by the parent, never retried. */
/** @param {readonly string[]} args @param {{allowWorker?: boolean}} [options] */
export function overtimeBrowserTarget(args, {allowWorker = false} = {}) {
  let attempt;
  let heldLockWorker = false;
  for (const arg of args) {
    if (allowWorker && arg === '--held-lock-worker' && !heldLockWorker) {
      heldLockWorker = true;
    } else if (/^--attempt=b[1-9][0-9]?$/.test(arg) && attempt === undefined) {
      attempt = arg.slice('--attempt='.length);
    } else {
      throw new Error('Only one bounded --attempt=b1 through b99 and the coordinator worker flag are supported.');
    }
  }
  return Object.freeze({
    attempt,
    heldLockWorker,
    childArgs: attempt === undefined ? [] : ['--attempt=' + attempt],
    database: attempt === undefined ? 'ai_hr_board16_overtime_browser' : 'ai_hr_board16_ot_' + attempt,
    namespace: attempt === undefined ? 'board16overtimebrowser' : 'board16ot_' + attempt,
    scratchpad: attempt === undefined ? 'scratchpad/board16-overtime-browser' : 'scratchpad/board16-overtime-' + attempt,
    port: '3210',
  });
}
