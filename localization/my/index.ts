/**
 * Malaysia localization pack (ADR-0008). Slice 1 ships the statutory profile; leave rules,
 * holiday calendar, and payroll calculators (EPF/SOCSO/EIS/PCB) join here in later slices.
 */
import { getStatutoryProfileMY, isValidIC, setStatutoryProfileMY } from './statutory';
import { annualEntitlement, entitlement, MY_LEAVE_TYPES } from './leave';
import { MY_HOLIDAYS_2026 } from './holidays';
import { eis, epf, overtimePay, pcbMonth, socso, statutory } from './payroll';
import { MY_RELIEFS } from './statutory-tables';
import { getActiveStatutoryMY } from './statutory-config';
import { getCompanyStatutoryMY, setCompanyStatutoryMY } from './company-statutory';
import { eaStatement, MY_REPORTS } from './reports';

export const myPack = {
  country: 'MY' as const,
  statutory: {
    set: setStatutoryProfileMY,
    get: getStatutoryProfileMY,
    validateIC: isValidIC,
  },
  companyStatutory: {
    set: setCompanyStatutoryMY,
    get: getCompanyStatutoryMY,
  },
  leave: {
    types: MY_LEAVE_TYPES,
    entitlement,
    annualEntitlement,
  },
  holidays: MY_HOLIDAYS_2026,
  payroll: {
    statutory,
    epf,
    socso,
    eis,
    pcbMonth,
    overtimePay,
    epfReliefCap: MY_RELIEFS.epfReliefCap,
    // Active-ruleset loader (ADR-0019): resolves the DB override or the verified default. The kernel
    // calls this once per run and threads the result into the calculators above.
    loadRuleset: getActiveStatutoryMY,
  },
  reports: MY_REPORTS,
  eaStatement,
};
