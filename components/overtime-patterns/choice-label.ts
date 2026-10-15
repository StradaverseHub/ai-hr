'use client';
import {useTranslations} from 'next-intl';
import type {OvertimeChoice} from './rule-controls';
/** Reuse the existing Personnel/Attendance vocabulary labels; configured labels remain stored data. */
export function useOvertimeChoiceText() {
  const t=useTranslations();
  return (field:string,option:OvertimeChoice)=>{
    const key=field==='employmentType'?`people.detail.employmentInfo.employmentType_${option.id}`:
      field==='dayType'?`attendance.dayEdit.kind.${option.id}`:
      field==='attendanceStatus'?`me.attStatus.${option.id}`:null;
    return key&&t.has(key)?t(key):option.label;
  };
}
