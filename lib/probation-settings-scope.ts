/**
 * Probation settings scope (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 3; migration 5742).
 *
 * One group standard sets every field. A company setting applies to a chosen list of companies and stores only the
 * fields it overrides; every other field follows the standard, including later standard changes. A company is in at
 * most one company setting. The database resolves standard ⊕ override into an ordinary published company settings
 * version (probation_configuration), so admission, intake and running cases keep reading one pinned version.
 * These helpers are pure: the database remains the last guard and the owner of the resolved rows.
 */
import {PROBATION_SETTINGS_FIELD_DEFAULTS,validateProbationConfig,type ProbationSettingsProvenance} from './probation-model';
import type {ProbationSettings} from '../core/probation';

/** Fields a company setting may override, in the order the editor shows them. */
export const PROBATION_SCOPED_FIELDS=[
 'eligibleGrades','gradeHEnabled','defaultMonths','plans','kpiGate','issueLeadDays','nonWorkingDayRule','fallbackGroupId','postingApproverGroupId',
 'kpiDueWorkingDays','kpiReminderWorkingDay','firstReminderDays','dailyReminderDays','lowBand','lmWaitsForEmployee','overrides',
] as const;
export type ProbationScopedField=typeof PROBATION_SCOPED_FIELDS[number];
export type ProbationSettingsOverride=Partial<Pick<ProbationSettings,ProbationScopedField>>;
export type ProbationSettingsScopeKind='standard'|'company';
export type ProbationSettingsScopeState='draft'|'published'|'retired';

const SCOPED=new Set<string>(PROBATION_SCOPED_FIELDS);
export const isProbationScopedField=(field:string):field is ProbationScopedField=>SCOPED.has(field);

/** Stable comparison of JSON values (object key order does not matter; array order does). */
export function sameProbationValue(a:unknown,b:unknown):boolean{return canonical(a)===canonical(b);}
function canonical(value:unknown):string{
 if(value===undefined)return 'null';
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value as Record<string,unknown>).filter(key=>(value as Record<string,unknown>)[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
}

/** A field's value as the resolved settings expose it, with the defaults for fields added on 16 Nov 2026. */
export function probationFieldValue(settings:ProbationSettings,field:ProbationScopedField):unknown{
 const value=(settings as Record<string,unknown>)[field];
 if(value!==undefined)return value;
 if(field==='overrides')return [];
 return (PROBATION_SETTINGS_FIELD_DEFAULTS as Record<string,unknown>)[field];
}

/** Only the scoped fields of an override, so stray keys never reach the resolved version. */
export function probationOverrideFields(override:ProbationSettingsOverride|null|undefined):ProbationScopedField[]{
 return override?PROBATION_SCOPED_FIELDS.filter(field=>Object.hasOwn(override,field)&&(override as Record<string,unknown>)[field]!==undefined):[];
}

/** standard ⊕ override: the values a company in this setting uses. */
export function resolveProbationSettings(standard:ProbationSettings,override:ProbationSettingsOverride|null|undefined):ProbationSettings{
 const resolved=structuredClone(standard) as Record<string,unknown>;
 for(const field of probationOverrideFields(override))resolved[field]=structuredClone((override as Record<string,unknown>)[field]);
 return resolved as ProbationSettings;
}

/** Overridden fields whose value equals the standard: flagged so the administrator can remove them. */
export function redundantProbationOverrides(standard:ProbationSettings,override:ProbationSettingsOverride|null|undefined):ProbationScopedField[]{
 return probationOverrideFields(override).filter(field=>sameProbationValue(probationFieldValue(standard,field),(override as Record<string,unknown>)[field]));
}

/** Fields whose values differ between two complete settings. */
export function probationSettingsDifferences(a:ProbationSettings,b:ProbationSettings):ProbationScopedField[]{
 return PROBATION_SCOPED_FIELDS.filter(field=>!sameProbationValue(probationFieldValue(a,field),probationFieldValue(b,field)));
}

/** Problems that stop a group standard or company setting from publishing; the same rules as a company version. */
export function probationScopeIssues(input:{scope:ProbationSettingsScopeKind;name:string;companyIds:string[];data:ProbationSettings|ProbationSettingsOverride;standard:ProbationSettings|null}):string[]{
 const issues:string[]=[];
 if(!input.name.trim()||input.name.length>200)issues.push('name');
 if(input.scope==='standard'){
  if(input.companyIds.length)issues.push('standard_companies');
  if((input.data as ProbationSettings).overrides?.length)issues.push('standard_rules');
  try{validateProbationConfig({...(input.data as ProbationSettings),version:1,gradeHFormPublished:true});}catch(error){issues.push(error instanceof Error?error.message:'invalid');}
  return issues;
 }
 if(!input.companyIds.length)issues.push('companies');
 if(new Set(input.companyIds).size!==input.companyIds.length||input.companyIds.length>500)issues.push('companies');
 if(Object.keys(input.data).some(key=>!isProbationScopedField(key)))issues.push('fields');
 if(!probationOverrideFields(input.data as ProbationSettingsOverride).length)issues.push('no_overrides');
 if(input.standard){
  try{validateProbationConfig({...resolveProbationSettings(input.standard,input.data as ProbationSettingsOverride),version:1,gradeHFormPublished:true});}catch(error){issues.push(error instanceof Error?error.message:'invalid');}
 }
 return issues;
}

export type ProbationScopeMember={companyId:string;settingKey:string;settingName:string;fields:string[]};
export type ProbationStandardPreviewRow={companyId:string;companyName:string;settingName:string|null;pickedUp:ProbationScopedField[];shielded:ProbationScopedField[]};
/**
 * Before a group standard change publishes: which companies pick up each changed field and which are shielded by an
 * override of that field. Running cases keep the values they started with either way.
 */
export function probationStandardPreview(input:{current:ProbationSettings|null;next:ProbationSettings;companies:{id:string;name:string}[];members:ProbationScopeMember[]}):{changed:ProbationScopedField[];rows:ProbationStandardPreviewRow[]}{
 const changed=input.current?probationSettingsDifferences(input.current,input.next):[...PROBATION_SCOPED_FIELDS];
 const members=new Map(input.members.map(member=>[member.companyId,member]));
 const rows=input.companies.map(company=>{
  const member=members.get(company.id),fields=new Set(member?.fields??[]);
  return{companyId:company.id,companyName:company.name,settingName:member?.settingName??null,pickedUp:changed.filter(field=>!fields.has(field)),shielded:changed.filter(field=>fields.has(field))};
 });
 return{changed,rows};
}

/** Where each field of a resolved version came from (case header, audit). Old versions without provenance are the company's own. */
export function probationFieldSources(provenance:ProbationSettingsProvenance|undefined|null):Record<ProbationScopedField,'standard'|'override'|'company'>{
 const fields=new Set(provenance?.fields??[]);
 return Object.fromEntries(PROBATION_SCOPED_FIELDS.map(field=>[field,!provenance?'company':fields.has(field)?'override':'standard'])) as Record<ProbationScopedField,'standard'|'override'|'company'>;
}
