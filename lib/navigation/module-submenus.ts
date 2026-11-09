/** Canonical route declarations only. Renderers retain their existing visibility,
 * translation, draft and context-carry owners. IDs do not grant page access. */
export const SYSTEM_LABEL_SUBMENU = [
 {id:'submenu.systemLabels.organisation',key:'organisation',href:'/admin/settings/system-labels',labelKey:'organisation'},
 {id:'submenu.systemLabels.profileOptions',key:'profile-options',href:'/admin/settings/system-labels/profile-options',labelKey:'profileOptions'},
] as const;
export const CLAIMS_SUBMENU = [
 {id:'submenu.claims.types',key:'types',href:'/admin/claims',labelKey:'types'},
 {id:'submenu.claims.limits',key:'limits',href:'/admin/claims/limits',labelKey:'limits'},
 {id:'submenu.claims.mileage',key:'mileage',href:'/admin/claims/mileage',labelKey:'mileage'},
 {id:'submenu.claims.reimbursements',key:'reimbursements',href:'/admin/claims/reimbursements',labelKey:'reimbursements'},
] as const;
export const ATTENDANCE_SUBMENU = [
 {id:'submenu.attendance.overview',key:'overview',href:'/attendance',labelKey:'overview'},
 {id:'submenu.attendance.daily',key:'daily',href:'/attendance/daily',labelKey:'daily'},
 {id:'submenu.attendance.individual',key:'individual',href:'/attendance/individual',labelKey:'individual'},
] as const;
export const HOLIDAY_SUBMENU = [
 {id:'submenu.holidays.holidays',key:'holidays',href:'/admin/holidays',labelKey:'holidays'},
 {id:'submenu.holidays.groups',key:'groups',href:'/admin/holidays/groups',labelKey:'groups'},
] as const;
export const STATUTORY_SUBMENU = [
 {id:'submenu.statutory.overview',key:'overview',href:'/payroll/configuration',labelKey:'tabOverview'},
 {id:'submenu.statutory.epf',key:'epf',href:'/payroll/configuration/epf',labelKey:'body_epf'},
 {id:'submenu.statutory.socso',key:'socso',href:'/payroll/configuration/socso',labelKey:'body_socso'},
 // SKBBK is the employee-paid leg on SOCSO bands, not an independently versioned body.
 {id:'submenu.statutory.skbbk',key:'skbbk',href:'/payroll/configuration/skbbk',labelKey:'body_skbbk'},
 {id:'submenu.statutory.eis',key:'eis',href:'/payroll/configuration/eis',labelKey:'body_eis'},
 {id:'submenu.statutory.pcb',key:'pcb',href:'/payroll/configuration/pcb',labelKey:'body_pcb'},
 {id:'submenu.statutory.hrdf',key:'hrdf',href:'/payroll/configuration/hrdf',labelKey:'body_hrdf'},
] as const;
export const REWARDS_ADMIN_SUBMENU = [
 {id:'submenu.rewards.configuration',key:'configuration',href:'/admin/rewards',labelKey:'configuration'},
 {id:'submenu.rewards.plans',key:'shared',href:'/admin/rewards/plans',labelKey:'shared'},
 {id:'submenu.rewards.salary',key:'salary',href:'/admin/rewards/salary-structures',labelKey:'salary'},
 {id:'submenu.rewards.bonus',key:'bonus',href:'/admin/rewards/bonus-matrices',labelKey:'bonus'},
 {id:'submenu.rewards.pat',key:'pat',href:'/admin/rewards/pat-inputs',labelKey:'pat'},
 {id:'submenu.rewards.access',key:'access',href:'/admin/rewards/access',labelKey:'access'},
] as const;
export const LEAVE_INQUIRY_SUBMENU = [
 {id:'submenu.leaveInquiry.balances',key:'balances',href:'/leave/employee-balances',labelKey:'employeeBalances'},
 {id:'submenu.leaveInquiry.records',key:'records',href:'/leave/employee-records',labelKey:'employeeLeaveRecord'},
] as const;

/** Catalogue composition consumes these exact renderer-owned references. */
export const MODULE_SUBMENU_REGISTRIES = [
 {id:'systemLabels',rendererOwner:'components/system-labels-tabs.tsx',items:SYSTEM_LABEL_SUBMENU},
 {id:'claims',rendererOwner:'components/claims-tabs.tsx',items:CLAIMS_SUBMENU},
 {id:'attendance',rendererOwner:'components/attendance-tabs.tsx',items:ATTENDANCE_SUBMENU},
 {id:'holidays',rendererOwner:'components/holiday-tabs.tsx',items:HOLIDAY_SUBMENU},
 {id:'statutory',rendererOwner:'components/statutory-tabs.tsx',items:STATUTORY_SUBMENU},
 {id:'rewardsAdmin',rendererOwner:'app/admin/rewards/admin-tabs.tsx',items:REWARDS_ADMIN_SUBMENU},
 {id:'leaveInquiry',rendererOwner:'components/leave/leave-inquiry-nav.tsx',items:LEAVE_INQUIRY_SUBMENU},
] as const;
