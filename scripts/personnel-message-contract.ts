/** Dynamic Personnel labels use the existing descriptor/choice vocabulary, across forms and imports. */
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {personnelFieldChoices} from '../lib/personnel-import-contract';
export function personnelClientMessageKeys(){
 const keys=new Set<string>();
 for(const field of PERSONNEL_FIELDS){
  if(field.labelKey)keys.add(field.labelKey);
  for(const key of (field as {labelParts?:readonly string[]}).labelParts??[])keys.add(key);
  for(const choice of personnelFieldChoices(field))if(choice.labelKey)keys.add(choice.labelKey);
 }
 return [...keys].sort();
}
const vocabulary=[...new Set(['people','me','attendance',...personnelClientMessageKeys()])].sort();
/** These components resolve only the shared Personnel vocabulary or their explicit namespaced hooks.
 * New unscoped consumers remain unknown and retain the full catalog until their owner is declared. */
export const unscopedClientMessageContracts:Readonly<Record<string,readonly string[]>>=Object.fromEntries([
 'app/me/profile-editor.tsx','components/personnel-field.tsx','components/download-template.tsx',
 'components/same-as-permanent-address.tsx','components/overtime-patterns/choice-label.ts',
 'components/attendance/location-assignment.tsx','components/assistant/module-profile-action-panel.tsx',
 'components/personnel-import-preparation-review.tsx','components/personnel-import-evidence-review.tsx','components/personnel-import-values.tsx',
 'app/admin/personnel/import/import-explanations.tsx','app/admin/personnel/import/employee-import.tsx',
 'app/admin/personnel/import/movement-import.tsx','app/admin/personnel/import/bank-import-progress.tsx',
 'app/admin/personnel/import/section-import.tsx','app/admin/personnel/new/wizard.tsx',
 'app/admin/personnel/new/family-step.tsx','app/admin/personnel/[employmentId]/hire-correction-form.tsx',
].map(file=>[file,vocabulary]));
