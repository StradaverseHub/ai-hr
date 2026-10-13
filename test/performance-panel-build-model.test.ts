import { describe, expect, it } from 'vitest';
import { additivePanelPlan, buildPanelCandidates, type PanelPerson } from '../packs/performance/onehr/panel-build-model';
const person=(id:string,patch:Partial<PanelPerson>={}):PanelPerson=>({id,personId:id,code:id,name:id,companyId:'company',groupId:'group',department:'Operations',grade:12,service:2,joinedOn:'2020-01-01',managerId:null,participates:false,...patch});
const population=[person('subject',{participates:true,managerId:'manager'}),person('manager'),person('older-report',{managerId:'subject',service:4}),person('newer-report',{managerId:'subject',service:3}),person('third-report',{managerId:'subject',service:1}),person('peer-1',{managerId:'manager',service:1}),person('peer-2',{managerId:'manager',grade:20,service:2}),person('tier-2',{service:10,grade:13}),person('other-department',{managerId:'manager',department:'Finance',service:20})];
describe('source bulk-panel selection and preservation',()=>{
 it('chooses one manager, longest-staying direct reports and same-manager peers before broader peers',()=>{
  const [panel]=buildPanelCandidates(population);
  expect(panel.members.map(m=>[m.employmentId,m.relationship])).toEqual([['manager','line_manager'],['older-report','direct_report'],['newer-report','direct_report'],['peer-2','peer'],['peer-1','peer']]);
  expect(panel).toMatchObject({directAvailable:3,managerStatus:'ok'});
 });
 it('allows unconfirmed assessors, seeds peer workloads and excludes other departments',()=>{
  const load={'peer-2':10};const [panel]=buildPanelCandidates(population,5,load);
  expect(panel.members.filter(m=>m.relationship==='peer').map(m=>m.employmentId)).toEqual(['peer-1','tier-2']);expect(load).toEqual({'peer-2':10});
  expect(panel.members.some(m=>m.employmentId==='other-department')).toBe(false);
 });
 it('keeps letter-grade subjects manager-only and never uses letter-grade or unavailable staff as assessors',()=>{
  const people=population.map(p=>p.id==='subject'?{...p,grade:null}:p.id==='peer-2'?{...p,grade:null}:p);
  expect(buildPanelCandidates(people)[0].members.map(m=>m.employmentId)).toEqual(['manager']);
  const [panel]=buildPanelCandidates(population.map(p=>p.id==='manager'?{...p,canAssess:false}:p));
  expect(panel.managerStatus).toBe('ineligible_lm_grade');expect(panel.members.some(m=>m.employmentId==='manager')).toBe(false);expect(panel.members).toHaveLength(4);
 });
 it('applies small configured caps and never re-adds archived pairs or a second manager',()=>{
  const [candidate]=buildPanelCandidates(population,1);expect(additivePanelPlan(candidate,[],'missing',1).add.map(m=>m.employmentId)).toEqual(['manager']);
  const plan=additivePanelPlan(candidate,[{employmentId:'manager',relationship:'line_manager',archived:true,submitted:false},{employmentId:'old-manager',relationship:'line_manager',archived:false,submitted:false}],'topup',5);
  expect(plan.add.some(m=>m.relationship==='line_manager')).toBe(false);expect(plan.add.some(m=>m.employmentId==='manager')).toBe(false);
 });
 it('preserves panels with submitted feedback, release or finalization and distinguishes build from top-up',()=>{
  const [candidate]=buildPanelCandidates(population),existing=[{employmentId:'manager',relationship:'line_manager',archived:false,submitted:true}];
  expect(additivePanelPlan(candidate,existing,'topup',5)).toMatchObject({status:'started',add:[]});
  expect(additivePanelPlan(candidate,[{...existing[0],submitted:false}],'topup',5,true)).toMatchObject({status:'released',add:[]});
  expect(additivePanelPlan(candidate,[],'missing',5,false,true)).toMatchObject({status:'finalized',add:[]});
  expect(additivePanelPlan(candidate,existing,'missing',5)).toMatchObject({status:'has_panel',add:[]});
  expect(additivePanelPlan(candidate,[],'topup',5)).toMatchObject({status:'has_panel',add:[]});
 });
 it('keeps native person identity distinct from employment when a person holds multiple jobs',()=>{
  const [candidate]=buildPanelCandidates([...population,person('self-other-job',{personId:'subject',managerId:'manager'}),person('peer-1-other-job',{personId:'peer-1',managerId:'manager',service:0})]);
  expect(candidate.members.some(m=>m.personId==='subject')).toBe(false);expect(new Set(candidate.members.map(m=>m.personId)).size).toBe(candidate.members.length);
  const plan=additivePanelPlan(candidate,[{employmentId:'peer-old-job',personId:'peer-1',relationship:'peer',archived:true,submitted:false}],'missing',5);
  expect(plan.add.some(m=>m.personId==='peer-1')).toBe(false);
 });
});
