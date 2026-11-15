/** Probation settings scope rules (decision 3; lib/probation-settings-scope.ts): pure resolution, overrides and preview. */
import {describe,expect,it} from 'vitest';
import {DEFAULT_PROBATION_CONFIG,createProbationCase,probationDueDay,validateProbationConfig,PROBATION_SETTINGS_FIELD_DEFAULTS} from '../lib/probation-model';
import {PROBATION_SCOPED_FIELDS,probationFieldSources,probationFieldValue,probationOverrideFields,probationScopeIssues,probationSettingsDifferences,probationStandardPreview,redundantProbationOverrides,resolveProbationSettings,sameProbationValue} from '../lib/probation-settings-scope';
import type {ProbationSettings} from '../core/probation';

const standard:ProbationSettings={...structuredClone(DEFAULT_PROBATION_CONFIG),...PROBATION_SETTINGS_FIELD_DEFAULTS,overrides:[]};

describe('group standard ⊕ company override',()=>{
 it('takes overridden fields from the company setting and every other field from the standard',()=>{
  const resolved=resolveProbationSettings(standard,{issueLeadDays:21,kpiGate:'warn'});
  expect(resolved).toMatchObject({issueLeadDays:21,kpiGate:'warn',defaultMonths:standard.defaultMonths,plans:standard.plans,eligibleGrades:standard.eligibleGrades});
  expect(standard.issueLeadDays).toBe(30);
  const later=resolveProbationSettings({...standard,defaultMonths:3,issueLeadDays:45},{issueLeadDays:21});
  expect(later).toMatchObject({defaultMonths:3,issueLeadDays:21});
 });
 it('ignores keys that are not settings fields and keeps the fixed extension rules',()=>{
  const resolved=resolveProbationSettings(standard,{issueLeadDays:14,maxExtensions:1,extensionMonths:[1]} as never);
  expect(resolved).toMatchObject({issueLeadDays:14,maxExtensions:2,extensionMonths:[3,6]});
  expect(probationOverrideFields({issueLeadDays:14,maxExtensions:1} as never)).toEqual(['issueLeadDays']);
  expect(PROBATION_SCOPED_FIELDS).not.toContain('maxExtensions');
 });
 it('flags an override equal to the standard so it can be removed',()=>{
  expect(redundantProbationOverrides(standard,{issueLeadDays:30,kpiGate:'warn',plans:structuredClone(standard.plans)})).toEqual(['plans','issueLeadDays']);
  expect(redundantProbationOverrides(standard,{nonWorkingDayRule:'previous',fallbackGroupId:null})).toEqual(['nonWorkingDayRule','fallbackGroupId']);
 });
 it('compares values regardless of object key order and treats absent new fields as their defaults',()=>{
  expect(sameProbationValue({a:1,b:[1,2]},{b:[1,2],a:1})).toBe(true);
  expect(sameProbationValue([1,2],[2,1])).toBe(false);
  const legacy={...structuredClone(DEFAULT_PROBATION_CONFIG)} as ProbationSettings;
  expect(probationFieldValue(legacy,'nonWorkingDayRule')).toBe('previous');
  expect(probationFieldValue(legacy,'overrides')).toEqual([]);
  expect(probationSettingsDifferences(legacy,standard)).toEqual([]);
  expect(probationSettingsDifferences(legacy,{...standard,kpiGate:'off',lowBand:3})).toEqual(['kpiGate','lowBand']);
 });
 it('names where each resolved field came from',()=>{
  const sources=probationFieldSources({standardId:'s',standardVersion:3,overrideId:'o',overrideVersion:1,overrideKey:'k',overrideName:'Fiamma Retail',fields:['issueLeadDays']});
  expect(sources.issueLeadDays).toBe('override');expect(sources.kpiGate).toBe('standard');
  expect(probationFieldSources(undefined).kpiGate).toBe('company');
 });
});

