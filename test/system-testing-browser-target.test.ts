import {describe,it,expect} from 'vitest';
import {SYSTEM_TESTING_BROWSER_TARGET,systemTestingBrowserOptions} from '../scripts/system-testing-browser-target.mjs';

describe('closed System Testing browser preparation target',()=>{
 it('has one named isolated target and no caller-selected URL/database',()=>{
  expect(SYSTEM_TESTING_BROWSER_TARGET).toEqual({database:'ai_hr_board19_profile_testing_browser',namespace:'b19profiletesting',port:'3231',scratchpad:'scratchpad/board19-profile-testing'});
<<<<<<< HEAD
  for(const args of [['--database=production'],['--port=3000'],['--reset'],['--resume'],['--attempt=other'],['--review-required','--review-required']])expect(()=>systemTestingBrowserOptions(args)).toThrow();
=======
  for(const args of [['--database=production'],['--port=3000'],['--reset'],['--resume'],['--attempt=other'],['--review-required','--review-required'],['--continue-observations','--continue-observations'],['--review-required','--continue-observations']])expect(()=>systemTestingBrowserOptions(args)).toThrow();
>>>>>>> 2dbe77d44 (test: prepare shared Profile and Testing browser fixture)
 });
 it('exposes the held worker only to the coordinator parser and keeps missing-evidence mode explicit',()=>{
  expect(systemTestingBrowserOptions([])).toEqual({heldLockWorker:false,reviewRequired:false,continueObservations:false});
  expect(systemTestingBrowserOptions(['--review-required'])).toEqual({heldLockWorker:false,reviewRequired:true,continueObservations:false});
  expect(systemTestingBrowserOptions(['--continue-observations'])).toEqual({heldLockWorker:false,reviewRequired:false,continueObservations:true});
  expect(()=>systemTestingBrowserOptions(['--held-lock-worker'])).toThrow();
  expect(systemTestingBrowserOptions(['--held-lock-worker','--review-required'],{allowWorker:true})).toEqual({heldLockWorker:true,reviewRequired:true,continueObservations:false});
  expect(systemTestingBrowserOptions(['--held-lock-worker','--continue-observations'],{allowWorker:true})).toEqual({heldLockWorker:true,reviewRequired:false,continueObservations:true});
 });
});
