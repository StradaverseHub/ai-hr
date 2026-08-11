/**
 * Malaysia statutory reports (ADR-0010). Layer-A (human-readable) reports derived from payroll
 * payslips, per legal entity. Each ReportDef is registered on the pack; the generic core
 * (core/reporting.ts) lists / previews / records them without naming any MY-specific report.
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import {
  company,
  companyStatutoryMy,
  eaOverride,
  employeeStatutoryMy,
  employment,
  payrollBatch,
  payslip,
  person,
} from '../../db/schema';
import { MY_STATUTORY_VERSION, DEFAULT_MY_STATUTORY } from './statutory-tables';
import { coordinatedPcbForPerson } from './payroll';

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
    batchStatus?: string;
    statutoryVersion: string;
    /** Headline counts shown above the table (e.g. Form E Part A). */
    summary?: { label: string; value: string | number }[];
    /** Caveats for this report (e.g. fields the payroll system does not track). */
    notes?: string[];
  };
};
export type ReportParams = { companyId: string; periodKey: string };
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
 * "SOCSO / EIS (PERKESO)" shelf — and the authorities that have no form yet (hrdf, zakat, ptptn,
 * tabung_haji, koperasi) all land under `other`, which is exactly the shelf the reporter called "Other
 * Statutory". When one of those grows a real form, it declares `other` and appears there with no screen
 * change; if it ever earns its own shelf, that is one key and one heading.
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
 *                  NOTHING else (public/forms/cp22-pin-1-2020.pdf, mapped in lib/cp22-fields.ts).
 *   `figures`    — every number the form needs, complete, in OUR layout rather than the agency's page.
 *   `draft-file` — built to the layout an agency publishes for portal upload, never yet accepted BY
 *                  that portal, so it stays marked draft until it has been.
 *
 * A fourth status, "not built yet", is deliberately NOT in this union: it belongs to `PlannedFormDef`,
 * which has no href and no action key at all, so the type itself makes an action impossible.
 */
export type FormFidelity = 'official' | 'figures' | 'draft-file';

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
  /** Target route. Placeholders: `{companyId}`, `{year}`. */
  href: string;
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
   * filing or a notice the operator would rather complete by hand. Both optional and read together; a row
   * with neither renders exactly one action, as every row did before.
   */
  secondaryHref?: string;
  secondaryLabelKey?: string;
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
type LoadedBatch = { hasBatch: boolean; batchStatus?: string; rows: BatchRow[] };

