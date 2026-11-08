/** Field edits owned by the General tab, in reading/write order. Record lifecycle stays separate.
 * Approved 6a2b463a relocates the sole SSM/TIN editor here; its country owner still stores the values.
 */
export const COMPANY_GENERAL_TAB_SECTION_ORDER = ['company', 'registration', 'cycle', 'parent'] as const;
export type CompanyGeneralTabSection = (typeof COMPANY_GENERAL_TAB_SECTION_ORDER)[number];
