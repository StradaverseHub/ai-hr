/** One client-safe label owner shared by Personnel forms, import headers and reports. */
import type {PersonnelFieldDescriptor} from './personnel-field-registry';
export type PersonnelLabelResolver=(key:string,fallback:string)=>string;
type LabelDescriptor=PersonnelFieldDescriptor&{labelParts?:readonly string[];import:PersonnelFieldDescriptor['import']&{qualifier?:'value'|'unit'}};
export function personnelFieldLabel(field:PersonnelFieldDescriptor,resolve?:PersonnelLabelResolver):string{
 const descriptor=field as LabelDescriptor;
 if(!resolve)return field.label;
 if(descriptor.labelParts?.length){const parts=descriptor.labelParts.map(key=>resolve(key,''));return parts.every(Boolean)?parts.join(' — '):field.label;}
 const base=field.labelKey?resolve(field.labelKey,field.label):field.label;
 // Fallback labels already include the business qualifier. Add it only to a resolved base label.
 if(!descriptor.import.qualifier||base===field.label)return base;
 const unit=descriptor.import.qualifier==='unit';return base+' — '+resolve(unit?'people.import.fieldUnit':'people.import.fieldValue',unit?'Unit':'Value');
}
