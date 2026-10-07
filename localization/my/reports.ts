import {readSavedTaxCircumstance} from './tax-circumstance';
import {explainPcb} from '../../core/pcb-explain';
/**
 * Malaysia statutory reports (ADR-0010). Layer-A (human-readable) reports derived from payroll
 * payslips, per legal entity. Each ReportDef is registered on the pack; the generic core
 * (core/reporting.ts) lists / previews / records them without naming any MY-specific report.
 */
import { and, desc, eq, gte, inArray, isNull, like, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import {
  assignment,
  company,
  companyStatutoryAuthority,
  companyStatutoryMy,
  eaOverride,
  employeeStatutoryMy,
  employment,
  payComponent,
  payrollBatch,
  payslip,
  person,
  position,
  tp1Relief,
} from '../../db/schema';
// ea54fe6e — read the itemised lines STRUCTURALLY (by shape), which is what lets this file consume the
// kernel's stamp without importing core/payroll and dragging the whole engine into every EA caller.
import { storedComponentLines } from '../../core/payslip-earning-lines';
import { hasCompleteHistoricalEaProvenance, accumulateEaRouting } from './ea-routing';
import { MY_EA_REPORTING } from './ea-reporting';
import { accumulatedEaNonCash, eaNonCashExemption } from './ea-noncash';
export { EA_BUCKET_SOURCE_FIELD } from './ea-routing';
import { MY_STATUTORY_VERSION, DEFAULT_MY_STATUTORY, childReliefTableHeadCount } from './statutory-tables';
import { coordinatedPcbForPerson } from './payroll';
// 8ca344bf — Borang 8A's read lives in its own file (it needs hire/termination dates and the employer
// header, which no other report on this shelf reads) but registers here like every other form.
import { borang8AReport } from './borang-8a';
// 9c8dad7a — Borang A's read lives in its own file for the same reason Borang 8A's does (it needs the
// employer header, the authorised-representative block and the EPF wage BASIS, which no other report on
// this shelf reads) and registers here like every other form. The two files share NO code: their
// contribution-month rules are opposites, and a shared helper is how one acquires the other's.
import { borangAReport } from './borang-a';
// r412 (item e74af58c, step 2) — the EIS (SIP) contribution schedule is the Borang 8A read re-shaped (no second
// read, no EIS arithmetic), and Borang 8B reads the employer header only. Both register here like every form.
import { sipContributionReport } from './sip-contribution';
import { borang8BReport } from './borang-8b';
// e0cd4583 — the CP39 PRINTED form's extra header and per-employee fields. NOT a second generator and
// NOT a second catalogue entry: `cp39()` below merges these into the rows and meta it already returns,
// so the LHDN shelf keeps ONE CP39 card with ONE readiness gate.
import { cp39FormExtras, CP39_FORM_NOTES } from './cp39-form';

/** da4fc817 — Section E's "Nama Kumpulan Wang". The approved fund an employee contributes to in Malaysia
 *  is KWSP; a pack constant rather than a column because it is not a per-employee fact. */
export const EA_FUND_NAME = 'KWSP';
// The period-shape guard lives with the FORM MODEL (lib/cp39-form.ts), not with this read, because the
// model is what refuses to print a month it cannot name. Imported here so the read degrades on the same
// rule the model enforces, rather than on a second copy of the regex that could drift from it.
import { isCp39PeriodKey } from '../../lib/cp39-form';
import { runSelectionSet } from '../../lib/payroll-run-selection';
import { todayInKualaLumpur } from '../../lib/hr-date';

export type ReportColumn = { key: string; label: string; numeric?: boolean };
export type ReportRow = Record<string, string | number | null>;
export type ReportReadiness = { employmentId: string; name: string; missing: string[] };
export type ReportResult = {
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, number>;
  /** Employees missing a field a remittance needs. Empty array = fully ready. */
  readiness: ReportReadiness[];
  meta: {
    hasBatch: boolean;
    /**
     * r372 (item f022dd70) — the month HAS payroll runs, but none of them is one the operator ticked.
     *
     * A THIRD STATE, NOT A SECOND SPELLING OF `hasBatch: false`. "Run payroll first" and "none of the
     * payroll cycles you picked exists in this month" send an operator to two different screens, and a
     * download that answered the first for the second would have them re-running a month that is already
     * done. Absent on every unfiltered read, which is every read that has no cycle selector.
     */
    selectionEmpty?: boolean;
    batchStatus?: string;
    statutoryVersion: string;
    /** Headline counts shown above the table (e.g. Form E Part A). */
    summary?: { label: string; value: string | number }[];
    /** Caveats for this report (e.g. fields the payroll system does not track). */
    notes?: string[];
    /**
     * 8ca344bf — the header values a FORM RENDERER needs and a TABLE has no column for.
     *
     * A Borang 8A carries an employer code, a MyCoID, an employer address, a contribution month and a
     * payment deadline. None of those is a per-employee column, and none of them belongs in `summary`,
     * which is headline COUNTS the screen prints in tiles. Optional and untyped-by-key on purpose: the
     * kernel must not learn one jurisdiction's form fields, so the key list is owned by the renderer
     * (lib/borang-8a.ts BORANG_8A_HEADER_KEYS) and pinned across both halves in test/borang-8a.test.ts.
     *
     * Values are SCALAR strings — a multi-line address is joined with '\n' and split back by the
     * renderer — so this stays a flat, serialisable blob that crosses the server/client boundary
     * exactly like the rest of `meta`.
     */
    formHeader?: Record<string, string>;
  };
};
export type ReportParams = {
  companyId: string;
  periodKey: string;
  /**
   * r372 (item f022dd70) — WHICH PAYROLL RUNS OF THAT MONTH, when the operator picked some of them.
   *
   * ABSENT MEANS EVERY RUN, and absent is what every caller that has no cycle selector sends. A report
   * reading this field must take its pre-existing whole-month path when it is `undefined` rather than
   * building a set of every run and filtering on it: that is what makes "tick all the cycles and the file
   * does not move" true by construction instead of by comparison. See lib/payroll-run-selection.ts.
   *
   * ⚠️ IT IS `run_seq`, NOT `payroll_cycle_id`. The cycle id is nullable and null on most batches; run_seq
   * is NOT NULL and unique per pay period. The cycle NAME is what the screen shows; the run is what the
   * database can actually separate. Reports that carry no wage column (CP39) may filter their query on it
   * directly; the two that DO carry one must read the whole month and scope the wage —
   * `scopedMonthWagesFrom` in ./statutory-month-wage explains why.
   *
   * ⚠️ EXACTLY THREE GENERATORS READ THIS FIELD TODAY — `my.borang-a` and `my.borang-8a`, the two reached
   * from Payment Submission's Payroll Cycle control, and since r409 `my.cp39`, whose criteria step asks for
   * the cycles (`runSelection`). Every other entry in this catalogue IGNORES it, which
   * is correct rather than an omission: nothing sends it to them, and a report that silently honoured a
   * selection its own screen has no control for would hand an operator a narrower document than the one
   * they asked for. Adding the control to another report means teaching that report the field, in the same
   * round. The CP39 UPLOAD FILE is not in this catalogue at all — it rides `CountryPack.paymentFiles` and
   * takes its own `runSeqs`.
   */
  runSeqs?: number[];
};
/**
 * Where a generated form actually gets submitted, and by when (feedback 956cec85).
 *
 * SOURCED FROM THE REPORTER, NOT INVENTED. The item was parked on exactly this question and their
 * answer (feedback_request block_trail, resolved 2026-07-30) named the portals and the deadline:
 * EPF via i-Akaun (Employer); SOCSO and EIS TOGETHER via PERKESO ASSIST; PCB via LHDN e-PCB /
 * e-Data PCB / e-CP39 — all due by the 15th of the following month.
 *
 * `dueDayOfNextMonth` is null where the deadline was NOT stated. The annual Form E deadline is a real
 * statutory date, but nobody told us it, and this codebase's rule for statutory facts is that an
 * invented one is worse than an absent one — the screen says "not configured" rather than printing a
 * date somebody might file against.
 */
/**
 * The statutory BODY a form is filed with — the category axis of the Statutory Forms screen (6babf4f6).
 *
 * A KEY, NOT THE `agency` STRING. `agency` is free text sourced from the reporter ("EPF (KWSP)",
 * "PERKESO", "LHDN") and exists to be READ; grouping on it would mean a section silently splitting the
 * day somebody tidies a label. The key is what makes the shelf stable.
 *
 * The vocabulary is deliberately COARSER than lib/statutory-authorities.ts, and lines up with it rather
 * than competing: `perkeso` is the one body that administers both `socso` and `eis` — the reporter's own
 * "SOCSO / EIS (PERKESO)" shelf — and the smaller authorities (hrdf, zakat, ptptn, tabung_haji)
 * all land under `other`, which is exactly the shelf the reporter called "Other Statutory". When one of
 * them grows a real form, it declares `other` and appears there with no screen change; if it ever earns
 * its own shelf, that is one key and one heading.
 *
 * r224 — AND ONE OF THEM NOW HAS. `my.hrd-levy` declares `other`, which is what turned that shelf from a
 * heading with an empty state under it into a shelf with a form on it — no edit to the screen, which is
 * the property this key exists to have. The sentence above used to read "the authorities that have no
 * form yet (hrdf, …)"; hrdf is no longer one of them.
 */
export type StatutoryBodyKey = 'epf' | 'perkeso' | 'lhdn' | 'other';

/** Fixed display order of the shelves — the order the reporter listed them in. */
export const STATUTORY_BODY_ORDER = ['epf', 'perkeso', 'lhdn', 'other'] as const;

export type ReportSubmission = {
  /** Which shelf this form sits on. REQUIRED: a new submission cannot be added without choosing one. */
  body: StatutoryBodyKey;
  /** The body the form is submitted to, as the reporter names it. */
  agency: string;
  /** The portal/channel they actually use. */
  channel: string;
  /** Day of the month FOLLOWING the period, or null when the deadline is not established. */
  dueDayOfNextMonth: number | null;
};

/**
 * A statutory form that is NOT a generatable `ReportDef` but still belongs on the shelf (6babf4f6).
 *
 * Two exist, and both were previously HARDCODED into the Statutory Forms page — which is precisely why
 * the screen had to be edited every time the catalog moved. The per-employee EA is one statement per
 * person, not one table per company; the CP22/CP22A worklist is driven by the hire/termination lifecycle
 * rather than a payroll period. Neither has a `generate`, so neither can be a ReportDef — but both are
 * things a user opens Statutory Forms looking for.
 *
 * FLAT DATA, no closures (ADR-0080 D4 anti-framework, and a server component must never hand a closure
 * to a client one). `href` carries `{companyId}` / `{year}` placeholders the screen substitutes.
 */
/**
 * 587ee719 — WHAT A FORM ON THIS SHELF CAN ACTUALLY GIVE YOU, said on the entry itself.
 *
 * The request asks for nineteen Malaysian statutory forms to be listed and generated. Six of them can
 * produce something today and exactly ONE of those comes out on the government's own printed page. A
 * screen that renders nineteen identical "Generate" buttons would hand an operator our spreadsheet
 * under the name of a form LHDN would not accept — which is the single failure this whole item guards
 * against. So every entry declares its fidelity, the card renders it, and the button has to match:
 *
 *   `official`   — the agency's own published artwork, filled from payroll. Today: `my.cp22` and
 *                  NOTHING else (public/forms/cp22-pin-1-2021.pdf, mapped in lib/cp22-fields.ts).
 *   `figures`    — every number the form needs, complete, in OUR layout rather than the agency's page.
 *   `draft-file` — built to the layout an agency publishes for portal upload, never yet accepted BY
 *                  that portal, so it stays marked draft until it has been.
 *
 * 8ca344bf ADDS A FOURTH, AND IT SITS BETWEEN `official` AND `figures`:
 *
 *   `agency-layout` — the AGENCY'S OWN LAYOUT, drawn by us, because we hold no blank page of theirs to
 *                     print onto. Every box, column and heading is where the agency's form puts it,
 *                     but the paper is ours.
 *
 *                     ⚠️ r218 NARROWED THIS DEFINITION WHEN `my.cp39` JOINED THE STATUS. It used to
 *                     read "because the AGENCY publishes no blank page", which was believed for PERKESO
 *                     and KWSP and NOT established for LHDN — whose own specimen carries "Borang ini
 *                     boleh difotokopi". ⚠️ r408: for PERKESO it was FALSE — PERKESO publishes a blank
 *                     Borang 8A (and 8B) on its website, which the reporter linked. The status is about what WE hold (`public/forms`
 *                     answers that, and is guarded); an agency's publishing decisions belong in that
 *                     form's own module, where the evidence is.
 *
 * WHY IT HAD TO EXIST RATHER THAN REUSING EITHER NEIGHBOUR. `official` is a claim about GOVERNMENT
 * ARTWORK and is `my.cp22`'s alone — the Borang 8A is our own drawing of the agency's page 1 (r408
 * measured it from PERKESO's published 2013 blank, which we do not print onto and do not hold in
 * `public/forms/`); claiming `official` for it would be the exact untrue claim this whole vocabulary exists
 * to prevent. `figures` is equally wrong in
 * the other direction: its hint says "laid out our way, not on the agency's own document", and a Borang
 * 8A drawn line for line to the agency's form is not laid out our way.
 *
 * c99e8358 (2026-08-21) — `my.cp39` JOINED THEM, WHICH IS THE POINT OF THE VALUE. It started as the pair
 * `my.borang-8a` + `my.borang-a`; the CP39's page one is now drawn to a transcribed Pin.2015 specimen
 * (docs/forms/), so it belongs in exactly the same box. The set grows; the vocabulary does not. A form
 * that gets an agency arrangement moves INTO this value rather than earning a status of its own, and
 * nothing moves up to `official` without government artwork in `public/forms/`.
 *
 * A fifth status, "not built yet", is deliberately NOT in this union: it belongs to `PlannedFormDef`,
 * which has no href and no action key at all, so the type itself makes an action impossible.
 */
export type FormFidelity = 'official' | 'agency-layout' | 'figures' | 'draft-file';

/** What comes out of a form, for the chips on its card. `file` is the agency upload file (draft). */
export type FormOutput = 'pdf' | 'xlsx' | 'csv' | 'print' | 'file';

export type StatutoryFormLink = {
  id: string;
  /** i18n key under `payroll.statutoryForms` — the pack names the key, the app owns the words. */
  labelKey: string;
  /** i18n key for the one-line explanation beneath the label. */
  hintKey: string;
  body: StatutoryBodyKey;
  cadence: 'monthly' | 'annual' | 'event';
  /** Target route. Placeholders: `{companyId}`, `{year}`, `{month}`. */
  href: string;
  /**
   * r256 (item 858a1128) — WHAT THE BUTTON ON THE CRITERIA STEP SAYS, when "Generate form" would be a lie.
   *
   * The directory now hands every templated entry to a criteria step, whose button reads `criteria_generate`
   * — because pressing it is the moment the form is produced. That is untrue of exactly one shape of entry:
   * the two C.P.8A (EA) rows, where company + year is the FIRST of two steps and the employee selection is
   * the second. Those rows name `criteria_continue` instead. The alternative — the step deciding from the
   * destination path — is the screen naming forms again, which is what this catalog exists to prevent.
   *
   * Optional ⇒ every other entry's step is byte-identical.
   */
  criteriaLabelKey?: string;
  /**
   * r256 (item 858a1128) — WHICH GENERATED REPORT SUPPLIES THIS ENTRY'S PEOPLE, when it opens a list of
   * them rather than a document.
   *
   * The two C.P.8A (EA) rows are the only entries with one, and it names `my.cp8d`. An EA is one statement
   * per PERSON, so the row cannot open "the EA" — it opens the year's employee list, and the EA population
   * IS the CP8D population (one row per employee for the tax year). Until this round that fact was encoded
   * as a destination: the rows' hrefs pointed straight at `/payroll/statutory-forms/my.cp8d`, and the
   * employee picker was the CP8D figures table with the names linked. The picker is its own screen now, so
   * the fact has to be declared rather than implied.
   *
   * IT STAYS IN THE CATALOG, NOT IN THE SCREEN. A page that hardcoded `my.cp8d` would be the app naming one
   * jurisdiction's report id — the thing this whole registry exists to stop — and a jurisdiction whose EA
   * population comes from somewhere else would need the screen edited rather than its pack.
   */
  populationReportId?: string;
  /** 587ee719 — i18n key for the card's fuller description. Optional ⇒ existing entries unchanged. */
  descriptionKey?: string;
  /** 587ee719 — what this entry produces, as chips. */
  outputs?: FormOutput[];
  /** 587ee719 — see `FormFidelity`. Absent means the card shows no status chip at all. */
  fidelity?: FormFidelity;
  /**
   * 587ee719 — position WITHIN its body shelf, so the reporter's own order survives the fact that a
   * shelf is assembled from three separate collections (generatable reports, these links, and the
   * planned forms). Rank, not array position: adding an entry never renumbers the others, and the
   * screen still names no form. Entries without one sort last, in catalog order.
   */
  shelfOrder?: number;
  /**
   * d3a9383c — the row's action wording, when `openForm` is a lie.
   *
   * Every shelf row renders the SHARED `openForm` label, and the CP22 row does not open a form: its href
   * scrolls to the worklist further down the same page. The two obvious fixes are both wrong. Rewording
   * `link_cp22` changes the row TITLE ("CP22 / CP22A notices"), and rewording `openForm` changes the action
   * on every row on the screen. So the row names its own action key and everything else falls back.
   * Optional ⇒ every existing row is byte-identical.
   */
  actionLabelKey?: string;
  /**
   * d3a9383c — a SECOND action on the row, when one exists. Today: the blank fillable CP22, for a late
   * filing or a notice the operator would rather complete by hand, and the blank C.P.8A beside each EA
   * row. Both optional and read together; a row with neither renders exactly one action, as every row did
   * before.
   */
  secondaryHref?: string;
  secondaryLabelKey?: string;
  /**
   * r220 — the TOOLTIP on the second action, from THIS screen's own `payroll.statutoryForms` namespace.
   *
   * d3a9383c gave the blank CP22 its tooltip from `payroll.cp22`, arguing that the sentence describes a
   * FORM rather than this screen. That is still true of the CP22's, so it is left exactly where it is and
   * an entry that declares no key still gets it — the CP22 row is byte-identical. A row that names its own
   * key gets that instead, which is what the two EA rows need: the blank C.P.8A's caveat is not the blank
   * CP22's, and the alternative (this screen mapping ids to namespaces) is the screen naming forms again.
   */
  secondaryTitleKey?: string;
  /**
   * r220 — a THIRD action, for the one row that has three.
   *
   * The two EA rows each offer their language's blank form AND the field register — every box on the
   * C.P.8A with its official wording and what feeds it, which is the document that makes the blank form
   * checkable box by box rather than merely printable. Naming it explicitly, like the second action, keeps
   * the shape of a row something you can read off the type: an action list would let a later edit grow a
   * row four buttons without anybody deciding to.
   */
  tertiaryHref?: string;
  tertiaryLabelKey?: string;
  tertiaryTitleKey?: string;
  /**
   * r242 (item b36a8a91) — ONE NAME OVER THE ROW'S EXTRA ACTIONS, so they read as one thing.
   *
   * The reporter downloaded a BLANK EA believing it was the completed one, and the row is why: three
   * actions side by side at equal weight, the middle one a blank form. Folding the blank and the field
   * register under a single named control leaves the row with one obvious route to a completed form and
   * one clearly-labelled aside — and BOTH extras stay reachable, which matters: a blank C.P.8A is a real
   * thing HR sometimes wants, so this is a demotion and not a deletion.
   *
   * Optional ⇒ a row that declares none renders its extras side by side exactly as before (the CP22 row
   * has one extra and needs no name over it).
   */
  extrasLabelKey?: string;
  /**
   * r402 (item f3cf2444) — THE VERSIONS THIS ENTRY CAN BE OPENED IN, when its href carries `{lang}`.
   *
   * Until r402 a form published in two languages was two shelf entries (`my.ea.en` / `my.ea.ms`), so the
   * Income Tax shelf showed four cards for two forms. The reporter asked for one card per form and the
   * language as a "Version" choice on the criteria step. The options are declared HERE, beside the href
   * that takes them, because the step must offer exactly the values the destination allowlists — a step
   * that hardcoded "en / ms" would be the screen naming a jurisdiction's languages.
   *
   * The FIRST option is the default. It is never the viewer's UI language: which language a statutory form
   * comes out in must be the operator's choice, not "whatever the screen was set to" (587ee719).
   *
   * `test/statutory-forms-criteria-858a1128.test.ts` pins that every `{lang}` href declares this and that
   * no other entry does.
   */
  versions?: { value: string; labelKey: string }[];
  /**
   * r402 (item f3cf2444) — IDS THIS ENTRY USED TO BE, each with the version it stood for.
   *
   * `/payroll/statutory-forms/open?form=my.ea.ms` is in somebody's bookmarks. The criteria step resolves a
   * former id to this entry with that version already chosen, rather than 404ing a link that worked last
   * week. Declared on the entry, so no screen writes down a form id.
   */
  formerIds?: { id: string; version: string }[];
};

export type ReportDef = {
  id: string;
  label: string;
  cadence: 'monthly' | 'annual' | 'event';
  scope: 'batch' | 'period' | 'year' | 'event';
  periodKind: 'month' | 'year' | 'event';
  /** Absent for reports that are not themselves a submission (e.g. the internal overview). */
  submission?: ReportSubmission;
  /** 587ee719 — i18n key under `payroll.statutoryForms` for the card's description. */
  descriptionKey?: string;
  /** 587ee719 — what this report produces, as chips. */
  outputs?: FormOutput[];
  /** 587ee719 — see `FormFidelity`. `official` is `my.cp22`'s and nothing else's. */
  fidelity?: FormFidelity;
  /** 587ee719 — position within its body shelf. See `StatutoryFormLink.shelfOrder`. */
  shelfOrder?: number;
  /**
   * r407 (item 4f45f9b0) — THIS FORM IS FILED PER PAYROLL CYCLE, AND WHERE ITS CRITERIA STEP CONTINUES TO.
   *
   * Declared ONLY by a report whose `generate` honours `params.runSeqs` — a criteria step that offered a
   * Payroll Cycle box for a generator that ignored it would be a control that silently does nothing, on a
   * statutory return. `action` is the screen the step's Continue opens (the form's own preview), which
   * runs the server-side "is there anything to file" gate and sends a refusal back to the step.
   * `app/payroll/statutory-forms/criteria.ts` turns this into the `cycles` criterion; my.borang-a declares
   * it (r407), my.borang-8a (r408, item e74af58c) and my.cp39 (r409, item 79f3f64d).
   */
  runSelection?: { action: string };
  /**
   * r409 (item 79f3f64d) — AN ANNUAL FORM WHOSE CRITERIA STEP CONTINUES TO ITS OWN PREVIEW.
   *
   * The yearly counterpart of `runSelection`, without the cycles: a year has no payroll cycle, so the step
   * asks for Company and Year only and Continue opens `action` — the form shown in the shared viewer, then
   * downloaded — instead of the generic figures screen. my.cp8d declares it.
   *
   * r412 (item e74af58c) — ALSO HONOURED ON A MONTHLY REPORT THAT DECLARES NO `runSelection`: the step asks
   * Company, Year and Month and Continue opens `action`. my.borang-8b declares it (an under-paid month, drawn
   * from no payroll run, so a cycle box would be a control that does nothing). `reportDestination` ignores
   * it on an 'event' report, and `runSelection` wins on a monthly one that declares both.
   */
  preview?: { action: string };
  generate: (ctx: SessionContext, params: ReportParams) => Promise<ReportResult>;
};

/**
 * 587ee719 — A FORM THE REPORTER NAMED THAT HAS NEVER BEEN BUILT.
 *
 * NO `href`, NO `actionLabelKey`, NO `generate` — and that is the whole point of the type rather than a
 * flag on `StatutoryFormLink`. A boolean would leave the href sitting there for a later edit to wire up;
 * this shape makes an action IMPOSSIBLE to render without changing the type, which is a code review, not
 * an accident. The screen draws these greyed, with a status chip and no action element at all.
 *
 * Why draw them at all, when 6babf4f6 argued the opposite? Because 6babf4f6 drew nothing and said so in
 * a comment nobody reads: an operator looking for Borang A found an empty shelf and could not tell
 * "not built" from "you are on the wrong screen". Naming them with a status is the honest middle — the
 * list is complete, and no entry pretends to produce anything. When one is built it becomes a ReportDef
 * or a StatutoryFormLink, is deleted from here, and appears in the same slot with its status changed.
 */
export type PlannedFormDef = {
  id: string;
  /** i18n key under `payroll.statutoryForms` — the form's own name, exactly as the reporter wrote it. */
  labelKey: string;
  /** i18n key for the one line explaining what it will be, and why it is not here yet. */
  hintKey: string;
  body: StatutoryBodyKey;
  cadence: 'monthly' | 'annual' | 'event';
  /** Position within its body shelf. See `StatutoryFormLink.shelfOrder`. */
  shelfOrder?: number;
};

const num = (v: unknown) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Shared batch loader ─────────────────────────────────────────────────────
// Every monthly report reads the same source — the company's payroll batch for the period — then
// each maps it to its own columns / totals / readiness. Loaded once here, mapped per report.
type Stat = Record<string, number>;
type BatchRow = {
  employmentId: string;
  name: string;
  ic: string | null;
  taxNo: string | null;
  epfNo: string | null;
  socsoNo: string | null;
  gross: number;
  /** Ruleset version the runs were computed with (ADR-0024 D7: one per month). Carried for report meta. */
  version?: string | null;
  st: Stat;
};
type LoadedBatch = {
  hasBatch: boolean;
  batchStatus?: string;
  rows: BatchRow[];
  /** r409 — the month HAS runs and none of them is one the caller asked for. Only with `honourRunSeqs`. */
  selectionEmpty?: boolean;
};

/**
 * r409 (item 79f3f64d) — `honourRunSeqs` IS OPT-IN, PER GENERATOR, and only CP39 opts in.
 *
 * Six reports share this loader and `ReportParams.runSeqs` is ignored by all but the ones that were taught
 * it (see that field's note). Reading it here unconditionally would make every one of them silently honour
 * a selection its own screen has no control for. CP39 may filter its SQL because every figure it reads
 * (PCB, CP38) is a per-run DELTA — the reason the e-Data PCB file filters its own query the same way — and
 * it has no wage column, which is what stops Borang A and Borang 8A from filtering here.
 *
 * ABSENT `runSeqs` ⇒ no filter at all, so the whole-month path is the one it always was, by construction.
 */
async function loadBatchRows(
  ctx: SessionContext,
  params: ReportParams,
  opts: { honourRunSeqs?: boolean } = {},
): Promise<LoadedBatch> {
  return withTenant(ctx, async (tx) => {
    // Wave 2C (ADR-0024): a (company, month) may now hold multiple runs (regular + bonus/off-cycle).
    // The monthly statutory return is ONE filing for the month, so aggregate across ALL runs of the
    // period. Runs store delta figures, so summing per employee yields the exact monthly total — with a
    // single run this is byte-identical to before. (Mirrors loadYearRows, scoped to one month.)
    const monthBatches = await tx
      .select({ id: payrollBatch.id, status: payrollBatch.status, runSeq: payrollBatch.runSeq })
      .from(payrollBatch)
      .where(
        and(eq(payrollBatch.companyId, params.companyId), eq(payrollBatch.payPeriod, params.periodKey)),
      );
    if (monthBatches.length === 0) return { hasBatch: false, rows: [] };
    // r409 — the runs the caller ticked, or the whole month (`undefined`, and every caller but CP39).
    const selection = opts.honourRunSeqs ? runSelectionSet(params.runSeqs) : undefined;
    const batches = selection ? monthBatches.filter((b) => selection.has(b.runSeq)) : monthBatches;
    // A DIFFERENT FACT from "no payroll": the month ran, the ticked cycles are not in it.
    if (batches.length === 0) return { hasBatch: true, selectionEmpty: true, rows: [] };
    const batchIds = batches.map((b) => b.id);
    // Period-level status for the report header: closed only if every run is closed; draft if any run
    // is still a draft; otherwise processed.
    const batchStatus = batches.every((b) => b.status === 'closed')
      ? 'closed'
      : batches.some((b) => b.status === 'draft')
        ? 'draft'
        : 'processed';
    const slips = await tx
      .select({
        employmentId: payslip.employmentId,
        name: person.fullName,
        ic: employeeStatutoryMy.icNumber,
        taxNo: employeeStatutoryMy.taxNumber,
        epfNo: employeeStatutoryMy.epfNumber,
        socsoNo: employeeStatutoryMy.socsoNumber,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(inArray(payslip.batchId, batchIds))
      .orderBy(person.fullName);
    // One row per employee: sum gross + every statutory delta across the period's runs.
    const byEmp = new Map<string, BatchRow>();
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Stat & { version?: string };
      let r = byEmp.get(s.employmentId);
      if (!r) {
        r = {
          employmentId: s.employmentId,
          name: s.name,
          ic: s.ic,
          taxNo: s.taxNo,
          epfNo: s.epfNo,
          socsoNo: s.socsoNo,
          gross: 0,
          version: st.version ?? null,
          st: {},
        };
        byEmp.set(s.employmentId, r);
      }
      r.gross = round2(r.gross + num(s.gross));
      for (const [k, v] of Object.entries(st)) {
        if (typeof v === 'number') r.st[k] = round2((r.st[k] ?? 0) + v);
      }
    }
    return {
      hasBatch: true,
      batchStatus,
      rows: [...byEmp.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

type IdFields = {
  employmentId: string;
  name: string;
  ic: string | null;
  taxNo: string | null;
  epfNo: string | null;
  socsoNo: string | null;
};

/** Per-employee readiness: which required identifier fields are blank. */
function readinessFor(
  rows: IdFields[],
  checks: { field: 'ic' | 'taxNo' | 'epfNo' | 'socsoNo'; label: string }[],
): ReportReadiness[] {
  const out: ReportReadiness[] = [];
  for (const r of rows) {
    const missing = checks.filter((c) => !r[c.field]).map((c) => c.label);
    if (missing.length) out.push({ employmentId: r.employmentId, name: r.name, missing });
  }
  return out;
}

function sumTotals(rows: ReportRow[], keys: string[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const k of keys) totals[k] = round2(rows.reduce((acc, r) => acc + num(r[k]), 0));
  return totals;
}

/**
 * Stamp the statutory version(s) the payslips were ACTUALLY computed with (ADR-0020): read the snapshot in
 * each payslip's `statutory` blob — NOT the code constant, which would misreport once a pack/override lands.
 * Multiple versions (an annual report spanning a mid-year change) are joined; legacy payslips with no stamped
 * version fall back to the code constant.
 */
function versionOf(blobs: unknown[]): string {
  const vs = [
    ...new Set(blobs.map((b) => ((b ?? {}) as { version?: string }).version).filter((v): v is string => !!v)),
  ].sort();
  return vs.length ? vs.join(',') : MY_STATUTORY_VERSION;
}

const meta = (b: LoadedBatch) => ({
  hasBatch: b.hasBatch,
  // r409 — present only when a selection-honouring read found none of the ticked runs.
  ...(b.selectionEmpty ? { selectionEmpty: true } : {}),
  batchStatus: b.batchStatus,
  statutoryVersion: versionOf(b.rows.map((r) => ({ version: r.version }))),
});

const empty = (columns: ReportColumn[], b: LoadedBatch): ReportResult => ({
  columns,
  rows: [],
  totals: {},
  readiness: [],
  meta: meta(b),
});

// ── Reports ─────────────────────────────────────────────────────────────────

const CONTRIB_COLS: ReportColumn[] = [
  { key: 'name', label: 'Employee' },
  { key: 'ic', label: 'IC' },
  { key: 'taxNo', label: 'Tax no' },
  { key: 'epfNo', label: 'EPF no' },
  { key: 'socsoNo', label: 'SOCSO no' },
  { key: 'gross', label: 'Gross', numeric: true },
  { key: 'epf', label: 'EPF (EE+ER)', numeric: true },
  { key: 'socso', label: 'SOCSO (EE+ER)', numeric: true },
  { key: 'eis', label: 'EIS (EE+ER)', numeric: true },
  { key: 'pcb', label: 'PCB', numeric: true },
];

/** Combined overview: every contribution at a glance. Backs the per-agency reports below. */
async function contributions(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const b = await loadBatchRows(ctx, params);
  if (!b.hasBatch) return empty(CONTRIB_COLS, b);
  const rows: ReportRow[] = b.rows.map((r) => ({
    name: r.name,
    ic: r.ic,
    taxNo: r.taxNo,
    epfNo: r.epfNo,
    socsoNo: r.socsoNo,
    gross: r.gross,
    epf: round2(num(r.st.epfEmployee) + num(r.st.epfEmployer)),
    socso: round2(num(r.st.socsoEmployee) + num(r.st.socsoEmployer)),
    eis: round2(num(r.st.eisEmployee) + num(r.st.eisEmployer)),
    pcb: num(r.st.pcb),
  }));
  return {
    columns: CONTRIB_COLS,
    rows,
    totals: sumTotals(rows, ['gross', 'epf', 'socso', 'eis', 'pcb']),
    readiness: readinessFor(b.rows, [
      { field: 'ic', label: 'IC' },
      { field: 'taxNo', label: 'Tax no' },
      { field: 'epfNo', label: 'EPF no' },
      { field: 'socsoNo', label: 'SOCSO no' },
    ]),
    meta: meta(b),
  };
}

const CP39_COLS: ReportColumn[] = [
  { key: 'name', label: 'Employee' },
  { key: 'taxNo', label: 'Tax no' },
  { key: 'ic', label: 'IC' },
  { key: 'pcb', label: 'MTD / PCB', numeric: true },
];

/**
 * CP39 — LHDN monthly tax deduction (MTD/PCB) statement.
 *
 * e0cd4583 ENRICHED THIS RATHER THAN ADDING A SECOND CATALOGUE ENTRY, and the columns above are
 * deliberately UNCHANGED. The figures screen keeps its four columns and the CSV/XLSX export keeps its
 * four headings — both map `result.columns`, never `Object.keys(row)` — while the rows grow the extra
 * fields the PRINTED form needs (`cp38`, `employeeNo`, `passport`, and the two blanks) and `meta` grows
 * the employer header. A second card would give the LHDN shelf two CP39s with two readiness gates that
 * could disagree about who is ready.
 *
 * `totals.cp38` is new alongside the `totals.pcb` that was always there; the screen's tile row is driven
 * off the NUMERIC COLUMNS, so nothing new appears on it. `test/slice0.test.ts` pins `cp39.totals.pcb`
 * against the overview and is untouched by the addition.
 */
async function cp39(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  // r409 (item 79f3f64d) — THE PRINTED CP39 HONOURS THE PAYROLL-CYCLE SELECTION. Until this round only the
  // e-Data PCB upload file did; the printed statement read the whole month whatever was ticked. See
  // `loadBatchRows` for why CP39 may filter its query and the two wage-carrying forms may not.
  const b = await loadBatchRows(ctx, params, { honourRunSeqs: true });
  // ⚠️ THE NO-BATCH ANSWER COMES FIRST, AND THE ORDER OF THESE TWO STATEMENTS IS THE WHOLE POINT.
  //
  // `cp39FormExtras` VALIDATES the period and THROWS on anything that is not YYYY-MM (it has to: a
  // statement stamped "2026-13" would look completely normal). But this generator is not only the printed
  // form's read — it also backs `/payroll/reports`, whose period box is FREE TEXT and still holds "2026"
  // when you switch the report dropdown from an annual form to CP39, and `/payroll/statutory-forms/my.cp39`,
  // which will build a periodKey out of a `?periodKey=2026-13` in the URL. Both of those call
  // `reportPreview` with NO try/catch, so calling the validating read before this branch turned a screen
  // that had always degraded to the "No payroll run" card into a 500. `my.cp39` has been total since
  // slice 0 and it stays total: a period that cannot name a month cannot name a batch either, so it lands
  // here and the card renders exactly as it always did.
  //
  // Nothing is lost by returning before the extras: `loadCp39Form` answers 'no-batch' (app/payroll/cp39/
  // shared.ts) before it ever looks at `meta.formHeader`, and `meta.notes` are rendered only inside
  // `StatutoryReportPanel`, which the no-batch branch of both screens does not reach. The four queries
  // this used to run on the empty path were discarded work.
  if (!b.hasBatch || b.selectionEmpty) return empty(CP39_COLS, b);
  // …AND THE ORDERING ABOVE IS NOT ENOUGH ON ITS OWN, because `hasBatch` is true whenever some
  // payroll_batch.pay_period equals this key VERBATIM — and nothing enforces that column's format.
  // db/schema.ts declares it plain `text` with no CHECK; createBatch/createAdditionalRun never validate
  // it; the server action takes `String(formData.get('payPeriod'))`; and the only real guard is
  // `<input type="month">` on the wizard, which Firefox and desktop Safari do not implement and render
  // as a plain text box. So a run genuinely CAN exist under "2026-13", and then hasBatch is true, the
  // return above does not fire, and the validating read below throws into two screens that have always
  // degraded gracefully. Resting a 500 on a browser's input-type support is not a guard.
  //
  // `isCp39PeriodKey` already existed for exactly this and was called only by its own test — dead
  // production code. Calling it here makes the degradation structural.
  if (!isCp39PeriodKey(params.periodKey)) return empty(CP39_COLS, b);
  // Second, narrow query rather than a wider `loadBatchRows`: that loader is shared by six reports and
  // only this one needs a passport number. Reached only with a period that produced a real batch, which
  // is why its validation is now a backstop rather than the screen's error path.
  const extras = await cp39FormExtras(ctx, {
    companyId: params.companyId,
    periodKey: params.periodKey,
    employmentIds: b.rows.map((r) => r.employmentId),
  });
  const rows: ReportRow[] = b.rows.map((r) => {
    const x = extras.byEmployment.get(r.employmentId);
    return {
      // The figures table's own four columns, exactly as before.
      name: r.name,
      taxNo: r.taxNo,
      ic: r.ic,
      pcb: num(r.st.pcb),
      // ADDITIVE — no column declares these, so no existing surface renders them. `employmentId` also
      // lets the shared panel link a name to that person's EA statement, as it already does for the
      // Borang A figures table.
      employmentId: r.employmentId,
      // 1.2.3 CP38 — the LHDN/court instalment, DISTINCT from MTD. Stamped non-zero on the regular run
      // only, so summing across the period's runs single-counts the month's one instalment; that is the
      // same rule `cp39FileForBatch` applies to the upload file (localization/my/cp39-file.ts:204).
      cp38: num(r.st.cp38),
      // WHO, as opposed to which job. Not a column and not printed: the printed form's duplicate
      // tax-number warning needs it to tell one person's two concurrent employments — which carry the
      // same tax number by construction, it is stored per PERSON — from two people sharing a number.
      personId: x?.personId ?? '',
      employeeNo: x?.employeeNo ?? '',
      passport: x?.passport ?? '',
      // e4b541c6 — both come off `cp39FormExtras` now that migration 0450 gave them columns. Empty here
      // means the employee has none on file, which is the ordinary case and prints a blank column.
      countryCode: x?.countryCode ?? '',
      oldIc: x?.oldIc ?? '',
    };
  });
  return {
    columns: CP39_COLS,
    rows,
    totals: sumTotals(rows, ['pcb', 'cp38']),
    readiness: readinessFor(b.rows, [{ field: 'taxNo', label: 'Tax no' }]),
    meta: { ...meta(b), formHeader: extras.header, notes: CP39_FORM_NOTES },
  };
}

const EPF_COLS: ReportColumn[] = [
  { key: 'name', label: 'Employee' },
  { key: 'epfNo', label: 'EPF no' },
  { key: 'ic', label: 'IC' },
  { key: 'gross', label: 'Gross', numeric: true },
  { key: 'employee', label: 'Employee', numeric: true },
  { key: 'employer', label: 'Employer', numeric: true },
  { key: 'total', label: 'Total', numeric: true },
];

/** EPF / KWSP monthly contribution (Borang A basis). */
async function epfReport(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const b = await loadBatchRows(ctx, params);
  if (!b.hasBatch) return empty(EPF_COLS, b);
  const rows: ReportRow[] = b.rows.map((r) => {
    const ee = num(r.st.epfEmployee);
    const er = num(r.st.epfEmployer);
    return { name: r.name, epfNo: r.epfNo, ic: r.ic, gross: r.gross, employee: ee, employer: er, total: round2(ee + er) };
  });
  return {
    columns: EPF_COLS,
    rows,
    totals: sumTotals(rows, ['gross', 'employee', 'employer', 'total']),
    readiness: readinessFor(b.rows, [{ field: 'epfNo', label: 'EPF no' }]),
    meta: meta(b),
  };
}

const SOCSO_COLS: ReportColumn[] = [
  { key: 'name', label: 'Employee' },
  { key: 'socsoNo', label: 'SOCSO no' },
  { key: 'ic', label: 'IC' },
  { key: 'socsoEmployee', label: 'SOCSO (EE)', numeric: true },
  { key: 'socsoEmployer', label: 'SOCSO (ER)', numeric: true },
  { key: 'socsoSkbbk', label: 'SKBBK (EE)', numeric: true },
  { key: 'eisEmployee', label: 'EIS (EE)', numeric: true },
  { key: 'eisEmployer', label: 'EIS (ER)', numeric: true },
];

/** SOCSO + EIS — PERKESO monthly contribution (ASSIST basis). */
async function socsoEis(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const b = await loadBatchRows(ctx, params);
  if (!b.hasBatch) return empty(SOCSO_COLS, b);
  const rows: ReportRow[] = b.rows.map((r) => ({
    name: r.name,
    socsoNo: r.socsoNo,
    ic: r.ic,
    socsoEmployee: num(r.st.socsoEmployee),
    socsoEmployer: num(r.st.socsoEmployer),
    socsoSkbbk: num(r.st.socsoSkbbk), // Lindung 24 Jam / SKBBK — employee-paid leg (eff 1 Jun 2026)
    eisEmployee: num(r.st.eisEmployee),
    eisEmployer: num(r.st.eisEmployer),
  }));
  return {
    columns: SOCSO_COLS,
    rows,
    totals: sumTotals(rows, ['socsoEmployee', 'socsoEmployer', 'socsoSkbbk', 'eisEmployee', 'eisEmployer']),
    readiness: readinessFor(b.rows, [{ field: 'socsoNo', label: 'SOCSO no' }]),
    meta: meta(b),
  };
}

const HRD_LEVY_COLS: ReportColumn[] = [
  { key: 'name', label: 'Employee' },
  { key: 'levy', label: 'HRD Corp levy', numeric: true },
];

/**
 * r224 — HRD CORP (HRDF) LEVY, the month's employer-only levy per employee, and the first form the
 * "Other statutory" shelf has ever carried.
 *
 * WHY IT EXISTS AT ALL. The shelf was a heading with an empty state under it: `body_other` and its hint
 * rendered, and not one catalog entry declared `body: 'other'`, so the section read as broken software
 * rather than as an authority we file nothing with. The levy figure has been computed and stamped on
 * every payslip since Wave 2A — `st.hrdf` — so the honest fix was to publish the figures that already
 * exist, not to delete the heading.
 *
 * IT RECALCULATES NOTHING, which is the same rule every report on this shelf follows. `st.hrdf` is what
 * the payroll run actually charged, summed across the month's runs by `loadBatchRows`. A bonus or
 * off-cycle run stamps `hrdf: 0` (core/payroll.ts — the levy rides the normal wage only), so summing the
 * period's runs yields the month's one levy rather than a second charge on the bonus.
 *
 * ⚠️ THERE IS DELIBERATELY NO WAGE-BASE COLUMN, AND IT IS NOT AN OVERSIGHT. The obvious next column is
 * the HRDF wage the levy was charged on, and the payslip does stamp it (`st.bases.hrdf`). But that base
 * is stamped for EVERY employee, including the ones `hrdfSubject()` excludes from the levy entirely and
 * every employee of a company whose registration band is `not_registered` — for all of whom the levy is
 * correctly 0. Printing a wage beside a zero levy asserts a levied wage that was never levied, on a
 * document an employer reconciles against what they pay HRD Corp. The subjectivity flag that would make
 * the column truthful is a BOOLEAN on the payslip blob, and `loadBatchRows` carries numbers only. So the
 * report states the levy — the figure that is actually owed — and says nothing it cannot stand behind.
 *
 * EVERY EMPLOYEE IS LISTED, INCLUDING THE ZEROES. A statutory return covers everyone the company must
 * report for; dropping the zero rows would turn "excluded from the levy" and "not on the payroll this
 * month" into the same absence, and the total would still be right while the list quietly stopped being
 * the month's list.
 *
 * `readiness` IS EMPTY BY DESIGN. Every other readiness gate here names an agency IDENTIFIER a filing
 * would omit — an EPF number, a SOCSO number, a tax number. The HRD Corp levy is remitted as the
 * employer's own total; no employee identifier goes up with it, so there is no per-person field whose
 * absence would produce a short file. An invented gate would refuse a return that is complete.
 */
async function hrdLevy(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const b = await loadBatchRows(ctx, params);
  if (!b.hasBatch) return empty(HRD_LEVY_COLS, b);
  const rows: ReportRow[] = b.rows.map((r) => ({ name: r.name, levy: num(r.st.hrdf) }));
  return {
    columns: HRD_LEVY_COLS,
    rows,
    totals: sumTotals(rows, ['levy']),
    readiness: [],
    meta: meta(b),
  };
}

// ── Annual (Form E / CP8D) ──────────────────────────────────────────────────
// Aggregates a tax year's payslips per employee. periodKey is the year, e.g. '2026'.
type YearRow = IdFields & {
  category: number | null;
  children: number | null;
  gross: number;
  epf: number;
  socso: number;
  eis: number;
  pcb: number;
};

async function loadYearRows(
  ctx: SessionContext,
  year: string,
  companyId: string,
): Promise<{ rows: YearRow[]; versions: string[] }> {
  return withTenant(ctx, async (tx) => {
    const versions = new Set<string>();
    const slips = await tx
      .select({
        employmentId: payslip.employmentId,
        name: person.fullName,
        ic: employeeStatutoryMy.icNumber,
        taxNo: employeeStatutoryMy.taxNumber,
        epfNo: employeeStatutoryMy.epfNumber,
        socsoNo: employeeStatutoryMy.socsoNumber,
        category: employeeStatutoryMy.taxCategory,
        children: employeeStatutoryMy.numChildren,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(and(eq(payrollBatch.companyId, companyId), like(payrollBatch.payPeriod, `${year}-%`)));

    const byEmp = new Map<string, YearRow>();
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Stat;
      const v = (s.statutory as { version?: string } | null)?.version;
      if (v) versions.add(v);
      let r = byEmp.get(s.employmentId);
      if (!r) {
        r = {
          employmentId: s.employmentId,
          name: s.name,
          ic: s.ic,
          taxNo: s.taxNo,
          epfNo: s.epfNo,
          socsoNo: s.socsoNo,
          category: s.category,
          children: s.children,
          gross: 0,
          epf: 0,
          socso: 0,
          eis: 0,
          pcb: 0,
        };
        byEmp.set(s.employmentId, r);
      }
      r.gross = round2(r.gross + num(s.gross));
      r.epf = round2(r.epf + num(st.epfEmployee));
      r.socso = round2(r.socso + num(st.socsoEmployee));
      r.eis = round2(r.eis + num(st.eisEmployee));
      r.pcb = round2(r.pcb + num(st.pcb));
    }
    return {
      rows: [...byEmp.values()].sort((a, b) => a.name.localeCompare(b.name)),
      versions: [...versions].sort(),
    };
  });
}

/**
 * Form E Part A headcounts for the year.
 *
 * ⚠️ b7b22514 REWROTE THE POPULATION, and the reason is Entity Transfer. Until an employee could move
 * between companies, `employment.company_id` WAS "who this company employed" and the old scan over it was
 * correct by construction. An Entity Transfer moves that column, and the moment it can move, three things
 * break at once:
 *
 *   • the person vanishes from the OLD company's Part A entirely — including for years that closed long
 *     before the transfer. Re-print company A's 2025 Form E after a 2026 transfer and the headcount is
 *     quietly lower than the one that was filed;
 *   • they are counted for the NEW company as if they had always been there;
 *   • either way the counts stop agreeing with the CP8D rows printed directly beneath them, which ARE
 *     company-true (loadYearRows joins through payroll_batch.company_id). One form, two populations.
 *
 * So the population now comes from the SAME place the rows do — the payslips this company actually paid in
 * this year — union the employments currently sitting here that it has not yet run payroll for (a company
 * mid-onboarding still has a headcount). A payslip is company-true by construction: it was paid by that
 * batch's company, and no later transfer rewrites it.
 *
 * NEW HIRES USES `join_date`, NOT `hired_on`. This is an EMPLOYER's return, and `hired_on` is the GROUP
 * service date that 89ea527b deliberately keeps still across a move. The date on which someone joined THIS
 * employer is `join_date` — which is precisely the column Entity Transfer moves. Using the group date
 * meant a transfer-in was never a new employee anywhere, on any company's form.
 *
 * KNOWN LIMIT, stated rather than hidden: `join_date` and `terminated_on` are current values, so re-running
 * a PRIOR year's Part A after a transfer reads today's join date for that employee. The population and the
 * active-at-year-end line are historically correct (they are payslip-derived); the new-hire line for a
 * re-printed prior year is not. Fixing that needs a dated company history, which does not exist yet — the
 * company timeline currently lives only in the event log (core/movement.ts companyIdAtSequence).
 */
async function formECounts(
  ctx: SessionContext,
  year: string,
  companyId: string,
  subjectToMtd: number,
): Promise<{ label: string; value: number }[]> {
  return withTenant(ctx, async (tx) => {
    const yStart = `${year}-01-01`;
    const yEnd = `${year}-12-31`;

    // Who this company PAID this year, and the last period it paid each of them. The last period is what
    // decides "still here at 31 December": someone transferred out in June has a December payslip at the
    // DESTINATION, so their last period here is 06 and they are correctly not counted at year end.
    const paid = await tx
      .select({
        employmentId: payslip.employmentId,
        payPeriod: payrollBatch.payPeriod,
        joinDate: employment.joinDate,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .where(and(eq(payrollBatch.companyId, companyId), like(payrollBatch.payPeriod, `${year}-%`)));

    type Member = { joinDate: string | null; hiredOn: string; terminatedOn: string | null; lastPeriod: string | null };
    const pop = new Map<string, Member>();
    for (const s of paid) {
      const cur = pop.get(s.employmentId);
      if (!cur) {
        pop.set(s.employmentId, {
          joinDate: s.joinDate,
          hiredOn: s.hiredOn,
          terminatedOn: s.terminatedOn,
          lastPeriod: s.payPeriod,
        });
      } else if (!cur.lastPeriod || s.payPeriod > cur.lastPeriod) {
        cur.lastPeriod = s.payPeriod;
      }
    }

    // A company that has not run payroll for someone yet still employs them. `lastPeriod: null` marks the
    // ones with no payslip this year, so the year-end test falls back to the dated columns for them.
    const here = await tx
      .select({ id: employment.id, joinDate: employment.joinDate, hiredOn: employment.hiredOn, terminatedOn: employment.terminatedOn })
      .from(employment)
      .where(eq(employment.companyId, companyId));
    for (const e of here) {
      if (pop.has(e.id)) continue;
      if (e.hiredOn > yEnd) continue;
      if (e.terminatedOn && e.terminatedOn < yStart) continue;
      pop.set(e.id, { joinDate: e.joinDate, hiredOn: e.hiredOn, terminatedOn: e.terminatedOn, lastPeriod: null });
    }

    const members = [...pop.values()];
    const currentIds = new Set(here.map((e) => e.id));
    const activeAtEnd = [...pop.entries()].filter(([id, m]) => {
      if (m.terminatedOn && m.terminatedOn < yEnd) return false;
      if (m.hiredOn > yEnd) return false;
      // Paid by this company for the year's final month it paid them at all — and still sitting here.
      // Both halves matter: the first rules out a transfer-out, the second a transfer-out with no payroll.
      return currentIds.has(id);
    }).length;
    // Joined THIS employer during the year — the transfer-in case, which `hired_on` could never see.
    const newHires = members.filter((m) => {
      const joined = m.joinDate ?? m.hiredOn;
      return joined >= yStart && joined <= yEnd;
    }).length;
    const ceased = members.filter((m) => m.terminatedOn && m.terminatedOn >= yStart && m.terminatedOn <= yEnd).length;
    return [
      { label: `Active at 31 Dec ${year}`, value: activeAtEnd },
      { label: 'Subject to MTD', value: subjectToMtd },
      { label: `New hires (${year})`, value: newHires },
      { label: `Ceased (${year})`, value: ceased },
    ];
  });
}

const CP8D_COLS: ReportColumn[] = [
  { key: 'no', label: 'No.' },
  { key: 'name', label: 'Employee' },
  { key: 'taxNo', label: 'TIN' },
  { key: 'ic', label: 'IC' },
  { key: 'category', label: 'Cat.' },
  { key: 'children', label: 'Children' },
  { key: 'gross', label: 'Gross remuneration', numeric: true },
  { key: 'epf', label: 'EPF', numeric: true },
  { key: 'pcb', label: 'MTD / PCB', numeric: true },
  { key: 'socso', label: 'SOCSO', numeric: true },
];

const CP8D_NOTE =
  'Covers payroll-derived figures only: gross cash remuneration, EPF, SOCSO and MTD/PCB. Benefits-in-kind, ' +
  'value of living accommodation, ESOS, tax-exempt allowances and zakat are not tracked in this view — add ' +
  'them in MyTax / e-CP8D before filing. (CP38 instalments are tracked and flow into the CP39 e-Data file, ' +
  'but are not summed into this annual CP8D view.)';

/** Form E / CP8D — annual employer return (per-employee remuneration + Part A headcounts). */
async function cp8d(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const year = params.periodKey;
  const { rows: yr, versions } = await loadYearRows(ctx, year, params.companyId);
  const rows: ReportRow[] = yr.map((r, i) => ({
    no: i + 1,
    employmentId: r.employmentId, // not a column — lets the UI deep-link each row to its EA statement
    name: r.name,
    taxNo: r.taxNo,
    ic: r.ic,
    category: r.category ?? 1,
    children: r.children ?? 0,
    gross: r.gross,
    epf: r.epf,
    pcb: r.pcb,
    socso: r.socso,
  }));
  const subjectToMtd = yr.filter((r) => r.pcb > 0).length;
  const summary = await formECounts(ctx, year, params.companyId, subjectToMtd);
  return {
    columns: CP8D_COLS,
    rows,
    totals: sumTotals(rows, ['gross', 'epf', 'pcb', 'socso']),
    readiness: readinessFor(yr, [
      { field: 'taxNo', label: 'Tax no' },
      { field: 'epfNo', label: 'EPF no' },
      { field: 'socsoNo', label: 'SOCSO no' },
    ]),
    meta: {
      hasBatch: yr.length > 0,
      statutoryVersion: versions.length ? versions.join(',') : MY_STATUTORY_VERSION,
      summary,
      notes: [CP8D_NOTE],
    },
  };
}

// ── EA statement (C.P.8A) — per employee ────────────────────────────────────
// 1.2.6 EA Data Overwrite — the EA-form fields HR may amend (overlay) WITHOUT touching payroll. A plain
// const tuple (not a pgEnum), mirroring app/admin/pay-components discriminators. `gross` is independently
// overridable (HR may set a known total directly); otherwise it is recomputed from the post-overlay
// components so the printed Part B lines always sum to their own total (see the merge below).
//
// 6036dab7 — THE VOCABULARY GREW; THERE IS STILL EXACTLY ONE OVERRIDE PATH. The customer's field mapping
// names EA boxes that payroll can never produce a figure for — a director's fee that is not a pay item, a
// share-option benefit, a gratuity, the value of living accommodation, a refund from an unapproved fund,
// compensation for loss of employment, a pension, an annuity. Every one of them is an amount HR KNOWS and
// the payroll ledger does not. The temptation is a second "manual EA figures" table beside ea_override;
// that would give one tax document two places to hold a number for the same box, which is how the two
// disagree. So they join THIS list instead: their derived baseline is 0 (see `derived` below), the same
// amend panel writes them, the same event trail records them, and the same "amended" footnote covers them.
//
// The three groups, and why the distinction matters when reading the merge:
//   • PAYROLL-DERIVED  grossSalary · bonus · allowances · gross · mtd · cp38 · zakat · epf · socso · eis
//                      — a real figure summed from the year's payslips; an override CORRECTS it.
//   • MANUAL PART B    directorFee · tipsPerquisites · taxBorneByEmployer · esos · gratuity · arrears ·
//                      benefitsInKind · livingAccommodation · unapprovedFundRefund · compensation
//                      — baseline 0; an override is the ONLY way any of them is non-zero.
//   • MANUAL PART C    pension · annuity — as above, and they total into Part C rather than Part B.
export const EA_FIELDS = [
  'grossSalary',
  'bonus',
  'allowances',
  'gross',
  'mtd',
  // 6036dab7 — cp38 and zakat were printed as the words "not tracked" on both EA surfaces long after
  // payroll started stamping them (payslip.statutory.cp38 / .zakat). They are DERIVED figures now, and
  // amendable for the same reason `mtd` is: HR may have to reconcile the form against what was remitted.
  'cp38',
  'zakat',
  'epf',
  'socso',
  // r367 (item fda53352, round A) — SKBBK JOINS THE VOCABULARY BECAUSE IT JOINED THE FORM.
  // Section E(2) prints SOCSO + EIS + SKBBK added together (see `partE` below for the caption reasoning).
  // All three legs stay SEPARATE data so HR can amend the right one: a single amendable "E(2) total"
  // would make a correction to the SOCSO leg indistinguishable from a correction to the EIS leg, and
  // core/statutory-explain.ts would then disagree with the form about which money moved.
  'eis',
  'skbbk',
  // Manual Part B boxes — no payroll source, derived baseline 0.
  'directorFee',
  'tipsPerquisites',
  'taxBorneByEmployer',
  'esos',
  'gratuity',
  'arrears',
  'benefitsInKind',
  'livingAccommodation',
  'unapprovedFundRefund',
  'compensation',
  // Manual Part C boxes — no payroll source, derived baseline 0.
  'pension',
  'annuity',
  // da4fc817 — SECTION D's missing lines. `tp1Relief` is DERIVED (core/tax-relief's tp1CountForYear, the
  // same rule the payroll feed reads) and amendable for the reason `mtd` is: HR may need to reconcile the
  // form against what was actually deducted.
  //
  // r351 — `childRelief` JOINED IT AS DERIVED. It is the annual, s.48-weighted relief the payroll kernel
  // allowed, read off the year's last slip carrying a `pcbMeta.reliefs` snapshot. `donations` and
  // `zakatOther` still have no payroll source and stay at a baseline of 0 until HR enters them.
  //
  // ⚠️ THIS COMMENT NAMED `optionalRow` UNTIL r351 AND THAT FUNCTION NO LONGER EXISTS — r346/r349
  // replaced it. The behaviour it described still holds under a different mechanism: the caption and its
  // rule are always printed and only the FIGURE is withheld, so an unset box is an empty rule rather than
  // a `0.00` (AGENTS 28; r209 shipped exactly that defect here).
  'tp1Relief',
  'donations',
  'zakatOther',
  'childRelief',
] as const;
export type EaField = (typeof EA_FIELDS)[number];

/** 6036dab7 — the Part B lines that sum into `partB.gross` when HR has not set the total directly. Held
 *  here rather than inline in the merge so the renderer's printed lines and the recomputed total can never
 *  drift apart: a new Part B box is added to THIS list or it silently fails to reach the total.
 *
 *  TWO DECISIONS ARE RECORDED IN THIS LIST, NOT JUST A SUM.
 *  1. `exemptAllowances` is deliberately ABSENT, AND THE REASON CHANGED IN r353.
 *
 *     ⚠️ THIS ENTRY USED TO READ: "It is the tax-exempt PORTION of `allowances`, already inside that
 *     line — adding it would double-count, which is why the form prints it muted and says '(included
 *     above)'." The arithmetic was right and the premise was wrong. Section B is headed "(EXCLUDING Tax
 *     Exempt Allowances / Perquisites / Gifts / Benefits)" — the exempt portion was never supposed to be
 *     inside `allowances`, and while it was, the same ringgit printed twice on one form: once under a
 *     caption forbidding it, once in Section F, which is the box the agency provides for it.
 *
 *     `allowances` now carries the TAXABLE excess only (see `taxableAllowances` in `eaStatement`), so
 *     this list is the Section B total the agency's own heading describes. `exemptAllowances` stays out
 *     because it is not Section B income at all — not because it is already counted here.
 *  2. The NON-CASH boxes (benefitsInKind, livingAccommodation) and the terminal ones
 *     (unapprovedFundRefund, compensation) ARE included, even though the section used to be titled
 *     "employment income (cash)". The alternative was a manual box HR can fill that changes no total,
 *     which is indistinguishable on the page from a box nothing reads. The rule this keeps is the one
 *     §0 established and the §0 test still pins: THE PRINTED LINES SUM TO THE PRINTED TOTAL. Every one
 *     of these is 0 until HR enters it, so every statement that exists today is arithmetically unchanged.
 *     HR can still override `gross` directly when the group's own total is known and differs. */
export const EA_PART_B_COMPONENTS = [
  'grossSalary',
  'bonus',
  'allowances',
  'directorFee',
  'tipsPerquisites',
  'taxBorneByEmployer',
  'esos',
  'gratuity',
  'arrears',
  'benefitsInKind',
  'livingAccommodation',
  'unapprovedFundRefund',
  'compensation',
] as const satisfies readonly EaField[];
/**
 * ea54fe6e — PAY ITEM → EA BOX. The table that finally joins `pay_component.ea_form_line` (stored since
 * ADR-0035 1A, wave 1) to the box this form prints. Until r228 nothing read it: the EA summed
 * `payslip.allowance` into one lump and no EA surface looked at pay_component at all.
 *
 * `allowance_exempt` IS DELIBERATELY ABSENT, AND THAT IS A STATUTORY DECISION, NOT AN OMISSION.
 * The exempt figure has ONE defined derivation: the PCB exemption ledger (`statutory.exemptionUsed`,
 * PCB_* codes). Feeding it a SECOND source would mean an item counted by both mechanisms is reported
 * twice on a tax form, and neither source knows about the other. So mapping a pay item to
 * `allowance_exempt` marks it as mapped (it stops being flagged unmapped) and moves no money.
 * AGENTS 28: a memo box that overstates exempt income is a confident wrong number, which is worse than
 * the lump it replaced. Reported to the reporter as the one line of their fourteen that does not move a
 * figure. THAT ARGUMENT IS UNCHANGED AND STILL BINDING — do not give this box a second derivation.
 *
 * ⚠️ r353 CORRECTED THE SENTENCE AROUND IT. This header used to call the exempt figure "a MEMO line —
 * the tax-exempt PORTION of `allowances`, printed muted as '(included above)'", and said an unmapped
 * `allowance_exempt` item "leaves its money in `allowances` where the kernel put it". It is not a memo
 * line: Section F is a box of the form in its own right, and Section B is headed "(EXCLUDING Tax Exempt
 * Allowances / Perquisites / Gifts / Benefits)", so the exempt part must NOT sit in `allowances`. It no
 * longer does — `eaStatement` subtracts it (see `taxableAllowances`). What routing does here is
 * unchanged; only the claim about where the money ends up was wrong.
 */
export const EA_LINE_TO_FIELD = {
  ...Object.fromEntries(MY_EA_REPORTING.map(entry => [entry.code, entry.destination])) as Record<string, EaField>,
  gross_salary: 'grossSalary',
  bonus: 'bonus',
  // Both, and not a bug — the printed box is "1(b) Fees (including directors' fees), commission or bonus".
  commission: 'directorFee',
  director_fee: 'directorFee',
  allowance_taxable: 'allowances',
  tips_perquisites: 'tipsPerquisites',
  tax_borne_by_employer: 'taxBorneByEmployer',
  esos: 'esos',
  gratuity: 'gratuity',
  arrears: 'arrears',
  bik: 'benefitsInKind',
  vola: 'livingAccommodation',
  unapproved_fund_refund: 'unapprovedFundRefund',
  compensation: 'compensation',
} as const satisfies Record<string, EaField>;

/**
 * WHICH SUMMARY FIGURE A ROUTED AMOUNT LEAVES. Routing MOVES money between boxes; it never adds any.
 * The kernel's bucket already decided which EA figure the amount reached, so taking it out of that figure
 * and putting it in the mapped one keeps `partB.gross` byte-identical — pinned by ea-line-routing's
 * "the total is unchanged" case. `reimburse` and `deduct` are absent on purpose: neither is Part B income,
 * so a pay item mapped to an EA line but paid through those buckets routes NOTHING rather than inventing
 * income. (`wage` → allowances and `ot` → grossSalary mirror the loop below: grossSalary = basic + overtime.)
 */


/**
 * THE YEAR ROUTING SWITCHES ON, AND THE REASON IS THE WHOLE RISK OF THIS FEATURE.
 *
 * Per-component line stamping began 2026-08-01 (862ed0ad). An EA covers January to December, so routing
 * assessment year 2026 would print an August-to-December subtotal in a box captioned as the full year: a
 * director paid 48,000 across 2026 would show ~20,000 against fees/director's fee. AGENTS 28 — a box left
 * alone tells the employee nothing, a box with a confident wrong number tells them something false and
 * they file a tax return on it. The earlier months CANNOT be recovered: those payslips hold monthly
 * totals only, and re-deriving the split from today's settings would disagree with the payslips already
 * issued (argued and rejected against 862ed0ad).
 *
 * 2027 is the first year whose January is stamped. Keep this general boundary. Earlier years may route only when every owned slip passes
 * hasCompleteHistoricalEaProvenance; missing or partial itemization stays on the legacy path.
 */
export const EA_ROUTING_FROM_YEAR = 2027;

/** One amended EA field, surfaced so the UI/PDF can render "original vs amended" + an "Amended" badge. */
export type EaOverrideEntry = { field: EaField; original: number; amended: number; reason: string };

export type EaStatement = {
  year: string;
  /** b7b22514 — WHICH employer this form speaks for. A transfer year has one form per employer, and
   *  the screen needs the id to mark the selected one; the name alone cannot be compared safely. */
  employerId: string;
  /**
   * The employer, as the C.P.8A's own boxes ask for it.
   *
   * r219 — `name` and `eNumber` are the two this read has always carried (Nama Majikan and the "TIN
   * Majikan E" box at the head of the form). The five after them are what the printed form's FOOT asks
   * for and nothing produced until the redraw: the ruled officer box carries Name Pegawai / Jawatan /
   * Nama dan Alamat Majikan / No. Telefon Majikan, and the header carries LHDNM Negeri.
   *
   * WHERE EACH COMES FROM:
   *   • address / phone → `company` (Organization → General's Contact Information). The form's box is
   *     "No. Telefon Majikan" — the EMPLOYER's number. Note that the printed CP39 puts a different
   *     number in a different box: its preparer panel carries `company_statutory_authority.phone`, the
   *     number recorded against the LHDN row. Two boxes asking two questions, deliberately not merged.
   *   • lhdnState / officerName / officerPosition → `company_statutory_authority` where
   *     `authority = 'lhdn'`: the branch state the employer's tax file sits with, and the signatory
   *     that record names, with their CURRENT job title. THE SIGNATORY IS THE SAME ROW THE PRINTED CP39
   *     reads for its preparer block (localization/my/cp39-form.ts) — one answer per question, because
   *     two LHDN documents naming different officers for one company is what costs a filing.
   *
   * Every one of them may be absent, and an absent one prints the form's own empty rule — never a
   * placeholder and never a plausible-looking guess (AGENTS 28).
   */
  employer: {
    name: string;
    eNumber: string | null;
    /** Alamat Majikan, one entry per printed line. Empty array = nothing on file. */
    address: string[];
    /** No. Telefon Majikan. */
    phone: string | null;
    /** LHDNM Negeri — the LHDN branch state on the employer's own statutory record. */
    lhdnState: string | null;
    /** "Name Pegawai" (the form's own spelling — see lib/ea-pdf.ts) and their Jawatan. */
    officerName: string | null;
    officerPosition: string | null;
  };
  employee: {
    name: string;
    ic: string | null;
    taxNo: string | null;
    epfNo: string | null;
    socsoNo: string | null;
    category: number;
    /**
     * A.8 — "Number of children qualified for tax relief". A COUNT OF CHILDREN, resolved per
     * child-relief mode (r364, reversing r359 — see the derivation in `eaStatement`).
     *
     * ⚠️ r359 SAID THE OPPOSITE AND SHIPPED IT. Its sentence here read: "A.8 — C, the NUMBER OF
     * QUALIFYING CHILDREN in LHDN's own sense: the s.48-weighted figure, not a count of child records
     * … NULL when the year's slips carry no stamped relief, which is the same condition that leaves
     * D.6 empty: the two boxes are one fact and are absent together." Both halves are reversed: A.8 is
     * a count again, and it no longer depends on D.6's stamp. C is a term in LHDN's MONTHLY tax
     * formula; it is not what this box asks for. D.6 carries the weighted ringgit on the same page.
     *
     * NULL means UNRECORDED, not zero: no `employee_statutory_my` row, or a null `num_children`, in a
     * mode that reads that column. `0` is a claim that no child qualifies, which is why an 'auto_table'
     * employee with no grid keyed prints 0 and an employee with nothing on file prints an empty rule.
     */
    children: number | null;
    hiredOn: string;
    terminatedOn: string | null;
    /** 6036dab7 — three Part A particulars the customer's field mapping asks for. All three already
     *  existed on tables this read ALREADY joins (employment.employee_code, employee_statutory_my.
     *  passport_number) or on one join away (the position title on the dated assignment) — which is why
     *  the plan says "no migration". `passport` is the same column cp39FormExtras reads for the same
     *  purpose; a second passport source is a second answer to "which passport is on this person's tax
     *  paperwork". `jobTitle` is the title on the assignment IN FORCE at the end of the employment's year,
     *  NOT on an open assignment — a leaver has none, and an EA is chiefly a leaver's document. */
    employeeNo: string | null;
    jobTitle: string | null;
    passport: string | null;
  };
  /** Part B — employment income. `exemptAllowances` (feedback 09b554e9) — the year's TAX-EXEMPT allowance
   *  portions (the PCB_* exemption amounts each slip stamps as statutory.exemptionUsed), reported in
   *  Section F, which is the box the agency provides for them.
   *
   *  ⚠️ r353 — IT IS NOT A PORTION OF `allowances`, AND THIS SENTENCE USED TO SAY IT WAS. `allowances`
   *  is Section B 1(c), whose section heading reads "(EXCLUDING Tax Exempt Allowances / Perquisites /
   *  Gifts / Benefits)", so it carries the TAXABLE excess only. The two figures are disjoint: 1(c) + F
   *  is the allowance money paid, and neither box double-reports the other's ringgit.
   *
   *  6036dab7 — the ten fields after it are the customer's mapped Part B boxes. Every one has a derived
   *  baseline of 0 and becomes non-zero only through an ea_override (see EA_FIELDS). They are REQUIRED on
   *  this type, not optional: an EA surface that can forget to print "Compensation for loss of employment"
   *  is an EA surface that quietly omits a taxable box. `gross` is their sum (EA_PART_B_COMPONENTS). */
  partB: {
    grossSalary: number;
    bonus: number;
    allowances: number;
    gross: number;
    exemptAllowances?: number;
    directorFee: number;
    tipsPerquisites: number;
    taxBorneByEmployer: number;
    esos: number;
    gratuity: number;
    arrears: number;
    benefitsInKind: number;
    livingAccommodation: number;
    unapprovedFundRefund: number;
    compensation: number;
  };
  /** 6036dab7 — Part C (Pencen dan Lain-lain). The section did not exist on either EA surface at all,
   *  which the plan calls the clearest gap in the mapping. Neither figure has a payroll source (this
   *  product does not pay pensions), so both are manual boxes and `total` is their sum. */
  partC: { pension: number; annuity: number; total: number };
  /** Total deduction — MTD/PCB, the LHDN/court CP38 instalment, and the year's zakat-via-salary (Z).
   *  6036dab7 — `cp38` is summed from payslip.statutory.cp38, the SAME scalar cp39() files; the EA
   *  surfaces printed the words "not tracked" for it long after payroll started stamping it. */
  partD: {
    mtd: number;
    cp38: number;
    zakat: number;
    /**
     * da4fc817 — the four lines the official C.P.8A has and this statement did not.
     *
     * `tp1Relief` is REAL: `core/tax-relief`'s `tp1CountForYear` over the year's approved declarations —
     * THE rule, not a second sum of `tp1_relief` (that file's header explains at length what a second
     * spelling cost last time).
     *
     * `donations` and `zakatOther` have NO payroll source: donations through salary are not a payroll
     * deduction here and zakat paid outside the salary is by definition not on a payslip. Both are 0
     * until HR enters one, and the renderer prints the caption and an empty rule rather than 0.00 on a
     * tax document.
     *
     * ⚠️ `childRelief` WAS in that list until r351 and is now DERIVED, at the reporter's instruction.
     * It is the annual, s.48-weighted child relief the payroll kernel actually allowed, read off the
     * year's LAST slip that carries a `pcbMeta.reliefs` snapshot. `da4fc817`'s reasoning — "a tax
     * computation the employee claims rather than a figure the employer withholds" — was the reason it
     * stayed empty; the agency's Section D is headed TOTAL DEDUCTION and lists it beside the employer's
     * own MTD, CP38 and TP1 figures, so it is the employer's allowance that belongs there. Still
     * amendable by HR, exactly as before.
     */
    tp1Relief: number;
    donations: number;
    zakatOther: number;
    childRelief: number;
  };
  /**
   * Section E — the employee's own compulsory contributions.
   *
   * ⚠️ r367 (item fda53352, round A) — `socso`, `eis` AND `skbbk` ARE THE THREE LEGS OF THE **ONE** BOX
   * THE FORM PRINTS AT E(2). They are kept apart here and added by the renderer; nothing derives a
   * fourth "E(2) total" field, because a stored total is a second source of truth for a sum.
   *
   * WHY THE BOX IS BROADER THAN THE SOCSO LEG — settled from LHDN's own paper, not from reasoning:
   *   • docs/forms/ea-cp8a-pin-2023-official-en.pdf, Section E is headed "CONTRIBUTIONS PAID BY EMPLOYEE
   *     TO APPROVED PROVIDENT / PENSION FUND AND SOCSO", and item 2 reads "SOCSO: Amount of compulsory
   *     contribution paid (state the employee's share of contribution only)".
   *   • docs/forms/ea-cp8a-pin-2023-official-bm.xlsx (sharedStrings 82 and 64) writes the SAME two
   *     captions as "… DAN PERKESO" and "PERKESO : Amaun caruman yang wajib dibayar (nyatakan bahagian
   *     pekerja sahaja)". The Malay original names the ORGANISATION — PERKESO — not one of its schemes;
   *     SOCSO is simply that organisation's English name.
   *   • LHDN's own companion form scopes a contribution to that organisation to two Acts:
   *     docs/forms/tp1-2026-form-en.pdf item C14 — "Contributions to PERKESO under the Employees' Social
   *     Security Act 1969 / Employment Insurance System Act 2017" — and its explanatory notes name them
   *     as [Act 4] and [Act 800].
   *   • EIS is Act 800. SKBBK is Act 4 as amended (Akta A1788), employee-only, MANDATORY from 1 Jun 2026
   *     and collected on the same PERKESO schedule (localization/my/statutory-tables.ts,
   *     core/statutory-explain.ts). It POSTDATES Pin. 2023 by three years, so its absence from the
   *     caption is a DATING fact, not an exclusion.
   * So E(2) asks for every compulsory PERKESO amount the employee paid, and until r367 we stated one of
   * the three. `eis` in particular was on no printed EA at all after r351 removed our below-form strip.
   *
   * A payslip written before June 2026 carries no `socsoSkbbk` key and `num()` gives 0, so every closed
   * year is byte-identical to what it printed before.
   */
  partE: {
    epf: number;
    socso: number;
    eis: number;
    /** Lindung 24 Jam / SKBBK — the employee-paid Act 4 leg (eff 1 Jun 2026). No employer share exists,
     *  so there is nothing to net off. Part of E(2)'s printed sum. */
    skbbk: number;
    /** da4fc817 — Section E asks WHICH fund before it asks how much ("Nama Kumpulan Wang"). Constant for
     *  the MY pack: the approved fund an employee contributes to here is KWSP. */
    fundName: string;
  }; // employee's share of EPF + the three PERKESO legs
  /**
   * ⚠️ r367 (item fda53352, round A) — THE "Tarikh" / "Date" BOX AT THE FOOT, WHICH WAS DELIBERATELY
   * BLANK UNTIL NOW. ISO `yyyy-mm-dd`, or null when there is no statement to date.
   *
   * THE RULE IS THE REPORTER'S BUSINESS RULE, NOT THE AGENCY'S: `MIN(today, 28 February of the year
   * after the EA year)`. **Nothing in this repository or in the committed agency files sources a
   * published LHDN furnishing deadline for the EA**, and `test/statutory-forms-page.test.ts` deliberately
   * leaves Form E's deadline UNSET on the recorded grounds that "an invented statutory deadline is worse
   * than an absent one: somebody files against it". So this is NOT a statutory-deadline field, is not
   * surfaced as one, and no deadline was added to the Statutory Forms screen. r219 decided the opposite
   * of this box ("the signing date is the employer's to write, not ours to invent"); the reporter has now
   * told us what to write, so we write it.
   *
   * COMPUTED HERE AND NOT IN THE RENDERER, on purpose: a clock read inside `renderEaPdf` would make every
   * EA test time-dependent. The clock is `todayInKualaLumpur()` — a UTC date names the WRONG DAY for the
   * eight hours between 00:00 and 08:00 MYT, and that exact bug has been fixed twice recently. The
   * comparison is ISO string arithmetic, so no Date maths can reintroduce a timezone.
   */
  formDate: string | null;
  statutoryVersion: string;
  /** EA-only amendments overlaid by HR (1.2.6). Empty = none. Additive + optional so existing consumers
   *  keep compiling; the PDF/HTML surfaces read it to badge amended lines. */
  overrides: EaOverrideEntry[];
  /**
   * ea54fe6e — the state of pay-item routing FOR THIS FORM, so the screen can say why a box reads as it
   * does instead of leaving the operator to guess.
   *
   * `unmapped` is the reporter's §7/§8: pay items that put Part B money on THIS form and carry no EA
   * line, which is precisely the set that would go on being lumped into allowances. It is computed
   * whatever the year, so the warning is useful BEFORE routing switches on — an operator can finish the
   * mapping during 2026 and have it take effect correctly in 2027, rather than discovering the gap on
   * the first form that needed it.
   */
  routing: {
    /** Earlier years remain inactive unless every owned slip proves complete historical item provenance. */
    active: boolean;
    /** Only a complete year of saved run-owned evidence may supply automatic B3/B4 amounts. */
    nonCashComplete?: boolean;
    fromYear: number;
    /** Pay items with Part B money on this form and no EA line, by code. Empty = nothing to warn about. */
    unmapped: { code: string; name: string }[];
  };
};

/**
 * b7b22514 — every employer that owes this employee an EA form for the year, oldest first.
 *
 * An EA form is per EMPLOYER, and after an Entity Transfer one employment has had more than one. The set
 * is derived from the payslips actually paid (company-true by construction, and unaffected by any later
 * transfer), with the employment's CURRENT company always included last — a company that has not yet run
 * payroll for someone it employs still owes them a form at year end.
 *
 * Returns a single entry for everyone who has never transferred, which is what keeps every existing
 * caller's output byte-identical.
 */
export async function eaCompaniesInYear(
  ctx: SessionContext,
  p: { employmentId: string; year: string },
): Promise<{ companyId: string; name: string; isCurrent: boolean }[]> {
  return withTenant(ctx, async (tx) => {
    const paid = await tx
      .selectDistinct({ companyId: payrollBatch.companyId, name: company.legalName, first: payrollBatch.payPeriod })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(and(eq(payslip.employmentId, p.employmentId), like(payrollBatch.payPeriod, `${p.year}-%`)));

    // Oldest employer first, so a transfer year reads in the order it happened.
    const byCompany = new Map<string, { companyId: string; name: string; first: string }>();
    for (const r of paid) {
      const cur = byCompany.get(r.companyId);
      if (!cur || r.first < cur.first) byCompany.set(r.companyId, { companyId: r.companyId, name: r.name, first: r.first });
    }
    const out = [...byCompany.values()].sort((a, b) => a.first.localeCompare(b.first));

    const [cur] = await tx
      .select({ companyId: employment.companyId, name: company.legalName })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    // `isCurrent` is returned rather than inferred from position: callers gate the amend panel on it, and
    // "the last one in the list" is a guess that happens to hold today and would break the day the sort
    // changes. The amend panel writing to the wrong employer's form is not a failure worth risking on one.
    if (!cur) return out.map(({ companyId, name }) => ({ companyId, name, isCurrent: false }));
    const result = out.map(({ companyId, name }) => ({ companyId, name, isCurrent: companyId === cur.companyId }));
    if (!result.some((r) => r.isCurrent)) result.push({ ...cur, isCurrent: true });
    return result;
  });
}

/**
 * Per-employee EA (C.P.8A) statement for a tax year, from the year's payslips — FOR ONE EMPLOYER.
 *
 * ⚠️ `companyId` EXISTS BECAUSE OF b7b22514 (Entity Transfer). An EA form is an EMPLOYER's statement of
 * what IT paid, and until an employee could move company, "the employment's payslips for the year" and
 * "this employer's payslips for the year" were the same set, so no filter was needed. They are no longer
 * the same set. Left unfiltered, an employee transferred from A to B in July got ONE form, printed on B's
 * letterhead with B's employer number, containing six months of A's remuneration — a wrong statutory
 * form, filed under the wrong employer, overstating the year at one company and omitting it at the other.
 *
 * Omitting `companyId` means "the employer this employment currently sits at", which is byte-identical to
 * the old behaviour for everyone who has never transferred. Use eaCompaniesInYear + one call per company
 * to produce the full set of forms a transferred employee is owed.
 */
/**
 * r219 — the employer address as the C.P.8A's foot prints it: the three free lines, then postcode/town
 * and state on one tail line. Blank parts are dropped rather than printed as gaps, so a company with one
 * address line gets one line and the remaining rules stay empty.
 *
 * A SECOND SPELLING OF cp39-form.ts's `addressLines`, deliberately NOT shared: that one is private to the
 * CP39 read and lives behind that form's own module, and exporting it to reach across two form modules
 * would make one form's layout change the other's. The rule itself is four lines of composition and is
 * asserted here on its own; if a third form needs it, that is when it earns a home of its own.
 */
function eaEmployerAddressLines(c: {
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  postcode: string | null;
  city: string | null;
  state: string | null;
}): string[] {
  const tail = [[c.postcode, c.city].filter(Boolean).join(' '), c.state].filter(Boolean).join(', ');
  return [c.addressLine1, c.addressLine2, c.addressLine3, tail].map((s) => (s ?? '').trim()).filter(Boolean);
}

/**
 * r367 (item fda53352, round A) — THE C.P.8A's "Tarikh" / "Date" BOX, WHICH WAS BLANK BY DECISION UNTIL NOW.
 *
 * `MIN(today in Kuala Lumpur, 28 February of the year AFTER the EA year)`, as ISO `yyyy-mm-dd`.
 *
 * ⚠️ WHOSE RULE THIS IS. The reporter's, stated by them and applied literally at their request. **There
 * is no published LHDN rule fixing this box**, and none is sourced anywhere in this repository or in the
 * committed agency files (docs/forms/ea-cp8a-pin-2023-official-en.pdf carries the box and no deadline).
 * `test/statutory-forms-page.test.ts` leaves Form E's deadline UNSET for the recorded reason that "an
 * invented statutory deadline is worse than an absent one: somebody files against it", so this function
 * is NOT a statutory-deadline source, nothing reads it as one, and the Statutory Forms screen gained no
 * deadline in this round. r219 pinned the opposite decision ("the signing date is the employer's to
 * write, not ours to invent"); the reporter has now said what to write.
 *
 * ⚠️ MALAYSIAN TIME, AND STRING ARITHMETIC. `todayInKualaLumpur()` because a UTC date names the wrong day
 * for the eight hours between 00:00 and 08:00 MYT, and that exact bug has been fixed twice recently. The
 * cap is compared as ISO text — `'2027-03-10' > '2027-02-28'` — so there is no Date construction for a
 * timezone to creep back into, and 28 February is LITERAL: a leap year does not move it to the 29th.
 *
 * `now` is injectable so the guards pin the rule against a chosen clock instead of a hardcoded future
 * date (CLAUDE.md §8).
 */
export function eaFormDate(year: string, now?: Date): string {
  const today = todayInKualaLumpur(now ?? new Date());
  const cap = `${Number(year) + 1}-02-28`;
  return today < cap ? today : cap;
}

export async function eaStatement(
  ctx: SessionContext,
  // r367 — `now` is the injectable clock for `formDate` and nothing else. Optional, so every existing
  // caller (core/reporting.ts, the two PDF routes, the country-pack facade) is unchanged.
  p: { employmentId: string; year: string; companyId?: string; now?: Date },
): Promise<EaStatement | null> {
  return withTenant(ctx, async (tx) => {
    const [info] = await tx
      .select({
        name: person.fullName,
        // da4fc817 — TP1 is stored per PERSON, so Section D's relief line needs the person behind the
        // employment. Already on a table this SELECT joins, so it costs nothing.
        personId: person.id,
        ic: employeeStatutoryMy.icNumber,
        taxNo: employeeStatutoryMy.taxNumber,
        epfNo: employeeStatutoryMy.epfNumber,
        socsoNo: employeeStatutoryMy.socsoNumber,
        category: employeeStatutoryMy.taxCategory,
        children: employeeStatutoryMy.numChildren,
        /**
         * r353 (item fda53352, point 1) — ITEM 8 IS MODE-DEPENDENT, AND r351 RULED ON ONLY ONE MODE.
         *
         * r351 answered the reporter that A.8 is "correct as a count" without distinguishing the three
         * child-relief modes, and that is right for 'auto' and wrong for 'auto_table':
         *
         *   'auto'       — `syncChildReliefFromFamily` writes `eligibleChildReliefCount` into
         *                  `num_children`, so the column IS the qualifying head count. Nothing to do; a
         *                  head count rather than s.48 units is the right answer for this box and
         *                  core/dependents.ts argues why on `eligibleChildReliefCount`.
         *   'auto_table' — the KEYED grid is what the PCB calculation prices
         *                  (`pricesChildReliefFromGrid`), and `num_children` is a separate stored figure
         *                  that only this employee's Identification & Tax card keeps level with it, on
         *                  save. So a corrected s.48 grid could drive the payslip while item 8 printed a
         *                  stale hand-keyed number. Item 8 now reads the grid, which is the source that
         *                  priced the tax.
         *   'manual'     — a typed figure BY DESIGN. Rail (a) of the sync exists so a human keeps control
         *                  of their own tax figure, so nothing here overwrites it.
         *
         * ⚠️ THE FIX IS A READ, NOT A WRITE, AND THAT IS DELIBERATE. The approved plan's build note said
         * to extend `syncChildReliefFromFamily`'s gate (core/dependents.ts) from `!== 'auto'` to include
         * 'auto_table', on the stated grounds that "its grid already derives". IT DOES NOT: the sync
         * writes `childReliefTable: state.grid` derived FROM THE FAMILY REGISTER and hardcodes
         * `childReliefMode: 'auto'`, while core/dependents.ts (`pricingTable`) records that 'auto_table'
         * "keeps the KEYED grid, because that mode exists precisely for the case where the employee's
         * DECLARED relief differs from what the Family tab holds and there is no register behind it to
         * re-derive from". Widening that gate would therefore have overwritten the declared grid with the
         * register's and silently flipped the employee out of 'auto_table' — moving real tax on the same
         * rail that exists to stop exactly that. Reported back on the item.
         */
        childReliefMode: employeeStatutoryMy.childReliefMode,
        childReliefTable: employeeStatutoryMy.childReliefTable,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        companyId: employment.companyId,
        companyName: company.legalName,
        // 6036dab7 — Part A's two remaining particulars. `employeeCode` and `passportNumber` are on tables
        // this SELECT already reads. The job title needs a dated lookup and is read separately below.
        employeeNo: employment.employeeCode,
        passport: employeeStatutoryMy.passportNumber,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!info) return null;
    /**
     * r353 — EA ITEM 8, "Number of children qualified for tax relief", PER MODE. See the long note on
     * the `childReliefMode` column in the SELECT above for the evidence and for the plan's build note
     * this deliberately does not follow.
     *
     * ⚠️ A HEAD COUNT IN EVERY BRANCH. `childReliefTableHeadCount` sums the grid's per-category COUNTS
     * of children, never their s.48 units, so the box stays the count the agency rules it for in all
     * three modes and CP8D's column (which reads `num_children` directly, unchanged) still agrees with
     * it for the two modes where `num_children` is maintained.
     *
     * ⚠️ AN 'auto_table' EMPLOYEE WITH NO GRID KEYED PRINTS 0, AND THAT IS THE HONEST FIGURE, not a
     * fallback to the stored column. `pricesChildReliefFromGrid` returns true for 'auto_table'
     * unconditionally, so an unkeyed grid DECLARES no child relief for anybody: zero children qualify,
     * and that is a fact about what this employee's tax record says, readable without any payroll run.
     *   ⚠️ r364 — THIS ANSWER IS KEPT AND ITS REASON IS RE-ARGUED. The sentence here used to end
     *   "Printing the stale `num_children` beside a D.6 of nothing would put two contradictory answers
     *   on one page; CLAUDE.md §8, the count follows the money." The 0 survives; "the count follows the
     *   money" does not, and that slogan is what r359 rode all the way to printing a price in a box
     *   ruled for a number of people. A.8 answers "how many children qualify"; D.6 answers "what is the
     *   relief worth". They are different questions, so the two boxes cannot contradict each other and
     *   neither one is evidence about the other.
     *
     * ══ r364 (fda53352 rev 8) · REVERSES r359. A.8 IS THE COUNT AGAIN, AND THE AGENCY'S OWN OUTPUT
     *    SETTLES IT INSIDE ONE DOCUMENT ═══════════════════════════════════════════════════════════════
     *
     * r359 replaced the expression below with `childReliefFromPayroll / perChild` — the s.48-weighted C
     * — reasoning from the MTD specification's variable list and from LHDN's PCB Calculation Slip. Those
     * govern the MONTHLY TAX CALCULATION. Nothing in either speaks to Form EA, and the slip itself
     * distinguishes the two figures on its own pages:
     *
     *   docs/forms/pcb-calculation-slip-specimen-2026-12.pdf page 1 (a filled SPECIMEN, not agency artwork; the
     *   governing document is docs/forms/pcb-spec-2026-computerised-calculation.pdf) — a grid headed "Number of children
     *   / Qualification rate 100% 50%", printing (a) Under 18 = 1 and (e) Disabled and still studying
     *   = 1. TWO children, each a whole child, for this very employee;
     *   the same file, page 6 — "Q = Deduction for eligible children 2,000.00" and "C = Number of
     *   eligible children 9.00".
     *
     * LHDN prints 2 where it means children and 9.00 where it means C, in one document. r359 read half
     * of it. And the form's own English is unambiguous: docs/forms/ea-cp8a-pin-2023-official-en.pdf
     * prints "8. Number of children qualified for tax relief" among New I.C. No., Passport No., EPF No.
     * and SOCSO No. — the left column of particulars, no RM heading over it — while the weighted money
     * has its own box in the RM column, "6. Total qualifying child relief". *Bilangan* is a count.
     *
     * DELIBERATELY NOT SOURCED FROM THE PAYSLIP TRACE. `trace.childCount` changed meaning at r359
     * (record count before, weighted after), so a slip written in August and one written in October
     * disagree about what that field is. A.8 reads the employee's tax record, which is one thing.
     *
     * KNOWN AND NAMED RATHER THAN QUIETLY WIDENED: this is the employee's position TODAY, not as at the
     * year the form covers. No per-year head-count snapshot exists. That was true before r359 as well
     * and is not fixed here; it is recorded on the item instead.
     */
    const eaQualifyingChildren =
      info.childReliefMode === 'auto_table'
        ? childReliefTableHeadCount(info.childReliefTable as Record<string, { full?: unknown; half?: unknown }> | null)
        : info.children;
    // ── Part A's Jawatan — r209 fix: IT MUST SURVIVE TERMINATION ─────────────────────────────────────
    // 6036dab7 read this off the OPEN assignment (`valid_to IS NULL`), copying cp39FormExtras, which asks
    // about a serving preparer. An EA is chiefly issued to LEAVERS, and terminateEmploymentTx closes the
    // open assignment at the termination date (core/org.ts) — so that predicate matched nobody who had
    // left, and Part A printed '—' for the job title on every leaver's form while the employee number and
    // passport beside it printed fine.
    //
    // So reconstruct the assignment IN FORCE on the last day this employment ran inside the tax year,
    // which is what ADR-0001 prescribes and what core/org.ts getAssignmentAsOf / core/analytics.ts
    // `assignmentEffectiveAt` already do. The upper bound is INCLUSIVE for the reason analytics documents
    // for its termination cohort: the closing row carries valid_to = the termination date, and the
    // employee held that job through their last day. `desc(validFrom)` settles a same-day handover (a
    // change closes the old row and opens the new one on the SAME date) in favour of the newer row.
    const yearEnd = `${p.year}-12-31`;
    const titleAsOf = info.terminatedOn && info.terminatedOn < yearEnd ? info.terminatedOn : yearEnd;
    const [asg] = await tx
      .select({ jobTitle: position.title })
      .from(assignment)
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(
        and(
          eq(assignment.employmentId, p.employmentId),
          isNull(assignment.supersededAt),
          lte(assignment.validFrom, titleAsOf),
          or(isNull(assignment.validTo), gte(assignment.validTo, titleAsOf)),
        ),
      )
      .orderBy(desc(assignment.validFrom))
      .limit(1);
    // The employer this form speaks for. Defaults to where the employment sits now; for a past employer
    // in a transfer year it is that company, and the name + E number must BOTH come from it — a form
    // carrying one company's name and another's employer number is worse than either alone.
    const employerId = p.companyId ?? info.companyId;
    // r219 — ONE read of the employer row, for the employer this form speaks for, whether or not that is
    // where the employment sits today. It used to be conditional (only a transfer year re-queried) and
    // returned the legal name alone; the printed C.P.8A's foot also needs the address and the telephone
    // number, and those must come from the SAME company as the name — a form carrying one company's name
    // and another's address is worse than either alone.
    const [co] = await tx
      .select({
        legalName: company.legalName,
        addressLine1: company.addressLine1,
        addressLine2: company.addressLine2,
        addressLine3: company.addressLine3,
        postcode: company.postcode,
        city: company.city,
        state: company.state,
        phone: company.phone,
      })
      .from(company)
      .where(eq(company.id, employerId))
      .limit(1);
    if (!co) return null;
    const employerName = co.legalName;
    const employerAddress = eaEmployerAddressLines(co);
    const [stat] = await tx
      .select({ eNumber: companyStatutoryMy.lhdnEmployerNo })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, employerId))
      .limit(1);
    // The foot's officer block and the header's LHDNM Negeri. `authority = 'lhdn'` is the row the
    // Organization screen already maintains and the printed CP39 already reads for its preparer block —
    // deliberately the same source, so the two LHDN documents cannot name different officers. A company
    // with no row simply leaves those boxes as the empty rules the blank form prints.
    const [auth] = await tx
      .select({ state: companyStatutoryAuthority.state })
      .from(companyStatutoryAuthority)
      .where(and(eq(companyStatutoryAuthority.companyId, employerId), eq(companyStatutoryAuthority.authority, 'lhdn')))
      .limit(1);
    // Display identity only, guarded by EA ownership/payroll scope inside the database. Ordinary
    // employees cannot read their company's signatory person row; do not widen person RLS for a form.
    const officer = await tx.execute<{ officer_name: string | null; officer_position: string | null }>(
      sql`select * from app.ea_signatory(${p.employmentId}::uuid, ${employerId}::uuid, ${p.year})`,
    );
    const officerName = officer[0]?.officer_name ?? null;
    const officerPosition = officer[0]?.officer_position ?? null;
    const slips = await tx
      .select({
        payPeriod: payrollBatch.payPeriod,
        basic: payslip.basicSalary,
        allowance: payslip.allowance,
        overtime: payslip.overtimePay,
        bonus: payslip.bonus,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .where(
        and(
          eq(payslip.employmentId, p.employmentId),
          like(payrollBatch.payPeriod, `${p.year}-%`),
          // THE FIX. A payslip belongs to the company whose batch paid it, and no later transfer rewrites
          // that — so this join is company-true for closed years as well as the current one.
          eq(payrollBatch.companyId, employerId),
        ),
      )
      // r351 — AN EXPLICIT ORDERING, because D.6 below takes "the LAST month's relief snapshot" and
      // CLAUDE.md §8 forbids reading that off an unordered result ("no [length-1], no 'the last entry'
      // … any asserted array from a query needs ORDER BY"). Every other figure this feeds is a SUM and
      // did not care; that one does. The column itself is NOT selected — ordering by a joined table's
      // column needs no projection, and adding one here would be a field nothing reads.
      .orderBy(payrollBatch.payPeriod);

    /**
     * ⚠️ 5d721048 — THE SAME REFUSAL `localization/my/pcb2ii.ts` MAKES, AND FOR THE SAME REASON.
     *
     * The rule, its two-fact test, why it is a bare 404 and why a never-paid employment still keeps its
     * empty form are all written out at pcb2ii.ts's copy of this line — read it there. r328 fixed the
     * PCB 2(II) and left the C.P.8A (EA) with the identical hole: `employerId` comes from a URL, and the
     * only thing standing in front of it was `scopedAdmin`'s scope check, which proves the OPERATOR may
     * see that company and never that this EMPLOYMENT sits in it. Two companies in one tenant, so RLS
     * cannot separate them either. The slips join above already keeps the MONEY company-true, so what
     * printed was a sheet of zeros — an employee's name, identity card and tax number under a letterhead
     * of a company that never employed them, which is a worse document than none.
     *
     * It is deliberately AFTER the slips query and not beside the `!info` / `!co` refusals above: the
     * second operand is `slips`, which does not exist yet up there.
     *
     * NOT a third population to keep in step with `eaCompaniesInYear` — that read returns exactly "the
     * companies whose batches paid this employment this year, plus the current one", so every employer
     * the switcher and `employeeEaStatements` can name passes this test by construction.
     */
    if (employerId !== info.companyId && slips.length === 0) return null;

    let grossSalary = 0;
    let bonus = 0;
    let allowances = 0;
    let gross = 0;
    let mtd = 0;
    // 6036dab7 — the LHDN/court instalment, DISTINCT from MTD. Stamped on the REGULAR run only (an
    // additional run carries cp38 = 0, core/payroll.ts:4749), so summing the year's slips single-counts
    // each month's one instalment — the same rule cp39() and cp39FileForBatch apply to the monthly return.
    let cp38 = 0;
    let zakat = 0;
    let epf = 0;
    let socso = 0;
    let eis = 0;
    // r367 — the third PERKESO leg. Summed exactly like the other two and printed INSIDE E(2); see the
    // `partE` type for the caption reasoning and for why the three stay apart.
    let skbbk = 0;
    let exemptAllowances = 0;
    let nonCashExemptions = 0;
    /**
     * ⚠️ r351, item fda53352 — D.6 "Total qualifying child relief" STOPS BEING AN EMPTY RULE.
     *
     * WHAT CHANGED AND WHAT DECISION IT REVERSES. `da4fc817` decided this box has no payroll source
     * because "the child-relief TOTAL is a tax computation the employee claims rather than a figure the
     * employer withholds", and left it 0 so the renderer prints the caption and an empty rule. The
     * reporter has asked for the ringgit, and the box is plainly a money box: the agency's own Section D
     * is headed TOTAL DEDUCTION and D.6 sits among MTD, CP38, zakat, donations and the TP1 relief, all
     * RM amounts. The count they were reading is A.8, "Number of children qualified for tax relief",
     * which is a different box and is correct as a count.
     *
     * THE FIGURE IS THE KERNEL'S OWN, NOT A SECOND DERIVATION. `pcbMeta.reliefs.children` is what
     * `localization/my/payroll.ts` actually netted off the annual projected income P — an ANNUAL ringgit
     * figure, already weighted by the s.48 grid, so a disabled child in higher education shows RM16,000
     * and not RM2,000. It is already on the slips this function selects, so no new query and no import
     * of core/dependents.ts (which would close a module cycle through localization/registry).
     *
     * ⚠️ THE LAST MONTH'S FIGURE, NOT THE SUM AND NOT THE MAXIMUM. The relief is annual and is restated
     * on every slip, so summing twelve months would print twelve times the relief. MTD is cumulative and
     * self-correcting, so the final month's projection is the one that reconciles the whole year — that
     * is the employee's year-end position and the figure a return would claim. The ORDER BY above is what
     * makes "last" mean anything.
     *
     * ⚠️ TWO SHAPES CARRY NO FIGURE, AND BOTH LEAVE THE BOX EMPTY RATHER THAN PRINT 0.00. A slip written
     * before item 169e3c24 has no `reliefs` key at all, and a `kind: 'flat'` snapshot (non-resident /
     * flat rate) has no relief block by construction. `core/pcb-explain.ts:384` handles the first by
     * falling back to the employee's CURRENT position and saying which it is showing; an EA cannot say
     * that in a box, and substituting today's family for the year's would be a figure we cannot stand
     * behind. CLAUDE.md §8: an absent box asserts nothing, `0.00` asserts the money does not exist.
     */
    let childReliefFromPayroll: number | null = null;
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Stat & {
        exemptionUsed?: Record<string, number>;
        pcbMeta?: { reliefs?: { children?: number } };
      };
      const stampedChildRelief = st.pcbMeta?.reliefs?.children;
      if (stampedChildRelief !== undefined && stampedChildRelief !== null) {
        childReliefFromPayroll = num(stampedChildRelief);
      }
      nonCashExemptions += eaNonCashExemption(s.statutory);
      grossSalary += num(s.basic) + num(s.overtime);
      bonus += num(s.bonus);
      allowances += num(s.allowance);
      gross += num(s.gross);
      mtd += num(st.pcb);
      cp38 += num(st.cp38);
      // 1.2.4 Zakat — the year's accumulated zakat-via-salary (each payslip stamps the month's figure).
      zakat += num(st.zakat);
      epf += num(st.epfEmployee);
      socso += num(st.socsoEmployee);
      eis += num(st.eisEmployee);
      // A slip written before 1 Jun 2026 has no `socsoSkbbk` key at all and `num(undefined)` is 0, so
      // every pre-2026 year keeps the figure it printed before this round.
      skbbk += num(st.socsoSkbbk);
      // Feedback 09b554e9 — the exempt PCB_* allowance portions accumulate to the EA exempt-allowances
      // figure (LP_* codes are optional DEDUCTIONS, not exempt income, so they are excluded here).
      if (st.exemptionUsed) {
        for (const [code, amt] of Object.entries(st.exemptionUsed)) {
          if (code.startsWith('PCB_')) exemptAllowances += num(amt);
        }
      }
    }

    // ── 1.2.6 EA Data Overwrite — overlay HR's EA-only amendments onto the payroll-derived figures ──
    // EA-ONLY: nothing above touched payroll; this only rewrites the figures the EA form renders. Read the
    // override rows for (employment, year), apply each to its field, then recompute partB.gross from the
    // post-overlay components (so the printed Part B lines always sum to their total) UNLESS an explicit
    // `gross` override exists, in which case that wins. The merge appends NO event — it is a pure read.
    // da4fc817 — the year's TP1 relief, through THE rule rather than a second sum of `tp1_relief`.
    // `status = 'approved'` and the whole year's rows, exactly as core/payroll.ts reads them; the
    // effective-from and one-row-per-month decisions live inside `tp1CountForYear` and stay there.
    /**
     * ⚠️ TWO THINGS ARE DELIBERATE HERE: WHERE this comes from, and WHEN it is loaded.
     *
     * WHERE — the payroll pack FACADE, never the boundary module behind it. TP1 counting sits inside the
     * payroll pack's boundary (ADR-0080 D9), and a pack file reaching straight past the facade is exactly
     * what test/payroll-pack-drift.test.ts refuses. The facade re-exports the same symbols, so this calls
     * THE rule the payroll feed and the limit check call — the invariant that matters — through the seam
     * the ADR defines. Do not "simplify" this to the boundary path: the ratchet is not a formality, and
     * its allowlist only ever shrinks.
     *
     * WHEN — at the call, not at module scope, because there is a real cycle tsc cannot see: the boundary
     * module loads the country registry, the registry loads this pack, and this pack's index re-exports
     * this file. A top-level version throws `Cannot access '__vite_ssr_import_1__' before initialization`
     * at RUN TIME with a green typecheck; it was found by two EA suites failing to load at all.
     */
    const { TP1_COUNTABLE_COLUMNS, tp1CountForYear } = await import('../../packs/payroll/service');
    const tp1Rows = await tx
      .select({ personId: tp1Relief.personId, ...TP1_COUNTABLE_COLUMNS })
      .from(tp1Relief)
      .where(
        and(
          eq(tp1Relief.personId, info.personId),
          eq(tp1Relief.assessmentYear, Number(p.year)),
          eq(tp1Relief.status, 'approved'),
        ),
      );
    // `throughMonth: null` — an EA covers the WHOLE year, where the payroll feed asks month by month.
    const tp1ReliefTotal = tp1CountForYear(tp1Rows, { throughMonth: null }).total;

    // ── ea54fe6e — PAY ITEM → EA BOX ROUTING ────────────────────────────────────────────────────────
    // Reads each payslip's itemised `componentLines`, looks up that pay item's configured `ea_form_line`,
    // and MOVES the amount out of the summary figure the kernel's bucket put it in and into the mapped
    // box. Three properties make this safe to ship:
    //
    //   1. IT MOVES, NEVER ADDS. Part B plus Part C retains the processed total, so a form
    //      that reconciled yesterday still reconciles. Pinned by test/ea-line-routing.test.ts.
    //   2. Explicit current assignments route to their approved box; blank taxable income defaults
    //      to B1(a). Exempt and non-income buckets never become salary through that default.
    //   3. IT IS OFF FOR EVERY YEAR WE CANNOT STAND BEHIND — see EA_ROUTING_FROM_YEAR.
    //
    // Applied to `derived` BEFORE the override merge below, so a hand amendment still wins: the reporter
    // asked for exactly that precedence (Pay Item mapping → auto amount → manual amendment → final).
    const routed: Partial<Record<EaField, number>> = {};
    let routingActive = Number(p.year) >= EA_ROUTING_FROM_YEAR;
    /** Pay items whose money reached this form but which no one has mapped — the reporter's §7/§8. */
    const unmappedPayItems = new Map<string, string>();
    if (slips.length) {
      const catalogue = await tx
        .select({ code: payComponent.code, name: payComponent.name, eaLine: payComponent.eaFormLine })
        .from(payComponent);
      const lineOf = new Map(catalogue.map((c) => [c.code, c.eaLine]));
      const nameOf = new Map(catalogue.map((c) => [c.code, c.name]));
      routingActive ||= hasCompleteHistoricalEaProvenance(slips, lineOf);
      const routing = accumulateEaRouting(slips.flatMap((slip) => storedComponentLines(slip.statutory)), lineOf, EA_LINE_TO_FIELD, routingActive);
      Object.assign(routed, routing.deltas);
      for (const code of routing.unmapped) unmappedPayItems.set(code, nameOf.get(code) ?? code);
    }
    const nonCashEa = accumulatedEaNonCash(slips);
    for (const code of nonCashEa.unmapped) unmappedPayItems.set(code, code);
    const withRouting = (field: EaField, base: number) => round2(base + (routed[field] ?? 0));

    /**
     * ⚠️ r353 (item fda53352, point 3) — B.1(c) IS THE TAXABLE ALLOWANCE, NOT THE ALLOWANCE PAID.
     * THE REPORTER WAS RIGHT AND THIS FILE ARGUED THE OPPOSITE IN WRITING. See EA_PART_B_COMPONENTS
     * and EA_LINE_TO_FIELD above for the two comments this reverses, and what in them still stands.
     *
     * THE AGENCY'S OWN WORDS. Section B is headed
     *   "(Tidak Termasuk Elaun / Perkuisit / Pemberian / Manfaat Yang Dikecualikan Cukai)"
     *   — EXCLUDING tax-exempt allowances / perquisites / gifts / benefits
     * (`docs/forms/ea-cp8a-pin-2023-transcription.txt:99-100`), and `lib/ea-pdf.ts` PRINTS that
     * sub-caption directly above this column. The exempt total has its own box — Section F, whose title
     * IS the item (transcription :153). And the PCB specification says the same in the other direction
     * (`docs/forms/pcb-spec-2026-extracts.txt`, rule 9, printed p.20):
     *
     *   "All the tax exemption on allowances, benefit-in-kind and perquisites shall be EXCLUDED FROM
     *    THE REMUNERATION for MTD purposes. Any amount exceed the restricted amount shall be taxable."
     *
     * Until this line existed, the exempt ringgit was printed TWICE on one form: inside 1(c), under a
     * caption saying it must not be, and again in Section F, where it belongs.
     *
     * WHY THE SUBTRACTION IS THE WHOLE FIX, AND WHY THE LIMIT IS NOT RE-APPLIED HERE. `payslip.allowance`
     * is `allowanceApplied + reimburse + otConvertAmount` (core/payroll.ts) and the kernel already carved
     * the exempt slice into `reimburse` — capped at the code's ANNUAL headroom by `roomFor()`, so the
     * OVER-LIMIT remainder ("any amount exceed the restricted amount shall be taxable") is already in
     * `allowanceApplied` and already in this column. Re-deriving `max(total − limit, 0)` here would be a
     * second derivation of the same statutory limit, disagreeing with the payslips already issued the
     * first time a cap changed mid-year. The EA's only job is to stop adding the exempt part back.
     *
     * ⚠️ `exemptAllowances` KEEPS ITS SINGLE DERIVATION — the PCB exemption ledger, PCB_* codes only,
     * summed in the loop above. LP_* codes are optional DEDUCTIONS, not exempt income, and stay out.
     *
     * NON-NEGATIVE BY CONSTRUCTION, so there is no clamp to hide behind: every PCB_* ringgit counted in
     * `exemptAllowances` was added to that month's `reimburse`, which is inside that month's
     * `s.allowance`. A clamp would turn a kernel disagreement into a silent zero on a tax form.
     *
     * WHAT IS DELIBERATELY LEFT IN 1(c) (decision taken in the approved plan, revision 5): genuine
     * non-exempt reimbursements and the overtime-conversion excess, both of which also ride
     * `s.allowance`. Whether the agency's "elaun-elaun lain" is meant to carry them is UNKNOWN from
     * anything in this repo, and guessing is how a tax form acquires a confident wrong number.
     *
     * `tp3_exemption_used` is NOT an input: that exemption was consumed against a PREVIOUS employer's
     * pay and belongs on THEIR EA. `eaStatement` does not read it and must not start.
     */
    const taxableAllowances = round2(allowances - (exemptAllowances - nonCashExemptions));

    const derived: Record<EaField, number> = {
      grossSalary: withRouting('grossSalary', grossSalary),
      bonus: withRouting('bonus', bonus),
      allowances: withRouting('allowances', taxableAllowances),
      gross: round2(gross),
      mtd: round2(mtd),
      cp38: round2(cp38),
      zakat: round2(zakat),
      epf: round2(epf),
      socso: round2(socso),
      eis: round2(eis),
      skbbk: round2(skbbk),
      // 6036dab7 — these had NO payroll source and zero was their derived value, because inventing a
      // source for one is how a tax document acquires a figure nobody can trace.
      //
      // ea54fe6e GIVES TEN OF THEM A TRACEABLE SOURCE, AND ONLY A TRACEABLE ONE. `withRouting` adds
      // nothing unless an admin mapped a pay item to that box AND the year is one we hold every month
      // for; the money then comes from that item's own stamped line, so the figure traces to a payslip.
      // Zero remains the value for every unmapped box, and an ea_override still overrides.
      directorFee: withRouting('directorFee', 0),
      tipsPerquisites: withRouting('tipsPerquisites', 0),
      taxBorneByEmployer: withRouting('taxBorneByEmployer', 0),
      esos: withRouting('esos', 0),
      gratuity: withRouting('gratuity', 0),
      arrears: withRouting('arrears', 0),
      benefitsInKind: withRouting('benefitsInKind', nonCashEa.benefitsInKind),
      livingAccommodation: withRouting('livingAccommodation', nonCashEa.livingAccommodation),
      unapprovedFundRefund: withRouting('unapprovedFundRefund', 0),
      compensation: withRouting('compensation', 0),
      // Explicit Part C classifications transfer the processed amount out of Part B.
      // Blank classification never infers a pension/annuity; amendments retain precedence.
      pension: withRouting('pension', 0),
      annuity: withRouting('annuity', 0),
      // da4fc817 — Section D's four. `tp1Relief` is the one with a real source: the year's APPROVED
      // declarations put through `tp1CountForYear`, which is the same rule the payroll feed reads (see
      // core/tax-relief.ts's header on why a second sum is forbidden). No `throughMonth` — an EA covers
      // the WHOLE year, where the feed asks month by month.
      tp1Relief: round2(tp1ReliefTotal),
      // donations and zakatOther still have no payroll source: donations through salary are not a payroll
      // deduction in this system, and zakat paid OUTSIDE the salary is by definition not on a payslip.
      donations: 0,
      zakatOther: 0,
      // r351 — childRelief IS derived now. See the long note on `childReliefFromPayroll` above for what
      // reverses `da4fc817`'s decision and why the fallback is 0 (the renderer prints an empty rule for
      // 0, which is the honest output for a year whose slips carry no relief snapshot at all).
      childRelief: childReliefFromPayroll ?? 0,
    };
    // b7b22514 — AN AMENDMENT IS APPLIED TO EXACTLY ONE OF A TRANSFER YEAR'S FORMS.
    //
    // ea_override is keyed (employment, year, field) — it was designed when a year had one employer, so it
    // carries no company. With two forms in play the same row would overlay BOTH, and an amendment meant to
    // correct one employer's figure would be counted twice across the group. Under-applying is recoverable
    // (HR sees the underived figure and re-amends); double-applying silently inflates the group total in a
    // statutory filing, so the amendment lands on the CURRENT employer's form only.
    //
    // Every override row that exists today was written in a single-company world, so this is byte-identical
    // for them. Keying the table by company is the follow-up that makes a past employer's form amendable.
    const overridesApply = employerId === info.companyId;
    const ovRows = overridesApply
      ? await tx
          .select({ field: eaOverride.field, amount: eaOverride.amount, reason: eaOverride.reason })
          .from(eaOverride)
          .where(and(eq(eaOverride.employmentId, p.employmentId), eq(eaOverride.year, p.year)))
      : [];
    const merged: Record<EaField, number> = { ...derived };
    const overrides: EaOverrideEntry[] = [];
    let grossOverridden = false;
    for (const r of ovRows) {
      const field = r.field as EaField;
      if (!(EA_FIELDS as readonly string[]).includes(field)) continue; // defensive: ignore unknown discriminators
      const amended = round2(num(r.amount));
      overrides.push({ field, original: derived[field], amended, reason: r.reason });
      merged[field] = amended;
      if (field === 'gross') grossOverridden = true;
    }
    // Recompute the total from the (possibly amended) components, unless HR set `gross` directly.
    // 6036dab7 — driven off EA_PART_B_COMPONENTS rather than a hand-written sum, so a Part B box added to
    // the form cannot be left out of the form's own total. Every added component's baseline is 0, so this
    // is arithmetically identical to `grossSalary + bonus + allowances` for every statement that exists.
    if (!grossOverridden) merged.gross = round2(EA_PART_B_COMPONENTS.reduce((a, f) => a + merged[f], 0));

    return {
      year: p.year,
      employerId,
      employer: {
        name: employerName,
        eNumber: stat?.eNumber ?? null,
        address: employerAddress,
        phone: co.phone ?? null,
        lhdnState: auth?.state ?? null,
        officerName,
        officerPosition,
      },
      employee: {
        name: info.name,
        ic: info.ic,
        taxNo: info.taxNo,
        epfNo: info.epfNo,
        socsoNo: info.socsoNo,
        category: info.category ?? 1,
        // r353, restored by r364 — item 8, "Number of children qualified for tax relief", read from
        // whichever source the employee's child-relief mode makes authoritative. A COUNT of children in
        // every mode; r359's weighted C is D.6's business, not this box's. See the note above the
        // `eaQualifyingChildren` expression and the one on the `childReliefMode` select.
        children: eaQualifyingChildren,
        hiredOn: info.hiredOn,
        terminatedOn: info.terminatedOn,
        employeeNo: info.employeeNo ?? null,
        jobTitle: asg?.jobTitle ?? null,
        passport: info.passport ?? null,
      },
      partB: {
        grossSalary: merged.grossSalary,
        bonus: merged.bonus,
        allowances: merged.allowances,
        gross: merged.gross,
        exemptAllowances: round2(exemptAllowances),
        directorFee: merged.directorFee,
        tipsPerquisites: merged.tipsPerquisites,
        taxBorneByEmployer: merged.taxBorneByEmployer,
        esos: merged.esos,
        gratuity: merged.gratuity,
        arrears: merged.arrears,
        benefitsInKind: merged.benefitsInKind,
        livingAccommodation: merged.livingAccommodation,
        unapprovedFundRefund: merged.unapprovedFundRefund,
        compensation: merged.compensation,
      },
      // Part C's total is recomputed from the (possibly amended) lines for the same reason Part B's is:
      // a printed section total that does not equal its own printed lines is worse than no total.
      partC: { pension: merged.pension, annuity: merged.annuity, total: round2(merged.pension + merged.annuity) },
      partD: {
        mtd: merged.mtd,
        cp38: merged.cp38,
        zakat: merged.zakat,
        tp1Relief: merged.tp1Relief,
        donations: merged.donations,
        zakatOther: merged.zakatOther,
        childRelief: merged.childRelief,
      },
      partE: { epf: merged.epf, socso: merged.socso, eis: merged.eis, skbbk: merged.skbbk, fundName: EA_FUND_NAME },
      // r367 — see the `formDate` field on EaStatement for the rule, whose rule it is, and why the clock
      // is read here rather than in the renderer.
      formDate: eaFormDate(p.year, p.now),
      statutoryVersion: versionOf(slips.map((s) => s.statutory)),
      overrides,
      routing: {
        active: routingActive,
        nonCashComplete: nonCashEa.complete,
        fromYear: EA_ROUTING_FROM_YEAR,
        // Sorted by code so the warning lists the same items in the same order on every render.
        unmapped: [...unmappedPayItems.entries()]
          .map(([code, name]) => ({ code, name }))
          .sort((a, b) => a.code.localeCompare(b.code)),
      },
    };
  });
}

export const MY_REPORTS: ReportDef[] = [
  // No `submission`: an internal reconciliation view, not a form anybody files.
  { id: 'my.contributions', label: 'Monthly statutory contributions (overview)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: contributions },
  // `official` on NONE of these: not one of them comes out on the agency's own artwork. Some are drawn
  // to the agency's arrangement on our paper (`agency-layout`) and the rest carry the figures in our own
  // (`figures`). `outputs` includes `file` for the two that also emit a prescribed agency upload file —
  // those files carry their own draft chip, because neither has yet been accepted by the portal it is
  // built for (localization/my/cp39-file.ts, localization/my/socso-eis-file.ts).
  //
  // c99e8358 (2026-08-21) — `my.cp39` MOVED FROM `figures` TO `agency-layout`, AND THAT IS THE THIRD
  // MEMBER OF THAT SET RATHER THAN A NEW STATUS. `agency-layout` is the claim that every box, column and
  // heading is where the AGENCY's form puts it, on our own paper, with no agency artwork on disk —
  // exactly what `my.borang-8a` and `my.borang-a` already say for the same reason.
  //
  // WHAT EARNED IT: a legible filled Borang CP39 (Pin.2015) is now in the repository at
  // `docs/forms/cp39-pin-2015-specimen.png`, transcribed word for word into
  // `docs/forms/cp39-pin-2015-transcription.txt`, and `lib/cp39-form-pdf.ts` draws page one to it —
  // masthead, statutory citations, UNTUK KEGUNAAN PEJABAT, the three-panel band and the A / B / C
  // instruction panels, in the specimen's positions and its own words. `figures` (every number the form
  // needs, complete, in OUR layout) now understates what comes off the printer.
  //
  // ⚠️ AND NOT ONE STEP FURTHER. The specimen is another payroll system's rendering of the agency's
  // page, not LHDN's own artwork; it is deliberately NOT in `public/forms/`, which still holds one file
  // and it is the CP22. `official` stays `my.cp22` alone. The drawn page and its text twin both say on
  // their face that the paper is ours. Understating is safe; overstating is the single failure this
  // vocabulary exists to prevent.
  { id: 'my.cp39', label: 'CP39 — MTD / PCB (LHDN)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: cp39,
    descriptionKey: 'desc_cp39', fidelity: 'agency-layout', outputs: ['pdf', 'xlsx', 'csv', 'print', 'file'], shelfOrder: 11,
    // r409 (item 79f3f64d) — Open Form asks for Company, Year, Month AND the payroll cycles, and Continue
    // opens the statement itself in the shared viewer. `cp39` honours `runSeqs` since r409 (it reads them
    // through `loadBatchRows(…, { honourRunSeqs: true })`), which is the only reason this may be declared.
    runSelection: { action: '/payroll/cp39/preview' },
    submission: { body: 'lhdn', agency: 'LHDN', channel: 'e-PCB / e-Data PCB / e-CP39', dueDayOfNextMonth: 15 } },
  // NOT "Borang A", and it never becomes Borang A by being renamed. What this produces is a contributions
  // listing whose wage column is GROSS PAY; Borang A wants the EPF-liable wage and is a different document
  // that now sits beside this one at shelfOrder 2. This keeps its honest name.
  { id: 'my.epf', label: 'EPF contributions (KWSP)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: epfReport,
    descriptionKey: 'desc_epf', fidelity: 'figures', outputs: ['pdf', 'xlsx', 'csv', 'print'], shelfOrder: 1,
    submission: { body: 'epf', agency: 'EPF (KWSP)', channel: 'i-Akaun (Employer)', dueDayOfNextMonth: 15 } },
  // 9c8dad7a / 3aae0789 — BORANG A, built. It LEFT MY_PLANNED_FORMS and joined this list at the same
  // shelfOrder 2 it held there, which is the migration path `PlannedFormDef` was designed for: the shelf
  // is unchanged, the card simply stops saying "not built yet" and grows an action.
  //
  // A SECOND EPF ENTRY, AND NOT A CONTRADICTION OF `my.epf` ABOVE. That one is our own contributions
  // LISTING, and its wage column is gross pay. This is KWSP's own monthly contribution FORM: Upah is the
  // wage EPF was actually charged on, and it is emphatically not produced by relabelling the listing.
  //
  // `dueDayOfNextMonth: 15` — KWSP's deadline, the same one `my.epf` carries, because it is the same
  // filing deadline for the same body. (Borang 8A carries 15 too since r408: PERKESO's own 2025 booklet
  // puts its deadline on the 15th of the following month.)
  //
  // `fidelity: 'agency-layout'`, never 'official': see FormFidelity. The reporter's specimens are other
  // vendors' outputs and we hold no KWSP blank (r411: the claim that KWSP publishes none was never
  // checked and is no longer made).
  //
  // `outputs` carries `file` as well as `pdf`/`print`: item 3aae0789 is the i-Akaun upload file, built
  // from the SAME rows as the drawn page, behind its own route.
  { id: 'my.borang-a', label: 'Borang A — monthly contribution form (KWSP)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: borangAReport,
    descriptionKey: 'desc_borang_a', fidelity: 'agency-layout', outputs: ['pdf', 'print', 'file'], shelfOrder: 2,
    // r407 (item 4f45f9b0) — Open Form asks for the payroll cycles too, and Continue opens the form itself.
    // `borangAReport` honours `runSeqs` (r372/r373), which is the only reason this may be declared.
    runSelection: { action: '/payroll/borang-a/preview' },
    submission: { body: 'epf', agency: 'EPF (KWSP)', channel: 'i-Akaun (Employer)', dueDayOfNextMonth: 15 } },
  // r411 (item 4f45f9b0) — BBCD, "Borang Bayaran Caruman Bulanan - Pita/Disket": the one-page cover for the
  // month's Borang A payment, laid out like the reporter's October sample.
  //
  // `generate: borangAReport`, AND THAT IS THE POINT, NOT A SHORTCUT. A BBCD has no figures of its own: its
  // Amaun Caruman is the Borang A total for the same company, month and payroll cycles (its own CATATAN 2:
  // "Jumlah cek mesti sama dengan jumlah Borang BBCD"). Its preview and PDF route call `loadBorangA` and
  // project the built form (lib/borang-bbcd.ts), so the two documents share one read and one number. The
  // generic figures screen, if it is ever opened for this id, shows that same Borang A read.
  //
  // `runSelection` — Open Form asks for the payroll cycles, and Continue opens the BBCD itself.
  // `fidelity: 'agency-layout'`: drawn to the sample's arrangement on our paper; the sample is another
  // payroll system's print, and we hold no KWSP blank. `outputs`: the drawn page only.
  //
  // `shelfOrder: 4`, after the planned "Borang BBCB" (3), which keeps its slot: whether the reporter's
  // "BBCB" was this form is THEIRS to confirm, and is not settled by this entry.
  { id: 'my.borang-bbcd', label: 'BBCD — Borang Bayaran Caruman Bulanan (KWSP)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: borangAReport,
    descriptionKey: 'desc_borang_bbcd', fidelity: 'agency-layout', outputs: ['pdf', 'print'], shelfOrder: 4,
    runSelection: { action: '/payroll/borang-bbcd/preview' },
    submission: { body: 'epf', agency: 'EPF (KWSP)', channel: 'KWSP / Ejen Kutipan KWSP', dueDayOfNextMonth: 15 } },
  // SOCSO and EIS go up TOGETHER through ASSIST's combined contribution function — the reporter's words.
  // ONE `perkeso` shelf for the same reason: they are one filing, not two that happen to share a portal.
  // Same rule as EPF above: this is not "Borang 8A" and is not offered as one.
  { id: 'my.socso-eis', label: 'SOCSO + EIS (PERKESO)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: socsoEis,
    descriptionKey: 'desc_socso_eis', fidelity: 'figures', outputs: ['pdf', 'xlsx', 'csv', 'print', 'file'], shelfOrder: 1,
    submission: { body: 'perkeso', agency: 'PERKESO', channel: 'PERKESO ASSIST', dueDayOfNextMonth: 15 } },
  // 8ca344bf — BORANG 8A, built. It LEFT MY_PLANNED_FORMS and joined this list at the same shelfOrder 2 it
  // held there, which is the migration path `PlannedFormDef` was designed for: the shelf is unchanged, the
  // card simply stops saying "not built yet" and grows an action.
  //
  // A SECOND PERKESO ENTRY, AND NOT A CONTRADICTION OF `my.socso-eis` ABOVE. That one is the COMBINED
  // SOCSO + EIS listing that goes up through ASSIST — one filing, one shelf, and it keeps its honest name.
  // This is a different document: PERKESO's own monthly contribution SCHEDULE, one SOCSO figure per person,
  // and it is emphatically not produced by relabelling the listing above.
  //
  // `dueDayOfNextMonth: 15` — r408 (item e74af58c). PERKESO's 2025 employer booklet: contributions are due
  // "tidak lewat daripada 15 hari bulan bagi caruman bulan sebelumnya". Until r408 this was null, on the
  // belief that the deadline was the last day of the contribution month; that was PERKESO's temporary
  // relief for April–September 2020 contributions only (Pekeliling Majikan Bil. 4 Tahun 2020). The same
  // date is computed by `paymentDueDateFor` and printed ON THE FORM.
  //
  // `fidelity: 'agency-layout'`, never 'official': see FormFidelity. PERKESO does publish a blank Borang 8A
  // (r408 corrected the opposite claim); we draw its page 1 box for box rather than printing onto a 2013
  // file whose guidance page quotes old limits.
  //
  // `runSelection` — r408: Open Form asks for the payroll cycles, and Continue opens the form itself.
  // `borang8AReport` honours `runSeqs` (r372/r373), which is the only reason this may be declared.
  { id: 'my.borang-8a', label: 'Borang 8A — monthly contribution schedule (PERKESO)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: borang8AReport,
    descriptionKey: 'desc_borang_8a', fidelity: 'agency-layout', outputs: ['pdf', 'print'], shelfOrder: 2,
    runSelection: { action: '/payroll/borang-8a/preview' },
    submission: { body: 'perkeso', agency: 'PERKESO', channel: 'PERKESO ASSIST', dueDayOfNextMonth: 15 } },
  // r412 (item e74af58c, step 2) — BORANG 8B, built. It LEFT MY_PLANNED_FORMS (`perkeso.borang-8b`) and joined
  // this list at the same shelfOrder 3 it held there. PERKESO's PER. 44D form for contributions UNDER-paid
  // for an earlier month: the header (employer, the underpaid month, the PERKESO signatory) is filled; every
  // employee line and amount stays blank, because core/back-pay.ts charges arrears in the month paid and the
  // system therefore holds no underpayment record. See localization/my/borang-8b.ts.
  //
  // `dueDayOfNextMonth: null` — PERKESO's own 8B sentence ends "…yang dilantik" and names NO deadline.
  // NO `runSelection`: the form is not drawn from a payroll run, so a cycle box would be a control that does
  // nothing. `preview` instead: the criteria step asks Company, Year and Month, and Continue opens the form.
  // `fidelity: 'agency-layout'`, never 'official' — the 8A's reasons, and the 8A's measured geometry.
  { id: 'my.borang-8b', label: 'Borang 8B — under-paid contributions (PERKESO)', cadence: 'event', scope: 'period', periodKind: 'month', generate: borang8BReport,
    descriptionKey: 'desc_borang_8b', fidelity: 'agency-layout', outputs: ['pdf', 'print'], shelfOrder: 3,
    preview: { action: '/payroll/borang-8b/preview' },
    submission: { body: 'perkeso', agency: 'PERKESO', channel: 'PERKESO / collection agent', dueDayOfNextMonth: null } },
  // r412 (item e74af58c, step 2) — THE EIS (SIP) MONTHLY CONTRIBUTION SCHEDULE, built. It takes the slot the
  // planned "SIP Forms" entry held (shelfOrder 4); SIP 2 / SIP 2A — the registration forms — stay planned
  // below. Laid out like the reporter's sample, which is another payroll system's report and NOT a PERKESO
  // form — so `fidelity: 'figures'`, NOT `agency-layout`: the shared agency-layout caption says "drawn box for
  // box to match the agency's own form", which is untrue of a vendor's report, and a shared caption may say
  // only what is true of every member (CLAUDE.md §8). Rasterising the criteria step caught it.
  //
  // `runSelection` — `sipContributionReport` IS the Borang 8A read (which honours `runSeqs`) re-shaped, so
  // the cycle box is real. `dueDayOfNextMonth: 15`: EIS is paid with SOCSO, on the 8A's date.
  { id: 'my.sip-contribution', label: 'EIS (SIP) monthly contribution schedule (PERKESO)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: sipContributionReport,
    descriptionKey: 'desc_sip_contribution', fidelity: 'figures', outputs: ['pdf', 'print'], shelfOrder: 4,
    runSelection: { action: '/payroll/sip-contribution/preview' },
    submission: { body: 'perkeso', agency: 'PERKESO', channel: 'PERKESO ASSIST', dueDayOfNextMonth: 15 } },
  // dueDayOfNextMonth null: the annual deadline was never stated to us. See ReportSubmission.
  //
  // ONE GENERATOR, TWO CATALOG ENTRIES. `cp8d` returns the Form E Part A headcounts (meta.summary, via
  // formECounts) AND the per-employee CP8D schedule from a single run — so the reporter's item 7 (Borang E)
  // and item 13 (CP8D Excel) are one output, not two. The Borang E entry in MY_STATUTORY_LINKS is an ALIAS
  // onto this id; both descriptions say the annual return comes out in one step. Forking this generator to
  // give Borang E its own would produce two annual returns that drift, and test/statutory-forms-page.test.ts
  // fails the moment a second annual LHDN report is registered.
  { id: 'my.cp8d', label: 'Form E / CP8D — annual (LHDN)', cadence: 'annual', scope: 'year', periodKind: 'year', generate: cp8d,
    descriptionKey: 'desc_cp8d', fidelity: 'figures', outputs: ['pdf', 'xlsx', 'csv', 'print'], shelfOrder: 13,
    // r409 (item 79f3f64d) — Company and Year, Continue, look, download. The preview frames the PDF this
    // entry has always exported (lib/report-export.ts, through the generic export route) — our layout,
    // `figures`, and it does not become LHDN's Form E by being shown in a viewer.
    preview: { action: '/payroll/cp8d/preview' },
    submission: { body: 'lhdn', agency: 'LHDN', channel: 'e-Filing (Form E)', dueDayOfNextMonth: null } },
  // r224 — THE FIRST ENTRY ON THE "OTHER STATUTORY" SHELF, which until now was a heading over an empty
  // state. See `hrdLevy` for what it does and does not print.
  //
  // `fidelity: 'figures'` AND IT MAY NOT MOVE. We hold no HRD Corp form, blank or filled, and nothing
  // here is drawn to an agency arrangement: this is the levy in OUR layout, which is exactly what
  // `figures` means. `agency-layout` would be a claim that the page matches a document nobody here has
  // ever seen — the overstatement this vocabulary exists to prevent, not the understatement.
  //
  // `dueDayOfNextMonth: 15` IS SOURCED, NOT ASSUMED: docs/wave2-payroll-design.md line 47 records
  // "Monthly, due by the 15th of the following month" against hrdcorp.gov.my/faq, alongside the rates and
  // the wage base the kernel already computes from. That is the same standard of evidence the other three
  // deadlines on this screen carry, and it is why this one is a number rather than the null Form E and
  // Borang 8A correctly hold.
  //
  // ⚠️ `channel` IS THE ONE FIELD HERE THAT DID NOT COME FROM THE REPORTER. The EPF, PERKESO and LHDN
  // channels are quoted from their own answer (block_trail, 2026-07-30); nobody has told us which portal
  // they remit the levy through, and e-TRiS is HRD Corp's employer portal as we understand it. It is
  // display text under the agency name on the form screen and nothing files against it — but if the
  // reporter names a different portal, this string is the whole fix.
  { id: 'my.hrd-levy', label: 'HRD Corp levy (PSMB)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: hrdLevy,
    descriptionKey: 'desc_hrd_levy', fidelity: 'figures', outputs: ['pdf', 'xlsx', 'csv', 'print'], shelfOrder: 1,
    // NO `dueDayOfNextMonth`, DELIBERATELY. A due day makes the shelf compute a deadline and colour it
    // overdue/due-soon for EVERY company on the filter — but the HRD levy is only owed by a company
    // registered with PSMB, and `company_statutory_my.hrdf_status` DEFAULTS to `not_registered`. So a
    // hard 15th would have printed a red "Overdue" statutory deadline at every tenant that has never
    // registered, which is a legal assertion we cannot stand behind (AGENTS rule 28: an absent box
    // asserts nothing, a red one asserts a missed filing). The card still populates the `other` shelf,
    // which is what the approved plan promised; the deadline waits for a per-company registration read.
    submission: { body: 'other', agency: 'HRD Corp', channel: 'HRD Corp e-TRiS', dueDayOfNextMonth: null } },
];

/**
 * The statutory forms that are NOT generatable reports (6babf4f6). See `StatutoryFormLink`.
 *
 * A DOOR, NOT A GENERATOR. Every entry here opens something that already exists; none of them computes
 * anything of its own. That is why Borang E can be an ALIAS onto `my.cp8d` (587ee719): the annual return
 * is one generator, and giving Borang E an entry costs a row in this list rather than a second copy of
 * the annual arithmetic.
 *
 * FORMS THAT DO NOT EXIST AT ALL LIVE IN `MY_PLANNED_FORMS`, not here — the type there carries no href,
 * so an unbuilt form cannot acquire an action by accident.
 */
export const MY_STATUTORY_LINKS: StatutoryFormLink[] = [
  // ⚠️ r402 (item f3cf2444) — READ THE HISTORY BELOW AS HISTORY. Every "both rows", "these two entries" and
  // "each EA row" in the notes that follow describes the shelf BEFORE r402, when the EA was two entries (one
  // per language) and each carried a blank form and a field register. Since r402 it is ONE entry, `my.ea`,
  // with a Version choice and no extra actions — the note directly above the entry says what changed.
  //
  // The EA statement is per EMPLOYEE, so it has no single company-wide table to open. The year's
  // employee list IS the CP8D population — one row per employee for the tax year.
  //
  // ⚠️ r256 (item 858a1128) — THE SENTENCE ABOVE USED TO END "…IS THE CP8D SCREEN", AND IT NO LONGER DOES.
  // The population is unchanged; where you meet it is not. Both rows now open a two-step flow of their own
  // — company + year, then an employee selection with search by name and by employee ID, select all and
  // clear — because the reporter's complaint was that the EA asked for a Payroll Month it does not use and
  // then handed over a table of figures rather than a list of people to pick from. `populationReportId`
  // carries the CP8D link that the href used to carry; the CP8D figures screen is untouched and its own
  // row still opens it.
  //
  // 587ee719 — TWO ENTRIES, ONE RENDERER. The reporter listed "C.P.8A (EA) – English" and
  // "C.P.8A (EA) – BM" as separate forms, and until this round they were not: app/me/ea/[employmentId]/pdf
  // resolved `payroll.ea` against the VIEWER's UI locale, so the same entry produced whichever language
  // the screen happened to be set to. The route now takes a `lang` param (en/ms, defaulting to the
  // request locale) and these two entries carry it. There is still exactly ONE EA renderer (lib/ea-pdf.ts)
  // and one EA statement read — the split is a translation locale, not a second implementation.
  //
  // r219 (item ece6d75d) — `fidelity` MOVED FROM `figures` TO `agency-layout`, FOR BOTH ENTRIES.
  // lib/ea-pdf.ts now draws the statement to the C.P.8A (Pin. 2024) arrangement — the masthead, No. Siri
  // and TIN Majikan E, the ruled banner, Section A's two-column numbering, B to F in the form's own order
  // with the RM column down the right, and the ruled officer box at the foot — traced from
  // `docs/forms/ea-cp8a-pin-2024-specimen.png` and its hand transcription. That is what `agency-layout`
  // means, and `figures` (every number the form needs, complete, in OUR layout) now understates it.
  //
  // ⚠️ AND IT MAY NEVER BE `official`. The specimen is a VENDOR's rendering (Producer = Developer Express
  // DXperience v23.2.5), not LHDN artwork; it is deliberately not in `public/forms/`, which still holds
  // exactly one genuine artwork, and `my.cp22` is still the only entry in this catalogue that says
  // `official`. The shared `agency-layout` chip says "we hold no blank from the agency to print onto",
  // which `public/forms/` answers for the C.P.8A too — nothing here claims what LHDN publishes
  // (AGENTS 28b).
  //
  // r220 (item 61c2e30f) — EACH EA ROW NOW OFFERS THE FORM WITH NOTHING IN IT, AND THE REGISTER OF ITS
  // BOXES. Until this round an EA could only be produced for a NAMED employee, for a year that already had
  // payroll behind it, so there was no way to open the form on its own and check the arrangement against
  // LHDN's page before trusting a filled one — which is exactly what the reporter asked for first.
  // `/payroll/ea/blank` renders THE SAME renderer over an empty statement with the money column
  // suppressed (never 0.00 — AGENTS 28), in this row's own language; `/payroll/ea/field-register` is the
  // box-by-box list that makes the blank checkable rather than merely printable, and it is one document
  // for both rows because it describes the FORM, not a language.
  //
  // The fidelity is UNCHANGED and stays `agency-layout` for both: a blank copy of our rendering is still
  // our rendering. Nothing here moves toward `official`, which needs agency artwork in `public/forms/`.
  //
  // r242 (item b36a8a91) — THE ROW NOW SAYS WHAT IS BEHIND IT, AND THE BLANK IS NO LONGER BESIDE IT.
  // r220 left each EA row with three actions at equal weight, the middle one a blank form; the reporter
  // pressed it, got an empty C.P.8A, and reported that the product could not produce a completed EA — which
  // it has been able to do all along, one screen further on. Two changes, both presentational:
  //   • the primary action REUSES the shared `openForm` label rather than naming the employee list it
  //     passes through. It is the same href and the same journey (list → person → their completed EA);
  //     what changes is that the button now names the DESTINATION. `openEmployeeList` is not retired — it
  //     is still what `my.tp1` says, where the list IS the destination.
  //   • `extrasLabelKey` folds the blank and the field register under one named control, so neither can be
  //     mistaken for the route to a completed form. Both stay reachable, one press further on.
  // Nothing about what either row PRODUCES moves, and the fidelity is untouched.
  //
  // ⚠️ r402 (item f3cf2444) — r220 AND r242 ARE REVERSED HERE, ON THE REPORTER'S OWN REQUEST. The two EA rows
  // became ONE (`my.ea`), the language moved to a Version choice on the criteria step (`{lang}` + `versions`
  // below), and the blank form and field register are no longer offered from the card at all: the
  // reporter asked for the "Blank form and field register" control to go, with nothing in its place. The
  // two routes (`/payroll/ea/blank`, `/payroll/ea/field-register`) and lib/ea-field-register.ts are KEPT as
  // unlinked endpoints — the reporter said not to remove the underlying data — so nothing that renders
  // either document moved. The former ids redirect (`formerIds`), and there is still one EA renderer.
  {
    id: 'my.ea',
    labelKey: 'link_ea',
    hintKey: 'link_ea_hint_version',
    descriptionKey: 'desc_ea',
    body: 'lhdn',
    cadence: 'annual',
    href: '/payroll/statutory-forms/ea?companyId={companyId}&year={year}&lang={lang}',
    actionLabelKey: 'openForm',
    criteriaLabelKey: 'criteria_continue',
    populationReportId: 'my.cp8d',
    versions: [
      { value: 'en', labelKey: 'version_en' },
      { value: 'ms', labelKey: 'version_ms' },
    ],
    formerIds: [
      { id: 'my.ea.en', version: 'en' },
      { id: 'my.ea.ms', version: 'ms' },
    ],
    fidelity: 'agency-layout',
    outputs: ['pdf', 'print'],
    shelfOrder: 3,
  },
  /**
   * ⚠️ r402 (item f3cf2444) — THIS NOTE DESCRIBES TWO ROWS AND THERE IS NOW ONE. `my.pcb2ii` replaced the
   * `.en` / `.ms` pair below the note; "both rows" and "these two" are r323's shelf, kept as history.
   *
   * 72b100cd (r323) — PCB 2(II), built. Both rows LEFT MY_PLANNED_FORMS and joined MY_STATUTORY_LINKS at
   * the SAME shelfOrder 5 and 6 they held there: the shelf is unchanged, the cards simply stop saying
   * "not built yet" and grow an action.
   *
   * THIS LIST AND NOT MY_REPORTS, which is the same call the EA and TP1 made. A `ReportDef` generates a
   * company-wide TABLE for a period; these two have no such table to generate, because the form is one
   * person's statement. They are DOORS — an href to a screen — which is what MY_STATUTORY_LINKS holds.
   *
   * SAME SHAPE AS THE EA BESIDE IT, AND FOR THE SAME REASON. Every other entry on this shelf produces ONE
   * document for a company and a period; these produce one statement PER EMPLOYEE for a year, so they
   * take the EA's two-step flow — company + year on `open`, then pick the people — rather than a direct
   * href to a single document. `populationReportId: 'my.cp8d'` is the EA's population verbatim, because
   * it is the same question: who did this employer pay in this tax year.
   *
   * `fidelity: 'agency-layout'`, never 'official'. This is our typesetting of LHDN's form from the
   * specimens the reporter attached, not a facsimile of their PDF — the same honest label Borang A,
   * Borang 8A and the EA carry. CP22 is the only 'official' row in this catalogue and a test pins that.
   */
  //
  // r402 (item f3cf2444) — ONE ENTRY, A VERSION CHOICE. The same merge as the EA above: `my.pcb2ii.en` and
  // `my.pcb2ii.ms` became `my.pcb2ii`, the language is chosen on the criteria step, and the former ids
  // redirect with their version preselected. The form, its renderer and its two languages are unchanged.
  {
    id: 'my.pcb2ii',
    labelKey: 'link_pcb2ii',
    hintKey: 'link_pcb2ii_hint',
    descriptionKey: 'desc_pcb2ii',
    body: 'lhdn',
    cadence: 'annual',
    href: '/payroll/statutory-forms/pcb2ii?companyId={companyId}&year={year}&lang={lang}',
    actionLabelKey: 'openForm',
    criteriaLabelKey: 'criteria_continue',
    populationReportId: 'my.cp8d',
    versions: [
      { value: 'en', labelKey: 'version_en' },
      { value: 'ms', labelKey: 'version_ms' },
    ],
    formerIds: [
      { id: 'my.pcb2ii.en', version: 'en' },
      { id: 'my.pcb2ii.ms', version: 'ms' },
    ],
    fidelity: 'agency-layout',
    outputs: ['pdf', 'print'],
    shelfOrder: 5,
  },
  // 587ee719 — BORANG E IS AN ALIAS, AND MUST STAY ONE. The reporter listed Borang E (item 7) and CP8D
  // (item 13) as two forms; they are two NAMES for one annual return we already produce in a single step,
  // so this entry's href resolves to the same `my.cp8d` generator the CP8D card opens. Both cards carry a
  // description saying so, because two entries that look like two different documents is the one outcome
  // this must not produce — somebody would sit waiting for a second file that is never coming.
  {
    id: 'my.borang-e',
    labelKey: 'link_borang_e',
    hintKey: 'link_borang_e_hint',
    descriptionKey: 'desc_borang_e',
    body: 'lhdn',
    cadence: 'annual',
    // r409 (item 79f3f64d) — THE SAME PREVIEW THE CP8D CARD OPENS, because they are one return. Until r409
    // this pointed at the figures screen `/payroll/statutory-forms/my.cp8d`; the alias is now declared by
    // `populationReportId` (the report its figures come from) rather than implied by the path.
    href: '/payroll/cp8d/preview?companyId={companyId}&year={year}',
    populationReportId: 'my.cp8d',
    // Continue, not Generate: the step opens the preview, and the download is a press further on.
    criteriaLabelKey: 'criteria_continue',
    fidelity: 'figures',
    outputs: ['pdf', 'xlsx', 'csv', 'print'],
    shelfOrder: 7,
  },
  /**
   * r224 — FORM TP1, BUILT. It LEFT MY_PLANNED_FORMS and joined this list at the same shelfOrder 1 it
   * held there, which is the third time a form has made that journey (after `perkeso.borang-8a` and
   * `epf.borang-a`) and the first time the destination is a LINK rather than a ReportDef.
   *
   * WHY A LINK AND NOT A REPORT. Every ReportDef on this shelf produces ONE table for the WHOLE COMPANY
   * for a period. A TP1 is one employee's own declaration for one deduction month — there is no
   * company-wide TP1 to generate, exactly as there is no company-wide EA statement, so it takes the same
   * shape the two EA rows take: a door onto the screen that already lists the people.
   *
   * THE ID CHANGED FROM `lhdn.tp1` TO `my.tp1`, following the two forms that migrated before it: a
   * planned form is keyed by the AUTHORITY it is planned for, and a built one is keyed by the PACK that
   * owns it, which is why every entry in this list and in MY_REPORTS reads `my.*`.
   *
   * ⚠️ THE HREF IS THE LIST, NOT `tp1/[year]/[month]`, AND THAT IS NOT A SHORTCUT. The month page 404s
   * without an `?employmentId=` (it resolves the employment against the admin's own scoped list and
   * `notFound()`s a miss), so a shelf card pointing straight at it would be a card that opens nothing —
   * the precise failure this promotion exists to fix. `/payroll/transactions/tp1` is the screen an
   * operator actually starts from: choose a person, choose a month, open or download their declaration.
   * `?year=` is already an accepted param there and the shelf's own year selects it.
   *
   * `cadence: 'annual'` IS THE HREF'S GRAIN, NOT A CLAIM THAT THE FORM IS ANNUAL. The declarations
   * themselves are per deduction month (the 1/2026 form has a DEDUCTION MONTH box, which is why the
   * record's grain moved in 7ad37961); the screen this opens is the ASSESSMENT YEAR's list, and the card
   * carries the year chip to match what you land on. It is unchanged from the planned descriptor.
   *
   * `fidelity: 'agency-layout'`, never 'official'. lib/tp1-pdf.ts draws the form from scratch to LHDN's
   * own wording, numbering (Sections A–F, C1–C17, D1), legal references and column order — which is what
   * this value means. The specimen it was checked against is the reporter's attachment, whose PDF
   * Producer is Microsoft Word 2019 rather than an agency press, and it is not in `public/forms/`, which
   * still holds exactly one genuine artwork and it is the CP22's.
   */
  {
    id: 'my.tp1',
    labelKey: 'link_tp1',
    hintKey: 'link_tp1_hint',
    descriptionKey: 'desc_tp1',
    body: 'lhdn',
    cadence: 'annual',
    href: '/payroll/transactions/tp1?year={year}',
    actionLabelKey: 'openEmployeeList',
    fidelity: 'agency-layout',
    outputs: ['pdf'],
    shelfOrder: 1,
  },
  /**
   * df35d60d — FORM TP3, BUILT. It LEFT MY_PLANNED_FORMS and joined this list at the same shelfOrder 2 it
   * held there, which is the fifth time a form has made that journey (after `perkeso.borang-8a`,
   * `epf.borang-a`, `lhdn.tp1` and the two PCB 2(II) rows).
   *
   * ⚠️ THE PLANNED ROW'S HINT WAS HALF WRONG AND THE CORRECTION IS THE WHOLE ITEM. It read "the figures
   * are already captured on the employee's payroll tab" — and four of them are, but the paper form asks
   * for gross, five exempt allowances and EPF as SEVEN SEPARATE BOXES where that tab holds one
   * already-combined (C1 - sum C2) - C3. The combination is not invertible, so the form could not have
   * been printed from what was captured. `link_tp3_hint` no longer says it could.
   *
   * WHY A LINK AND NOT A REPORT, the same call the EA, TP1 and PCB 2(II) rows made: every ReportDef on
   * this shelf produces ONE table for the WHOLE COMPANY for a period, and a TP3 is one employee's own
   * previous-employment record. There is no company-wide TP3 to generate.
   *
   * THE HREF IS THE SCREEN, and `?year=` is already an accepted param there, so the shelf's own year
   * selects the assessment year the operator lands on. `cadence: 'annual'` is that href's grain.
   *
   * `fidelity: 'agency-layout'`, never 'official'. lib/tp3-pdf.ts draws the form from scratch to LHDN's
   * own wording, numbering (Sections A-E, C1-C5, D1-D17), legal reference, NOTE block and column layout
   * — which is what this value means. The specimen it was checked against is the reporter's own
   * attachment, and it is not in `public/forms/`, which still holds exactly one genuine artwork and it
   * is the CP22's.
   */
  {
    id: 'my.tp3',
    labelKey: 'link_tp3',
    hintKey: 'link_tp3_hint',
    descriptionKey: 'desc_tp3',
    body: 'lhdn',
    cadence: 'annual',
    href: '/payroll/transactions/tp3?year={year}',
    actionLabelKey: 'openEmployeeList',
    fidelity: 'agency-layout',
    outputs: ['pdf'],
    shelfOrder: 2,
  },
  // CP22 / CP22A are event-driven (a hire, a cessation), not period-driven, so they are a worklist
  // rather than a form you pick a month for. It renders on the Statutory Forms landing page itself.
  // d3a9383c: the row now says "Open worklist" (which is what the href does) and carries a second action —
  // the blank fillable CP22. The per-joiner document hangs off the worklist ROWS, not off this shelf entry.
  //
  // 587ee719 — `fidelity: 'official'` HERE AND NOWHERE ELSE. CP22 is the only form in this catalog drawn
  // on the agency's own published page (public/forms/cp22-pin-1-2021.pdf; 53 areas mapped in
  // lib/cp22-fields.ts, 38 pre-filled and 15 left blank by design). A second `official` in this catalog
  // is a test failure, deliberately: it is the claim that costs the most if it is untrue.
  //
  // 88076362 — the edition changed under this entry and the entry did not: LHDN superseded Pin. 1/2020
  // with the two-page [Pin.1/2021], so `official` now means THAT page. The shelf position, the fidelity
  // and the assertion that it is the only 'official' row are all unchanged.
  {
    id: 'my.cp22',
    labelKey: 'link_cp22',
    hintKey: 'link_cp22_hint',
    descriptionKey: 'desc_cp22',
    body: 'lhdn',
    cadence: 'event',
    href: '/payroll/statutory-forms#worklist',
    actionLabelKey: 'openWorklist',
    secondaryHref: '/payroll/cp22/blank',
    secondaryLabelKey: 'link_cp22_blank',
    fidelity: 'official',
    outputs: ['pdf', 'print'],
    shelfOrder: 9,
  },
];

/**
 * 587ee719 — THE FORMS THE REPORTER NAMED THAT HAVE NEVER BEEN BUILT, in the reporter's own order, on
 * the reporter's own shelves. See `PlannedFormDef` for why these are a separate type.
 *
 * r224 — THIS COMMENT USED TO OPEN "THE THIRTEEN FORMS" AND THE LIST HELD TEN, which is the kind of
 * staleness that makes a reader trust the rest of the file less. Thirteen was true the day it was
 * written; three of them have since been built and left (`perkeso.borang-8a`, `epf.borang-a`,
 * `lhdn.tp1`). The count is deliberately no longer written down here — it is the length of the array
 * below, and a number in prose beside a list is a number that goes stale the next time the list moves.
 *
 * WHY THIS EXISTS AT ALL. 6babf4f6 drew none of them and explained why in a source comment — which meant
 * an operator opening EPF (KWSP) looking for Borang A saw one unrelated row and could not tell "not built
 * yet" from "wrong screen". Naming each form with a status and no button is the honest answer: the list
 * is complete, and nothing on it pretends to produce a document.
 *
 * WHAT THIS IS NOT. It is not a to-do list the screen can be talked into wiring up. Each of these is a
 * real government form with its own layout, its own required fields, its own validation and its own
 * output format — a build apiece, checked against the official artwork one form at a time, which is
 * exactly the phased approach the request describes. When one is built it leaves this list and joins
 * MY_REPORTS (or MY_STATUTORY_LINKS) at the SAME `shelfOrder`, and the screen is not touched.
 *
 * Borang BBCB is listed exactly as the reporter wrote it. We could not identify which KWSP form it is,
 * and its hint says so rather than guessing — building against a guess is the mistake this whole item
 * exists to avoid.
 */
export const MY_PLANNED_FORMS: PlannedFormDef[] = [
  // 9c8dad7a — `epf.borang-a` STOOD HERE and is deliberately gone: it was BUILT, so it left this list and
  // joined MY_REPORTS at the same shelfOrder 2, exactly as `perkeso.borang-8a` did one round earlier.
  { id: 'epf.borang-bbcb', labelKey: 'planned_epf_borang_bbcb', hintKey: 'planned_epf_borang_bbcb_hint', body: 'epf', cadence: 'monthly', shelfOrder: 3 },
  // 8ca344bf — `perkeso.borang-8a` STOOD HERE and is deliberately gone: it was BUILT, so it left this list
  // and joined MY_REPORTS at the same shelfOrder 2, which is exactly the path this type's doc-comment
  // describes. Its two message keys went with it; the shelf and this screen were not touched.
  // r412 (item e74af58c, step 2) — `perkeso.borang-8b` STOOD HERE and is deliberately gone: it was BUILT, so it
  // left this list and joined MY_REPORTS as `my.borang-8b` at the same shelfOrder 3. And `perkeso.sip` ("SIP
  // Forms") stood here at shelfOrder 4: its monthly half — the EIS contribution schedule — is BUILT and took
  // that slot as `my.sip-contribution`. What it named that is NOT built is SIP 2 / SIP 2A, the EIS
  // registration forms, and those STAY planned, by their own name, below. The retired message keys are
  // marked "[retired r412 …]" in every locale rather than deleted.
  { id: 'perkeso.employee-registration', labelKey: 'planned_perkeso_employee_registration', hintKey: 'planned_perkeso_employee_registration_hint', body: 'perkeso', cadence: 'event', shelfOrder: 5 },
  // r412 — SIP 2 / SIP 2A stay planned (the approved plan): PERKESO's forms date from 2017 and still print the
  // old RM4,000 wage limit, and PERKESO's 2025 guide registers employees through the ASSIST portal.
  { id: 'perkeso.sip-2', labelKey: 'planned_perkeso_sip_2', hintKey: 'planned_perkeso_sip_2_hint', body: 'perkeso', cadence: 'event', shelfOrder: 6 },
  // r224 — `lhdn.tp1` STOOD HERE and is deliberately gone: it was BUILT (the declaration screen at
  // /payroll/transactions/tp1 and the drawn form at lib/tp1-pdf.ts), so it left this list and joined
  // MY_STATUTORY_LINKS as `my.tp1` at the same shelfOrder 1, exactly as the two Borangs did before it.
  // Its two message keys went with it.
  // df35d60d — `lhdn.tp3` STOOD HERE and is deliberately gone: it was BUILT (the previous-employment
  // screen at /payroll/transactions/tp3 and the drawn form at lib/tp3-pdf.ts), so it left this list and
  // joined MY_STATUTORY_LINKS as `my.tp3` at the same shelfOrder 2, exactly as TP1, PCB 2(II) and the two
  // Borangs did before it. Its two planned_* message keys went with it.
  // 72b100cd (r323) — `lhdn.pcb2ii-en` and `lhdn.pcb2ii-ms` STOOD HERE and are deliberately gone: both
  // are BUILT now (the screen at /payroll/statutory-forms/pcb2ii and the drawn form at lib/pcb2ii-pdf.ts),
  // so they left this list and joined MY_STATUTORY_LINKS as `my.pcb2ii.en` / `my.pcb2ii.ms` at the SAME shelf
  // orders 5 and 6 they held here — the migration path `PlannedFormDef` was designed for, and the one
  // TP1, Borang A and Borang 8A each took before them. Their four planned_* message keys went with them.
  // (r402 merged that pair into the one entry `my.pcb2ii` at shelfOrder 5; the ids redirect.)
  { id: 'lhdn.cp21', labelKey: 'planned_lhdn_cp21', hintKey: 'planned_lhdn_cp21_hint', body: 'lhdn', cadence: 'event', shelfOrder: 8 },
  // r409 (item 79f3f64d) — NEW KEYS, BECAUSE THE OLD ONES SAID THE WRONG THING. `planned_lhdn_cp22a` called
  // CP22A "tax clearance on cessation". That label was ours and it was wrong: on LHDN's own form CP22A is the
  // notice a PRIVATE-SECTOR employer gives when an employee stops working (resignation, retirement, death).
  // The old pair is retired in all six catalogues, not deleted (a key dropped from `en` alone keeps
  // rendering from the others). Still planned: it is built in step 2 of the same item.
  { id: 'lhdn.cp22a', labelKey: 'planned_lhdn_cp22a_cessation', hintKey: 'planned_lhdn_cp22a_cessation_hint', body: 'lhdn', cadence: 'event', shelfOrder: 10 },
  // CP39A STAYS PLANNED. We hold no current LHDN CP39A and it is not on LHDN's form download page; the
  // reporter is asked to send the official form as a request of its own (item 79f3f64d's plan).
  { id: 'lhdn.cp39a', labelKey: 'planned_lhdn_cp39a', hintKey: 'planned_lhdn_cp39a_hint', body: 'lhdn', cadence: 'monthly', shelfOrder: 12 },
];

/**
 * r409 (item 79f3f64d) — FORMS WE HAVE DECIDED NOT TO BUILD BECAUSE THEY DO NOT APPLY, and why.
 *
 * NOT `MY_PLANNED_FORMS`: a planned form is one we intend to build, and the shelf shows it as such. These are
 * forms whose own title says they are for somebody else, so listing one on a private company's shelf as
 * "planned" would promise a document that company can never file. Recorded here, in data, so the decision has
 * an owner and a test, and so the next round that reads the reporter's list of forms does not re-plan it.
 * Nothing renders this list.
 *
 * CP22B is LHDN's cessation notice for GOVERNMENT AGENCIES ("Agensi Kerajaan" is printed in its title); a
 * private-sector employer files CP22A for the same event. If a tenant's company IS a government agency, that
 * is a new request naming the company, not a change to this list.
 */
export const MY_NOT_APPLICABLE_FORMS: readonly { id: string; body: StatutoryBodyKey; reason: 'government-agency'; note: string }[] = [
  {
    id: 'lhdn.cp22b',
    body: 'lhdn',
    reason: 'government-agency',
    note: 'CP22B is the cessation notice for government agencies only; private-sector employers file CP22A.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0029 — cross-employer PCB exposure (read-only diagnostic, G2 Slice 2c).
// For each person with payslips in ≥2 of the tenant's companies for a period, compare the SUMMED filed
// MTD (what per-employer filing deducts) against the COMBINED-month MTD (`coordinatedPcbForPerson`, taxed
// once). The positive delta is the monthly under-deduction the employee will face at annual assessment —
// Compliance uses it to decide a designated paymaster (scope-out) or to enable coordination. EXACT for
// no-bonus months (the dominant case); months with a bonus are indicative (the K₁/Kₜ split is approximated
// from the slip). Never mutates payroll.
// ─────────────────────────────────────────────────────────────────────────────
export type CrossEmployerPcbRow = {
  personId: string;
  personName: string;
  summedMtd: number;
  combinedMtd: number;
  delta: number;
  indicative: boolean; // true when any employment had a bonus this month (K split approximated)
  employments: { employmentId: string; company: string; filedPcb: number }[];
};

export async function crossEmployerPcbExposure(ctx: SessionContext, period: string): Promise<CrossEmployerPcbRow[]> {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const month = Math.min(12, Math.max(1, parseInt(period.slice(5, 7), 10) || 1));
  return withTenant(ctx, async (tx) => {
    const slips = await tx
      .select({
        personId: employment.personId,
        personName: person.fullName,
        employmentId: payslip.employmentId,
        company: company.legalName,
        basic: payslip.basicSalary,
        allowance: payslip.allowance,
        overtime: payslip.overtimePay,
        bonus: payslip.bonus,
        category: employeeStatutoryMy.taxCategory,
        children: employeeStatutoryMy.numChildren,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(payrollBatch.payPeriod, period));

    type Acc = { personId: string; personName: string; category: number | null; children: number | null;
      invalidApplicability:boolean; recordedCategories:number[]; applicability:boolean[]; inputs: { employmentId: string; monthlyWage: number; epfMonthly: number; additional: number; epfOnAdditional: number;
        acc: { netRemuneration: number; epfClaimed: number; pcbPaid: number } }[];
      filed: { employmentId: string; company: string; filedPcb: number }[]; indicative: boolean };
    const byPerson = new Map<string, Acc>();
    for (const s of slips) {
      const st = (s.statutory ?? {}) as { epfEmployee?: number; pcb?: number; pcbMeta?: { ytdNet?: number; epfClaimed?: number; pcbPaid?: number } };
      const bonus = Number(s.bonus) || 0;
      let p = byPerson.get(s.personId);
      if (!p) p = { personId: s.personId, personName: s.personName, category: s.category, children: s.children, invalidApplicability:false, recordedCategories:[], applicability:[],inputs: [], filed: [], indicative: false };
      const meta=(s.statutory as {pcbMeta?:{taxCircumstance?:unknown}}|null)?.pcbMeta;
      const hasSaved=meta!==null&&typeof meta==='object'&&Object.hasOwn(meta,'taxCircumstance');
      const saved=readSavedTaxCircumstance(meta?.taxCircumstance);
      const explanation=hasSaved?explainPcb(s.statutory,null):null;
      if(hasSaved&&!saved || explanation?.kind==='unavailable' || saved?.applicable===false&&explanation?.kind!=='not_subject')p.invalidApplicability=true;
      if(saved?.applicable)p.recordedCategories.push(saved.category!);
      p.applicability.push(saved?.applicable??true);
      p.inputs.push({
        employmentId: s.employmentId,
        monthlyWage: (Number(s.basic) || 0) + (Number(s.allowance) || 0) + (Number(s.overtime) || 0),
        epfMonthly: Number(st.epfEmployee) || 0, // K₁ — exact when no bonus
        additional: bonus,
        epfOnAdditional: 0,
        acc: { netRemuneration: Number(st.pcbMeta?.ytdNet) || 0, epfClaimed: Number(st.pcbMeta?.epfClaimed) || 0, pcbPaid: Number(st.pcbMeta?.pcbPaid) || 0 },
      });
      p.filed.push({ employmentId: s.employmentId, company: s.company, filedPcb: Number(st.pcb) || 0 });
      if (bonus > 0) p.indicative = true;
      byPerson.set(s.personId, p);
    }

    const out: CrossEmployerPcbRow[] = [];
    for (const p of byPerson.values()) {
      if (p.inputs.length < 2) continue; // only concurrent-employment people
      const summedMtd = r2(p.filed.reduce((a, b) => a + b.filedPcb, 0));
      if(p.recordedCategories.some(x=>x!==p.recordedCategories[0]))p.invalidApplicability=true;
      if(p.recordedCategories.length)p.category=p.recordedCategories[0];
      if(p.invalidApplicability)continue; // Present malformed history is unavailable, never a legacy taxable fallback.
      if(p.applicability.some(x=>x!==p.applicability[0]))continue; // Inconsistent recorded applicability is not a combined formula.
      const coord = coordinatedPcbForPerson(p.inputs, {
        taxApplicable:p.applicability[0],
        month,
        profile: { category: (p.category ?? 1) as 1 | 2 | 3, children: p.children ?? 0 },
        pcb: DEFAULT_MY_STATUTORY.pcb,
      });
      out.push({
        personId: p.personId,
        personName: p.personName,
        summedMtd,
        combinedMtd: coord.combinedMtd,
        delta: r2(coord.combinedMtd - summedMtd),
        indicative: p.indicative,
        employments: p.filed,
      });
    }
    return out.sort((a, b) => b.delta - a.delta);
  });
}
