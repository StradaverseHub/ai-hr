import { EMERGENCY_CONTACT_PRIORITIES } from './emergency-contact-vocabulary';
import { DEPENDENT_RELATIONSHIPS, DEPENDENT_GENDERS, DEPENDENT_MARRIAGE_STATUSES, CHILD_RELIEF_CATEGORIES, CHILD_RELIEF_PERCENTAGES } from './dependent-vocabulary';
import { EMPLOYMENT_PERIOD_UNITS } from './employment-period';
import { isCalendarDate } from './calendar-date';
import { GENDERS, MARITAL_STATUSES, PERSON_GENDER_LABEL_KEYS, PERSON_MARITAL_LABEL_KEYS } from './person-vocabulary';
/** Client-safe presentation and file boundary for the authoritative Personnel descriptors.
 * Domain writers still own permissions, catalogs, dated changes and audit events. */
import { PERSONNEL_FIELDS, PERSONNEL_IMPORT_COMPATIBILITY, type PersonnelFieldDescriptor } from './personnel-field-registry';
import { parseCsv } from './csv';

export type PersonnelLabelResolver = (key: string, fallback: string) => string;
export type PersonnelImportSheet = 'employee' | 'family' | 'qualification' | 'emergency';
export const PERSONNEL_TEMPLATE_GENERATION = 2;
/** Compatibility is deliberately version bounded, not a permanent alias accumulator. */
export const PERSONNEL_LEGACY_HEADER_GENERATION = 1;
const normalized = (value: string) => value.replace(/^\uFEFF/, '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
export function personnelFieldLabel(field: PersonnelFieldDescriptor, resolve?: PersonnelLabelResolver): string {
  return field.labelKey && resolve ? resolve(field.labelKey, field.label) : field.label;
}
export function personnelImportFields(sheet: PersonnelImportSheet): PersonnelFieldDescriptor[] {
  if(sheet==='qualification'||sheet==='emergency')return PERSONNEL_FIELDS.filter(field=>field.import.register?.kind===sheet).map(field=>({...field,import:{...field.import,column:field.import.register!.column,requiredCreate:field.import.register!.requiredCreate,writerField:field.import.register!.writerField,catalog:field.allowedValuesOwner?.startsWith('profile_option:')?field.allowedValuesOwner.slice('profile_option:'.length):field.import.catalog}})).sort((a,b)=>a.import.order-b.import.order);
  return PERSONNEL_FIELDS.filter(f => f.import.column && (sheet === 'family' ? f.import.section === 'family' : f.import.section !== 'family'))
    .sort((a,b) => a.import.order-b.import.order);
}
export function personnelImportField(column: string, sheet: PersonnelImportSheet = 'employee') {
  // Employee ID is the shared key on both sheets, not a fabricated dependent property.
  return personnelImportFields(sheet).find(f => f.import.column === column)
    ?? (column === 'employee_code' ? PERSONNEL_FIELDS.find(f => f.owner === 'employment' && f.ownerField === 'employeeCode') : undefined);
}
/** Temporary month/day compatibility adapters refer to one compound owner field. */
const LEGACY_COMPOUND_COLUMNS: Record<string,{id:string;unit:string}> = {
  probation_months:{id:'employment.employment_dates_and_service.probationvalue',unit:'month'},
  probation_days:{id:'employment.employment_dates_and_service.probationvalue',unit:'day'},
  resignation_notice_months:{id:'employment.employment_dates_and_service.noticebeforeconfirmationvalue',unit:'month'},
  resignation_notice_days:{id:'employment.employment_dates_and_service.noticebeforeconfirmationvalue',unit:'day'},
};
export function personnelColumnLabel(column: string, sheet: PersonnelImportSheet = 'employee', resolve?: PersonnelLabelResolver): string {
  if(column==='record_id')return resolve?.('people.import.registerRecordId','Record ID (existing records only)')??'Record ID (existing records only)';
  const field = personnelImportField(column,sheet);
  if (field) {
    const base=personnelFieldLabel(field,resolve);
    const label=field.import.qualifier ? `${base} — ${resolve?.(`people.import.field${field.import.qualifier==='unit'?'Unit':'Value'}`,field.import.qualifier==='unit'?'Unit':'Value')??(field.import.qualifier==='unit'?'Unit':'Value')}` : base;
    const collisions=personnelImportFields(sheet).filter(other => personnelFieldLabel(other,resolve) === label);
    return collisions.length > 1 ? `${label} (${field.section})` : label;
  }
  const adapter=LEGACY_COMPOUND_COLUMNS[column];
  if(adapter) {
    const owner=PERSONNEL_FIELDS.find(f=>f.id===adapter.id)!;
    return `${personnelFieldLabel(owner,resolve)} (${adapter.unit})`;
  }
  const compatibility=PERSONNEL_IMPORT_COMPATIBILITY.find(adapter=>adapter.column===column);
  if(compatibility)return compatibility.label;
  return column.split('_').map(word=>['ic','epf','socso','eis'].includes(word)?word.toUpperCase():word[0]?.toUpperCase()+word.slice(1)).join(' ');
}
export class PersonnelImportHeaderError extends Error {
  constructor(message:string) { super(message);this.name='PersonnelImportHeaderError'; }
}
function currentPersonnelHeaders(column:string,sheet:PersonnelImportSheet,resolve?:PersonnelLabelResolver) {
  const field=personnelImportField(column,sheet);if(!field)return [personnelColumnLabel(column,sheet,resolve)];
  const labels=[personnelColumnLabel(column,sheet,resolve)];
  for(const alias of PERSONNEL_FIELDS)if(alias.id!==field.id && alias.owner===field.owner && alias.ownerField===field.ownerField && alias.tab===field.tab && !alias.import.column)labels.push(personnelFieldLabel(alias,resolve));
  return [...new Set(labels)];
}
/** Resolve BEFORE creating records: duplicate old/new headings must never overwrite a cell. */
export function parsePersonnelImportCsv(text:string, options:{columns:readonly string[];sheet?:PersonnelImportSheet;resolvers?:readonly PersonnelLabelResolver[];generation?:number}) {
  const rows=parseCsv(text);
  if(!rows.length)return {headers:[] as string[],records:[] as Record<string,string>[],warnings:[] as string[]};
  const sheet=options.sheet??'employee';
  const aliases=new Map<string,Set<string>>();
  const register=(label:string,column:string)=> { const key=normalized(label); const values=aliases.get(key)??new Set<string>();values.add(column);aliases.set(key,values); };
  for(const column of options.columns) {
    const retired=column in LEGACY_COMPOUND_COLUMNS;
    if(!retired || (options.generation??PERSONNEL_TEMPLATE_GENERATION)===PERSONNEL_LEGACY_HEADER_GENERATION+1) {
      for(const label of currentPersonnelHeaders(column,sheet))register(label,column);
      for(const resolve of options.resolvers??[])for(const label of currentPersonnelHeaders(column,sheet,resolve))register(label,column);
    }
    if((options.generation??PERSONNEL_TEMPLATE_GENERATION)===PERSONNEL_LEGACY_HEADER_GENERATION+1) {
      register(column,column);register(column.replaceAll('_',' '),column);
      for(const alias of personnelImportField(column,sheet)?.import.aliases??[])register(alias,column);
    }
  }
  const warnings:string[]=[];const seen=new Set<string>();
  const headers=rows[0].map(raw=>{
    const matches=aliases.get(normalized(raw));
    if(!matches || matches.size!==1)throw new PersonnelImportHeaderError(matches ? `Ambiguous column “${raw}”. Download the current template and use its complete heading.` : `Unrecognized or removed column “${raw}”. Download the current template; this column cannot be applied.`);
    const column=[...matches][0];
    if(seen.has(column))throw new PersonnelImportHeaderError(`Column “${raw}” repeats “${personnelColumnLabel(column,sheet)}”. Keep one column; old and new headings cannot appear together.`);
    seen.add(column);
    const current=[...currentPersonnelHeaders(column,sheet),...(options.resolvers??[]).flatMap(resolve=>currentPersonnelHeaders(column,sheet,resolve))];
    if(column in LEGACY_COMPOUND_COLUMNS || !current.some(label=>normalized(label)===normalized(raw))) warnings.push(`Older header “${raw}”: use “${personnelColumnLabel(column,sheet)}” in the next template generation.`);
    return column;
  });
  const records=rows.slice(1).map((row,index)=>{
    if(row.length>headers.length && row.slice(headers.length).some(cell=>cell.trim()))throw new PersonnelImportHeaderError(`Row ${index+2} has values beyond its column headings.`);
    return Object.fromEntries(headers.map((header,i)=>[header,normalizePersonnelImportValue(header,(row[i]??'').trim(),sheet,options.resolvers??[])]));
  });
  return {headers,records,warnings};
}
export const PERSONNEL_EMPLOYMENT_IMPORT_FIELDS = PERSONNEL_FIELDS.filter(field=>field.import.writer==='employment-info');
export const PERSONNEL_PROFILE_IMPORT_FIELDS = PERSONNEL_FIELDS.filter(f=>f.import.writer==='person-profile');
export const PERSONNEL_COMPLIANCE_IMPORT_FIELDS = PERSONNEL_FIELDS.filter(f=>f.import.writer==='person-compliance');

/** Scalar validation shared by Personnel and import. Cross-field decisions remain with owners. */
export function personnelScalarIssue(field:PersonnelFieldDescriptor,value:string):string|null {
  if(!value.trim())return null;
  if(field.import.writer==='employment-info' && field.type==='number' && (!Number.isSafeInteger(Number(value)) || Number(value)<0))return 'non-negative whole number';
  if(field.type==='date' && (field.unit==='month'?!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value.trim()):!isCalendarDate(value.trim())))return field.unit==='month'?'year and month':'date';
  if(['primaryEmail','personalEmail'].includes(field.ownerField) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))return 'email';
  const choices=personnelFieldChoices(field);
  if(choices.length && !choices.some(choice=>choice.value===value.trim()))return 'choice';
  return null;
}

