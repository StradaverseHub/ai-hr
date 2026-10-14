import { describe,expect,it } from 'vitest';
import { readManagerCommand,type ManagerCommandFacts } from '../packs/performance/onehr/manager-command-model';
const facts:ManagerCommandFacts={stage:'moderation',self:false,manager:true,moderator:false,finalized:false,kpis:[{id:'delivery',title:'Delivery'}],competencyStatus:'submitted',plan:{id:'plan',status:'shared',goals:[{id:'facilitation',area:'Facilitation'}]}};
describe('explicit human reviewer instructions',()=>{
 it('confirms only the named pending item or an explicit whole-assessment instruction',()=>{
  expect(readManagerCommand('Confirm KPI: Delivery',facts)).toEqual({action:'confirm_kpi',id:'delivery'});expect(readManagerCommand('Please confirm all KPI results.',facts)).toEqual({action:'confirm_performance'});
  expect(readManagerCommand('Someone said "Confirm KPI: Delivery" but I have not decided.',facts)).toBeNull();expect(readManagerCommand('Consider confirming KPI: Delivery',facts)).toBeNull();expect(()=>readManagerCommand('Confirm KPI: Another person',facts)).toThrow(/assigned/);
  expect(()=>readManagerCommand('Confirm KPI: Delivery',{...facts,self:true})).toThrow(/assigned reviewer/);expect(()=>readManagerCommand('Confirm KPI: Delivery',{...facts,finalized:true})).toThrow(/read-only/);
 });
 it('resolves a literal KPI name ending in a period before treating punctuation as sentence ending',()=>{
  expect(readManagerCommand('Confirm KPI: Delivery.',facts)).toEqual({action:'confirm_kpi',id:'delivery'});
  expect(readManagerCommand('Confirm KPI: Delivery.',{...facts,kpis:[...facts.kpis,{id:'period-name',title:'Delivery.'}]})).toEqual({action:'confirm_kpi',id:'period-name'});
 });
 it('keeps approval in the correct manager stage and rejects an unsubmitted assessment',()=>{
  expect(readManagerCommand('Approve competency review.',{...facts,stage:'competency'})).toEqual({action:'approve_competencies'});
  for(const patch of [{stage:'career'},{manager:false,moderator:true},{competencyStatus:'pending'}])expect(()=>readManagerCommand('Approve competency review.',{...facts,stage:'competency',...patch})).toThrow(/approval/);
 });
 it('preserves literal reviewer comments and leaves the overall plan remark with the line manager',()=>{
  const career={...facts,stage:'career'};
  expect(readManagerCommand('Goal comment: Facilitation: Practise with the next workshop.',career)).toEqual({action:'comment_goal',id:'facilitation',text:'Practise with the next workshop.'});
  expect(readManagerCommand('Career comment: Consider an operational leadership role.',{...career,plan:null,manager:false,moderator:true})).toEqual({action:'comment_career',text:'Consider an operational leadership role.'});
  expect(()=>readManagerCommand('Plan comment: Agreed actions.',{...career,manager:false,moderator:true})).toThrow(/line manager/);
  expect(()=>readManagerCommand('Goal comment: Facilitation: Agreed.',{...career,plan:{...career.plan!,status:'closed'}})).toThrow(/shared, open/);
 });
 it('uses the canonical overall-plan owner fallback for an assigned matrix reviewer',()=>{
  const career={...facts,stage:'career',manager:false,moderator:true,planRemarkWriter:true};
  expect(readManagerCommand('Plan comment: Agreed actions.',career)).toEqual({action:'comment_plan',text:'Agreed actions.'});
  expect(()=>readManagerCommand('Plan comment: Agreed actions.',{...career,manager:true,moderator:false,planRemarkWriter:false})).toThrow(/eligible line manager/);
 });
 it('closes only a shared plan, keeping an optional date and the human’s own conversation note',()=>{
  expect(readManagerCommand('Close development plan on 2026-10-13: Discussed the planned learning actions.',{...facts,stage:'career'})).toEqual({action:'close_plan',heldOn:'2026-10-13',text:'Discussed the planned learning actions.'});
  expect(()=>readManagerCommand('Close development plan on 2026-02-30: Agreed.',{...facts,stage:'career'})).toThrow();
  expect(()=>readManagerCommand('Close development plan.',{...facts,stage:'career',plan:null})).toThrow(/shared, open/);
 });
});
