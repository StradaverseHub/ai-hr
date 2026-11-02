import {describe,it,expect} from 'vitest';
import {effectiveProbationSettings} from '../lib/probation-configuration';
import {DEFAULT_PROBATION_CONFIG} from '../lib/probation-model';
import {DEFAULT_PROBATION_FORM,scoreProbationForm,validateProbationForm} from '../lib/probation-form';
import {probationWorkflowIssues,renderProbationWords,type ProbationWorkflow} from '../lib/probation-workflow';
describe('published probation policy',()=>{
 it('matches BG, distinct BU, grade and plan length without changing the employee period',()=>{
  const settings={...DEFAULT_PROBATION_CONFIG,overrides:[{businessGroupId:'bg',kpiGate:'warn' as const},{businessGroupId:'bg',grade:'12',months:3,kpiGate:'off' as const},{businessGroupId:'bg',grade:'12',months:3,kpiGate:'block' as const}]};
  expect(effectiveProbationSettings(settings,{businessGroupId:'bg',businessUnitId:'bu',grade:'12'},3)).toMatchObject({kpiGate:'block',defaultMonths:settings.defaultMonths});
  expect(effectiveProbationSettings(settings,{businessGroupId:'bg',businessUnitId:'bg',grade:'12'},6).kpiGate).toBe('warn');
  expect(effectiveProbationSettings({...settings,overrides:[{businessUnitId:'bu',kpiGate:'off'}]},{businessGroupId:'bu',businessUnitId:null,grade:'12'},3).kpiGate).toBe(DEFAULT_PROBATION_CONFIG.kpiGate);
 });
 it('does not show a total for an unrated configurable criterion and preserves integer weighted results',()=>{
  validateProbationForm(DEFAULT_PROBATION_FORM);const assessment=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:5,evidence:''}]));expect(scoreProbationForm(DEFAULT_PROBATION_FORM,assessment)?.hundredths).toBe(500);expect(scoreProbationForm(DEFAULT_PROBATION_FORM,{...assessment,kpi:{rating:null,evidence:''}})).toBeNull();
 });
 it('bounds authored text and recipients and accepts only supported merge fields',()=>{
  const workflow:ProbationWorkflow={id:'review',name:'Review',module:'probation',status:'published',description:'Current pending reviewer',trigger:{event:'review_reminder'},conditions:{},steps:[{id:'message',type:'notify',subject:'Review for {{employeeName}}',body:'Complete Part {{part}} by {{dueOn}}.',to:['lm']}]};
  expect(probationWorkflowIssues(workflow)).toEqual([]);expect(renderProbationWords(workflow.steps[0].subject,{employeeName:'Fictional Employee'})).toBe('Review for Fictional Employee');
  expect(probationWorkflowIssues({...workflow,steps:[{...workflow.steps[0],subject:'Bad\r\nBcc: external',body:'{{salary}}'}]})).not.toEqual([]);
 });
});
