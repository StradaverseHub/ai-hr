/** Display only: canonical import codes remain unchanged for validation, receipts and audit. */
import {MOVEMENT_FORM_IDS} from './movement-form-contract';
import {personnelFormLabel} from './personnel-form-contract';
import type {PersonnelLabelResolver} from './personnel-import-contract';

export function movementImportFieldLabel(key:string,resolve:PersonnelLabelResolver){
 if(key==='incrementAmount')return resolve('people.import.movement.v2.incrementAmount','Increment Amount');
 if(key==='employeeCode'||key==='employee_code')return resolve('people.import.movement.employeeId','Employee ID');
 if(key==='event_type')return personnelFormLabel(MOVEMENT_FORM_IDS.kind,resolve);
 return key in MOVEMENT_FORM_IDS?personnelFormLabel(MOVEMENT_FORM_IDS[key as keyof typeof MOVEMENT_FORM_IDS],resolve):resolve('people.import.movement.currentFields.'+key,key);
}

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** YYYY-MM-DD as DD-MMM-YYYY, the date form the Movement template asks for; anything else unchanged. */
export function movementIssueDate(value:string){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);return m&&Number(m[2])>=1&&Number(m[2])<=12?`${m[3]}-${MONTHS[Number(m[2])-1]}-${m[1]}`:value;}

export function movementImportIssueText(issues:string|readonly string[],resolve:PersonnelLabelResolver){
 const parts=[...new Set((typeof issues==='string'?[issues]:issues).flatMap(issue=>issue.split('; ')))];
 return parts.map(part=>{
  const [code,...detail]=part.split(':'),translated=resolve('people.import.movement.issues.'+code,'');
  // A message that names a date (e.g. the record that blocks a backdated change) carries it as the detail.
  if(translated&&translated.includes('%date%'))return translated.split('%date%').join(movementIssueDate(detail.join(':')));
  return translated?translated+(detail.length?' · '+movementImportFieldLabel(detail.join(':'),resolve):''):resolve('people.import.movement.v2.refused','This change could not be applied. Correct the highlighted field and check the complete sequence again.')+(detail.length?' · '+movementImportFieldLabel(detail[0],resolve):'');
 }).join('; ');
}
