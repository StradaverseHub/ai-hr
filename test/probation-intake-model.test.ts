import {describe,it,expect} from 'vitest';
import {createProbationCase,DEFAULT_PROBATION_CONFIG} from '../lib/probation-model';
import {probationCutoverDates,probationCutoverWorkflowMatches} from '../lib/probation-intake-model';
import type {ProbationWorkflow} from '../lib/probation-workflow';
describe('conditional probation cutover rehearsal',()=>{
 it('exports the entire date set without post-due reminders and never replays completed offline work',()=>{
  let n=0;const record=createProbationCase({id:'case',employmentId:'employment',companyId:'company',sourceKey:'source',startOn:'2026-01-01',endOn:'2026-06-30',months:6,grade:'12',explicitNoProbation:false,config:DEFAULT_PROBATION_CONFIG,nextId:()=>String(++n),isWorking:()=>true})!;
  record.parts[0].state='completed_offline';const dates=probationCutoverDates(record,{kpiReminderOn:'2026-01-03',kpiOverdueOn:'2026-01-07'});expect(dates.some(d=>d.part.type===1)).toBe(false);
  for(const part of record.parts.filter(p=>p.type!==1)){const reminders=dates.filter(d=>d.part.id===part.id&&d.event==='review_reminder');expect(reminders).toHaveLength(9);expect(reminders.every(d=>d.dueOn<=part.dueOn)).toBe(true);expect(new Set(reminders.map(d=>d.dueOn)).size).toBe(9);}
 });
 it('keeps actual BG and BU separate in matching conditions',()=>{
  const workflow:ProbationWorkflow={id:'w',name:'w',module:'probation',status:'published',description:'',trigger:{event:'review_due'},conditions:{businessGroupId:'bg',businessUnitId:'bu',part:3},steps:[]};
  expect(probationCutoverWorkflowMatches(workflow,{companyId:'co',businessGroupId:'bg',businessUnitId:'bu',departmentId:null,grade:'12'},3)).toBe(true);
  expect(probationCutoverWorkflowMatches(workflow,{companyId:'co',businessGroupId:'bu',businessUnitId:'bg',departmentId:null,grade:'12'},3)).toBe(false);
 });
});
