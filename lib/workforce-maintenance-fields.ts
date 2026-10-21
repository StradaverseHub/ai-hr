import {PERSONNEL_FIELDS,personnelField} from './personnel-field-registry';
import {WORKFORCE_PROFILE_FIELDS} from './workforce-record-fields';
export type WorkforceMaintenanceKind='person'|'qualification'|'emergency';
export type WorkforceMaintenanceOperation='add'|'update'|'archive';
export type WorkforceValue=string|boolean|null;
export const WORKFORCE_PROFILE_SECTIONS=[
 {key:'personal',title:'personalDetails',prefix:'profile.personal_details.'},
 {key:'contact',title:'contactAddressTitle',prefix:'profile.contact_and_permanent_address.'},
 {key:'correspondence',title:'correspondenceAddressTitle',prefix:'profile.correspondence_address.'},
] as const;
export function workforceMaintenanceFields(kind:WorkforceMaintenanceKind,section?:string){
 if(kind==='person'){
  const group=WORKFORCE_PROFILE_SECTIONS.find(item=>item.key===section);
  return WORKFORCE_PROFILE_FIELDS.filter(f=>!section||group&&f.fieldId.startsWith(group.prefix)).map(f=>({key:f.key as string,field:personnelField(f.fieldId)!}));
 }
 return PERSONNEL_FIELDS.filter(f=>f.ess.binding?.owner===kind).map(field=>({key:field.ess.binding!.field,field}));
}
