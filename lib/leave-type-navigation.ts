/** Storage keys, not translated labels or record identities. Preserve their exact order. */
export const TAB_KEYS = ['identity', 'eligibility', 'entitlement', 'application', 'approvers'] as const;
export type TabKey=(typeof TAB_KEYS)[number];
const navigation:Record<TabKey,string>={
 identity:'nested.leaveType.identity',eligibility:'nested.leaveType.eligibility',entitlement:'nested.leaveType.entitlement',application:'nested.leaveType.application',approvers:'nested.leaveType.approvers',
};
export const LEAVE_TYPE_TAB_DEFINITIONS=TAB_KEYS.map(key=>({key,navigationId:navigation[key]}));
/** The choice has a bound record parameter; UUIDs never become declaration IDs. */
export const LEAVE_TYPE_WORKSPACE_CHOICE={navigationId:'nested.leaveTypeWorkspace.selection'} as const;
export function leaveTypeTabNavigation(key:TabKey){return navigation[key];}
