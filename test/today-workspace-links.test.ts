/**
 * "Your workspace" on Employee Today and Manager Today (owner decision, 12 Nov 2026): the links that replace the old
 * team workbench and the old personal Home under a partner's Today. Each is offered only when the page it opens would
 * admit the person, by that page's own check, and only for a module in use; nothing here grants access.
 */
import {describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {workspaceLinksFor} from '../lib/today/workspace';

const as=(...roles:string[]):SessionContext=>({tenantId:'fictional-tenant',userId:'fictional-login',roles,grants:roles.map(role=>({role,companyId:null}))} as SessionContext);
const all=()=>true;
const hrefs=(s:SessionContext,team:boolean,moduleOn:(code:string)=>boolean=all)=>workspaceLinksFor(s,{team,moduleOn}).map(link=>link.href);

describe('workspaceLinksFor',()=>{
 it('offers a manager the team pages the retired workbench led to',()=>{
  expect(hrefs(as('manager'),true)).toEqual(['/manage/my-team','/approvals','/leave/tracker?calendar=1']);
 });
 it('offers someone who manages through a reporting line only the pages their roles open',()=>{
  // No manager role: My Team (requireTeamAccess) and the Approvals rail rule would refuse them.
  expect(hrefs(as('employee'),true)).toEqual(['/leave/tracker?calendar=1']);
 });
 it('offers a payroll partner their own payroll pages and a performance partner the performance administration',()=>{
  expect(hrefs(as('employee','payroll_partner'),false)).toEqual(['/payroll/payslip-information','/payroll/income-tax-recalculation']);
  expect(hrefs(as('employee','performance_partner'),false)).toEqual(['/performance']);
  expect(hrefs(as('employee','performance_comp_partner'),false)).toEqual(['/performance']);
 });
 it('offers a partner who manages a team both groups',()=>{
  expect(hrefs(as('manager','payroll_partner'),true)).toEqual(['/manage/my-team','/approvals','/leave/tracker?calendar=1',
   '/payroll/payslip-information','/payroll/income-tax-recalculation']);
 });
 it('offers a plain employee nothing, and never the old dashboard or an administrator-only page',()=>{
  expect(hrefs(as('employee'),false)).toEqual([]);
  for(const roles of [['manager'],['employee','payroll_partner'],['employee','performance_partner'],['manager','performance_comp_partner']]){
   for(const href of hrefs(as(...roles),true)){
    expect(href).not.toContain('workspace=');
    expect(href.startsWith('/control-tower')).toBe(false);
   }
  }
 });
 it('drops a link whose module is not in use',()=>{
  const without=(off:string)=>(code:string)=>code!==off;
  expect(hrefs(as('manager'),true,without('leave'))).toEqual(['/manage/my-team','/approvals']);
  expect(hrefs(as('employee','payroll_partner'),false,without('payroll'))).toEqual([]);
  expect(hrefs(as('employee','performance_partner'),false,without('performance'))).toEqual([]);
 });
 it('follows the company-scoped grant, not the flattened role list',()=>{
  const scoped={...as('employee','payroll_partner'),grants:[{role:'employee',companyId:null},{role:'payroll_partner',companyId:'fictional-company'}]} as SessionContext;
  expect(hrefs(scoped,false)).toEqual(['/payroll/payslip-information','/payroll/income-tax-recalculation']);
  const noGrant={...as('employee'),roles:['employee','payroll_partner']} as SessionContext;
  expect(hrefs(noGrant,false)).toEqual([]);
 });
});
