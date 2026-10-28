import { ATTENDANCE_PHOTO_SETTINGS, ATTENDANCE_PHOTO_LABEL_KEYS } from './attendance-photo-setting';
import { PAYMENT_METHODS } from './payment-methods';
import { EMERGENCY_CONTACT_PRIORITIES } from './emergency-contact-vocabulary';
import { PERSONNEL_EMPLOYMENT_TYPES } from './personnel-choice-vocabulary';
import { EPF_UI_MODE_OPTIONS } from './epf-mode-map';
import { PERSONNEL_PAY_MODES,PERSONNEL_PAYMENT_TERMS,PERSONNEL_EPF_CITIZENSHIPS,PERSONNEL_SOCSO_CATEGORIES,PERSONNEL_EIS_CATEGORIES,PERSONNEL_CHILD_RELIEF_MODES,PERSONNEL_TAX_RESIDENCIES } from './personnel-choice-vocabulary';
import { DEPENDENT_RELATIONSHIPS, DEPENDENT_GENDERS, DEPENDENT_MARRIAGE_STATUSES, CHILD_RELIEF_CATEGORIES, CHILD_RELIEF_PERCENTAGES } from './dependent-vocabulary';
import { EMPLOYMENT_PERIOD_UNITS } from './employment-period';
import { isCalendarDate } from './calendar-date';
import { GENDERS, MARITAL_STATUSES, PERSON_GENDER_LABEL_KEYS, PERSON_MARITAL_LABEL_KEYS } from './person-vocabulary';
/** Client-safe presentation and file boundary for the authoritative Personnel descriptors.
 * Domain writers still own permissions, catalogs, dated changes and audit events. */
import { PERSONNEL_FIELDS, PERSONNEL_IMPORT_COMPATIBILITY, type PersonnelFieldDescriptor } from './personnel-field-registry';
import { parsePersonnelCsv } from './personnel-csv';

