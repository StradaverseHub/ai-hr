/**
 * The `CountryPack` contract (ADR-0080 D1) — the explicit interface a jurisdiction pack implements.
 *
 * Before this file existed the registry derived its pack type FROM `myPack` (`type CountryPack =
 * typeof myPack`) — backwards: Malaysia defined the contract. Rung 1 of the ADR-0080 retrofit ladder
 * inverts that: this interface owns the shape, `myPack` is annotated `: CountryPack`, and
 * `packFor()` returns `CountryPack | undefined`.
 *
 * Scope honesty (rung 1 = no behaviour change): the STRUCTURE below is contract-owned, but several
 * member signatures are still derived from the MY implementation via type-only
 * `typeof import('./my/…')` accessors — the DB-backed CRUD surfaces whose row types are inferred
 * from the drizzle schema, and the composite `payroll.statutory` calculator. Rung 5 (the country
 * seam restoration, ADR-0080 §5) nominalizes those signatures as part of the D6 vocabulary work.
 * Until a second pack stress-tests it, expect this interface to be wrong in places (ADR-0080 §7,
 * "Interface churn" risk) — it is internal, so revisions stay cheap.
 *
 * Extension points that do NOT exist yet (deliberately absent, not forgotten):
 *   - D4 UI descriptors (configuration sections, personnel-profile cards, report entries) — land in
 *     rung 5b/5c when country UI mounting becomes registry-driven. Kept off the interface until then
 *     so nothing speculative accretes.
 *
 * Rung 5a (kernel seam restoration) added the D6 engine vocabulary as first-class fields — state
 * labels, IC helpers, PCB exemption tables/remuneration types, TP1 relief caps, the pay-component
 * seed catalog, and the EA field list — so no `core/` file imports `localization/my` any more (the
 * R55 `MY_PCB_EXEMPTION_CODES` precedent, corrected). The kernel consumes whatever the active pack
 * supplies via `packFor()` / `requirePackFor()`; a missing pack FAILS LOUDLY (ADR-0080 D3).
 *
 * This file is type-only at runtime: every import is `import type` or a type-position
 * `typeof import(…)`, so importing the contract never drags in db/client or the MY tables.
 */
import type { SessionContext, Tx } from '../db/client';
import type { Tp1CategoryKey } from '../db/schema';
import type { MyLeaveTypeDef } from './my/leave';
import type { MyHoliday } from './my/holidays';
import type {
  EpfElection,
  OtDay,
  OvertimePayResult,
  PcbAccumulators,
  PcbMonthResult,
  TaxProfile,
} from './my/payroll';
import type {
  HrdfStatus,
  PcbExemptionTable,
  PcbRemunerationType,
  StatutoryBody,
  StatutoryRuleset,
} from './my/statutory-tables';
import type {
  ActiveResolution,
  StatutoryComponentRow,
  StatutoryPackRow,
  StatutoryRulesetRow,
  StatutorySource,
} from './my/statutory-config';
import type { EaField, EaOverrideEntry, EaStatement, ReportDef, ReportResult } from './my/reports';
import type { PayComponentSeed } from './my/pay-components';

// ── Contract-fronted vocabulary types (rung 5a) ────────────────────────────────────────────────────
// Kernel consumers import these FROM THE CONTRACT, never from localization/my (D1/D7). The shapes are
// still MY-derived (see the scope-honesty note above); nominalization is future interface churn.
export type {
  EaField,
  EaOverrideEntry,
  EaStatement,
  ReportDef,
  ReportResult,
  PcbExemptionTable,
  PcbRemunerationType,
  PayComponentSeed,
};

// ── MY-derived signature accessors (type-only; nominalized in rung 5, see header) ──────────────────
type MyStatutoryModule = typeof import('./my/statutory');
type MyCompanyStatutoryModule = typeof import('./my/company-statutory');
type MyStatutoryConfigModule = typeof import('./my/statutory-config');
type MyPayrollModule = typeof import('./my/payroll');

/**
 * A jurisdiction's compliance surface. One implementation per country, registered under the
 * company's ISO alpha-2 `company.country` code; the kernel resolves it via `packFor()` and never
 * names a jurisdiction directly (enforced by the drift-guard ratchet, ADR-0080 D7).
 */
