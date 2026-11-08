import {ESS_PROFILE_TABS} from './personnel-ess-model';

/** Exact compatibility tuple moved from app/me/visible-fields; no scope or policy change. */
export const PERSONNEL_TAB_KEYS = ['profile','family','job','careerMovement','attendance','bankStatutory','payroll','leave','documents','qualification','others'] as const;
export type PersonnelTabKey=(typeof PERSONNEL_TAB_KEYS)[number];
/** Stable metadata only. Native pages retain all record/ESS authority and state. */
const navigation:Record<PersonnelTabKey,{recordNavigationId:string|null;essNavigationId:string;essSection:(typeof ESS_PROFILE_TABS)[number]}>= {
 profile:{recordNavigationId:'nested.personnelRecord.profile',essNavigationId:'nested.essProfile.profile',essSection:ESS_PROFILE_TABS[0]},
 family:{recordNavigationId:'nested.personnelRecord.family',essNavigationId:'nested.essProfile.family',essSection:ESS_PROFILE_TABS[1]},
 job:{recordNavigationId:'nested.personnelRecord.job',essNavigationId:'nested.essProfile.job',essSection:ESS_PROFILE_TABS[2]},
 careerMovement:{recordNavigationId:'nested.personnelRecord.careerMovement',essNavigationId:'nested.essProfile.careerMovement',essSection:ESS_PROFILE_TABS[3]},
 attendance:{recordNavigationId:'nested.personnelRecord.attendance',essNavigationId:'nested.essProfile.attendance',essSection:ESS_PROFILE_TABS[4]},
 bankStatutory:{recordNavigationId:'nested.personnelRecord.bankStatutory',essNavigationId:'nested.essProfile.bankStatutory',essSection:ESS_PROFILE_TABS[5]},
 payroll:{recordNavigationId:'nested.personnelRecord.payroll',essNavigationId:'nested.essProfile.payroll',essSection:ESS_PROFILE_TABS[6]},
 leave:{recordNavigationId:'nested.personnelRecord.leave',essNavigationId:'nested.essProfile.leave',essSection:ESS_PROFILE_TABS[7]},
 documents:{recordNavigationId:'nested.personnelRecord.documents',essNavigationId:'nested.essProfile.documents',essSection:ESS_PROFILE_TABS[8]},
 qualification:{recordNavigationId:'nested.personnelRecord.qualification',essNavigationId:'nested.essProfile.qualification',essSection:ESS_PROFILE_TABS[9]},
 others:{recordNavigationId:null,essNavigationId:'nested.essProfile.others',essSection:ESS_PROFILE_TABS[10]},
};
export const PERSONNEL_TAB_DEFINITIONS=PERSONNEL_TAB_KEYS.map(key=>({key,...navigation[key]}));
// Others remains an ESS section; the activated Personnel page retired it.
export const PERSONNEL_RECORD_TAB_DEFINITIONS=PERSONNEL_TAB_DEFINITIONS.flatMap(tab=>tab.recordNavigationId===null?[]:[{key:tab.key,navigationId:tab.recordNavigationId}]);
export const ESS_PROFILE_TAB_DEFINITIONS=PERSONNEL_TAB_DEFINITIONS.map(tab=>({key:tab.key,navigationId:tab.essNavigationId,section:tab.essSection}));
