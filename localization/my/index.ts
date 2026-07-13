/**
 * Malaysia localization pack (ADR-0008). Slice 1 ships the statutory profile; leave rules,
 * holiday calendar, and payroll calculators (EPF/SOCSO/EIS/PCB) join here in later slices.
 */
import { getStatutoryProfileMY, isValidIC, setBankProfileMY, setIcProfileMY, setStatutoryProfileMY, setTaxProfileMY, setTp3ProfileMY } from './statutory';
import { annualEntitlement, entitlement, MY_LEAVE_TYPES } from './leave';
import { MY_HOLIDAYS_2026 } from './holidays';
import { eis, epf, hrdfLevy, overtimePay, pcbMonth, socso, statutory } from './payroll';
import { DEFAULT_MY_STATUTORY, MY_RELIEFS } from './statutory-tables';
import {
  archiveComponentOverrideMY,
  archiveStatutoryRulesetMY,
  getActiveStatutoryMY,
  getActiveStatutoryResolvedMY,
  listComponentOverridesMY,
  listStatutoryPacksMY,
  listStatutoryRulesetsMY,
  MY_STATUTORY_SOURCES,
  readActiveStatutoryMY,
  saveStatutoryRulesetMY,
  setComponentOverrideMY,
  statutorySyncStatusMY,
  validateStatutoryComponent,
  validateStatutoryRuleset,
} from './statutory-config';
import { getCompanyStatutoryMY, setCompanyStatutoryMY } from './company-statutory';
import { eaStatement, MY_REPORTS } from './reports';

export const myPack = {
  country: 'MY' as const,
  statutory: {
    set: setStatutoryProfileMY,
    get: getStatutoryProfileMY,
    // Partial save of only the four TP3 opening-balance columns (item a6a47698 — TP3 relocated to the
    // Payroll tab with its own save; the full statutory overwrite no longer carries these).
    setTp3: setTp3ProfileMY,
    // Partial save of only the salary-payment bank columns + custom-payment-holder controls (item ef720d3a —
    // Bank Information split out of the statutory form into its own card with its own save).
    setBank: setBankProfileMY,
    // Partial saves for the Identification & Tax card (item 8b5334db): IC relocated to the Profile tab (its own
    // seed setter), and the tax columns split into their own card with a dedicated partial save.
    setIc: setIcProfileMY,
    setTax: setTaxProfileMY,
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
    hrdfLevy,
    epfReliefCap: MY_RELIEFS.epfReliefCap,
    // Active-ruleset loader (ADR-0019): resolves the DB override or the verified default. The kernel
    // calls this once per run and threads the result into the calculators above.
    loadRuleset: getActiveStatutoryMY,
    // Resolved loader (ADR-0020 §7): same resolution + pack provenance (packVersion/signedKeyId) so the
    // kernel can snapshot which vendor pack + key produced each payslip.
    loadRulesetResolved: getActiveStatutoryResolvedMY,
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
    // Vendor pack distribution (ADR-0020): the pack panel + staleness signal.
    listPacks: listStatutoryPacksMY,
    syncStatus: statutorySyncStatusMY,
    // Per-body overrides (ADR-0037, #6): each statutory body versions independently via an overlay.
    listComponents: listComponentOverridesMY,
    setComponent: setComponentOverrideMY,
    archiveComponent: archiveComponentOverrideMY,
    validateComponent: validateStatutoryComponent,
  },
  reports: MY_REPORTS,
  eaStatement,
};
