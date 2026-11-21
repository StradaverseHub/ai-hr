import {describe,expect,it} from 'vitest';
import {probationLetterBuilderContent,probationLetterConversionReport,probationLetterMergeGroups,probationLetterSampleValues} from '../lib/probation-letter-builder';
import {newProbationLetterTemplate,PROBATION_LETTER_KEYS} from '../lib/probation-letter-template';

describe('canonical Probation letter builder projection',()=>{
 it('offers every registered field once and supplies labelled fictional values before case intake',()=>{
  const fields=probationLetterMergeGroups.flatMap(group=>group.fields.map(field=>field.key));
  expect(fields).toHaveLength(PROBATION_LETTER_KEYS.length);
  expect([...fields].sort()).toEqual([...PROBATION_LETTER_KEYS].sort());
  for(const key of fields)expect(probationLetterSampleValues[key as keyof typeof probationLetterSampleValues].trim(),key).not.toBe('');
  expect(probationLetterSampleValues.employeeName).toBe('Alex Tan (sample)');
  expect(probationLetterSampleValues.employeeCode).toBe('SAMPLE-001');
 });
 it('preserves blocks, fields, tokens and identities without mutating stored versions',()=>{
  const original=newProbationLetterTemplate('confirm','letter','Confirm');
  original.blocks[2].text='Dear {employeeName}: {unsupported.retained}';
  original.fields=[{id:'answer',label:'HR comment',type:'text',owner:'hr',pmKey:null,required:false,sensitive:false,options:[],section:'main',when:null}];
  const frozen=structuredClone(original),view=probationLetterBuilderContent(original);
  expect(view).toEqual({blocks:frozen.blocks,fields:frozen.fields});
  view.blocks[2].text='Edited draft';view.fields[0].label='Edited label';
  expect(original).toEqual(frozen);
  const report=probationLetterConversionReport(original,7,{});
  expect(report.version).toBe(7);
  expect(report.fields).toEqual([{key:'employeeName',supported:true},{key:'unsupported.retained',supported:false}]);
  expect(report.complete).toBe(false);
 });
 it('reports every old matching value, including archived and unknown values, without guessing by name',()=>{
  const template=newProbationLetterTemplate('extend','legacy','Legacy');
  template.rules={businessGroup:['parent-company'],businessUnit:['old-bu'],company:['company'],department:['old-department','archived-department'],grade:['17']};
  const report=probationLetterConversionReport(template,3,{
   businessGroup:[{id:'parent-company',name:'Same text',code:'NEW-BU'}],businessUnit:[{id:'old-bu',name:'Same text'}],company:[{id:'company',name:'Company'}],department:[{id:'new-department',name:'old-department'},{id:'archived-department',name:'Archived',archived:true}],grade:[{id:'grade-uuid',name:'17',code:'JG17'}],
  });
  expect(report.matching.map(row=>[row.dimension,row.value,row.status,row.proposedId])).toEqual([
   ['businessGroup','parent-company','reviewRequired',null],['businessUnit','old-bu','reviewRequired',null],['company','company','sameIdentity','company'],['department','old-department','reviewRequired',null],['department','archived-department','archived','archived-department'],['grade','17','reviewRequired',null],
  ]);
  expect(report.signing).toEqual([{stepId:'pbp',role:'pbp',source:'Probation People Business Partner holder',requiresReview:true},{stepId:'employee',role:'employee',source:'Probation employee',requiresReview:false}]);
  expect(template.rules.businessGroup).toEqual(['parent-company']);
 });
 it('reports canonical identity matches while keeping recorded grade distinct from current names',()=>{
  const template={...newProbationLetterTemplate('confirm','canonical','Canonical'),organisationMapping:'personnel-v2' as const};
  template.rules={businessGroup:['bu-id'],grade:['recorded-grade']};
  const report=probationLetterConversionReport(template,1,{businessGroup:[{id:'bu-id',code:'BU17',name:'Business Unit'}],grade:[{id:'recorded-grade',code:'JG17',name:'Grade seventeen'}]});
  expect(report.matching.map(row=>row.proposedCode)).toEqual(['BU17','JG17']);
 });
});
