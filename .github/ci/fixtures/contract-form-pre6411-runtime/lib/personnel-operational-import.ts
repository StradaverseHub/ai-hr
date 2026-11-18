import {PERSONNEL_FIELDS} from './personnel-field-registry';
import {personnelScalarIssue} from './personnel-import-contract';
import {isPaymentMethod,type PaymentMethod} from './payment-methods';
import {ATTENDANCE_PHOTO_SETTINGS,type AttendancePhotoSetting} from './attendance-photo-setting';
export type PersonnelOperationalPatch={cardId?:string;attendancePhotoSetting?:AttendancePhotoSetting;paymentMethod?:PaymentMethod};
export const PERSONNEL_OPERATIONAL_FIELDS=PERSONNEL_FIELDS.filter(field=>field.import.writer==='operational');
export function personnelOperationalValues(record:Record<string,string>) {
 const values:PersonnelOperationalPatch={};const errors:string[]=[];
 for(const field of PERSONNEL_OPERATIONAL_FIELDS) {
  const column=field.import.column!,raw=(record[column]??'').trim();if(!raw)continue;
  const issue=personnelScalarIssue(field,raw);if(issue){errors.push(`${column}: invalid ${issue} value`);continue;}
  if(field.import.writerField==='cardId')values.cardId=raw;
  if(field.import.writerField==='attendancePhotoSetting' && (ATTENDANCE_PHOTO_SETTINGS as readonly string[]).includes(raw))values.attendancePhotoSetting=raw as AttendancePhotoSetting;
  if(field.import.writerField==='paymentMethod' && isPaymentMethod(raw))values.paymentMethod=raw;
 }
 return {values,errors};
}
