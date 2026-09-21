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
 *   - D4 route/section mounting descriptors (configuration sections, report entries) — land in
 *     rung 5c when country UI ROUTE mounting becomes registry-driven. Kept off the interface until
 *     then so nothing speculative accretes. Rung 5b added the first D4 slice: the CLIENT-SAFE
 *     vocabulary (`CountryPackClient`, the `client` field below) that shared `components/` widgets
 *     consume through `localization/registry.client.ts` instead of importing `localization/my`.
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
import type { Pcb2iiForm } from '../lib/pcb2ii-form';

/**
 * ADR-0024 §7 worksheet vocabulary, RE-EXPORTED from the contract so a generic screen can name the
 * worksheet's shape without importing the MY pack (ADR-0080 D7 — the drift ratchet counts a type-only
 * import as coupling, and it is right to). Type-only, so this adds nothing at runtime.
 */
export type {
  Figures as WorksheetFigures,
  MultiCycleWorksheet,
  WorksheetItem,
  WorksheetRow,
  WorksheetRunView,
  WorksheetSkip,
  WorksheetSkipReason,
  WorksheetVerdict,
} from './my/multicycle-worksheet';

import type { Tp1CategoryKey } from '../db/schema';
import type { MyLeaveTypeDef } from './my/leave';
import type { MyHoliday } from './my/holidays';
import type {
  EpfElection,
  EpfMode,
  OtDay,
  OvertimePayResult,
  PcbAccumulators,
  PcbMonthResult,
  TaxProfile,
} from './my/payroll';
import type {
  ContribBand,
  HrdfStatus,
  PcbExemptionTable,
  PcbRemunerationType,
  SocsoBand,
  StatutoryBody,
  StatutoryRuleset,
  Tp1CatalogueItem,
} from './my/statutory-tables';
import type {
  ActiveResolution,
  StatutoryComponentRow,
  StatutoryPackRow,
  StatutoryRulesetRow,
  StatutorySource,
} from './my/statutory-config';
import type {
  EaField,
  EaOverrideEntry,
  EaStatement,
  FormFidelity,
  FormOutput,
  PlannedFormDef,
  ReportDef,
  ReportResult,
  StatutoryBodyKey,
  StatutoryFormLink,
} from './my/reports';
import type { PayComponentSeed } from './my/pay-components';

// ── Contract-fronted vocabulary types (rung 5a) ────────────────────────────────────────────────────
// Kernel consumers import these FROM THE CONTRACT, never from localization/my (D1/D7). The shapes are
// still MY-derived (see the scope-honesty note above); nominalization is future interface churn.
export type {
  ContribBand,
  EaField,
  EaOverrideEntry,
  EaStatement,
  EpfMode,
  FormFidelity,
  FormOutput,
  HrdfStatus,
  PlannedFormDef,
  ReportDef,
  ReportResult,
  PcbExemptionTable,
  PcbRemunerationType,
  PayComponentSeed,
  SocsoBand,
  StatutoryBodyKey,
  StatutoryFormLink,
  StatutoryRuleset,
};

/**
 * Rung 5c (ADR-0080 D4) — a country-admin configuration section the pack contributes. FLAT data only
 * (anti-framework, ADR-0080 §7 "descriptor-driven UI"): a stable key, an i18n `labelKey`, and the
 * route `href`. `overview` marks the sections that also appear in the Statutory Configuration
 * landing-page per-body version grid (the independently-versioned bodies; SKBBK is a routed section
 * but rides the SOCSO bands, so it is NOT in the overview grid).
 *
 * The descriptor carries no component ref: these routes are the pack's own UI files (kept physically
 * in `app/payroll/configuration/*` pending migration under `localization/my/ui/` — open decision 2).
 * The `key` is the ROUTE-OWNERSHIP marker: generic config routes resolve the acting company's pack
 * and 404 unless it declares a section with their key (the gate moves from "route exists" to "pack
 * declares the section", ADR-0080 D4). For MY — which declares every section — this never 404s.
 */
export type ConfigSectionDescriptor = {
  /** Stable section key: the URL segment, the guard key, and the `components[]` version-grid key. */
  key: string;
  /** i18n key resolved under the `payroll.config` namespace (e.g. 'body_epf'). */
  labelKey: string;
  /** The section's route (kept at its current URL for MY — no user-visible churn, ADR-0080 D4). */
  href: string;
  /** Shown in the landing-page per-body version grid (epf/socso/eis/pcb/hrdf; SKBBK excluded). */
  overview?: boolean;
};

