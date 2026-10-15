/** Client-safe closed sets consumed by Personnel and the authoritative schema/service owners. */
export const PERSONNEL_PAY_MODES=['monthly','daily','hourly','custom_period'] as const;
export const PERSONNEL_PAYMENT_TERMS=['monthly','weekly','biweekly'] as const;
export const PERSONNEL_EPF_CITIZENSHIPS=['citizen','pr','non_citizen'] as const;
export const PERSONNEL_SOCSO_CATEGORIES=['auto','first','second','none'] as const;
export const PERSONNEL_EIS_CATEGORIES=['auto','none'] as const;
export const PERSONNEL_CHILD_RELIEF_MODES=['manual','auto','auto_table'] as const;
export const PERSONNEL_TAX_RESIDENCIES=['resident','non_resident','rep','knowledge_worker','c_suite'] as const;
