import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {leaveSelfReturnUrl} from '../lib/leave-return-context';
const source=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const id='22222222-2222-4222-8222-222222222222';
describe('own Leave navigation is explicit and never an on-behalf authority',()=>{
 it('retains only safe selected own context and fixed destinations',()=>{
  const form=new FormData();form.set('ownSelectedEmploymentId',id);form.set('leaveContext','target=https://evil.invalid&employmentId='+id);
  expect(leaveSelfReturnUrl(form,'toast','Saved & reviewed')).toBe('/leave?employmentId='+id+'&toast=Saved+%26+reviewed');
  form.set('leaveOrigin','history');form.set('leaveContext','employmentId='+id+'&hTab=approved&target=https://evil.invalid');
  expect(leaveSelfReturnUrl(form,'error','Try again')).toBe('/leave/history?employmentId='+id+'&hTab=approved&error=Try+again');
 });
 it('keeps no-query HR landing and binds every selected-own live request/claim path before its owner',()=>{
  const page=source('app/leave/page.tsx');expect(page).toContain('if (me == null || (admin && !selectedOwn)) {');expect(page).toContain('ownLiveEmployment(session, sp.employmentId)');expect(page).toContain('fixedOwnEmploymentId={selectedOwn?.employmentId}');
  for(const name of ['selectedOwnSubmitLeaveCreditAction','selectedOwnLeaveCreditDayFactsAction','selectedOwnLeaveCreditClaimReviewAction'])expect(page).toContain(name+'.bind(null,selectedOwn.employmentId)');
  const actions=source('app/leave/credit/actions.ts');expect(actions).toContain('selectedOwnLeaveSubject(session,selectedOwnId)');expect(actions).toContain("form.set('ownSelectedEmploymentId',employmentId)");
  expect(source('app/leave/actions.ts')).toContain('!own.some(subject => subject.employmentId === employmentId)');
  expect(source('components/leave/own-leave-history.tsx')).toContain("['employmentId', sp.employmentId]");
 });
});
