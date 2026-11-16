/** Field rules extracted from the existing V9 document owner. Subjects supply identity/turn permissions;
 * this pure module neither reads Personnel nor grants a role or writes a record. */
import {isCalendarDate} from './calendar-date';
import type {Block,Field} from './lifecycle-v9-model';

export function documentFieldValueProblem(field:Field,value:string):string|null{
 if(value.length>20000)return 'A field exceeds the allowed length.';
 if(field.type==='select'&&value&&!field.options.includes(value))return `Choose a valid option for ${field.label}.`;
 if(field.type==='date'&&value&&!isCalendarDate(value))return `Enter a valid date for ${field.label}.`;
 if(field.type==='checkbox'&&value&&!['true','false'].includes(value))return `Choose a valid value for ${field.label}.`;
 if(field.type==='number'&&value&&!Number.isFinite(Number(value)))return `Enter a valid number for ${field.label}.`;
 if(field.type==='email'&&value&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))return `Enter a valid email for ${field.label}.`;
 if(field.type==='table'&&value){
  let rows:unknown;try{rows=JSON.parse(value);}catch{return `Enter valid rows for ${field.label}.`;}
  if(!Array.isArray(rows)||rows.length>50||!rows.every(row=>Array.isArray(row)&&row.length===(field.columns?.length??0)&&row.every(cell=>typeof cell==='string'&&cell.length<=1000)))return `Enter valid rows for ${field.label}.`;
 }
 return null;
}
export const documentFieldVisible=(field:Field,values:Readonly<Record<string,string>>)=>!field.when||values[field.when.field]===field.when.value;
export function documentRequiredFieldProblems(fields:readonly Field[],values:Readonly<Record<string,string>>,owner:'employee'|'hr'|'all'='all'):string[]{
 const problems:string[]=[];
 for(const field of fields){
  if(owner==='hr'&&field.owner==='employee'||!documentFieldVisible(field,values))continue;
  const value=Object.hasOwn(values,field.id)?values[field.id]:'';
  const invalid=documentFieldValueProblem(field,value);if(invalid)problems.push(invalid);
  if(field.required&&(!value.trim()||field.type==='checkbox'&&value!=='true'||field.type==='table'&&value==='[]'))problems.push(`Complete ${field.label} before signing.`);
 }
 return [...new Set(problems)];
}
/** V9 permits saving owned hidden fields, but only visible required fields block signing. Show-when is
 * presentation/requiredness, not an access grant. Editable IDs are adjudicated by the native subject owner. */
export function documentResponsePatch(fields:readonly Field[],before:Readonly<Record<string,string>>,patch:Readonly<Record<string,string>>,editableFieldIds:readonly string[]):{values:Record<string,string>;problems:string[]}{
 const offered=new Map(fields.map(field=>[field.id,field])),editable=new Set(editableFieldIds),problems:string[]=[];
 for(const [id,value] of Object.entries(patch)){
  const field=offered.get(id);
  if(!field||field.owner==='pmLocked'||!editable.has(id)){problems.push('This field cannot be changed.');continue;}
  const invalid=documentFieldValueProblem(field,value);if(invalid)problems.push(invalid);
 }
 return {values:Object.fromEntries([...Object.entries(before),...Object.entries(patch)]),problems:[...new Set(problems)]};
}
export type DerivedDocumentKind='Form'|'Acknowledgement'|'Letter';
/** Mirrors the approved HTML's tplKindOf; kind follows actual blocks/routing, never a user selector. */
export function derivedDocumentKind(blocks:readonly Block[],employeeStepIds:readonly string[]=[]):DerivedDocumentKind{
 if(blocks.some(block=>block.type==='field'||block.type==='fields'))return 'Form';
 const signatures=blocks.filter(block=>block.type==='signature'),employees=new Set(employeeStepIds);
 return signatures.length&&signatures.every(block=>block.role==='employee'||block.role?.startsWith('step:')&&employees.has(block.role.slice(5)))?'Acknowledgement':'Letter';
}
