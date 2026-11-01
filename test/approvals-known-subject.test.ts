/** Whole-stack review H4 (claude/teras-review-fixes): pendingLeaveTaskMetadata batches assertCanDecide's subject lookup
 * and applies its role rules without a statement per request. decideByRoleForKnownSubject must give assertCanDecide's
 * answer for those rules and defer everything else. Pure; fictional ids. */
import {describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {decideByRoleForKnownSubject} from '../core/approvals';

const me='00000000-0000-4000-8000-0000000000a1',other='00000000-0000-4000-8000-0000000000a2';
const ctx=(roles:string[],personId:string|undefined=me)=>({tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb',personId,roles}) as SessionContext;

describe('decideByRoleForKnownSubject',()=>{
 it('refuses self-approval for everyone but a super_admin, as assertCanDecide does',()=>{
  for(const roles of [['hr_admin'],['manager'],['employee']])expect(decideByRoleForKnownSubject(ctx(roles),me),roles.join()).toBe('refused');
  expect(decideByRoleForKnownSubject(ctx(['super_admin']),me)).toBe('allowed');
 });
 it('allows an admin role for someone else',()=>{
  expect(decideByRoleForKnownSubject(ctx(['hr_admin']),other)).toBe('allowed');expect(decideByRoleForKnownSubject(ctx(['super_admin']),other)).toBe('allowed');
 });
 it('defers managers, delegates, employees and unknown subjects to assertCanDecide',()=>{
  for(const roles of [['manager'],['employee'],['payroll_partner']])expect(decideByRoleForKnownSubject(ctx(roles),other),roles.join()).toBeNull();
  expect(decideByRoleForKnownSubject(ctx(['hr_admin']),undefined)).toBeNull();
 });
 it('without a person binding, an admin is allowed and nobody is refused as self',()=>{
  expect(decideByRoleForKnownSubject(ctx(['hr_admin'],undefined),other)).toBe('allowed');expect(decideByRoleForKnownSubject(ctx(['manager'],undefined),other)).toBeNull();
 });
});
