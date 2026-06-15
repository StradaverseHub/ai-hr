/**
 * Malaysia localization pack (ADR-0008). Slice 1 ships the statutory profile; leave rules,
 * holiday calendar, and payroll calculators (EPF/SOCSO/EIS/PCB) join here in later slices.
 */
import { getStatutoryProfileMY, isValidIC, setStatutoryProfileMY } from './statutory';
import { annualEntitlement, entitlement, MY_LEAVE_TYPES } from './leave';
import { MY_HOLIDAYS_2026 } from './holidays';
import { eis, epf, overtimePay, pcbMonth, socso, statutory } from './payroll';
import { DEFAULT_MY_STATUTORY, MY_RELIEFS } from './statutory-tables';
import {
  archiveStatutoryRulesetMY,
  getActiveStatutoryMY,
  listStatutoryRulesetsMY,
  MY_STATUTORY_SOURCES,
  readActiveStatutoryMY,
  saveStatutoryRulesetMY,
  validateStatutoryRuleset,
} from './statutory-config';
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
  // Editable statutory configuration (ADR-0019): the admin view/edit/audit surface. The verified
  // DEFAULT and per-section source metadata drive the transparency cards.
  statutoryConfig: {
    readActive: readActiveStatutoryMY,
    list: listStatutoryRulesetsMY,
    save: saveStatutoryRulesetMY,
    archive: archiveStatutoryRulesetMY,
    validate: validateStatutoryRuleset,
    default: DEFAULT_MY_STATUTORY,
    sources: MY_STATUTORY_SOURCES,
  },
  reports: MY_REPORTS,
  eaStatement,
};