export function personnelColumnGuidance(column:string,sheet:PersonnelImportSheet,mode:'create'|'update',words:{required:string;optional:string;reference:string;blankRetains:string}) {
  const field=personnelImportField(column,sheet);
  const required=column==='employee_code' && (sheet==='family'||mode==='update') || (mode==='create'?field?.import.requiredCreate:field?.import.requiredUpdate);
  return [required?words.required:words.optional,field?.type==='date'?(field.unit==='month'?'YYYY-MM':'YYYY-MM-DD'):undefined,
    field?.type==='number'||field?.type==='currency'?[field.type,field.unit].filter(Boolean).join(' '):undefined,
    field?.type==='choice'?words.reference:undefined,mode==='update'?words.blankRetains:undefined].filter(Boolean).join(' · ');
}

export function personnelFieldChoices(field:PersonnelFieldDescriptor) {
  if(field.allowedValuesOwner==='emergency.priority')return EMERGENCY_CONTACT_PRIORITIES.map(value=>({value,labelKey:`people.detail.emergency.${{primary:'priorityPrimary',secondary:'prioritySecondary',other:'priorityOther'}[value]}`}));
  if(field.allowedValuesOwner==='dependent.relationship')return DEPENDENT_RELATIONSHIPS.map(value=>({value,labelKey:`people.detail.family.rel.${value}`}));
  if(field.allowedValuesOwner==='dependent.childReliefPercentage')return CHILD_RELIEF_PERCENTAGES.map(value=>({value:String(value),labelKey:`people.detail.family.childReliefPct_${value}`}));
  if(field.allowedValuesOwner==='dependent.gender')return DEPENDENT_GENDERS.map(value=>({value,labelKey:`people.detail.family.gender.${value}`}));
  if(field.allowedValuesOwner==='dependent.marriageStatus')return DEPENDENT_MARRIAGE_STATUSES.map(value=>({value,labelKey:`people.detail.family.marriageStatus.${value}`}));
  if(field.allowedValuesOwner==='dependent.childReliefCategory')return CHILD_RELIEF_CATEGORIES.map(value=>({value,labelKey:`people.detail.family.childReliefCat_${value}`}));
  if(field.allowedValuesOwner==='employment.periodUnit')return EMPLOYMENT_PERIOD_UNITS.map(value=>({value,labelKey:`people.detail.employmentInfo.unit_${value}`}));
  if(field.allowedValuesOwner==='person.gender')return GENDERS.map(value=>({value,labelKey:PERSON_GENDER_LABEL_KEYS[value]}));
  if(field.allowedValuesOwner==='person.maritalStatus')return MARITAL_STATUSES.map(value=>({value,labelKey:PERSON_MARITAL_LABEL_KEYS[value]}));
  return [];
}
function normalizePersonnelImportValue(column:string,raw:string,sheet:PersonnelImportSheet,resolvers:readonly PersonnelLabelResolver[]) {
  const field=personnelImportField(column,sheet);if(!field||!raw)return raw;
  const options=personnelFieldChoices(field);if(!options.length)return raw;
  const matches=options.filter(option=>normalized(option.value)===normalized(raw)||resolvers.some(resolve=>normalized(resolve(option.labelKey,option.value))===normalized(raw)));
  return matches.length===1?matches[0].value:raw;
}

export function personnelImportProposedValues(record:Record<string,string>,sheet:PersonnelImportSheet) {
  const known=new Set(personnelImportFields(sheet).map(field=>field.import.column!));
  if(sheet!=='employee'){known.add('employee_code');known.add('record_id');}
  if(sheet==='employee')for(const adapter of PERSONNEL_IMPORT_COMPATIBILITY)known.add(adapter.column);
  return Object.entries(record).filter(([column,value])=>known.has(column)&&value.trim()!=='').map(([column,value])=>({column,value}));
}