async function loadBatchRows(ctx: SessionContext, params: ReportParams): Promise<LoadedBatch> {
  return withTenant(ctx, async (tx) => {
    // Wave 2C (ADR-0024): a (company, month) may now hold multiple runs (regular + bonus/off-cycle).
    // The monthly statutory return is ONE filing for the month, so aggregate across ALL runs of the
    // period. Runs store delta figures, so summing per employee yields the exact monthly total — with a
    // single run this is byte-identical to before. (Mirrors loadYearRows, scoped to one month.)
    const batches = await tx
      .select({ id: payrollBatch.id, status: payrollBatch.status })
      .from(payrollBatch)
      .where(
        and(eq(payrollBatch.companyId, params.companyId), eq(payrollBatch.payPeriod, params.periodKey)),
      );
    if (batches.length === 0) return { hasBatch: false, rows: [] };
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

/** CP39 — LHDN monthly tax deduction (MTD/PCB) statement. */
async function cp39(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const b = await loadBatchRows(ctx, params);
  if (!b.hasBatch) return empty(CP39_COLS, b);
  const rows: ReportRow[] = b.rows.map((r) => ({
    name: r.name,
    taxNo: r.taxNo,
    ic: r.ic,
    pcb: num(r.st.pcb),
  }));
  return {
    columns: CP39_COLS,
    rows,
    totals: sumTotals(rows, ['pcb']),
    readiness: readinessFor(b.rows, [{ field: 'taxNo', label: 'Tax no' }]),
    meta: meta(b),
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
// 1.2.6 EA Data Overwrite — the 8 EA-form fields HR may amend (overlay) WITHOUT touching payroll. A plain
// const tuple (not a pgEnum), mirroring app/admin/pay-components discriminators. `gross` is independently
// overridable (HR may set a known total directly); otherwise it is recomputed from the post-overlay
// components so the printed Part B lines always sum to their own total (see the merge below).
export const EA_FIELDS = ['grossSalary', 'bonus', 'allowances', 'gross', 'mtd', 'epf', 'socso', 'eis'] as const;
export type EaField = (typeof EA_FIELDS)[number];
/** One amended EA field, surfaced so the UI/PDF can render "original vs amended" + an "Amended" badge. */
export type EaOverrideEntry = { field: EaField; original: number; amended: number; reason: string };

export type EaStatement = {
  year: string;
  /** b7b22514 — WHICH employer this form speaks for. A transfer year has one form per employer, and
   *  the screen needs the id to mark the selected one; the name alone cannot be compared safely. */
  employerId: string;
  employer: { name: string; eNumber: string | null };
  employee: {
    name: string;
    ic: string | null;
    taxNo: string | null;
    epfNo: string | null;
    socsoNo: string | null;
    category: number;
    children: number;
    hiredOn: string;
    terminatedOn: string | null;
  };
  /** Part B — employment income (cash). Untracked items (BIK, VOLA, ESOS, gratuity) are out of scope.
   *  `exemptAllowances` (feedback 09b554e9) — the year's TAX-EXEMPT allowance portions (the PCB_* exemption
   *  amounts each slip stamps as statutory.exemptionUsed), reported in the EA's exempt-allowances section.
   *  Optional + additive; the general EA line-mapping (ea_form_line consumption) remains a follow-up. */
  partB: { grossSalary: number; bonus: number; allowances: number; gross: number; exemptAllowances?: number };
  partD: { mtd: number; zakat: number }; // total deduction — MTD/PCB + the year's zakat-via-salary (Z)
  partE: { epf: number; socso: number; eis: number }; // employee's share of EPF + SOCSO/EIS
  statutoryVersion: string;
  /** EA-only amendments overlaid by HR (1.2.6). Empty = none. Additive + optional so existing consumers
   *  keep compiling; the PDF/HTML surfaces read it to badge amended lines. */
  overrides: EaOverrideEntry[];
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
export async function eaStatement(
  ctx: SessionContext,
  p: { employmentId: string; year: string; companyId?: string },
): Promise<EaStatement | null> {
  return withTenant(ctx, async (tx) => {
    const [info] = await tx
      .select({
        name: person.fullName,
        ic: employeeStatutoryMy.icNumber,
        taxNo: employeeStatutoryMy.taxNumber,
        epfNo: employeeStatutoryMy.epfNumber,
        socsoNo: employeeStatutoryMy.socsoNumber,
        category: employeeStatutoryMy.taxCategory,
        children: employeeStatutoryMy.numChildren,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        companyId: employment.companyId,
        companyName: company.legalName,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!info) return null;
    // The employer this form speaks for. Defaults to where the employment sits now; for a past employer
    // in a transfer year it is that company, and the name + E number must BOTH come from it — a form
    // carrying one company's name and another's employer number is worse than either alone.
    const employerId = p.companyId ?? info.companyId;
    let employerName = info.companyName;
    if (employerId !== info.companyId) {
      const [co] = await tx
        .select({ legalName: company.legalName })
        .from(company)
        .where(eq(company.id, employerId))
        .limit(1);
      if (!co) return null;
      employerName = co.legalName;
    }
    const [stat] = await tx
      .select({ eNumber: companyStatutoryMy.lhdnEmployerNo })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, employerId))
      .limit(1);
    const slips = await tx
      .select({
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
      );

    let grossSalary = 0;
    let bonus = 0;
    let allowances = 0;
    let gross = 0;
    let mtd = 0;
    let zakat = 0;
    let epf = 0;
    let socso = 0;
    let eis = 0;
    let exemptAllowances = 0;
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Stat & { exemptionUsed?: Record<string, number> };
      grossSalary += num(s.basic) + num(s.overtime);
      bonus += num(s.bonus);
      allowances += num(s.allowance);
      gross += num(s.gross);
      mtd += num(st.pcb);
      // 1.2.4 Zakat — the year's accumulated zakat-via-salary (each payslip stamps the month's figure).
      zakat += num(st.zakat);
      epf += num(st.epfEmployee);
      socso += num(st.socsoEmployee);
      eis += num(st.eisEmployee);
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
    const derived: Record<EaField, number> = {
      grossSalary: round2(grossSalary),
      bonus: round2(bonus),
      allowances: round2(allowances),
      gross: round2(gross),
      mtd: round2(mtd),
      epf: round2(epf),
      socso: round2(socso),
      eis: round2(eis),
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
    if (!grossOverridden) merged.gross = round2(merged.grossSalary + merged.bonus + merged.allowances);

    return {
      year: p.year,
      employerId,
      employer: { name: employerName, eNumber: stat?.eNumber ?? null },
      employee: {
        name: info.name,
        ic: info.ic,
        taxNo: info.taxNo,
        epfNo: info.epfNo,
        socsoNo: info.socsoNo,
        category: info.category ?? 1,
        children: info.children ?? 0,
        hiredOn: info.hiredOn,
        terminatedOn: info.terminatedOn,
      },
      partB: { grossSalary: merged.grossSalary, bonus: merged.bonus, allowances: merged.allowances, gross: merged.gross, exemptAllowances: round2(exemptAllowances) },
      partD: { mtd: merged.mtd, zakat: round2(zakat) },
      partE: { epf: merged.epf, socso: merged.socso, eis: merged.eis },
      statutoryVersion: versionOf(slips.map((s) => s.statutory)),
      overrides,
    };
  });
}

export const MY_REPORTS: ReportDef[] = [
  // No `submission`: an internal reconciliation view, not a form anybody files.
  { id: 'my.contributions', label: 'Monthly statutory contributions (overview)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: contributions },
  // `fidelity: 'figures'` on all four submissions and `official` on none of them: not one of these comes
  // out on the agency's own page. `outputs` includes `file` for the two that also emit a prescribed
  // agency upload file — those files carry their own draft chip, because neither has yet been accepted
  // by the portal it is built for (localization/my/cp39-file.ts, localization/my/socso-eis-file.ts).
  { id: 'my.cp39', label: 'CP39 — MTD / PCB (LHDN)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: cp39,
    descriptionKey: 'desc_cp39', fidelity: 'figures', outputs: ['pdf', 'xlsx', 'csv', 'print', 'file'], shelfOrder: 11,
    submission: { body: 'lhdn', agency: 'LHDN', channel: 'e-PCB / e-Data PCB / e-CP39', dueDayOfNextMonth: 15 } },
  // NOT "Borang A", and it never becomes Borang A by being renamed. What this produces is a contributions
  // listing; Borang A is a KWSP form we have never seen the layout of. It keeps its honest name and Borang
  // A keeps its place on the shelf as an unbuilt form — see MY_PLANNED_FORMS.
  { id: 'my.epf', label: 'EPF contributions (KWSP)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: epfReport,
    descriptionKey: 'desc_epf', fidelity: 'figures', outputs: ['pdf', 'xlsx', 'csv', 'print'], shelfOrder: 1,
    submission: { body: 'epf', agency: 'EPF (KWSP)', channel: 'i-Akaun (Employer)', dueDayOfNextMonth: 15 } },
  // SOCSO and EIS go up TOGETHER through ASSIST's combined contribution function — the reporter's words.
  // ONE `perkeso` shelf for the same reason: they are one filing, not two that happen to share a portal.
  // Same rule as EPF above: this is not "Borang 8A" and is not offered as one.
  { id: 'my.socso-eis', label: 'SOCSO + EIS (PERKESO)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: socsoEis,
    descriptionKey: 'desc_socso_eis', fidelity: 'figures', outputs: ['pdf', 'xlsx', 'csv', 'print', 'file'], shelfOrder: 1,
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
    submission: { body: 'lhdn', agency: 'LHDN', channel: 'e-Filing (Form E)', dueDayOfNextMonth: null } },
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
  // The EA statement is per EMPLOYEE, so it has no single company-wide table to open. The year's
  // employee list IS the CP8D screen — every row there links to that person's EA for the year.
  //
  // 587ee719 — TWO ENTRIES, ONE RENDERER. The reporter listed "C.P.8A (EA) – English" and
  // "C.P.8A (EA) – BM" as separate forms, and until this round they were not: app/me/ea/[employmentId]/pdf
  // resolved `payroll.ea` against the VIEWER's UI locale, so the same entry produced whichever language
  // the screen happened to be set to. The route now takes a `lang` param (en/ms, defaulting to the
  // request locale) and these two entries carry it. There is still exactly ONE EA renderer (lib/ea-pdf.ts)
  // and one EA statement read — the split is a translation locale, not a second implementation.
  {
    id: 'my.ea.en',
    labelKey: 'link_ea_en',
    hintKey: 'link_ea_hint',
    descriptionKey: 'desc_ea_en',
    body: 'lhdn',
    cadence: 'annual',
    href: '/payroll/statutory-forms/my.cp8d?companyId={companyId}&year={year}&lang=en',
    actionLabelKey: 'openEmployeeList',
    fidelity: 'figures',
    outputs: ['pdf', 'print'],
    shelfOrder: 3,
  },
  {
    id: 'my.ea.ms',
    labelKey: 'link_ea_ms',
    hintKey: 'link_ea_hint',
    descriptionKey: 'desc_ea_ms',
    body: 'lhdn',
    cadence: 'annual',
    href: '/payroll/statutory-forms/my.cp8d?companyId={companyId}&year={year}&lang=ms',
    actionLabelKey: 'openEmployeeList',
    fidelity: 'figures',
    outputs: ['pdf', 'print'],
    shelfOrder: 4,
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
    href: '/payroll/statutory-forms/my.cp8d?companyId={companyId}&year={year}',
    fidelity: 'figures',
    outputs: ['pdf', 'xlsx', 'csv', 'print'],
    shelfOrder: 7,
  },
  // CP22 / CP22A are event-driven (a hire, a cessation), not period-driven, so they are a worklist
  // rather than a form you pick a month for. It renders on the Statutory Forms landing page itself.
  // d3a9383c: the row now says "Open worklist" (which is what the href does) and carries a second action —
  // the blank fillable CP22. The per-joiner document hangs off the worklist ROWS, not off this shelf entry.
  //
  // 587ee719 — `fidelity: 'official'` HERE AND NOWHERE ELSE. CP22 is the only form in this catalog drawn
  // on the agency's own published page (public/forms/cp22-pin-1-2020.pdf; 33 areas mapped in
  // lib/cp22-fields.ts, 26 pre-filled and 7 left blank by design). A second `official` in this catalog is
  // a test failure, deliberately: it is the claim that costs the most if it is untrue.
  {
    id: 'my.cp22',
    labelKey: 'link_cp22',
    hintKey: 'link_cp22_hint',
    descriptionKey: 'desc_cp22',
    body: 'lhdn',
    cadence: 'event',
    href: '/payroll/statutory-forms?companyId={companyId}#worklist',
    actionLabelKey: 'openWorklist',
    secondaryHref: '/payroll/cp22/blank',
    secondaryLabelKey: 'link_cp22_blank',
    fidelity: 'official',
    outputs: ['pdf', 'print'],
    shelfOrder: 9,
  },
];

/**
 * 587ee719 — THE THIRTEEN FORMS THE REPORTER NAMED THAT HAVE NEVER BEEN BUILT, in the reporter's own
 * order, on the reporter's own shelves. See `PlannedFormDef` for why these are a separate type.
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
  { id: 'epf.borang-a', labelKey: 'planned_epf_borang_a', hintKey: 'planned_epf_borang_a_hint', body: 'epf', cadence: 'monthly', shelfOrder: 2 },
  { id: 'epf.borang-bbcb', labelKey: 'planned_epf_borang_bbcb', hintKey: 'planned_epf_borang_bbcb_hint', body: 'epf', cadence: 'monthly', shelfOrder: 3 },
  { id: 'perkeso.borang-8a', labelKey: 'planned_perkeso_borang_8a', hintKey: 'planned_perkeso_borang_8a_hint', body: 'perkeso', cadence: 'monthly', shelfOrder: 2 },
  { id: 'perkeso.borang-8b', labelKey: 'planned_perkeso_borang_8b', hintKey: 'planned_perkeso_borang_8b_hint', body: 'perkeso', cadence: 'monthly', shelfOrder: 3 },
  { id: 'perkeso.sip', labelKey: 'planned_perkeso_sip', hintKey: 'planned_perkeso_sip_hint', body: 'perkeso', cadence: 'monthly', shelfOrder: 4 },
  { id: 'perkeso.employee-registration', labelKey: 'planned_perkeso_employee_registration', hintKey: 'planned_perkeso_employee_registration_hint', body: 'perkeso', cadence: 'event', shelfOrder: 5 },
  { id: 'lhdn.tp1', labelKey: 'planned_lhdn_tp1', hintKey: 'planned_lhdn_tp1_hint', body: 'lhdn', cadence: 'annual', shelfOrder: 1 },
  { id: 'lhdn.tp3', labelKey: 'planned_lhdn_tp3', hintKey: 'planned_lhdn_tp3_hint', body: 'lhdn', cadence: 'annual', shelfOrder: 2 },
  { id: 'lhdn.pcb2ii-en', labelKey: 'planned_lhdn_pcb2ii_en', hintKey: 'planned_lhdn_pcb2ii_en_hint', body: 'lhdn', cadence: 'annual', shelfOrder: 5 },
  { id: 'lhdn.pcb2ii-ms', labelKey: 'planned_lhdn_pcb2ii_ms', hintKey: 'planned_lhdn_pcb2ii_ms_hint', body: 'lhdn', cadence: 'annual', shelfOrder: 6 },
  { id: 'lhdn.cp21', labelKey: 'planned_lhdn_cp21', hintKey: 'planned_lhdn_cp21_hint', body: 'lhdn', cadence: 'event', shelfOrder: 8 },
  { id: 'lhdn.cp22a', labelKey: 'planned_lhdn_cp22a', hintKey: 'planned_lhdn_cp22a_hint', body: 'lhdn', cadence: 'event', shelfOrder: 10 },
  { id: 'lhdn.cp39a', labelKey: 'planned_lhdn_cp39a', hintKey: 'planned_lhdn_cp39a_hint', body: 'lhdn', cadence: 'monthly', shelfOrder: 12 },
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
      inputs: { employmentId: string; monthlyWage: number; epfMonthly: number; additional: number; epfOnAdditional: number;
        acc: { netRemuneration: number; epfClaimed: number; pcbPaid: number } }[];
      filed: { employmentId: string; company: string; filedPcb: number }[]; indicative: boolean };
    const byPerson = new Map<string, Acc>();
    for (const s of slips) {
      const st = (s.statutory ?? {}) as { epfEmployee?: number; pcb?: number; pcbMeta?: { ytdNet?: number; epfClaimed?: number; pcbPaid?: number } };
      const bonus = Number(s.bonus) || 0;
      let p = byPerson.get(s.personId);
      if (!p) p = { personId: s.personId, personName: s.personName, category: s.category, children: s.children, inputs: [], filed: [], indicative: false };
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
      const coord = coordinatedPcbForPerson(p.inputs, {
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
