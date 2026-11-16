/** Approval routing on the Probation form version (lane E, handoff B3): model rules. Fictional data only. */
import {describe,expect,it} from 'vitest';
import {DEFAULT_PROBATION_FORM,defaultProbationApprovals,probationApprovalChain,probationApprovalIssues,validateProbationForm,type ProbationApprovalRow,type ProbationForm} from '../lib/probation-form';
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
 it('accepts routings, groups, named people and the Direct Superior with Review, Approve or Approve and sign (5756)',()=>{
  const approvals=defaultProbationApprovals();
  const choices:[string,Partial<ProbationApprovalRow>][]=[['superior',{}],['routing:00000000-0000-4000-8000-0000000000a1',{pick:'roundRobin'}],['group:fictional-group',{pick:'any'}],['people',{userIds:['00000000-0000-4000-8000-000000000001']}]];
  for(const [who,extra] of choices)
   for(const action of ['review','approve','approve_sign'] as const)
    expect(()=>validateProbationForm(form({approvals:{...approvals,'2':[{id:'extra',order:1,action,who,...extra}]}}))).not.toThrow();
  expect(probationApprovalIssues(form({approvals:{...approvals,'2':[{id:'extra',order:1,action:'approve',who:'routing:not-a-routing-id'}]}}))).toContain('2:extra:who');
  expect(probationApprovalIssues(form({approvals:{...approvals,'2':[{id:'extra',order:1,action:'approve',who:'hod',pick:'any'}]}}))).toContain('2:extra:pick');
  expect(probationApprovalIssues(form({approvals:{...approvals,'2':[{id:'employee',order:1,action:'approve',who:'superior'}]}}))).toContain('2:id');
  expect(()=>validateProbationForm(form({approvals:{...approvals,'2':[{id:'extra',order:1,action:'approve',who:'people',userIds:[]}]}}))).toThrow(/between 1 and 20/);
 });
 it('refuses a Part 3 with no approver, and a role, routing, group or the same people twice in one Part',()=>{
  const approvals=defaultProbationApprovals();
  expect(()=>validateProbationForm(form({approvals:{...approvals,'3':[]}}))).toThrow(/Part 3 needs at least one Approve/);
  expect(()=>validateProbationForm(form({approvals:{...approvals,'3':[{...approvals['3'][0],action:'review'}]}}))).toThrow(/Part 3 needs at least one Approve/);
  expect(probationApprovalIssues(form({approvals:{...approvals,'3':[approvals['3'][0],{...approvals['3'][1],id:'hod_again',who:'hod'}]}}))).toContain('3:hod_again:who_duplicate');
  const people={action:'approve' as const,who:'people',userIds:['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001']};
  expect(probationApprovalIssues(form({approvals:{...approvals,'3':[{...people,id:'a',order:1},{...people,id:'b',order:2,userIds:[...people.userIds].reverse()}]}}))).toContain('3:b:who_duplicate');
  expect(probationApprovalIssues(form({approvals:{...approvals,'3':[{...approvals['3'][0],order:10}]}}))).toContain('3:hod:order');
  expect(probationApprovalIssues(form({duplicateRolePolicy:{mode:'named_alternate',alternateUserId:null}}))).toContain('policy:alternate');
 });
});
