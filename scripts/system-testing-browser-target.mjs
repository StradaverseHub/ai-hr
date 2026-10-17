/** Closed disposable System Testing target, never selected through a caller URL or generic DB name. */
export const SYSTEM_TESTING_BROWSER_TARGET=Object.freeze({database:'ai_hr_board19_profile_testing_browser',namespace:'b19profiletesting',port:'3231',scratchpad:'scratchpad/board19-profile-testing'});
export function systemTestingBrowserOptions(args,{allowWorker=false}={}) {
  const seen=new Set();for(const arg of args){if(seen.has(arg)||!(arg==='--review-required'||arg==='--continue-observations'||allowWorker&&arg==='--held-lock-worker'))throw new Error('Only --review-required, --continue-observations and the guarded coordinator worker flag are supported.');seen.add(arg);}
  if(seen.has('--review-required')&&seen.has('--continue-observations'))throw new Error('Continuation preserves observations with a newly prepared ready identity; missing-evidence mode is an independent initial run.');
  return Object.freeze({heldLockWorker:seen.has('--held-lock-worker'),reviewRequired:seen.has('--review-required'),continueObservations:seen.has('--continue-observations')});
}