import {personnelFieldLabel,type PersonnelLabelResolver} from './personnel-field-label';
export {personnelFieldLabel,type PersonnelLabelResolver} from './personnel-field-label';
export type PersonnelImportSheet = 'employee' | 'family' | 'qualification' | 'emergency';
export const PERSONNEL_TEMPLATE_GENERATION = 2;
/** Compatibility is deliberately version bounded, not a permanent alias accumulator. */
export const PERSONNEL_LEGACY_HEADER_GENERATION = 1;
const normalized = (value: string) => value.replace(/^\uFEFF/, '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
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
const LEGACY_COMPOUND_COLUMNS: Record<string,{id:string;unit:string;label:string}> = {
  probation_months:{id:'employment.employment_dates_and_service.probationvalue',unit:'month',label:'Probation Period'},
  probation_days:{id:'employment.employment_dates_and_service.probationvalue',unit:'day',label:'Probation Period'},
  resignation_notice_months:{id:'employment.employment_dates_and_service.noticebeforeconfirmationvalue',unit:'month',label:'Notice Before Confirmation'},
  resignation_notice_days:{id:'employment.employment_dates_and_service.noticebeforeconfirmationvalue',unit:'day',label:'Notice Before Confirmation'},
};
export function personnelColumnLabel(column: string, sheet: PersonnelImportSheet = 'employee', resolve?: PersonnelLabelResolver): string {
  if(column==='record_id')return resolve?.('people.import.registerRecordId','Record ID (existing records only)')??'Record ID (existing records only)';
  const field = personnelImportField(column,sheet);
  if (field) {
    const label=personnelFieldLabel(field,resolve);
    // A current download must not collide with another field's accepted older technical heading.
    // Example: emergency 'Home phone' versus the person's legacy home_phone alias. Qualify the
    // downloaded heading instead of prioritizing current labels and silently reinterpreting old files.
    const key=normalized(label);
    const collision=personnelImportFields(sheet).some(other=>other.import.column!==column &&
      [personnelFieldLabel(other,resolve),other.import.column!,other.import.column!.replaceAll('_',' '),
        ...other.import.aliases??[]].some(candidate=>normalized(candidate)===key));
    return collision ? `${label} (${field.section})` : label;
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
export type PersonnelImportHeaderOptions = {columns:readonly string[];sheet?:PersonnelImportSheet;resolvers?:readonly PersonnelLabelResolver[];generation?:number};
/** Same whole-file grammar/alias owner as the strict parser. Suggestions are not validation. */
export function personnelImportHeaderCandidates(headings:readonly string[], options:PersonnelImportHeaderOptions) {
  const sheet=options.sheet??'employee';
  // Generation 1 downloads used a complete technical-key header grammar. Recognise that FILE
  // only during its one-release compatibility window, never by preferring an individual exact key
  // over ambiguous display aliases (e.g. permanent/correspondence Postcode). An underscore-bearing
  // key supplies explicit format evidence; every heading must belong to the same exact grammar.
  const legacyGeneration=(options.generation??PERSONNEL_TEMPLATE_GENERATION)===PERSONNEL_LEGACY_HEADER_GENERATION+1;
  const technicalKeys=new Set(options.columns);
  const technicalHeadings=headings.map(raw=>raw.replace(/^\uFEFF/,'').trim());
  const legacyTechnicalFile=legacyGeneration && technicalHeadings.some(raw=>raw.includes('_'))
    && technicalHeadings.every(raw=>technicalKeys.has(raw));
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
      const compound=LEGACY_COMPOUND_COLUMNS[column];
      if(compound){
        const owner=PERSONNEL_FIELDS.find(field=>field.id===compound.id)!;
        register(`${compound.label} (${compound.unit})`,column);
        for(const resolve of options.resolvers??[])register(`${resolve(owner.labelKey,compound.label)} (${compound.unit})`,column);
      }
      const field=personnelImportField(column,sheet);
      for(const alias of field?.import.aliases??[])register(alias,column);
      // Former unqualified display labels are also bounded aliases. Keep all possible identities so
      // an ambiguous stale heading refuses; never select the first or silently prefer a new label.
      if(field){register(personnelFieldLabel(field),column);for(const resolve of options.resolvers??[])register(personnelFieldLabel(field,resolve),column);}
    }
  }
  return headings.map((raw,index)=>{
    const matches=[...(legacyTechnicalFile ? new Set([technicalHeadings[index]]) : aliases.get(normalized(raw)) ?? [])];
    const current=matches.length===1 && !(matches[0] in LEGACY_COMPOUND_COLUMNS) &&
      [...currentPersonnelHeaders(matches[0],sheet),...(options.resolvers??[]).flatMap(resolve=>currentPersonnelHeaders(matches[0],sheet,resolve))].some(label=>normalized(label)===normalized(raw));
    return {index,raw,matches,current,legacyTechnicalFile};
  });
}

export function parsePersonnelImportCsv(text:string, options:PersonnelImportHeaderOptions) {
  const rows=parsePersonnelCsv(text,options.sheet??'employee');
  if(!rows.length)return {headers:[] as string[],records:[] as Record<string,string>[],warnings:[] as string[]};
  const sheet=options.sheet??'employee';
  const candidates=personnelImportHeaderCandidates(rows[0],options);
  const warnings:string[]=[];const seen=new Set<string>();
  const headers=candidates.map(({raw,matches,current})=>{
    if(matches.length!==1)throw new PersonnelImportHeaderError(matches.length ? `Ambiguous column “${raw}”. Download the current template and use its complete heading.` : `Unrecognized or removed column “${raw}”. Download the current template; this column cannot be applied.`);
    const column=matches[0];
    if(seen.has(column))throw new PersonnelImportHeaderError(`Column “${raw}” repeats “${personnelColumnLabel(column,sheet)}”. Keep one column; old and new headings cannot appear together.`);
    seen.add(column);
    if(!current) warnings.push(`Older header “${raw}”: use “${personnelColumnLabel(column,sheet)}” in the next template generation.`);
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
  const required=column==='employee_code' && (sheet!=='employee'||mode==='update') || (mode==='create'?field?.import.requiredCreate:field?.import.requiredUpdate);
  return [required?words.required:words.optional,field?.type==='date'?(field.unit==='month'?'YYYY-MM':'YYYY-MM-DD'):undefined,
    field?.type==='number'||field?.type==='currency'?[field.type,field.unit].filter(Boolean).join(' '):undefined,
    field?.type==='choice'?words.reference:undefined,mode==='update'?words.blankRetains:undefined].filter(Boolean).join(' · ');
}

export function personnelFieldChoices(field:PersonnelFieldDescriptor) {
  if(field.allowedValuesOwner==='attendance.photoSetting')return ATTENDANCE_PHOTO_SETTINGS.map(value=>({value,labelKey:ATTENDANCE_PHOTO_LABEL_KEYS[value]}));
  if(field.allowedValuesOwner==='employment.paymentMethod')return PAYMENT_METHODS.map(value=>({value,labelKey:`people.detail.paymentMethod_${value}`}));
  if(field.import.register && field.type==='boolean')return [{value:'true',labelKey:'people.import.registerYes'},{value:'false',labelKey:'people.import.registerNo'}];
  if(field.allowedValuesOwner==='emergency.priority')return EMERGENCY_CONTACT_PRIORITIES.map(value=>({value,labelKey:`people.detail.emergency.${{primary:'priorityPrimary',secondary:'prioritySecondary',other:'priorityOther'}[value]}`}));
  if(field.allowedValuesOwner==='employment.type')return PERSONNEL_EMPLOYMENT_TYPES.map(value=>({value,labelKey:`people.detail.employmentInfo.employmentType_${value}`}));
  if(field.allowedValuesOwner==='movement.blacklist')return [{value:'true',labelKey:'people.detail.movement.form.blacklistSet'},{value:'false',labelKey:'people.detail.movement.form.blacklistClear'}];
  if(field.allowedValuesOwner==='statutory.epfUiMode')return EPF_UI_MODE_OPTIONS;
  if(field.allowedValuesOwner==='statutory.socsoCategory')return PERSONNEL_SOCSO_CATEGORIES.map(value=>({value,labelKey:`people.detail.socsoCategory${value[0].toUpperCase()+value.slice(1)}`}));
  if(field.allowedValuesOwner==='statutory.eisCategory')return PERSONNEL_EIS_CATEGORIES.map(value=>({value,labelKey:`people.detail.eisCategory${value[0].toUpperCase()+value.slice(1)}`}));
  if(field.allowedValuesOwner==='statutory.childReliefMode')return PERSONNEL_CHILD_RELIEF_MODES.map(value=>({value,labelKey:`people.detail.${{manual:'childReliefModeManual',auto:'childReliefModeAuto',auto_table:'childReliefModeAutoTable'}[value]}`}));
  if(field.allowedValuesOwner==='statutory.taxResidency')return PERSONNEL_TAX_RESIDENCIES.map(value=>({value,labelKey:`people.detail.${{resident:'taxResidencyResident',non_resident:'taxResidencyNonResident',rep:'taxResidencyRep',knowledge_worker:'taxResidencyKnowledgeWorker',c_suite:'taxResidencyCSuite'}[value]}`}));

  if(field.allowedValuesOwner==='payroll.payMode')return PERSONNEL_PAY_MODES.map(value=>({value,labelKey:`people.detail.payMode_${value}`}));
  if(field.allowedValuesOwner==='payroll.paymentTerm')return PERSONNEL_PAYMENT_TERMS.map(value=>({value,labelKey:`people.detail.paymentTerm_${value}`}));
  if(field.allowedValuesOwner==='statutory.epfCitizenship')return PERSONNEL_EPF_CITIZENSHIPS.map(value=>({value,labelKey:`people.detail.${{citizen:'epfCitizenshipCitizen',pr:'epfCitizenshipPr',non_citizen:'epfCitizenshipNonCitizen'}[value]}`}));
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
export function normalizePersonnelImportValue(column:string,raw:string,sheet:PersonnelImportSheet,resolvers:readonly PersonnelLabelResolver[]) {
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
