/** Closed disposable System Testing target, never selected through a caller URL or generic DB name. */
export const SYSTEM_TESTING_BROWSER_TARGET=Object.freeze({database:'ai_hr_board16_system_testing_browser',namespace:'b16systemtesting',port:'3214',scratchpad:'scratchpad/board16-system-testing'});
export function systemTestingBrowserOptions(args,{allowWorker=false}={}) {
  const seen=new Set();for(const arg of args){if(seen.has(arg)||!(arg==='--review-required'||allowWorker&&arg==='--held-lock-worker'))throw new Error('Only --review-required and the guarded coordinator worker flag are supported.');seen.add(arg);}
  return Object.freeze({heldLockWorker:seen.has('--held-lock-worker'),reviewRequired:seen.has('--review-required')});
}
