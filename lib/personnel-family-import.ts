/** The Family sheet is a register, not a flattened employee row. Owner validation runs again at apply. */
import type { DependentInput } from '../core/dependents';
import { PERSONNEL_FIELDS } from './personnel-field-registry';
import { isCalendarDate } from './calendar-date';
import { personnelFieldChoices } from './personnel-import-contract';
export function personnelFamilyValues(record:Record<string,string>) {
  const values:Partial<DependentInput>={};const errors:string[]=[];
  for(const field of PERSONNEL_FIELDS.filter(field=>field.import.writer==='dependent')) {
    const {column,writerField,appliesTo}=field.import;const raw=(record[column!]??'').trim();if(!raw)continue;
    if(appliesTo && record.relationship!==appliesTo){errors.push(`${column} applies only to ${appliesTo} records`);continue;}
    let value:string|number|boolean=raw;
    if(field.type==='date'&&!isCalendarDate(raw)){errors.push(`${column} must be a real date in YYYY-MM-DD format`);continue;}
    if(field.type==='boolean') {
      if(['yes','true','1','y'].includes(raw.toLowerCase()))value=true;
      else if(['no','false','0','n'].includes(raw.toLowerCase()))value=false;
      else {errors.push(`${column} must be yes or no`);continue;}
    }
    if(field.type==='number') {
      value=Number(raw);if(!Number.isFinite(value)){errors.push(`${column} must be a number`);continue;}
    }
    const choices=personnelFieldChoices(field);
    if(field.allowedValuesOwner!=='dependent.relationship' && choices.length&&!choices.some(choice=>choice.value===raw)){errors.push(`Unknown ${column}`);continue;}
    (values as Record<string,string|number|boolean>)[writerField!]=value;
  }
  return {values,errors};
}

export function personnelFamilyCatalogErrors(record:Record<string,string>,catalog:Map<string,Set<string>>) {
  const errors:string[]=[];
  for(const field of PERSONNEL_FIELDS.filter(field=>field.import.writer==='dependent' && field.import.catalog)) {
    const raw=(record[field.import.column!]??'').trim();const values=catalog.get(field.import.catalog!);
    if(raw && values!==undefined && !values.has(raw))errors.push(`${field.import.column} is not an active ${field.import.catalog} option`);
  }
  return errors;
}
