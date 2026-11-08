/** Canonical Personnel record tab declarations, never availability or permission.
 * Native readers/page bodies and ClientTabs still own data and interaction. */
import {RETIRED_PERSONNEL_TABS} from './personnel-tab-sections';
export const PERSONNEL_RECORD_TABS = [
 {id:'personnel-record.profile',key:'profile',labelKey:'tabs.profile'},
 {id:'personnel-record.family',key:'family',labelKey:'tabs.family'},
 {id:'personnel-record.job',key:'job',labelKey:'tabs.job'},
 {id:'personnel-record.careerMovement',key:'careerMovement',labelKey:'tabs.careerMovement'},
 {id:'personnel-record.attendance',key:'attendance',labelKey:'tabs.attendance'},
 {id:'personnel-record.bankStatutory',key:'bankStatutory',labelKey:'tabs.bankStatutory'},
 {id:'personnel-record.payroll',key:'payroll',labelKey:'tabs.payroll'},
 {id:'personnel-record.leave',key:'leave',labelKey:'tabs.leave'},
 {id:'personnel-record.documents',key:'documents',labelKey:'tabs.documents'},
 {id:'personnel-record.qualification',key:'qualification',labelKey:'tabs.qualification'},
 ] as const;
export type PersonnelRecordTabKey=(typeof PERSONNEL_RECORD_TABS)[number]['key'];
/** Retired keys remain a compatibility vocabulary; their redirect owner is reused. */
export type PersonnelRecordCompatibleTabKey=PersonnelRecordTabKey|keyof typeof RETIRED_PERSONNEL_TABS;
export const PERSONNEL_RECORD_RETIRED_NAVIGATION=[
 {id:'personnel-record.others',key:'others',targetKey:RETIRED_PERSONNEL_TABS.others,redirectOwner:RETIRED_PERSONNEL_TABS},
] as const;