export interface CountryPack {
  /** ISO alpha-2 country code (uppercase) — the registry key, matching `company.country`. */
  country: string;

  /**
   * The jurisdiction's state/territory labels (MY: the 16 gazette states + federal territories) —
   * D6 vocabulary consumed by holiday-group validation, location state overrides, and the
   * profile-option `state` catalog seed. Order is significant (it drives seed sortOrder).
   */
  states: readonly string[];

  /**
   * Per-employee statutory profile handlers: the full-row overwrite (`set`/`get`) plus the partial
   * card saves the profile UI grew over time (TP3 opening balances, bank, IC/passport identity,
   * tax, "others statutory"). Row shapes are drizzle-inferred → MY-derived signatures for now.
   */
  statutory: {
    set: MyStatutoryModule['setStatutoryProfileMY'];
    get: MyStatutoryModule['getStatutoryProfileMY'];
    setTp3: MyStatutoryModule['setTp3ProfileMY'];
    setBank: MyStatutoryModule['setBankProfileMY'];
    setIc: MyStatutoryModule['setIcProfileMY'];
    setPassport: MyStatutoryModule['setPassportProfileMY'];
    setTax: MyStatutoryModule['setTaxProfileMY'];
    setOthersStatutory: MyStatutoryModule['setOthersStatutoryMY'];
    /** National-ID validity check (MY: MyKad 12-digit IC). */
    validateIC: (ic: string) => boolean;
    /** Canonical storage form of a national ID (MY: digits only). */
    normalizeIC: (ic: string) => string;
    /** Date of birth derivable from the national ID (MY: MyKad YYMMDD prefix), or null. */
    dobFromIC: (ic: string, now?: Date) => string | null;
  };

  /** Company-level statutory registration (employer numbers, HRDF band, …). */
  companyStatutory: {
    set: MyCompanyStatutoryModule['setCompanyStatutoryMY'];
    get: MyCompanyStatutoryModule['getCompanyStatutoryMY'];
  };

  /** Statutory leave vocabulary + entitlement hooks the leave engine dispatches through. */
  leave: {
    types: MyLeaveTypeDef[];
    /** Entitlement in days for a leave-type code at a given completed years of service. */
    entitlement: (code: string, serviceYears: number) => number;
    /** Annual-leave entitlement in days (the EA s.60E ladder for MY). */
    annualEntitlement: (serviceYears: number) => number;
  };

  /** Seed holiday calendar (pack-provided defaults; tenants own their calendars after provisioning). */
  holidays: MyHoliday[];

  /** Payroll calculators + the ruleset loaders the kernel threads through a run. */
  payroll: {
    /**
     * All statutory contributions for one employee-month (EPF/SOCSO/EIS/PCB composite). The widest
     * signature on the pack — MY-derived until rung 5 splits its options into contract vocabulary.
     */
    statutory: MyPayrollModule['statutory'];
    epf: (
      wage: number,
      additional?: number,
      cfg?: StatutoryRuleset['epf'],
      election?: EpfElection,
    ) => { employee: number; employer: number };
    socso: (
      wage: number,
      category?: 1 | 2,
      cfg?: StatutoryRuleset['socso'],
    ) => { employer: number; employee: number; skbbk: number };
    eis: (wage: number, cfg?: StatutoryRuleset['eis']) => { employer: number; employee: number };
    pcbMonth: (p: {
      monthlyWage: number;
      epfMonthly: number;
      month: number;
      profile?: TaxProfile;
      acc?: PcbAccumulators;
      additional?: number;
      epfOnAdditional?: number;
      lpCurrent?: number;
      zakatCurrent?: number;
      pcb?: StatutoryRuleset['pcb'];
    }) => PcbMonthResult;
    overtimePay: (p: {
      monthlyWages: number;
      days: OtDay[];
      normalDailyHours?: number;
      wageCeiling?: number;
      restDayExcessMultiplier?: number;
      holidayExcessMultiplier?: number;
    }) => OvertimePayResult;
    hrdfLevy: (
      base: number,
      status: HrdfStatus,
      cfg?: { mandatoryRate: number; optionalRate: number },
    ) => number;
    /** Effective per-employee HRDF subjectivity (tri-state flag resolved against the employer band). */
    hrdfSubject: (subjectToHrdf: boolean | null | undefined, status: HrdfStatus) => boolean;
    /** EPF relief cap (RM) used by the PCB accumulator maths. */
    epfReliefCap: number;
    /**
     * D6 (the corrected R55 shape): the built-in PCB exemption / optional-deduction (LP) code→cap
     * tables. The kernel uses these as the FALLBACK when a resolved ruleset predates them
     * (`rules.pcbExemptions` absent) — it never names the MY tables directly.
     */
    pcbExemptionTables: { pcb: PcbExemptionTable; lp: PcbExemptionTable };
    /** The remuneration-type vocabulary for pay-code PCB classification (D6). */
    pcbRemunerationTypes: readonly PcbRemunerationType[];
    /** Exemption-code list valid for a remuneration type (defaults to the built-in tables). */
    pcbExemptionCodesFor: (
      type: PcbRemunerationType,
      tables?: { pcb: PcbExemptionTable; lp: PcbExemptionTable },
    ) => PcbExemptionTable;
    /**
     * Sourced per-category caps for the TP1 optional-relief declaration (MY: LHDN 2026 MTD reliefs —
     * only the categories with a VERIFIED statutory number carry a cap; the rest are uncapped by
     * design, ADR-0008 "no unsourced statutory number").
     */
    taxReliefCategoryCaps: Readonly<Partial<Record<Tp1CategoryKey, number>>>;
    /** Active-ruleset loader (ADR-0019): DB override or the verified default, as of a date. */
    loadRuleset: (tx: Tx, p: { asOf: string }) => Promise<StatutoryRuleset>;
    /** Same resolution + pack provenance (ADR-0020 §7) for payslip snapshotting. */
    loadRulesetResolved: (tx: Tx, p: { asOf: string }) => Promise<ActiveResolution>;
  };

