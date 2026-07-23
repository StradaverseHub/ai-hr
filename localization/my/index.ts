/**
 * Malaysia localization pack (ADR-0008). Slice 1 ships the statutory profile; leave rules,
 * holiday calendar, and payroll calculators (EPF/SOCSO/EIS/PCB) join here in later slices.
 */
import { defaultSocsoEisNumber, dobFromIC, getStatutoryProfileMY, isValidIC, normalizeIC, setBankProfileMY, setIcProfileMY, setOthersStatutoryMY, setPassportProfileMY, setStatutoryProfileMY, setTaxProfileMY, setTp3ProfileMY } from './statutory';
import { annualEntitlement, entitlement, MY_LEAVE_TYPES } from './leave';
import { MY_HOLIDAYS_2026, MY_STATES } from './holidays';
import { eis, epf, hrdfLevy, hrdfSubject, overtimePay, pcbMonth, socso, statutory } from './payroll';
import {
  DEFAULT_MY_STATUTORY,
  MY_EPF_THIRD_SCHEDULE_PART_A,
  MY_EPF_THIRD_SCHEDULE_PART_E,
  MY_HRDF,
  MY_LP_OPTIONAL_DEDUCTION_CODES,
  MY_PCB_EXEMPTION_CODES,
  MY_RELIEFS,
  PCB_REMUNERATION_TYPES,
  pcbExemptionCodesFor,
} from './statutory-tables';
import { MY_CONFIG_SECTIONS } from './config-sections';
import { seedReferenceDataMY } from './provision';
import { myClientPack } from './client';
import { BACKFILL_COMPONENT_CODES, MY_DEFAULT_PAY_COMPONENTS } from './pay-components';
import { EA_FIELDS } from './reports';
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
import { getCompanyStatutoryMY, listCompanyStatutoryMY, setCompanyStatutoryMY } from './company-statutory';
import { eaStatement, MY_REPORTS } from './reports';
import type { CountryPack } from '../country-pack';

// ADR-0080 D1: the pack implements the registry-owned CountryPack contract (previously the
// registry derived its type FROM this object — backwards).
export const myPack: CountryPack = {
  country: 'MY' as const,
  // Rung 5b (ADR-0080 D4) — the client-safe vocabulary slice, ALSO served to 'use client'
  // components by localization/registry.client.ts (this reference makes it contract-declared).
  client: myClientPack,
  // Rung 5a (ADR-0080 D6) — jurisdiction state labels, consumed by holiday groups, location state
  // overrides, and the profile-option 'state' catalog seed via the registry.
  states: MY_STATES,
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
    // Item e3ce0d4d — non-Malaysian identity: save the passport identification block (skips MyKad IC validation).
    // The counterpart to setIc; the identity form on the Profile tab picks one based on the selected nationality.
    setPassport: setPassportProfileMY,
    setTax: setTaxProfileMY,
    // Feedback 0df0c635 — partial save of only the Others Statutory controls (today: subject_to_hrdf).
    // The Others Statutory card on the Bank & Statutory tab saves through this, like setTp3/setBank/setTax.
    setOthersStatutory: setOthersStatutoryMY,
    validateIC: isValidIC,
    // Rung 5a (D6) — IC canonicalisation + MyKad-derived DOB, consumed by the bulk importer through
    // the pack instead of a direct localization/my import.
    normalizeIC,
    dobFromIC,
    // Rung 5c — the SOCSO/EIS blank-number default, consumed by the generic personnel + zakat screens
    // through the pack (previously a direct localization/my/statutory import).
    defaultSocsoEisNumber,
  },
  companyStatutory: {
    set: setCompanyStatutoryMY,
    get: getCompanyStatutoryMY,
    // Rung 5c — the group Organization admin panel reads every company's statutory row through the pack.
    list: listCompanyStatutoryMY,
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
    // Feedback 0df0c635 — effective per-employee HRDF subjectivity (tri-state subject_to_hrdf resolved
    // against the employer's registration band). D6 vocabulary: the kernel consumes it via the pack.
    hrdfSubject,
    epfReliefCap: MY_RELIEFS.epfReliefCap,
    // Rung 5c (D6) — the built-in HRDF levy rates; the OT/HRDF config + Attendance-policy screens'
    // fallback when a resolved ruleset predates the `hrdf` slice (they never name MY_HRDF directly).
    hrdfDefault: MY_HRDF,
    // Rung 5b (D6) — the built-in verified EPF Third Schedule tables; the statutory band-table
    // editor's fallback for stored overrides that predate partA/partE (threaded down as props by
    // the configuration pages).
    epfThirdSchedule: { partA: MY_EPF_THIRD_SCHEDULE_PART_A, partE: MY_EPF_THIRD_SCHEDULE_PART_E },
    // Rung 5a (D6 — the corrected R55 shape): the built-in LHDN PCB 2026 exemption/LP tables and the
    // remuneration-type vocabulary. The kernel's ruleset fallback and the pay-component classification
    // validator consume THESE, never the MY table names.
    pcbExemptionTables: { pcb: MY_PCB_EXEMPTION_CODES, lp: MY_LP_OPTIONAL_DEDUCTION_CODES },
    pcbRemunerationTypes: PCB_REMUNERATION_TYPES,
    pcbExemptionCodesFor,
    // Rung 5a (D6) — the TP1 categories with a VERIFIED LHDN cap (statutory-tables MY_RELIEFS).
    // `children` / EPF are per-unit caps and deliberately absent (see core/tax-relief.ts rationale).
    taxReliefCategoryCaps: { individual: MY_RELIEFS.individual, spouse: MY_RELIEFS.spouse },
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
  // Rung 5a (D6) — the default pay-component catalog (treatment flags are jurisdiction facts) and the
  // backfill-critical code roles core/pay-components resolves through the registry.
  payComponents: {
    defaults: MY_DEFAULT_PAY_COMPONENTS,
    backfillCodes: BACKFILL_COMPONENT_CODES,
  },
  // Rung 5a (D6) — the EA-form field vocabulary the EA-only amendment layer validates against.
  eaFields: EA_FIELDS,
  // Rung 5c (D4) — the country-admin configuration sections; the generic Statutory Configuration
  // landing page renders these instead of a hardcoded MY body list, and the config routes 404 unless
  // the acting company's pack declares their section.
  configSections: MY_CONFIG_SECTIONS,
  // Rung 5c (D5 / ADR-0079) — seed the MY leave-type catalog + holiday calendar into a new tenant;
  // db/provision.ts + db/seed.ts invoke this through the registry instead of importing the MY pack.
  seedReferenceData: seedReferenceDataMY,
  reports: MY_REPORTS,
  eaStatement,
};
