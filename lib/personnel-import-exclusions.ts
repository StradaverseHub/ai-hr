import {MOVEMENT_FORM_IDS} from './movement-form-contract';
import {PERSONNEL_FIELDS,PERSONNEL_IMPORT_COMPATIBILITY,type PersonnelFieldDescriptor} from './personnel-field-registry';
import {personnelFieldLabel,type PersonnelLabelResolver} from './personnel-field-label';
import type {ImportSection,PersonnelImportChoice} from './import-sections';
export type {PersonnelImportChoice} from './import-sections';

/** Translation adapter for the registry's existing owner reasons, not a second field inventory.
 * Unknown reasons remain visible verbatim; the exact coverage test requires their translation.
 */
const REASON_KEYS:Readonly<Record<string,string>>={
  'The displayed name follows the Direct Superior selected through the supported Employee ID or work email import; it is not a separate name entry.':'superiorName',
  'The Personnel record selector uses an internal employment identity. Imports select the same reporting relationship through the supported Employee ID or work email column.':'superiorRecord',
  "Derived/history field or specialist owner workflow; no section-import writer is declared.": "managed",
  "File content or interface control is not imported.": "file",
  "Derived from the initial confirmation date and any approved probation extension; the Movement workflow owns extensions and this final date is never directly imported.": "confirmation",
  "No existing import column/writer is declared for this field; use its authoritative editor.": "editor",
  "Detailed tax circumstance is confirmed in the employer-scoped Income Tax selection workflow; a numeric legacy category cannot determine a specific circumstance.": "tax",
  "Dated direct-superior selection uses authorized manager candidates; the manager owner validates scope, self-management and cycles.": "superior",
  "Approval delegation selects an authorized employment ID; the delegation owner validates dates, scope and conflicts.": "delegation",
  "Dated work-location selection uses company-authorized Location IDs; the Location assignment owner validates the effective date and source. Code/name report projections remain separate.": "location",
  "EPF election categories are mapped by mapEpfUiMode and validated by the country-pack resolveEpfElection owner. The persisted lawful enum remains the separate epfmode descriptor; election is not a generic scalar import.": "epf",
  "Clocking Control owner saves the selected company-authorized Clocking Location ID set, validates usable locations and preserves assignment audit; code/name/address register projections remain separate.": "clocking",
  "Backup Shift selects an eligible Shift ID within the effective Schedule Group; the dated Attendance owner validates pool/rotation/archived choices. Existing shift code/name report projections remain separate.": "backupShift",
  "Statutory child-relief grid count is submitted as part of one validated country-pack tax selection. Generic scalar import cannot replace the employer-scoped tax election or grid; use the guarded Income Tax workflow.": "taxRelief",
  "Correct Hire Details selects the original assignment Cost Centre ID through the guarded correction owner, carries only proven inherited values and retains the prior audit. The cost-centre name report projection remains separate.": "hireCorrection",
  "The lifecycle Movement workflow validates coded exit reason, derives turnover classification and requires the associated dates before applying termination.": "termination",
};
const SECTION_TABS:Record<ImportSection,string>={profile:'Profile',bank_statutory:'Bank & Statutory',family:'Family',qualification:'Qualification',emergency:'Profile'};
const TAB_KEYS:Readonly<Record<string,string>>={Profile:'profile',Family:'family',Employment:'job','Employment History':'careerMovement',Attendance:'attendance','Bank & Statutory':'bankStatutory',Payroll:'payroll',Leave:'leave',Documents:'documents',Qualification:'qualification',Others:'others'};
export function personnelImportExclusionReasonKey(field:PersonnelFieldDescriptor):string|undefined{return REASON_KEYS[field.import.disabledReason??''];}
/** A supported full column or repeated-record column is never advertised as unimportable.
 * Repeated captions for the same saved fact also keep the supported owner's status.
 */
export function personnelImportExclusions(choice:PersonnelImportChoice,fields:readonly PersonnelFieldDescriptor[]=PERSONNEL_FIELDS){
  const movementFields=new Set<string>([...Object.entries(MOVEMENT_FORM_IDS).filter(([key])=>key!=='reason').map(([,id])=>id),'employment_history.event_information.lastworkingdate']);
  const compatibilityIds=new Set<string>(PERSONNEL_IMPORT_COMPATIBILITY.map(adapter=>adapter.fieldId));
  const carried=new Set(fields.filter(field=>field.import.column||field.import.register||compatibilityIds.has(field.id)).map(field=>JSON.stringify([field.owner,field.ownerField,field.grain])));
  return fields.filter(field=>!movementFields.has(field.id)&&!field.import.column&&!field.import.register && !carried.has(JSON.stringify([field.owner,field.ownerField,field.grain])) && (choice==='full'||choice==='movement'&&field.tab==='Employment History'||choice!=='movement'&&field.tab===SECTION_TABS[choice] && (choice!=='emergency'||field.owner==='emergencyContact')));
}
export function personnelImportExclusionEntries(choice:PersonnelImportChoice,resolve:PersonnelLabelResolver){
  return personnelImportExclusions(choice).map(field=>{
    const reasonKey=personnelImportExclusionReasonKey(field);
    return {id:field.id,tab:resolve('people.detail.tabs.'+TAB_KEYS[field.tab],field.tab),label:field.import.exclusionLabelKey?resolve(field.import.exclusionLabelKey,field.label):personnelFieldLabel(field,resolve),reason:reasonKey?resolve('people.import.exclusionReasons.'+reasonKey,field.import.disabledReason!):field.import.disabledReason??resolve('people.import.exclusionReasons.editor','Use the Personnel section for this value.')};
  });
}
/** Both workbook producers consume the same explanations that HR can read before uploading. */
export function personnelImportExclusionRows(choice:PersonnelImportChoice,resolve:PersonnelLabelResolver):string[][]{
  const entries=personnelImportExclusionEntries(choice,resolve);
  if(!entries.length)return [];
  return [[resolve('people.import.exclusionsTitle','Fields managed in Personnel')],['','',resolve('people.import.exclusionsHint','These fields are not entered through an employee import. Use the listed Personnel tab for their available actions.')],[],[resolve('people.import.exclusionsTab','Personnel tab'),resolve('people.import.exclusionsField','Field'),resolve('people.import.exclusionsReason','Why and where to go')],...entries.map(entry=>[entry.tab,entry.label,entry.reason])];
}