  /**
   * Editable statutory configuration (ADR-0019): the admin view/edit/audit surface, vendor pack
   * distribution (ADR-0020), and per-body component overrides (ADR-0037).
   */
  statutoryConfig: {
    readActive: MyStatutoryConfigModule['readActiveStatutoryMY'];
    list: (ctx: SessionContext) => Promise<StatutoryRulesetRow[]>;
    save: (
      ctx: SessionContext,
      input: { effectiveFrom: string; version: string; data: StatutoryRuleset; notes?: string | null },
    ) => Promise<{ id: string }>;
    archive: (ctx: SessionContext, id: string) => Promise<void>;
    validate: (data: StatutoryRuleset) => string[];
    /** The verified built-in ruleset (transparency cards + fallback resolution). */
    default: StatutoryRuleset;
    /** Per-section source metadata driving the transparency cards. */
    sources: StatutorySource[];
    listPacks: (ctx: SessionContext) => Promise<StatutoryPackRow[]>;
    syncStatus: (ctx: SessionContext) => Promise<{
      latestIngested: string | null;
      lastSync: { ranAt: string; ingested: number; failed: number; error: string | null } | null;
    }>;
    listComponents: (ctx: SessionContext) => Promise<StatutoryComponentRow[]>;
    setComponent: (
      ctx: SessionContext,
      input: { body: StatutoryBody; effectiveFrom: string; version: string; data: unknown; notes?: string | null },
    ) => Promise<{ id: string }>;
    archiveComponent: (ctx: SessionContext, id: string) => Promise<void>;
    validateComponent: (body: StatutoryBody, data: unknown) => string[];
  };

  /**
   * Pay-component vocabulary (D6): the default catalog the tenant seed installs and the
   * backfill-critical code roles the legacy→typed bridge looks up. Flags are jurisdiction facts
   * (EPF/SOCSO/PCB/HRDF treatment), so the seed belongs to the pack, not the kernel.
   */
  payComponents: {
    defaults: PayComponentSeed[];
    backfillCodes: { basic: string; allowance: string; overtime: string; bonus: string; claim: string };
  };

  /** The EA-statement field vocabulary the EA-only amendment layer (core/ea-override.ts) validates against. */
  eaFields: readonly EaField[];

  /** Statutory report catalog (CP39, SOCSO/EIS files, …) the reporting engine enumerates. */
  reports: ReportDef[];

  /** EA-statement generator (annual employee statement; MY: Borang EA). */
  eaStatement: (
    ctx: SessionContext,
    p: { employmentId: string; year: string },
  ) => Promise<EaStatement | null>;
}