/**
 * The CLIENT-SAFE slice of a country pack's vocabulary (rung 5b, D4): pure data + pure functions
 * ONLY — zero db / server-only / 'use client' deps — so `'use client'` components can consume
 * jurisdiction vocabulary without dragging the full pack (whose statutory-config surface imports
 * db/client) into the client bundle. Each pack implements it in a LEAF entry file (MY:
 * `localization/my/client.ts`) that `localization/registry.client.ts` imports directly; the server
 * pack object references the same implementation via `CountryPack.client` so the declaration is
 * part of the contract. Flat data/refs only (D4 anti-framework): no components, no render hooks.
 */
export interface CountryPackClient {
  /** ISO alpha-2 country code (uppercase) — same registry key as the server pack. */
  country: string;

  /** National-identity vocabulary the personnel Profile widgets consume. */
  identity: {
    /**
     * Is this nationality catalog value the jurisdiction's OWN nationality (MY: Malaysian /
     * Malaysia / MY / MYS, loose case-insensitive match)? Drives the NRIC-vs-passport identity
     * fork on the personnel profile.
     */
    isLocalNationality: (nationality?: string | null) => boolean;
    /** Date of birth derivable from the national ID (MY: MyKad YYMMDD prefix), or null. */
    dobFromIC: (ic: string, now?: Date) => string | null;
  };

  /**
   * Client-safe STATUTORY vocabulary — pure functions only, no db surface.
   *
   * 35b7af0a group 7 added this slice so a shared field component can apply the SAME default on the
   * wizard as the Personnel screen applies server-side. Before it, the wizard had no way to reach
   * `defaultSocsoEisNumber` without importing the server pack, so it simply left the number blank and
   * hires created there arrived with an empty SOCSO/EIS number.
   */
  statutory: {
    /**
     * The SOCSO & EIS number to show/persist: for a local employee with a blank number, their
     * (normalised) national ID — the scheme registers locals under it. Returns undefined when the
     * jurisdiction has no opinion, so the caller keeps whatever is stored.
     */
    defaultSocsoEisNumber: (args: {
      socsoNumber?: string | null;
      icNumber?: string | null;
      nationality?: string | null;
    }) => string | undefined;
  };

  /** Client-safe statutory-leave vocabulary. */
  leave: {
    /** Statutory floor: entitlement in days for a leave-type code at completed years of service. */
    entitlement: (code: string, serviceYears: number) => number;
  };

