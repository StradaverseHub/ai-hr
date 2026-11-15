/** Approval routing on the Probation form version (lane E, handoff B3): model rules. Fictional data only. */
import {describe,expect,it} from 'vitest';
import {DEFAULT_PROBATION_FORM,defaultProbationApprovals,probationApprovalChain,probationApprovalIssues,validateProbationForm,type ProbationForm} from '../lib/probation-form';
const form=(patch:Partial<ProbationForm>):ProbationForm=>({...structuredClone(DEFAULT_PROBATION_FORM),...patch});
describe('form approval routing',()=>{
 it('defaults to today\'s route: Part 3 to the Head of Department, then the People Business Partner, both approve and sign',()=>{
  expect(DEFAULT_PROBATION_FORM.approvals).toEqual(defaultProbationApprovals());
  expect(defaultProbationApprovals()['3'].map(row=>[row.order,row.who,row.action])).toEqual([[1,'hod','approve_sign'],[2,'pbp','approve_sign']]);
  expect(probationApprovalIssues(DEFAULT_PROBATION_FORM)).toEqual([]);expect(()=>validateProbationForm(DEFAULT_PROBATION_FORM)).not.toThrow();
 });
 it('runs rows by order, and rows sharing an order in the order listed',()=>{
  const rows=[{id:'pbp',order:2,action:'approve_sign' as const,who:'pbp'},{id:'hod',order:1,action:'approve_sign' as const,who:'hod'}];
  expect(probationApprovalChain(rows).map(row=>row.who)).toEqual(['hod','pbp']);
  expect(probationApprovalChain([{...rows[0],order:1},rows[1]]).map(row=>row.who)).toEqual(['pbp','hod']);
 });
 it('keeps versions saved before form routing on the route configuration',()=>{
  const legacy=form({});delete legacy.approvals;expect(probationApprovalIssues(legacy)).toEqual([]);expect(()=>validateProbationForm(legacy)).not.toThrow();
 });
 it('refuses what the signing runtime cannot run, a Part 3 with no approver, and a role twice in one Part',()=>{
  const approvals=defaultProbationApprovals();
  for(const who of ['superior','routing:fictional-routing','group:fictional-group','user:00000000-0000-4000-8000-000000000001'])
   expect(()=>validateProbationForm(form({approvals:{...approvals,'2':[{id:'extra',order:1,action:'approve_sign',who}]}}))).toThrow(/Head of Department or the People Business Partner/);
  expect(()=>validateProbationForm(form({approvals:{...approvals,'3':[{...approvals['3'][0],action:'review'}]}}))).toThrow(/approve and sign/);
  expect(()=>validateProbationForm(form({approvals:{...approvals,'3':[]}}))).toThrow(/Part 3 needs at least one approval step/);
  expect(probationApprovalIssues(form({approvals:{...approvals,'3':[approvals['3'][0],{...approvals['3'][1],id:'hod_again',who:'hod'}]}}))).toContain('3:hod_again:who_duplicate');
  expect(probationApprovalIssues(form({approvals:{...approvals,'3':[{...approvals['3'][0],order:10}]}}))).toContain('3:hod:order');
  expect(probationApprovalIssues(form({duplicateRolePolicy:{mode:'named_alternate',alternateUserId:null}}))).toContain('policy:alternate');
 });
});
