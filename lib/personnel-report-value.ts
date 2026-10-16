/** Closed typed selector for multiple business cells owned by one canonical statutory table. */
import type {PersonnelFieldDescriptor} from './personnel-field-registry';
import type {MasterCell} from './employee-master-report';
export type PersonnelChildReliefCell={category:'under_18'|'study_preu'|'study_tertiary'|'disabled'|'disabled_study';share:'full'|'half'};
type ChildCellDescriptor=PersonnelFieldDescriptor&{childReliefCell?:PersonnelChildReliefCell};
export function personnelChildReliefCell(field:PersonnelFieldDescriptor):PersonnelChildReliefCell|undefined{
 const cell=(field as ChildCellDescriptor).childReliefCell;
 return field.owner==='statutory'&&field.ownerField==='childReliefTable'&&cell&&['under_18','study_preu','study_tertiary','disabled','disabled_study'].includes(cell.category)&&['full','half'].includes(cell.share)?cell:undefined;
}
export function personnelReportValueKey(field:PersonnelFieldDescriptor):string{return personnelChildReliefCell(field)?field.id:field.ownerField;}
export function personnelChildReliefValue(table:unknown,cell:PersonnelChildReliefCell):MasterCell{
 const group=table&&typeof table==='object'&&!Array.isArray(table)?(table as Record<string,unknown>)[cell.category]:undefined;
 const value=group&&typeof group==='object'&&!Array.isArray(group)?(group as Record<string,unknown>)[cell.share]:undefined;
 return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?{value,unit:'children'}:{value:null,unavailable:'not-recorded',unit:'children'};
}
