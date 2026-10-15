import {defaultMasterColumn,runEmployeeMasterProjection,validateEmployeeMasterSpec,type EmployeeMasterSpec} from '../lib/employee-master-report';
import {describe,it,expect} from 'vitest';
import {personnelChildReliefValue,personnelReportValueKey,type PersonnelChildReliefCell} from '../lib/personnel-report-value';
import {PERSONNEL_FIELDS,type PersonnelFieldDescriptor} from '../lib/personnel-field-registry';
describe('report statutory child relief grid facts',()=>{
 it('keeps all ten category/share cells distinct and preserves recorded zero',()=>{
  const categories:PersonnelChildReliefCell['category'][]=['under_18','study_preu','study_tertiary','disabled','disabled_study'];
  const keys=new Set<string>();let count=0;
  for(const category of categories)for(const share of ['full','half'] as const){const descriptor={...PERSONNEL_FIELDS[0],id:'bank_statutory.income_tax_pcb.childrelieftable_'+category+'_'+share,owner:'statutory',ownerField:'childReliefTable',childReliefCell:{category,share}} as PersonnelFieldDescriptor;keys.add(personnelReportValueKey(descriptor));expect(personnelChildReliefValue({[category]:{[share]:count}},{category,share}).value).toBe(count++);}
  expect(keys.size).toBe(10);
 });
 it('never substitutes current grid counts into a historical report or permits their past-date condition',()=>{
  const today='2026-10-15',descriptor={...PERSONNEL_FIELDS[0],id:'bank_statutory.income_tax_pcb.childrelieftable_under_18_full',owner:'statutory',ownerField:'childReliefTable',type:'number',history:'current',scope:'employment',childReliefCell:{category:'under_18',share:'full'}} as PersonnelFieldDescriptor;
  const company='11111111-1111-4111-8111-111111111111',spec:EmployeeMasterSpec={v:2,asAt:'2026-10-14',companyIds:[company],includeDrafts:false,columns:[defaultMasterColumn(descriptor)],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
  const result=runEmployeeMasterProjection(spec,[descriptor],[{id:'employment',kind:'employment',personId:'person',companyId:company,owners:{statutory:[{id:'statutory',values:{[descriptor.id]:{value:3}}}]}}],today);
  expect(result.sections[0].rows[0].cells[0]).toMatchObject({value:null,unavailable:'historical-unavailable'});
  expect(()=>validateEmployeeMasterSpec({...spec,expression:{id:'root',type:'group',logic:'and',children:[{id:'count',type:'condition',field:descriptor.id,operator:'eq',value:3}]}},[descriptor],today)).toThrow('current-only');
 });
 it('does not manufacture zero from an absent, unmaintained or malformed table/cell',()=>{
  for(const table of [null,undefined,{},[],{under_18:{}},{under_18:{full:'0'}},{under_18:{full:-1}},{under_18:{full:0.5}}])expect(personnelChildReliefValue(table,{category:'under_18',share:'full'})).toMatchObject({value:null,unavailable:'not-recorded'});
 });
});
