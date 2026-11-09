/** Field edits owned by the General tab, in reading and write order. */
export const COMPANY_GENERAL_TAB_SECTION_ORDER = ['company', 'cycle', 'parent'] as const;
export type CompanyGeneralTabSection = (typeof COMPANY_GENERAL_TAB_SECTION_ORDER)[number];