  /**
   * Canonical salary-bank names for the employee bank picker, in catalog order (MY: the BNM/IBG
   * receiving-bank directory — every name resolves to a routing code, so a picked value can never
   * produce an unpayable salary file).
   */
  bankNames: readonly string[];
}

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
   * Rung 5b (D4) — the pack's client-safe vocabulary slice (see `CountryPackClient`). The SAME
   * object `localization/registry.client.ts` serves to `'use client'` components; declared here so
   * providing a client entry is part of the contract, not an MY convention.
   */
  client: CountryPackClient;

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
    /**
     * 7ee14bbc — every OTHER person in a company already filed under one income tax reference number.
     * ADVISORY: the personnel screen shows it beside the field as it is typed, so a duplicate is caught
     * there rather than on the CP39 at filing time. Never gates the save.
     */
    taxNumberSharedWith: MyStatutoryModule['taxNumberSharedWithMY'];
    setOthersStatutory: MyStatutoryModule['setOthersStatutoryMY'];
    /**
     * Feedback 57840a6e — one-shot, audit-gated repair of the employees an earlier UI pinned to an
     * explicit statutory opt-out by accident (MY: "Subject to HRDF = No" captured from the company
     * default by the old checkbox). Read-only unless `apply`. Exposed on the pack so the maintenance
     * CLI resolves jurisdiction through the registry instead of importing the MY module directly.
     */
    correctAccidentalHrdfOptOuts: MyStatutoryModule['correctAccidentalHrdfOptOutsMY'];
    /** National-ID validity check (MY: MyKad 12-digit IC). */
    validateIC: (ic: string) => boolean;
    /** Canonical storage form of a national ID (MY: digits only). */
    normalizeIC: (ic: string) => string;
    /** Date of birth derivable from the national ID (MY: MyKad YYMMDD prefix), or null. */
    dobFromIC: (ic: string, now?: Date) => string | null;
    /**
     * The statutory number to persist when a form leaves it blank (MY: a local's SOCSO/EIS number
     * defaults to their MyKad IC; a non-local or an explicit value is returned untouched). Rung 5c —
     * consumed by the generic personnel/zakat screens through the pack instead of a direct import.
     */
    defaultSocsoEisNumber: MyStatutoryModule['defaultSocsoEisNumber'];
  };

  /** Company-level statutory registration (employer numbers, HRDF band, …). */
  companyStatutory: {
    set: MyCompanyStatutoryModule['setCompanyStatutoryMY'];
    get: MyCompanyStatutoryModule['getCompanyStatutoryMY'];
    /** Every company's statutory registration row (the group Organization admin panel). */
    list: MyCompanyStatutoryModule['listCompanyStatutoryMY'];
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
    /**
     * Item d64d0df4 (D6) — an employee's keyed child-relief GRID → the total child deduction in RM.
     *
     * The kernel holds the stored grid (employee_statutory_my.child_relief_table) and the resolved
     * ruleset's relief slice; it hands BOTH back to the pack rather than knowing what a category is
     * worth, so no jurisdiction's relief figure can leak into core/payroll.ts. The result feeds
     * `TaxProfile.childReliefAmount`, which REPLACES `children × perChild` in the projection — and is
     * supplied only for an employee whose child-relief mode is 'auto_table'.
     *
     * OPTIONAL on the pack: a jurisdiction with no per-category child relief simply omits it, and the
     * kernel then never supplies an amount, leaving that pack's own arithmetic untouched.
     */
    childReliefAmountFor?: (table: unknown, reliefs?: StatutoryRuleset['pcb']['reliefs']) => number;
    /** EPF relief cap (RM) used by the PCB accumulator maths. */
    epfReliefCap: number;
    /**
     * The built-in HRDF levy rates (MY: HRD Corp mandatory 1% / optional 0.5%) — the FALLBACK the OT/
     * HRDF configuration screens apply when a resolved ruleset predates the `hrdf` slice. D6 vocabulary
     * so the generic Attendance-policy / config screens never name the MY table.
     */
    hrdfDefault: { mandatoryRate: number; optionalRate: number };
    /**
     * Rung 5b (D6) — the built-in verified EPF Third Schedule band tables (MY: Part A citizen/PR
     * <60, Part E citizen 60–<75). The statutory band-table editor uses these as the FALLBACK when
     * a stored ruleset override predates the partA/partE fields — the same fallback the calculator
     * itself applies — threaded down as props by the configuration pages (the component never
     * names the MY tables).
     */
    epfThirdSchedule: { partA: ContribBand[]; partE: ContribBand[] };
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
    /**
     * The FULL TP1 deduction/rebate catalogue the declaration form is built from (item 7ad37961,
     * ADR-0081): the agency's own numbered items, their lettered sub-lines, and the annual limit the
     * agency's form prints against each. MY supplies LHDN TP1 (1/2026).
     *
     * THIS IS THE GENERALISATION OF `taxReliefCategoryCaps` ABOVE, NOT ITS REPLACEMENT. The old slot
     * still exists and still carries the two legacy eight-key caps, because rows written before this
     * catalogue existed are still read through the legacy key list (db/schema TP1_CATEGORY_KEYS) and
     * must keep validating exactly as they did. New declarations validate against `taxReliefCatalogue`.
     * ADR-0008 holds on both: an item whose `limit` is null is captured and printed, never blocked.
     */
    taxReliefCatalogue: {
      readonly formCode: string;
      readonly items: readonly Tp1CatalogueItem[];
      readonly rebates: readonly Tp1CatalogueItem[];
    };
    /** Active-ruleset loader (ADR-0019): DB override or the verified default, as of a date. */
    loadRuleset: (tx: Tx, p: { asOf: string }) => Promise<StatutoryRuleset>;
    /** Same resolution + pack provenance (ADR-0020 §7) for payslip snapshotting. */
    loadRulesetResolved: (tx: Tx, p: { asOf: string }) => Promise<ActiveResolution>;
    /**
     * ADR-0024 §7 — the READ-ONLY multi-cycle statutory worksheet an accountant signs off before the
     * month-as-one aggregation may be enabled. A replay over the jurisdiction's own payroll history:
     * for every employee-month that had more than one run it compares what was PAID against both
     * readings of the statute, and reports the ringgit movement, the months it refuses to guess at,
     * and a worked example.
     *
     * OPTIONAL on the contract. A jurisdiction whose statute has no monthly-unit rule (no SOCSO
     * s.6(7) equivalent, no banded monthly EPF) has nothing to reconcile, and must not be forced to
     * implement a Malaysian question. Callers check for the member and render "not applicable" when
     * the acting company's pack omits it.
     */
    multiCycleWorksheet?: (
      ctx: SessionContext,
      p: { companyIds: string[]; year?: string },
    ) => Promise<import('./my/multicycle-worksheet').MultiCycleWorksheet>;
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

  /**
   * Rung 5c (D4) — the country-admin configuration sections this pack contributes. The generic
   * Statutory Configuration landing page renders the `overview` sections' links from HERE (not a
   * hardcoded MY body list), and each config route resolves the acting company's pack and 404s
   * unless it declares a section with the route's key. A company in another country gets that
   * country's sections; an unknown country gets none (the routes 404).
   */
  configSections: ConfigSectionDescriptor[];

  /**
   * Rung 5c (D5 / ADR-0079) — seed this pack's tenant-wide reference data into a NEW tenant: the
   * statutory leave-type catalog and the national + state public-holiday calendar (the
   * jurisdiction-shaped rows). Returns the created leave-type ids keyed by code (callers wire standing
   * grants / demo opt-ins off the codes). Generic seeding (profile-option catalogs) stays in
   * db/provision.ts; only the country-shaped rows move behind the pack, so db/seed.ts and
   * db/provision.ts route through the registry instead of importing `localization/my`. The
   * implementation may physically stay under `localization/my/` — the pack references it.
   */
  seedReferenceData: (tx: Tx, tenantId: string) => Promise<Record<string, string>>;

  /** Statutory report catalog (CP39, SOCSO/EIS files, …) the reporting engine enumerates. */
  reports: ReportDef[];

  /**
   * 6babf4f6 (D4) — statutory forms that belong on the Statutory Forms shelves but are NOT generatable
   * `ReportDef`s: the per-employee annual statement and the event-driven joiner/leaver worklist. Flat
   * descriptors, so the screen renders its shelves entirely from the catalog and a newly built form
   * appears in its authority's section without the page being edited.
   */
  statutoryLinks: StatutoryFormLink[];

  /**
   * 587ee719 (D4) — statutory forms this jurisdiction has that we have NOT built. Descriptor-only: the
   * type carries no href and no action key, so the screen can name them without any risk of one growing
   * a button that produces a different form's figures. A pack with nothing outstanding declares `[]`.
   */
  plannedForms: PlannedFormDef[];

  /** EA-statement generator (annual employee statement; MY: Borang EA), for ONE employer.
   *  `companyId` defaults to the employment's current company; b7b22514 (Entity Transfer) means a year
   *  can span more than one employer, and an EA form belongs to exactly one of them. */
  eaStatement: (
    ctx: SessionContext,
    p: { employmentId: string; year: string; companyId?: string },
  ) => Promise<EaStatement | null>;

  /** Every employer that owes this employee a statement for the year, oldest first. One entry for anyone
   *  who has never transferred — which is what keeps single-company output unchanged. */
  eaCompaniesInYear: (
    ctx: SessionContext,
    p: { employmentId: string; year: string },
  ) => Promise<{ companyId: string; name: string; isCurrent: boolean }[]>;

  /**
   * 72b100cd — the employer's per-employee statement of TAX PAID for a year (MY: PCB 2(II)).
   *
   * OPTIONAL, and that is the modelling rather than laziness. An annual employee statement (`eaStatement`)
   * is a concept every payroll jurisdiction has in some form, so the contract requires it. "The statement
   * an employer files with the revenue board declaring the monthly tax it deducted and the receipt it was
   * given" is LHDN's form, and a pack for a country with no such filing should say so by NOT implementing
   * this — not by returning a plausible empty document under a Malaysian form's name (D-14: a
   * non-statutory jurisdiction owes no statutory form, which is the correct empty and not a degraded one).
   */
  pcb2iiStatement?: (
    ctx: SessionContext,
    p: { employmentId: string; year: string; companyId?: string },
  ) => Promise<Pcb2iiForm | null>;
}