describe('publish preview and checks',()=>{
 const companies=[{id:'a',name:'Alpha'},{id:'b',name:'Beta'},{id:'c',name:'Gamma'}];
 it('lists which companies pick up a standard change and which are shielded by an override',()=>{
  const preview=probationStandardPreview({current:standard,next:{...standard,issueLeadDays:45,kpiGate:'warn'},companies,members:[{companyId:'b',settingKey:'k',settingName:'Beta setting',fields:['issueLeadDays']},{companyId:'c',settingKey:'k2',settingName:'Gamma setting',fields:['lowBand']}]});
  expect(preview.changed).toEqual(['kpiGate','issueLeadDays']);
  expect(preview.rows).toEqual([
   {companyId:'a',companyName:'Alpha',settingName:null,pickedUp:['kpiGate','issueLeadDays'],shielded:[]},
   {companyId:'b',companyName:'Beta',settingName:'Beta setting',pickedUp:['kpiGate'],shielded:['issueLeadDays']},
   {companyId:'c',companyName:'Gamma',settingName:'Gamma setting',pickedUp:['kpiGate','issueLeadDays'],shielded:[]},
  ]);
  expect(probationStandardPreview({current:standard,next:standard,companies,members:[]}).changed).toEqual([]);
 });
 it('refuses a standard with companies, narrow rules or invalid values, and a company setting with no companies or fields',()=>{
  expect(probationScopeIssues({scope:'standard',name:'Group standard',companyIds:[],data:standard,standard:null})).toEqual([]);
  expect(probationScopeIssues({scope:'standard',name:'Group standard',companyIds:['a'],data:{...standard,overrides:[{kpiGate:'off'}]},standard:null})).toEqual(expect.arrayContaining(['standard_companies','standard_rules']));
  expect(probationScopeIssues({scope:'standard',name:' ',companyIds:[],data:{...standard,issueLeadDays:0},standard:null}).length).toBe(2);
  expect(probationScopeIssues({scope:'company',name:'Fiamma',companyIds:[],data:{},standard})).toEqual(expect.arrayContaining(['companies','no_overrides']));
  expect(probationScopeIssues({scope:'company',name:'Fiamma',companyIds:['a','a'],data:{kpiGate:'warn'},standard})).toContain('companies');
  expect(probationScopeIssues({scope:'company',name:'Fiamma',companyIds:['a'],data:{nonWorkingDayRule:'sideways'} as never,standard}).length).toBe(1);
  expect(probationScopeIssues({scope:'company',name:'Fiamma',companyIds:['a'],data:{issueLeadDays:21},standard})).toEqual([]);
 });
});

describe('due date on a non-working day',()=>{
 const weekdays=(day:string)=>![0,6].includes(new Date(day+'T00:00:00Z').getUTCDay());
 it('moves to the working day before by default and to the next working day when chosen',()=>{
  expect(probationDueDay('2026-11-21',weekdays)).toBe('2026-11-20');
  expect(probationDueDay('2026-11-21',weekdays,'next')).toBe('2026-11-23');
  expect(probationDueDay('2026-11-20',weekdays,'next')).toBe('2026-11-20');
 });
 it('plans review due dates with the published rule and validates the new fields',()=>{
  const plan=(rule:'previous'|'next')=>createProbationCase({id:'case',employmentId:'e',companyId:'c',sourceKey:'k',startOn:'2026-05-22',endOn:null,months:6,grade:'12',explicitNoProbation:false,config:{...DEFAULT_PROBATION_CONFIG,nonWorkingDayRule:rule},nextId:(()=>{let n=0;return()=>'p'+(++n);})(),isWorking:weekdays})!;
  expect(plan('previous').parts.find(p=>p.type===3)!.dueOn).toBe('2026-11-20');
  expect(plan('next').parts.find(p=>p.type===3)!.dueOn).toBe('2026-11-23');
  expect(()=>validateProbationConfig({...DEFAULT_PROBATION_CONFIG,nonWorkingDayRule:'sideways' as never})).toThrow();
  expect(()=>validateProbationConfig({...DEFAULT_PROBATION_CONFIG,fallbackGroupId:''})).toThrow();
  expect(()=>validateProbationConfig({...DEFAULT_PROBATION_CONFIG,fallbackGroupId:'g-people',postingApproverGroupId:null})).not.toThrow();
 });
});
