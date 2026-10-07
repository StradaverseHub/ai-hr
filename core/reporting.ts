/**
 * Statutory reporting seam (ADR-0010). Generic over jurisdiction: it asks the localization pack for
 * its report registry, then lists / previews / records reports. Reports are derived from payroll, but
 * a recorded generation is persisted as an append-only `statutory_report` artefact + domain event
 * (audit / idempotency / reproducibility). Filed per legal entity — RLS gates on is_admin_for.
 */
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Pcb2iiForm } from '../lib/pcb2ii-form';
import { alias } from 'drizzle-orm/pg-core';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  appUser,
  assignment,
  STATUTORY_FILED_STATUSES,
  type StatutoryFiledStatus,
  attendance,
  attendanceAllowancePolicy,
  attendanceCorrection,
  attendancePolicy,
  clockingLocation,
  company,
  companyStatutoryAuthority,
  companyStatutoryMy,
  compensation,
  department,
  employeeDependent,
  employeeStatutoryMy,
  employment,
  employmentTaxSelectionMy,
  employmentPayComponent,
  payComponent,
  payrollBatch,
  payslip,
  performanceGoal,
  performanceReview,
  person,
  position,
  reviewCycle,
  statutoryReport,
  toilAccrual,
} from '../db/schema';
import { evaluateAllowancesForPeriod } from './attendance-allowance';
import { packFor } from '../localization/registry';
import { isAdmin, canManagePayroll } from '../lib/authz';
// Rung 5a (ADR-0080 D1): report/EA types come from the pack CONTRACT, never from localization/my.
import type {
  EaStatement,
  FormFidelity,
  FormOutput,
  PlannedFormDef,
  ReportDef,
  ReportResult,
  StatutoryFormLink,
} from '../localization/country-pack';
import type { ReportData } from '../lib/report-export';
// TYPE-ONLY, and that matters: lib/cp22-pdf.ts imports pdf-lib, and `import type` is erased at compile
// time so this read pulls no PDF machinery into every caller of core/reporting.
import type { Cp22Address, Cp22PdfData } from '../lib/cp22-pdf';
// r413 — the same reasoning: TYPE-ONLY, so no pdf-lib reaches this module.
import type { Cp22aCessation, Cp22aPayLine, Cp22aPdfData } from '../lib/cp22a-pdf';
import type { Cp21PayLine, Cp21PdfData } from '../lib/cp21-pdf';
// r292 — `resolvePayrollPermission` is REUSED, not re-implemented: `markReportFiled` is gated on the same
// two-layer granular mechanism payroll.unlock / payroll.close use, so a customer configures who may file
// from the screen they already configure every other high-risk payroll authority from.
import { daysInMonth, resolvePayrollPermission } from './payroll';

import { todayInKualaLumpur } from '../lib/hr-date';

async function companyCountry(ctx: SessionContext, companyId: string): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const [co] = await tx
      .select({ country: company.country })
      .from(company)
      .where(eq(company.id, companyId))
      .limit(1);
    return co?.country ?? null;
  });
}

function reportsForCountry(country: string | null): ReportDef[] {
  return packFor(country)?.reports ?? [];
}

/**
 * ONE report definition, narrowed to what a catalog screen may see: metadata, never a generator.
 *
 * r256 — EXTRACTED FROM `listReports` SO THE COMPANY-LESS CATALOG BELOW CANNOT DRIFT FROM IT. The
 * Statutory Forms directory no longer picks a company before it lists forms, so it reads the catalog
 * through `listStatutoryCatalog`; a second hand-written projection there is how one of the two would
 * quietly stop carrying `fidelity` and start drawing a form with no status chip on it.
 */
export type StatutoryReportCard = {
  id: string;
  label: string;
  cadence: ReportDef['cadence'];
  periodKind: ReportDef['periodKind'];
  submission: NonNullable<ReportDef['submission']> | null;
  descriptionKey: string | null;
  outputs: readonly FormOutput[] | null;
  fidelity: FormFidelity | null;
  shelfOrder: number | null;
  /** r407 (item 4f45f9b0) — see `ReportDef.runSelection`. Null for a form not filed per payroll cycle. */
  runSelection: { action: string } | null;
  /** r409 (item 79f3f64d) — see `ReportDef.preview`. Null for a form that opens the generic figures screen. */
  preview: { action: string } | null;
};

function reportCard(r: ReportDef): StatutoryReportCard {
  return {
    id: r.id,
    label: r.label,
    cadence: r.cadence,
    periodKind: r.periodKind,
    // 956cec85 — where this form is filed and by when, as the pack declares it. Absent for reports that
    // are not themselves a submission, which is how the Statutory Forms screen tells the two apart.
    // 6babf4f6 added `submission.body`, the shelf key — it rides through here untouched, so a newly
    // registered form lands in its authority's section with no change to this seam or to the screen.
    submission: r.submission ?? null,
    // 587ee719 — the card's own metadata, same passthrough treatment as `submission` above: the pack
    // decides what a form can honestly give you, this seam carries it, and the screen renders it. Null
    // rather than undefined so a pack that declares none reads the same as one that has not been updated.
    descriptionKey: r.descriptionKey ?? null,
    outputs: r.outputs ?? null,
    fidelity: r.fidelity ?? null,
    shelfOrder: r.shelfOrder ?? null,
    runSelection: r.runSelection ?? null,
    preview: r.preview ?? null,
  };
}

/** Report definitions (metadata only) available for a company's jurisdiction. */
export async function listReports(ctx: SessionContext, companyId: string) {
  const country = await companyCountry(ctx, companyId);
  return reportsForCountry(country).map(reportCard);
}

/**
 * r256 (item 858a1128) — THE WHOLE STATUTORY CATALOG, WITH NO COMPANY CHOSEN.
 *
 * WHY THIS EXISTS. Statutory Forms used to ask for Company, Payroll Year and Payroll Month before it
 * would show you a single form name — the period chosen before the form, which is the reverse of the
 * order an HR operator works in. The directory now lists the forms first and asks each form for what it
 * actually needs afterwards, so it has no `companyId` to resolve a jurisdiction with.
 *
 * IT RESOLVES THE JURISDICTIONS THE ADMIN CAN ACTUALLY REACH, not a hardcoded one. The caller hands in
 * its company scope; this reads their DISTINCT countries in ONE query and unions the packs' catalogs.
 * A tenant whose companies are all Malaysian gets exactly the MY catalog it got before; a tenant that
 * later spans two jurisdictions gets both, deduplicated by form id rather than listed twice.
 *
 * STILL METADATA ONLY, and that is the whole point: nothing here computes a figure, and no entry
 * carries a generator. Deduplication is FIRST-WINS across the three collections at once, so an id can
 * never appear as both a generatable report and a planned one.
 */
export type StatutoryCatalog = {
  reports: StatutoryReportCard[];
  links: StatutoryFormLink[];
  planned: PlannedFormDef[];
};

export async function listStatutoryCatalog(
  ctx: SessionContext,
  companyIds: string[],
): Promise<StatutoryCatalog> {
  if (companyIds.length === 0) return { reports: [], links: [], planned: [] };
  const countries = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ country: company.country })
      .from(company)
      .where(inArray(company.id, companyIds));
    return [...new Set(rows.map((r) => r.country).filter((c): c is string => !!c))];
  });
  const out: StatutoryCatalog = { reports: [], links: [], planned: [] };
  const seen = new Set<string>();
  for (const country of countries) {
    const pack = packFor(country);
    if (!pack) continue;
    for (const r of pack.reports) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.reports.push(reportCard(r));
    }
    for (const l of pack.statutoryLinks) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.links.push(l);
    }
    for (const pf of pack.plannedForms) {
      if (seen.has(pf.id)) continue;
      seen.add(pf.id);
      out.planned.push(pf);
    }
  }
  return out;
}

/**
 * 6babf4f6 — the pack's non-generatable statutory-form entries (the per-employee EA statement, the
 * CP22/CP22A worklist). Separate from `listReports` because they have no `generate`: they are places to
 * go, not tables to produce. Empty for a jurisdiction no pack owns, exactly like `listReports`.
 */
export async function listStatutoryLinks(
  ctx: SessionContext,
  companyId: string,
): Promise<StatutoryFormLink[]> {
  const country = await companyCountry(ctx, companyId);
  return packFor(country)?.statutoryLinks ?? [];
}

/**
 * 587ee719 — the pack's statutory forms that have NOT been built, for the shelf to name with a status.
 *
 * Beside `listStatutoryLinks` rather than folded into it, because the two answer different questions and
 * the descriptors have different SHAPES: a `PlannedFormDef` has no href and no action key, so no caller
 * can render an action for one however carelessly it is written. Empty for a jurisdiction no pack owns,
 * exactly like the two seams above.
 */
export async function listPlannedForms(
  ctx: SessionContext,
  companyId: string,
): Promise<PlannedFormDef[]> {
  const country = await companyCountry(ctx, companyId);
  return packFor(country)?.plannedForms ?? [];
}

/**
 * When a monthly statutory submission for `periodKey` (YYYY-MM) is due, and where that leaves you today.
 *
 * Pure — no DB, no pack lookup — so the boundary cases are unit-testable: the deadline falling on the
 * day itself (due, not overdue), and a period whose deadline is not established at all.
 *
 * `today` defaults to the TENANT's date, not the server's: a deadline judged in UTC flips a day early
 * for the eight hours between 00:00 and 08:00 MYT, which is the bug bb4f2265 spent a round removing.
 */
export type SubmissionDue = {
  dueBy: string | null;
  status: 'overdue' | 'due_soon' | 'upcoming' | 'unknown';
};

export function submissionDueFor(
  periodKey: string,
  dueDayOfNextMonth: number | null,
  today: string = todayInKualaLumpur(),
): SubmissionDue {
  if (dueDayOfNextMonth == null || !/^\d{4}-\d{2}$/.test(periodKey)) return { dueBy: null, status: 'unknown' };
  const year = Number(periodKey.slice(0, 4));
  const month = Number(periodKey.slice(5, 7)); // 1-12; the deadline is in the month AFTER this one
  const dueYear = month === 12 ? year + 1 : year;
  const dueMonth = month === 12 ? 1 : month + 1;
  const dueBy = `${dueYear}-${String(dueMonth).padStart(2, '0')}-${String(dueDayOfNextMonth).padStart(2, '0')}`;
  // Strictly AFTER the due date is overdue — filing ON the 15th is on time, which is the whole point of
  // the deadline being a date rather than an instant.
  const status = today > dueBy ? 'overdue' : today >= isoAddDays(dueBy, -7) ? 'due_soon' : 'upcoming';
  return { dueBy, status };
}

async function resolveDef(ctx: SessionContext, companyId: string, reportId: string): Promise<ReportDef> {
  const country = await companyCountry(ctx, companyId);
  const def = reportsForCountry(country).find((r) => r.id === reportId);
  if (!def) throw new Error(`Unknown report '${reportId}' for ${country ?? 'company'}`);
  return def;
}

/**
 * ADR-0077 slice 9 — the ONE narrow use of the statutory override, and what decides it.
 *
 * r104 makes a suspended tenant read-only and carves out exactly one exception: "EPF, SOCSO and PCB
 * deadlines do not pause because an invoice is disputed". r105 built the thing that suspends. Nothing
 * ever set the override, so the carve-out was theory — and the consequence was not a missing audit row.
 *
 * WHAT ACTUALLY BROKE. `recordFileReport` is awaited BETWEEN generating a submission file and returning
 * it (app/payroll/reports/cp39-file/route.ts). Its read-only error fell into the route's generic catch,
 * which answers 500 "Could not generate the CP39 file". So a suspended customer did not merely lose the
 * artefact — THEY COULD NOT FILE THEIR PCB AT ALL. That is the precise outcome the carve-out exists to
 * prevent, and it is worse than the state before r104, where the write simply succeeded.
 *
 * `submission` IS THE DISCRIMINATOR, and it already existed — no new marker, no per-report allowlist to
 * keep in step. A ReportDef carries `submission` when it is a form filed with an agency on a deadline
 * (CP39/LHDN, EPF/KWSP, SOCSO+EIS/PERKESO, Form E). It is ABSENT on `my.contributions`, which the
 * registry itself describes as "an internal reconciliation view, not a form anybody files".
 *
 * So the rule is exactly r104's rule, applied: a filing obligation writes through; an internal
 * convenience does not. A suspended customer can meet a legal deadline and cannot generate management
 * reporting — which is the whole point of suspending them. When a new report is added to a pack, it gets
 * the override if and only if it is genuinely filed, decided by the same field that decides whether the
 * submission panel shows an agency and a due date.
 *
 * The reason string NAMES the report and the agency, because SessionContext types this field as a reason
 * rather than a boolean so an override is attributable in review rather than anonymous.
 */
function statutoryCtx(ctx: SessionContext, def: { id: string; submission?: { agency: string } }): SessionContext {
  if (!def.submission) return ctx;
  return { ...ctx, statutoryOverride: `statutory submission ${def.id} to ${def.submission.agency}` };
}

/** Generate a report for preview — pure, no artefact persisted. */
export async function reportPreview(
  ctx: SessionContext,
  p: {
    companyId: string;
    reportId: string;
    periodKey: string;
    /**
     * r372 (item f022dd70) — the payroll runs of that month the operator ticked, or ABSENT for all of
     * them. Forwarded verbatim; this seam neither invents a default nor widens an empty one. A report
     * that does not read it is unaffected, which is every report but the three statutory submissions.
     */
    runSeqs?: number[];
  },
): Promise<ReportResult> {
  const def = await resolveDef(ctx, p.companyId, p.reportId);
  return def.generate(ctx, { companyId: p.companyId, periodKey: p.periodKey, runSeqs: p.runSeqs });
}

/** Generate and RECORD a report: persist a statutory_report artefact + append a domain event. */
export async function recordReport(
  ctx: SessionContext,
  p: {
    companyId: string;
    reportId: string;
    periodKey: string;
    /**
     * r372 (item f022dd70) — the same selection `reportPreview` takes, forwarded for the same reason it
     * exists at all: a RECORDED artefact whose `rowCount` and `totals` were built from a different
     * population than the preview the operator looked at is worse than no artefact. Absent ⇒ every run,
     * which is what every caller sends today (nothing on the Payment Submission shelf records anything).
     */
    runSeqs?: number[];
  },
) {
  const def = await resolveDef(ctx, p.companyId, p.reportId);
  const result = await def.generate(ctx, {
    companyId: p.companyId,
    periodKey: p.periodKey,
    runSeqs: p.runSeqs,
  });
  const country = await companyCountry(ctx, p.companyId);
  return withTenant(statutoryCtx(ctx, def), async (tx) => {
    const [row] = await tx
      .insert(statutoryReport)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        jurisdiction: country ?? 'MY',
        reportType: def.id,
        periodKind: def.periodKind,
        periodKey: p.periodKey,
        status: 'draft',
        statutoryVersion: result.meta.statutoryVersion,
        rowCount: result.rows.length,
        totals: result.totals,
        generatedBy: ctx.userId,
      })
      .returning({ id: statutoryReport.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'statutory-report',
      aggregateId: row.id,
      eventType: 'statutory-report.generated',
      actor: actorOf(ctx),
      payload: {
        reportType: def.id,
        companyId: p.companyId,
        periodKey: p.periodKey,
        rowCount: result.rows.length,
        totals: result.totals,
      },
    });
    return row;
  });
}

/** Record a Layer-B submission FILE generation (byte-exact agency files, ADR-0010 §6D) as the
 *  same append-only artefact + event the table reports use. The file itself is not stored —
 *  it is reproducible from the payslips + the stamped statutory version. */
export async function recordFileReport(
  ctx: SessionContext,
  p: {
    companyId: string;
    reportType: string; // e.g. 'my.cp39-file'
    periodKey: string;
    rowCount: number;
    totals: Record<string, number>;
    statutoryVersion: string;
    /**
     * ADR-0077 slice 9 — the agency this file is filed with, e.g. 'LHDN' or 'PERKESO'.
     *
     * REQUIRED, and declared by the CALLER rather than inferred here. Every Layer-B file is by
     * definition a submission, but `reportType` is a free string ('my.cp39-file'), so deriving the
     * agency would mean stripping a suffix and looking the remainder up — a substring game on the one
     * path where being wrong means a customer cannot file. Naming the agency at the call site makes the
     * override attributable in review, which is what SessionContext types this as a reason for.
     */
    agency: string;
  },
) {
  const country = await companyCountry(ctx, p.companyId);
  // The file is generated BEFORE this call and returned AFTER it; without the override the read-only
  // error surfaces as a 500 and the customer gets no file at all. See statutoryCtx above.
  const writeCtx: SessionContext = {
    ...ctx,
    statutoryOverride: `statutory submission file ${p.reportType} to ${p.agency}`,
  };
  return withTenant(writeCtx, async (tx) => {
    const [row] = await tx
      .insert(statutoryReport)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        jurisdiction: country ?? 'MY',
        reportType: p.reportType,
        periodKind: 'month',
        periodKey: p.periodKey,
        status: 'draft',
        statutoryVersion: p.statutoryVersion,
        rowCount: p.rowCount,
        totals: p.totals,
        generatedBy: ctx.userId,
      })
      .returning({ id: statutoryReport.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'statutory-report',
      aggregateId: row.id,
      eventType: 'statutory-report.file-generated',
      actor: actorOf(ctx),
      payload: {
        reportType: p.reportType,
        companyId: p.companyId,
        periodKey: p.periodKey,
        rowCount: p.rowCount,
        totals: p.totals,
      },
    });
    return row;
  });
}

// ══════════════════════════ Marking a return FILED (r292 / readiness 3.2) ══════════════════════════
//
// WHAT WAS BROKEN. Every `statutory_report` row was born 'draft' and NOTHING updated the column, so
// 'final' | 'submitted' | 'amended' were unreachable and all 20 rows on production were 'draft'. The
// damage was downstream: `batchDownstreamWarnings.statutoryFiled` (core/payroll.ts) is
// `rows.length > 0`, so the amber banner shown before an unlock, a reset or an edit to a processed run
// said "statutory returns have already been filed for this month" whenever somebody had merely pressed
// Record generation on a PREVIEW — and could never say it when a return really had been lodged. It
// misled in both directions, which is worse than saying nothing: an operator who learns the banner
// cries wolf will ignore it on the day it is telling the truth.
//
// WHAT "FILED" NOW MEANS. A row is filed when an operator with the `payroll.statutory_file` permission
// has recorded the agency's ACKNOWLEDGEMENT for it. That is a fact about the outside world, keyed by a
// named human, not an inference the system draws from its own activity.
//
// THREE STATES, NOT FOUR — see the `status` comment in db/schema.ts for why `final` is not implemented.

/** `STATUTORY_FILED_STATUSES` is owned by db/schema.ts, beside the column — see the comment there for
 *  why it cannot live in this file or in core/payroll.ts. Re-exported so callers of this seam do not
 *  have to know that. */
export { STATUTORY_FILED_STATUSES, type StatutoryFiledStatus } from '../db/schema';
const isFiledStatus = (v: string): v is StatutoryFiledStatus =>
  (STATUTORY_FILED_STATUSES as readonly string[]).includes(v);

/** Named refusal, mirroring EaOverrideError (core/ea-override.ts): a server action maps the CODE to
 *  translated copy instead of pushing a raw English core string into a URL, and a test can assert the
 *  code rather than a message string that would also match the wrong throw. */
export class StatutoryFilingError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'forbidden'
      | 'notFound'
      | 'ackRefRequired'
      | 'ackRefTooLong'
      | 'reasonRequired'
      | 'invalidFiledOn'
      | 'filedOnInFuture'
      | 'alreadyFiled'
      | 'notFiled',
  ) {
    super(message);
    this.name = 'StatutoryFilingError';
  }
}

const ACK_REF_MAX = 120;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Record that a generated statutory return has been FILED with its agency.
 *
 * ── WHO MAY DO THIS ─────────────────────────────────────────────────────────────────────────────────
 * The granular `payroll.statutory_file` permission (lib/payroll-permissions.ts), resolved exactly the
 * way payroll.unlock / payroll.close are: code default of hr_admin + super_admin, overridable per
 * company or tenant-wide from app/admin/payroll-permissions. Filing is a statutory act and WHOSE act it
 * is differs per customer (HR, an outsourced bureau, a finance director) — that is a real UNKNOWN, and
 * a configurable key is how this codebase answers one, rather than my guessing on the customer's behalf.
 * The service is the primary gate; the 0026 RLS policy (`app.is_admin_for(company_id)`) is the SQL
 * backstop, and it is NOT redundant — it is what fences a cross-company write.
 *
 * ── SUBMITTED vs AMENDED IS DERIVED, NOT ASKED ──────────────────────────────────────────────────────
 * Filing a return for a (company, report type, period) that ALREADY has a live filed return is, by the
 * agencies' own vocabulary, an amended return. The system knows this and the operator would have to be
 * told it, so it is derived. It is derived from a CURRENTLY filed sibling: if the earlier mark was
 * reversed, the next one is a plain 'submitted' again, because a retracted claim was never a filing.
 *
 * ── WHAT THIS DOES *NOT* DO, AND WHY (readiness 3.4) ────────────────────────────────────────────────
 * It does not gate unlock, reset or a processed-run edit. 3.4 records that the only correction path
 * today is unlock → reset (which DELETES payslips) → regenerate → re-close. Turning a true "this month
 * is filed" into a BLOCK would mean a customer who filed a wrong figure could no longer correct it at
 * all — strictly worse than today. `batchDownstreamWarnings` has always been "READ AND RECORDED, never
 * a gate" (core/payroll.ts) and stays that way; the change here is that it is now telling the truth.
 *
 * ── AND WHAT IT DOES NOT CARVE OUT ──────────────────────────────────────────────────────────────────
 * No `statutoryOverride`. `statutoryCtx` above exists because a SUSPENDED tenant must still be able to
 * GENERATE a return and meet a legal deadline. Recording an acknowledgement is bookkeeping ABOUT an act
 * already performed outside this system; it meets no deadline and can wait until the invoice is
 * settled. Widening r104's one carve-out to cover it would be widening it on no evidence.
 */
export async function markReportFiled(
  ctx: SessionContext,
  p: {
    /** The `statutory_report` row being marked. */
    reportId: string;
    /** The agency's acknowledgement / receipt reference. MANDATORY — see below. */
    ackRef: string;
    /** 'YYYY-MM-DD', the day it was lodged WITH THE AGENCY. Defaults to today in Kuala Lumpur. */
    filedOn?: string;
  },
) {
  // ⚠️ VALIDATE BEFORE THE PERMISSION READ NEEDS A TX, BUT REFUSE ON AUTHORITY BEFORE TOUCHING A ROW.
  // The ack reference is MANDATORY and non-empty after trimming. Without it, `filed` is once again an
  // unevidenced click — the exact defect 3.2 names, moved one column across. There is deliberately NO
  // format check: LHDN, KWSP and PERKESO each issue a different shape, this repo can verify none of
  // them, and inventing a pattern would block a customer from recording a filing that really happened.
  const ackRef = p.ackRef?.trim() ?? '';
  if (!ackRef) {
    throw new StatutoryFilingError('An acknowledgement reference is required to mark a return filed', 'ackRefRequired');
  }
  if (ackRef.length > ACK_REF_MAX) {
    throw new StatutoryFilingError(`An acknowledgement reference may not exceed ${ACK_REF_MAX} characters`, 'ackRefTooLong');
  }
  // No hardcoded dates anywhere: today is derived from the clock through the one KL helper (CLAUDE.md §8).
  const today = todayInKualaLumpur();
  const filedOn = (p.filedOn ?? '').trim() || today;
  if (!ISO_DATE.test(filedOn)) throw new StatutoryFilingError('Filing date must be a YYYY-MM-DD date', 'invalidFiledOn');
  // A future filing date asserts something that has not happened yet. This is checkable and unarguable,
  // unlike "not before it was generated" — a return can legitimately be re-generated after being filed.
  if (filedOn > today) throw new StatutoryFilingError('A return cannot be filed in the future', 'filedOnInFuture');

  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: statutoryReport.id,
        companyId: statutoryReport.companyId,
        reportType: statutoryReport.reportType,
        periodKey: statutoryReport.periodKey,
        status: statutoryReport.status,
      })
      .from(statutoryReport)
      .where(eq(statutoryReport.id, p.reportId))
      .limit(1);
    // RLS already fenced the tenant and the company subtree, so "not visible" and "does not exist" are
    // the same answer here on purpose — an out-of-scope id must not be distinguishable from a bad one.
    if (!row) throw new StatutoryFilingError('Statutory report not found', 'notFound');

    if (!(await resolvePayrollPermission(tx, ctx, 'payroll.statutory_file', row.companyId))) {
      throw new StatutoryFilingError('Not authorized to mark a statutory return filed', 'forbidden');
    }
    // Re-filing the SAME row is not an amendment, it is a double-entry: the row already carries an
    // acknowledgement, and overwriting it would erase the first one. Reverse it first, or file the
    // regenerated return (a different row), which is what produces 'amended' below.
    if (isFiledStatus(row.status)) {
      throw new StatutoryFilingError('This return is already marked filed', 'alreadyFiled');
    }

    // Is there a LIVE filed return for the same company + report + period? Then this one is an amendment.
    const [prior] = await tx
      .select({ id: statutoryReport.id })
      .from(statutoryReport)
      .where(
        and(
          eq(statutoryReport.companyId, row.companyId),
          eq(statutoryReport.reportType, row.reportType),
          eq(statutoryReport.periodKey, row.periodKey),
          inArray(statutoryReport.status, [...STATUTORY_FILED_STATUSES]),
        ),
      )
      .orderBy(desc(statutoryReport.filedOn), desc(statutoryReport.filedAt))
      .limit(1);
    const status: StatutoryFiledStatus = prior ? 'amended' : 'submitted';

    const [updated] = await tx
      .update(statutoryReport)
      .set({ status, ackRef, filedOn, filedAt: new Date(), filedBy: ctx.userId ?? null })
      .where(eq(statutoryReport.id, row.id))
      .returning({
        id: statutoryReport.id,
        status: statutoryReport.status,
        ackRef: statutoryReport.ackRef,
        filedOn: statutoryReport.filedOn,
        filedAt: statutoryReport.filedAt,
        filedBy: statutoryReport.filedBy,
      });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'statutory-report',
      aggregateId: row.id,
      eventType: 'statutory-report.filed',
      actor: actorOf(ctx),
      payload: {
        reportType: row.reportType,
        companyId: row.companyId,
        periodKey: row.periodKey,
        status,
        ackRef,
        filedOn,
        amendsReportId: prior?.id ?? null,
      },
    });
    return updated;
  });
}

/**
 * Reverse a mark made in error — the return goes back to `draft` and stops counting as filed.
 *
 * ── WHY IT IS REVERSIBLE AT ALL ─────────────────────────────────────────────────────────────────────
 * A mis-keyed acknowledgement, or the right reference on the wrong row, is an ordinary mistake, and an
 * irreversible mark would leave a customer with a permanent false record and an amber banner that
 * cannot be silenced. Locking the state would also re-create 3.2 in mirror image: a warning that says
 * "filed" when nothing was.
 *
 * ── AND WHY THIS DESTROYS NOTHING ───────────────────────────────────────────────────────────────────
 * The `filed_*` columns are the row's CURRENT claim, and a retracted claim must not keep asserting
 * itself — so they are cleared. The HISTORY lives where this codebase always puts it: the
 * `statutory-report.filing-reversed` event carries the retracted acknowledgement, the declared filing
 * date, who had filed it, who reversed it and why, in the same transaction as the clear.
 *
 * A reason is MANDATORY, for the reason `UnlockReasonRequiredError` exists on the unlock path: undoing
 * a statutory record is exactly the kind of act whose audit row has to explain itself.
 *
 * NOT its own permission key: an operator who can enter this state but not leave it is a trap. See the
 * `payroll.statutory_file` comment in lib/payroll-permissions.ts.
 */
export async function reverseReportFiling(ctx: SessionContext, p: { reportId: string; reason: string }) {
  const reason = p.reason?.trim() ?? '';
  if (!reason) throw new StatutoryFilingError('A reason is required to reverse a filing mark', 'reasonRequired');

  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: statutoryReport.id,
        companyId: statutoryReport.companyId,
        reportType: statutoryReport.reportType,
        periodKey: statutoryReport.periodKey,
        status: statutoryReport.status,
        ackRef: statutoryReport.ackRef,
        filedOn: statutoryReport.filedOn,
        filedBy: statutoryReport.filedBy,
      })
      .from(statutoryReport)
      .where(eq(statutoryReport.id, p.reportId))
      .limit(1);
    if (!row) throw new StatutoryFilingError('Statutory report not found', 'notFound');

    if (!(await resolvePayrollPermission(tx, ctx, 'payroll.statutory_file', row.companyId))) {
      throw new StatutoryFilingError('Not authorized to reverse a statutory filing mark', 'forbidden');
    }
    if (!isFiledStatus(row.status)) {
      throw new StatutoryFilingError('This return is not marked filed', 'notFiled');
    }

    const [updated] = await tx
      .update(statutoryReport)
      .set({ status: 'draft', ackRef: null, filedOn: null, filedAt: null, filedBy: null })
      .where(eq(statutoryReport.id, row.id))
      .returning({
        id: statutoryReport.id,
        status: statutoryReport.status,
        ackRef: statutoryReport.ackRef,
        filedOn: statutoryReport.filedOn,
        filedAt: statutoryReport.filedAt,
        filedBy: statutoryReport.filedBy,
      });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'statutory-report',
      aggregateId: row.id,
      eventType: 'statutory-report.filing-reversed',
      actor: actorOf(ctx),
      payload: {
        reportType: row.reportType,
        companyId: row.companyId,
        periodKey: row.periodKey,
        reason,
        // The retracted claim, preserved here because the columns above are now null.
        retractedStatus: row.status,
        retractedAckRef: row.ackRef,
        retractedFiledOn: row.filedOn,
        retractedFiledBy: row.filedBy,
      },
    });
    return updated;
  });
}

/**
 * The country of the EMPLOYER an EA form speaks for.
 *
 * ADR-0077 slice 6 — `companyId` is the whole point. An EA form is one EMPLOYER's statement of what IT
 * paid (localization/my/reports.ts: eaStatement), and since Entity Transfer (b7b22514) the employer a
 * form speaks for is NOT necessarily the company the employment currently sits at. Resolving the
 * jurisdiction from the employment's CURRENT company and then applying it to a PRIOR employer is the
 * defect this slice exists to remove: an employee transferred from a Singaporean entity to a Malaysian
 * one would have had the Singaporean half of their year rendered as a Malaysian C.P.8A.
 *
 * Absent `companyId` ⇒ the employment's current company, which is byte-identical to the old behaviour
 * for everyone who has never transferred, and for every transfer inside one country.
 *
 * Returns `undefined` when the employment (or the named company) is not visible to this caller — RLS
 * does the fencing, and "not visible" must stay distinguishable from "visible, but no country on file"
 * so an out-of-scope id keeps producing the route's 404 rather than an unlabelled form.
 */
async function eaEmployerCountry(
  ctx: SessionContext,
  p: { employmentId: string; companyId?: string },
): Promise<string | null | undefined> {
  return withTenant(ctx, async (tx) => {
    if (p.companyId) {
      const [co] = await tx
        .select({ country: company.country })
        .from(company)
        .where(eq(company.id, p.companyId))
        .limit(1);
      return co ? co.country : undefined;
    }
    const [row] = await tx
      .select({ country: company.country })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    return row ? row.country : undefined;
  });
}

/**
 * Security assessment 2026-09, finding H4 — WHO MAY READ AN EA STATEMENT AT ALL.
 *
 * ── THE OLD CLAIM, RETIRED HERE ──────────────────────────────────────────────────────────────────────
 * Both EA seams below used to document their authorization as "RLS scopes visibility: an employee sees
 * only their own (+ reports'); admins see their company scope", and `app/me/ea/[employmentId]/pdf/route.ts`
 * says the same in as many words: "an employee can only pull their own (or a subordinate's, or — as admin
 * — their company's) EA". THE SUBORDINATE CASE WAS THE DEFECT, not a feature. An EA form prints the
 * person's IC or passport, their tax number and every ringgit the employer paid them for the year; a line
 * manager is not entitled to any of it. The exploit was verified by direct URL.
 *
 * ── WHY THE GUARD IS HERE AND NOT ONLY ON THE SCREEN ─────────────────────────────────────────────────
 * The remediation that introduced migration 0492 guarded the HTML page and nothing else. That left the PDF
 * route — same document, same IC, same tax number, one URL away — reading through RLS alone, and
 * `test/0492-payslip-statutory-privacy.test.ts` demonstrated that a manager still got a full statement
 * back. Migration 0492 could not close it either: the EA read resolves through `employment` and the pack's
 * own aggregates, not through `payslip_rls`.
 *
 * So the gate sits at the seam every door already goes through — one authoritative owner of the decision,
 * which is the point. The page keeps its own check as defence in depth.
 *
 * Payroll-staff-or-self, deliberately the same predicate the page uses. Note this is a CEILING, not a
 * grant: RLS still fences everything underneath, so a payroll admin for one company cannot reach another
 * company's people by passing this.
 */
async function eaReadableBy(ctx: SessionContext, employmentId: string): Promise<boolean> {
  if (isAdmin(ctx) || canManagePayroll(ctx)) return true;
  if (!ctx.personId) return false;
  // Self only. Read against `employment.person_id` rather than a cached list so a second concurrent
  // employment — the case the EA itself exists to handle — is included without a second source of truth.
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(and(eq(employment.id, employmentId), eq(employment.personId, ctx.personId!)))
      .limit(1);
    return !!row;
  });
}

/**
 * Per-employee EA statement for a tax year, via the EMPLOYER'S jurisdiction pack. Payroll-staff-or-self
 * (see eaReadableBy); RLS then scopes what that caller may actually reach.
 *
 * The pack comes from `p.companyId` when the caller names an employer (the EA screen's employer switcher
 * and the PDF route's `?company=` both do) — see `eaEmployerCountry`.
 */
export async function employeeEaStatement(
  ctx: SessionContext,
  p: { employmentId: string; year: string; companyId?: string },
): Promise<EaStatement | null> {
  if (!(await eaReadableBy(ctx, p.employmentId))) return null;
  const country = await eaEmployerCountry(ctx, p);
  if (country === undefined) return null;
  const pack = packFor(country);
  if (!pack) return null;
  return pack.eaStatement(ctx, p);
}

/**
 * 72b100cd — one employee's PCB 2(II) for a tax year, via the EMPLOYER'S jurisdiction pack.
 *
 * The same seam `employeeEaStatement` uses, and for the same reasons: RLS scopes visibility, and the pack
 * is resolved from the employer rather than assumed. A jurisdiction whose pack does not implement the
 * form returns null — LHDN's statement of tax paid is not a universal concept, and a pack that has no
 * such filing must not be made to produce a plausible-looking one (see the contract's own note).
 */
export async function employeePcb2iiStatement(
  ctx: SessionContext,
  p: { employmentId: string; year: string; selectedDate: string; companyId?: string },
): Promise<Pcb2iiForm | null> {
  const country = await eaEmployerCountry(ctx, p);
  if (country === undefined) return null;
  const pack = packFor(country);
  if (!pack?.pcb2iiStatement) return null;
  return pack.pcb2iiStatement(ctx, p);
}

/** b7b22514 — the employers that owe this employee an EA form for the year, oldest first. Drives the
 *  employer switcher on the EA screen and the PDF route's `company` parameter.
 *
 *  ADR-0077 slice 6, RECORDED RATHER THAN BUILT: the ENUMERATION still runs through the CURRENT
 *  company's pack, so an employee who has transferred INTO a jurisdiction no pack owns (a D-14
 *  non-statutory company) gets an empty switcher and loses access to the form their PRIOR, packed
 *  employer still owes them. The enumeration itself is jurisdiction-neutral — "the companies that paid
 *  this employment this year, plus the current one" — so the fix is to lift it off the pack, not to
 *  thread a second country through it. Left alone deliberately: it is a shape only a second pack can
 *  settle (which employer list belongs to which jurisdiction's form set), and inventing it now would be
 *  designing against an imagined second country, exactly as `complianceWorklist` argues below. Nothing
 *  here is wrong for a single-jurisdiction tenant. */
export async function employeeEaCompanies(
  ctx: SessionContext,
  p: { employmentId: string; year: string },
): Promise<{ companyId: string; name: string; isCurrent: boolean }[]> {
  // H4: this is the PDF route's `?company=` validator and the source `employeeEaStatements` fans out
  // from, so it carries the same ceiling as employeeEaStatement. An empty list is what both callers
  // already treat as "nothing to show", so no caller learns whether the employment exists.
  if (!(await eaReadableBy(ctx, p.employmentId))) return [];
  const country = await eaEmployerCountry(ctx, { employmentId: p.employmentId });
  if (country === undefined) return [];
  const pack = packFor(country);
  if (!pack) return [];
  return pack.eaCompaniesInYear(ctx, p);
}

/**
 * b7b22514 — EVERY EA statement the employee is owed for the year, one per employer, oldest first.
 *
 * An Entity Transfer moves an employment between legal entities mid-year, and an EA form is a statement of
 * what ONE employer paid. Before transfers existed the two were the same thing and a single statement was
 * complete; now a transferred employee is owed one form per company that paid them, and the screens that
 * render "the EA form" have to render all of them or they are handing out an incomplete tax record.
 *
 * Returns exactly one element for everyone who has never transferred.
 *
 * ADR-0077 slice 6 — EACH FORM IS BUILT BY ITS OWN EMPLOYER'S PACK. This used to resolve one pack from
 * the employment's current company and then generate EVERY employer's form with it, which is precisely
 * the "pack resolved from one company, applied to rows spanning several" defect: a cross-border transfer
 * produced a Malaysian C.P.8A for a foreign employer, on that employer's letterhead. An employer whose
 * jurisdiction no pack owns is SKIPPED rather than rendered under someone else's law — a non-statutory
 * company owes no statutory form, which is the correct empty and not a degraded one (D-14).
 *
 * Resolved once per distinct employer country, not per employer: a transfer year has at most a handful
 * of employers, but the map keeps the shape honest and mirrors `overtimeReport`'s per-country resolve.
 */
export async function employeeEaStatements(
  ctx: SessionContext,
  p: { employmentId: string; year: string },
): Promise<EaStatement[]> {
  const companies = await employeeEaCompanies(ctx, p);
  if (companies.length === 0) return [];
  const countryByCompany = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: company.id, country: company.country })
      .from(company)
      .where(inArray(company.id, companies.map((c) => c.companyId)));
    return new Map(rows.map((r) => [r.id, r.country]));
  });
  const out: EaStatement[] = [];
  for (const c of companies) {
    // THIS employer's jurisdiction, not the employment's. A company the read cannot see is absent from
    // the map and yields `undefined` ⇒ no pack ⇒ skipped, which is the same fail-closed answer RLS gives.
    const pack = packFor(countryByCompany.get(c.companyId));
    if (!pack) continue;
    const ea = await pack.eaStatement(ctx, { ...p, companyId: c.companyId });
    if (ea) out.push(ea);
  }
  return out;
}

// ── Compliance worklist (CP22 / CP22A) ──────────────────────────────────────
export type WorklistItem = {
  employmentId: string;
  name: string;
  form: 'CP22' | 'CP22A';
  reason: string;
  eventDate: string;
  /**
   * The statutory deadline, or NULL when the law ties it to a date the system does not hold. CP22A
   * [Pin.1/2023]'s own instruction: "sekurang-kurangnya 30 hari sebelum tarikh pemberhentian … atau dalam
   * tempoh 30 hari selepas dimaklumkan kematian seseorang pekerja". For a DEATH the clock starts when the
   * employer is TOLD (the form's own box A5), which nothing records — so no date is computed and the row
   * says why (`on_notice`), rather than printing leaving date − 30, a deadline that is not the law's.
   */
  dueBy: string | null;
  status: 'overdue' | 'due_soon' | 'upcoming' | 'on_notice';
};

const isoAddDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const statusFor = (today: string, dueBy: string): WorklistItem['status'] =>
  today > dueBy ? 'overdue' : today >= isoAddDays(dueBy, -7) ? 'due_soon' : 'upcoming';

/**
 * CP22 (new-hire) / CP22A (cessation) notifications due to LHDN, driven by the hire/termination
 * lifecycle (the same events the domain log records). MY-shaped — would move to the localization
 * pack for other jurisdictions. This is a human-reviewed worklist: filing happens in MyTax; we only
 * surface what's outstanding, never auto-submit (ADR-0010). No persistence yet — items age out of
 * the relevance window rather than being marked filed (a documented follow-up).
 */
/**
 * ADR-0080 slice 6 — CP22 and CP22A ARE MALAYSIAN LHDN FORMS, and this worklist emitted them for every
 * company regardless of jurisdiction. On a non-Malaysian company that is not a cosmetic slip: it tells
 * an HR administrator they have a statutory filing obligation that does not exist, with a due date.
 *
 * Gated the same way every other jurisdiction-owned surface is (r111's two-tier company): resolve the
 * company's pack, and emit nothing when no pack owns that jurisdiction. A NON-STATUTORY company has no
 * statutory worklist — that is the correct empty, not a degraded one.
 *
 * The forms themselves stay hardcoded here rather than moving onto ReportDef: there is exactly one pack
 * today, so a second pack is what should force that generalisation, and inventing the abstraction now
 * would be designing against an imagined second jurisdiction. The GATE is what cannot wait, because it
 * is wrong for a real company the moment one is onboarded.
 */
/**
 * r413 (item 79f3f64d, step 2) — GENERALISED FOR THE EVENT-SELECTION SCREEN, AND ONLY NARROWED.
 *
 * The forms about one person (CP22 for a joiner, CP22A for a leaver) open on a list of the people the
 * event happened to. That list IS this worklist, with the same window (hires in the last 60 days;
 * cessations from 60 days back to 90 days ahead) and the same statuses — a second read with its own
 * window would be a second answer to "who needs a CP22A". Two optional narrowings, both absent for the
 * Statutory Forms foot, which is therefore byte-unchanged:
 *   `form`      — only that form's rows;
 *   `nameQuery` — a case-insensitive substring of the person's name, applied AFTER RLS (it can only hide).
 */
export function complianceWorklist(
  ctx: SessionContext,
  p: { companyId: string; today?: string; form?: WorklistItem['form']; nameQuery?: string },
): Promise<WorklistItem[]> {
  const today = p.today ?? todayInKualaLumpur();
  const hireFloor = isoAddDays(today, -60); // recent hires still within / just past the 30-day window
  const ceaseFloor = isoAddDays(today, -60);
  const ceaseCeil = isoAddDays(today, 90); // upcoming cessations need notice before the date
  return withTenant(ctx, async (tx) => {
    // Resolved BEFORE the employee scan: a company whose jurisdiction no pack owns has no statutory
    // worklist, and the cheapest correct answer is not to look at its employees at all.
    const [co] = await tx
      .select({ country: company.country })
      .from(company)
      .where(eq(company.id, p.companyId))
      .limit(1);
    const pack = packFor(co?.country ?? null);
    if (!pack) return [];
    const emps = await tx
      .select({
        id: employment.id,
        name: person.fullName,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        terminationType: employment.terminationType,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(employment.companyId, p.companyId));
    const items: WorklistItem[] = [];
    for (const e of emps) {
      if (e.hiredOn >= hireFloor && e.hiredOn <= today) {
        const dueBy = isoAddDays(e.hiredOn, 30); // notify within 30 days of commencement
        items.push({ employmentId: e.id, name: e.name, form: 'CP22', reason: 'New hire', eventDate: e.hiredOn, dueBy, status: statusFor(today, dueBy) });
      }
      if (e.terminatedOn && e.terminatedOn >= ceaseFloor && e.terminatedOn <= ceaseCeil) {
        if (e.terminationType === 'death') {
          // Within 30 days of being TOLD of the death — a date not recorded, so none is computed (see dueBy).
          items.push({ employmentId: e.id, name: e.name, form: 'CP22A', reason: 'Cessation', eventDate: e.terminatedOn, dueBy: null, status: 'on_notice' });
        } else {
          const dueBy = isoAddDays(e.terminatedOn, -30); // notify ≥30 days before cessation
          items.push({ employmentId: e.id, name: e.name, form: 'CP22A', reason: 'Cessation', eventDate: e.terminatedOn, dueBy, status: statusFor(today, dueBy) });
        }
      }
    }
    const rank = { overdue: 0, due_soon: 1, on_notice: 2, upcoming: 3 };
    const needle = (p.nameQuery ?? '').trim().toLocaleLowerCase();
    return items
      .filter((i) => !p.form || i.form === p.form)
      .filter((i) => !needle || i.name.toLocaleLowerCase().includes(needle))
      .sort((a, b) => rank[a.status] - rank[b.status] || (a.dueBy ?? '').localeCompare(b.dueBy ?? ''));
  });
}

// ── CP22 month cohort (db46d9a2) ────────────────────────────────────────────
/**
 * Who started at one company in one CALENDAR MONTH, and whether their CP22 pages will come out complete.
 *
 * WHY IT IS A SECOND READ RATHER THAN A PARAMETER ON `complianceWorklist`. That read is a DEADLINE ALARM:
 * hires in the last 60 days and cessations in a 150-day band around today, ranked overdue → due soon →
 * upcoming, so it answers "what is outstanding right now". This one answers a different question — "who
 * started in July 2026" — for any month, including one years past whose deadline is long gone and for
 * which no status is meaningful. Widening the worklist's window would have made its statuses lie, so the
 * worklist is untouched and this sits beside it.
 *
 * GATED IDENTICALLY to the worklist and to `cp22Particulars`: RLS decides which employments are visible at
 * all, and the company's pack decides whether the form applies. A company whose jurisdiction no pack owns
 * gets `null`, not an empty month — CP22 is an LHDN form, and "nobody started in July" is a different (and
 * false) statement from "this company has no CP22". The route turns that null into the same 404 an unknown
 * company gets, and the screen draws no card at all.
 *
 * TERMINATED EMPLOYMENTS ARE INCLUDED. Someone hired in July and gone in August still needed a CP22 for
 * the hire, and the notice is often what a late filing is chasing.
 *
 * NO MISSING-HIRE-DATE BRANCH EXISTS, because `employment.hiredOn` is `.notNull()` (db/schema.ts) — an
 * employment record cannot exist without one, so nobody can be silently dropped from this list for want of
 * a date. The readiness flags below are the honest equivalent: they name what a page will be MISSING.
 */
export type Cp22CohortRow = {
  employmentId: string;
  name: string;
  /** ISO yyyy-mm-dd, inside the requested month by construction. */
  hiredOn: string;
  /** An IC number OR a passport number is on file — the form takes either. */
  hasIdentityNo: boolean;
  /** An LHDN income tax number is on file. */
  hasTaxNo: boolean;
};

export type Cp22MonthCohort = {
  /** yyyy-mm, echoed back so a caller cannot mismatch the list against the month it asked for. */
  periodKey: string;
  /** The month's first and last day, ISO — the inclusive bounds the rows were read with. */
  from: string;
  to: string;
  /**
   * The COMPANY-level readiness flag: `company_statutory_my.lhdn_employer_no` is one row per company
   * (uniqueIndex company_statutory_my_company_uq), so its absence gaps box 3 on EVERY page at once. A
   * boolean rather than the number itself: the screen only ever needs to know whether to warn.
   */
  employerNoOnFile: boolean;
  /** Hire date, then name — the order the screen lists and the order the batch document pages. */
  rows: Cp22CohortRow[];
};

const PERIOD_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function cp22MonthCohort(
  ctx: SessionContext,
  p: { companyId: string; periodKey: string },
): Promise<Cp22MonthCohort | null> {
  const m = PERIOD_KEY.exec(p.periodKey);
  // A malformed month is not an empty month. Null here is what makes the route answer 404 rather than
  // silently rendering some other month's joiners.
  if (!m) return Promise.resolve(null);
  const from = `${p.periodKey}-01`;
  const to = `${p.periodKey}-${String(daysInMonth(Number(m[1]), Number(m[2]))).padStart(2, '0')}`;
  return withTenant(ctx, async (tx) => {
    // Resolved BEFORE the employee scan, exactly as the worklist does it: a company whose jurisdiction no
    // pack owns has no CP22, and the cheapest correct answer is not to look at its employees at all.
    const [co] = await tx
      .select({ country: company.country })
      .from(company)
      .where(eq(company.id, p.companyId))
      .limit(1);
    if (!co || !packFor(co.country)) return null;

    const [statutory] = await tx
      .select({ eNumber: companyStatutoryMy.lhdnEmployerNo })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, p.companyId))
      .limit(1);

    // LEFT join, not inner: an employee with no Malaysian statutory row is exactly the person this list
    // has to NAME, and an inner join would hide them instead. Safe against duplication —
    // employee_statutory_my is unique on person_id (employee_statutory_my_person_uq).
    const rows = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        hiredOn: employment.hiredOn,
        taxNumber: employeeStatutoryMy.taxNumber,
        icNumber: employeeStatutoryMy.icNumber,
        passportNumber: employeeStatutoryMy.passportNumber,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(
        and(
          eq(employment.companyId, p.companyId),
          // Inclusive at BOTH edges: a hire on the 1st and a hire on the last day are both this month's.
          gte(employment.hiredOn, from),
          lte(employment.hiredOn, to),
        ),
      )
      .orderBy(employment.hiredOn, person.fullName);

    return {
      periodKey: p.periodKey,
      from,
      to,
      employerNoOnFile: Boolean(statutory?.eNumber?.trim()),
      rows: rows.map((r) => ({
        employmentId: r.employmentId,
        name: r.name,
        hiredOn: r.hiredOn,
        hasIdentityNo: Boolean(r.icNumber?.trim() || r.passportNumber?.trim()),
        hasTaxNo: Boolean(r.taxNumber?.trim()),
      })),
    };
  });
}

// ── CP22 particulars (the new-hire notice itself, d3a9383c) ─────────────────
/**
 * Everything the CP22 [Pin.1/2021] form can be filled from, for one employment.
 *
 * SITS BESIDE complianceWorklist DELIBERATELY: that read says WHO needs a CP22 and by when, this one
 * produces the document for a row of it, and they are gated identically — RLS decides whether the
 * employment is visible at all (a foreign id simply reads as absent, so this returns null rather than
 * throwing or leaking existence), and the company's pack decides whether the form applies at all. CP22 is
 * an LHDN form; a company no pack owns has no CP22 and gets null, exactly as the worklist gets [].
 *
 * NOTHING IS INVENTED. Every field is nullable end to end and an absent record travels as null all the way
 * to an EMPTY, still-editable box on the page (lib/cp22-fields.ts → `CP22_UNFILLABLE` documents the
 * fifteen that can never be filled). In particular: employeeDependent.companyName / employerAddress are
 * the SPOUSE'S employer and are NOT the form's "previous employer in Malaysia" (section E), so they are
 * not read here at all.
 *
 * NO DOMAIN EVENT. Rendering a form is a read; downloading it is not filing. Same deliberate skip the EA
 * and payslip PDF routes make.
 */
export type Cp22Particulars = Cp22PdfData & {
  /** The employing company — the route intersects it with the caller's active company scope. */
  companyId: string;
};

/** The un-itemised `compensation.monthly_allowance` lump, labelled the way the artwork labels things. */
export const CP22_FIXED_ALLOWANCE_LABEL = 'Elaun tetap bulanan / Fixed monthly allowance';

const asMoney = (v: unknown): number => Number(v ?? 0);

const trimmed = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

/**
 * Address parts → the shape the 2021 form's B12/B13 blocks ask for: THREE FREE ROWS for the street, and
 * postcode, town and state each in their OWN PRINTED BOX.
 *
 * THIS FUNCTION USED TO FOLD, AND FOLDING HERE IS THE r175a BUG RELOCATED. The 2020 page had one four-row
 * address block and nothing else, so this returned `[line1, line2, line3, "postcode city, state"]` — the
 * tail line carried the postcode, the town and the state together because that was the only place they
 * could go. Reuse that against the 2021 page and every one of those three values lands in a FREE STREET
 * ROW while the three boxes LHDN prints for them stay empty. The page looks complete. It is a Malaysian
 * address filed to LHDN with its state written in the wrong box and three blanks where the agency asked
 * for the same information — the identical class of silent loss as the address that went out without its
 * state at all, which is why it is called out here rather than quietly rewritten.
 *
 * So: street lines stay street lines, and postcode/town/state travel separately, all the way to their own
 * widgets. Anything past the third street line is folded into the third by the renderer (`foldToRows`),
 * never dropped.
 */
function cp22Address(p: {
  line1?: string | null;
  line2?: string | null;
  line3?: string | null;
  postcode?: string | null;
  city?: string | null;
  state?: string | null;
}): Cp22Address {
  return {
    lines: [p.line1, p.line2, p.line3].map((s) => (s ?? '').trim()).filter(Boolean),
    postcode: trimmed(p.postcode),
    town: trimmed(p.city),
    state: trimmed(p.state),
  };
}

/**
 * The employer's address for A2, which IS still a plain run of lines — the 2021 form gives section A three
 * free rows and no structured postcode/town/state boxes at all. So the employer address keeps the folded
 * tail the employee's address had to give up, and that asymmetry is the artwork's, not an oversight.
 */
function employerAddressLines(p: {
  line1?: string | null;
  line2?: string | null;
  line3?: string | null;
  postcode?: string | null;
  city?: string | null;
  state?: string | null;
}): string[] {
  const tail = [[p.postcode, p.city].filter(Boolean).join(' '), p.state].filter(Boolean).join(', ');
  return [p.line1, p.line2, p.line3, tail].map((s) => (s ?? '').trim()).filter(Boolean);
}

export function cp22Particulars(
  ctx: SessionContext,
  p: { employmentId: string; today?: string },
): Promise<Cp22Particulars | null> {
  const today = p.today ?? todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    const [base] = await tx
      .select({
        personId: employment.personId,
        companyId: employment.companyId,
        hiredOn: employment.hiredOn,
        contractStartDate: employment.contractStartDate,
        contractEndDate: employment.contractEndDate,
        country: company.country,
        companyName: company.legalName,
        companyLine1: company.addressLine1,
        companyLine2: company.addressLine2,
        companyLine3: company.addressLine3,
        companyPostcode: company.postcode,
        companyCity: company.city,
        companyState: company.state,
        companyPhone: company.phone,
        fullName: person.fullName,
        dateOfBirth: person.dateOfBirth,
        gender: person.gender,
        maritalStatus: person.maritalStatus,
        nationality: person.nationality,
        primaryEmail: person.primaryEmail,
        personalEmail: person.personalEmail,
        phone: person.phone,
        permLine1: person.permanentAddressLine1,
        permLine2: person.permanentAddressLine2,
        permLine3: person.permanentAddressLine3,
        permPostcode: person.permanentPostcode,
        permCity: person.permanentCity,
        permState: person.permanentState,
        corrLine1: person.correspondenceAddressLine1,
        corrLine2: person.correspondenceAddressLine2,
        corrLine3: person.correspondenceAddressLine3,
        corrPostcode: person.correspondencePostcode,
        corrCity: person.correspondenceCity,
        corrState: person.correspondenceState,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    // RLS-gated: an employment the caller may not see is simply not there. Null → the route's 404.
    if (!base) return null;
    if (!packFor(base.country)) return null;

    const [statutory] = await tx
      .select({ eNumber: companyStatutoryMy.lhdnEmployerNo })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, base.companyId))
      .limit(1);

    const [ident] = await tx
      .select({
        taxNumber: employeeStatutoryMy.taxNumber,
        icNumber: employeeStatutoryMy.icNumber,
        passportNumber: employeeStatutoryMy.passportNumber,
      })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, base.personId))
      .limit(1);

    // THE TRAP: employmentType lives on ASSIGNMENT, not on employment. A query against
    // employment.employmentType does not compile, and the reason it is tempting is that hiredOn and the
    // contract dates DO live on employment.
    const [current] = await tx
      .select({ title: position.title, employmentType: assignment.employmentType })
      .from(assignment)
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(
        and(
          eq(assignment.employmentId, p.employmentId),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .limit(1);

    const [spouse] = await tx
      .select({
        fullName: employeeDependent.fullName,
        icOrPassport: employeeDependent.icOrPassport,
        phone: employeeDependent.phone,
      })
      .from(employeeDependent)
      .where(
        and(
          eq(employeeDependent.personId, base.personId),
          eq(employeeDependent.relationship, 'spouse'),
          isNull(employeeDependent.archivedAt),
        ),
      )
      .orderBy(employeeDependent.createdAt)
      .limit(1);

    // The salary IN FORCE ON THE COMMENCEMENT DATE — a CP22 states the pay the employee starts on, not
    // today's. When no row covers that date (a salary keyed after the hire), the EARLIEST recorded row is
    // used: still a real record of what they were hired on, never a figure this code made up.
    const comps = await tx
      .select({
        basicSalary: compensation.basicSalary,
        monthlyAllowance: compensation.monthlyAllowance,
        validFrom: compensation.validFrom,
      })
      .from(compensation)
      .where(and(eq(compensation.employmentId, p.employmentId), isNull(compensation.supersededAt)))
      .orderBy(compensation.validFrom);
    const comp = [...comps].reverse().find((c) => c.validFrom <= base.hiredOn) ?? comps[0] ?? null;

    // Box (b): the named recurring earnings in force on the commencement date. 'allowance' is the kind the
    // catalog uses for both cash allowances and allowances-in-kind, which is exactly what the box asks for.
    const recurring = await tx
      .select({ label: payComponent.label, name: payComponent.name, amount: employmentPayComponent.amount })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .where(
        and(
          eq(employmentPayComponent.employmentId, p.employmentId),
          eq(payComponent.kind, 'allowance'),
          isNull(employmentPayComponent.supersededAt),
          lte(employmentPayComponent.validFrom, base.hiredOn),
          or(isNull(employmentPayComponent.validTo), gte(employmentPayComponent.validTo, base.hiredOn)),
        ),
      )
      .orderBy(payComponent.name);

    // Section F's declarant — name, designation and identification number — ONLY when the session resolves
    // to a person who holds a current assignment. SessionContext.personId is documented null for an admin
    // not tied to an employee, and there is no honest fallback: the company name is NOT a person's name.
    // Blank is the right answer, and the box stays editable so the real signer can write their own.
    let declarant: Cp22Particulars['declarant'] = { name: null, designation: null, icOrPassport: null };
    if (ctx.personId) {
      const [me] = await tx
        .select({
          name: person.fullName,
          title: position.title,
          // F2 asks for the DECLARANT'S own identification or passport number — their record, on a form
          // they personally sign. Read from the same table the employee's B3/B4 come from.
          icNumber: employeeStatutoryMy.icNumber,
          passportNumber: employeeStatutoryMy.passportNumber,
        })
        .from(person)
        .innerJoin(employment, eq(employment.personId, person.id))
        .innerJoin(
          assignment,
          and(
            eq(assignment.employmentId, employment.id),
            isNull(assignment.validTo),
            isNull(assignment.supersededAt),
          ),
        )
        .leftJoin(position, eq(position.id, assignment.positionId))
        .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, person.id))
        .where(eq(person.id, ctx.personId))
        .limit(1);
      if (me) {
        declarant = {
          name: me.name,
          designation: me.title ?? null,
          // The form prints "No. pengenalan / pasport *" with "delete whichever is not relevant", so
          // either satisfies it. IC first because a Malaysian declarant almost always has one.
          icOrPassport: trimmed(me.icNumber) ?? trimmed(me.passportNumber),
        };
      }
    }

    // D4 — the recurring CASH allowances in force on the commencement date, one entry each. Their total
    // goes in D4's amount box and their names onto D4's two "nyatakan / specify" rules.
    const cashAllowances: Cp22Particulars['pay']['cashAllowances'] = [];
    if (comp && asMoney(comp.monthlyAllowance) > 0) {
      cashAllowances.push({ label: CP22_FIXED_ALLOWANCE_LABEL, amount: asMoney(comp.monthlyAllowance) });
    }
    for (const r of recurring) cashAllowances.push({ label: r.label || r.name, amount: asMoney(r.amount) });

    // Derived, not stored: a contract or internship states its dates, everything else is Permanent. Left
    // editable in the downloaded file either way — this is the one pre-filled box that is a judgement.
    const dated = current?.employmentType === 'contract' || current?.employmentType === 'intern';
    const from = base.contractStartDate ?? base.hiredOn;
    const expectedDuration = dated
      ? base.contractEndDate
        ? `${from} - ${base.contractEndDate}`
        : 'Contract'
      : 'Permanent';

    return {
      companyId: base.companyId,
      employer: {
        name: base.companyName,
        addressLines: employerAddressLines({
          line1: base.companyLine1,
          line2: base.companyLine2,
          line3: base.companyLine3,
          postcode: base.companyPostcode,
          city: base.companyCity,
          state: base.companyState,
        }),
        eNumber: statutory?.eNumber ?? null,
        phone: base.companyPhone ?? null,
      },
      employee: {
        fullName: base.fullName,
        // B15 Jawatan and B17 Jenis pekerjaan are DIFFERENT QUESTIONS, and the 2020 page asked only one of
        // them. The job title is the designation; the nature of employment is the KIND of engagement, which
        // lives on ASSIGNMENT (see the trap noted above the `current` query) and is written back in the
        // stored vocabulary rather than reworded into LHDN's.
        designation: current?.title ?? null,
        // Written back in the stored vocabulary, never reworded into LHDN's — but the STORED form is
        // 'full_time', and an underscore on a government form reads as a database leak rather than an
        // answer. Only the separator changes.
        natureOfEmployment: current?.employmentType
          ? current.employmentType.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
          : null,
        commencementDate: base.hiredOn,
        expectedDuration,
        residentialAddress: cp22Address({
          line1: base.permLine1,
          line2: base.permLine2,
          line3: base.permLine3,
          postcode: base.permPostcode,
          city: base.permCity,
          state: base.permState,
        }),
        correspondenceAddress: cp22Address({
          line1: base.corrLine1,
          line2: base.corrLine2,
          line3: base.corrLine3,
          postcode: base.corrPostcode,
          city: base.corrCity,
          state: base.corrState,
        }),
        phone: base.phone ?? null,
        email: base.personalEmail || base.primaryEmail || null,
        incomeTaxNo: ident?.taxNumber ?? null,
        icNo: ident?.icNumber ?? null,
        passportNo: ident?.passportNumber ?? null,
        gender: base.gender ?? null,
        citizen: base.nationality ?? null,
        dateOfBirth: base.dateOfBirth ?? null,
        maritalStatus: base.maritalStatus ?? null,
      },
      // C4 is new on this edition, and employeeDependent.phone already holds it — no migration needed.
      spouse: spouse
        ? { fullName: spouse.fullName, icOrPassport: spouse.icOrPassport ?? null, phone: spouse.phone ?? null }
        : null,
      pay: {
        salaryAndOvertime: comp ? asMoney(comp.basicSalary) : null,
        cashAllowances,
      },
      declarant,
      today,
    };
  });
}

// ── CP22A particulars (the private-sector cessation notice, r413 / 79f3f64d step 2) ─────────────────────
/**
 * Everything LHDN's CP22A [Pin.1/2023] can be filled from, for one LEAVER.
 *
 * BUILT ON `cp22Particulars`, NOT BESIDE IT. The employer block, the identity numbers, date of birth,
 * marital status, telephone, e-mail, correspondence address and spouse are the SAME facts about the same
 * person the CP22 already reads, under the same RLS and the same pack gate — so this calls it, and a
 * second copy of that read cannot drift. What CP22A adds is the cessation (date and kind), the year's pay
 * so far, the year's deductions, and an authorised officer.
 *
 * NULL — the route's 404 — for an employment the caller cannot see, a company no pack owns, and an
 * employment with NO CESSATION DATE: a CP22A is a notice about someone leaving, and a form for somebody
 * who is not leaving would be a document about an event that has not been recorded.
 *
 * ── SECTION B, AND WHY IT IS THE EA ENGINE ───────────────────────────────────────────────────────────
 * The CP22A's section B is the year's remuneration "dari hari pertama tahun semasa sehingga tarikh
 * berhenti" — the same income, line for line, that the EA reports for the year. So it is READ from
 * `pack.eaStatement`, narrowed three ways that no EA caller asks for: payslips up to the CESSATION MONTH,
 * PROCESSED batches only, and no whole-year ea_override (see the parameter note on `eaStatement`). No PCB,
 * MTD or EA calculation changes; the EA figures are re-grouped onto LHDN's CP22A lines:
 *
 *   1  Gaji, bayaran, upah dan kerja lebih masa ← EA grossSalary (basic + overtime)
 *   3  Komisen dan bonus                      ← EA bonus + directorFee (the EA box "fees, commission or
 *                                                bonus" holds commission and director's fee together; the
 *                                                CP22A puts fees on line 1, commission on line 3 — they
 *                                                cannot be told apart, so the EA's own grouping stands)
 *   4  Ganjaran                               ← EA gratuity
 *   5  Pampasan kehilangan pekerjaan          ← EA compensation
 *   6  Elaun tunai termasuk cukai ditanggung  ← EA allowances (taxable) + tipsPerquisites + taxBorneByEmployer
 *   7  Pencen daripada majikan                ← EA pension
 *   8  Manfaat berupa barangan                ← EA benefitsInKind
 *   9  Nilai tempat kediaman                  ← EA livingAccommodation
 *   12 Lain-lain bayaran                      ← EA arrears + unapprovedFundRefund + annuity, each named
 *   13 ESOS / ESPP                            ← EA esos
 *   2, 10, 11                                 ← nothing (no EA figure separates them) — always blank
 *
 * ⚠️ BLANK, NOT 0.00, FOR A LINE NOTHING COULD HAVE REACHED. Lines 1, 3 and 6 are always derived from the
 * payslip's own columns, so their 0.00 is a fact. The others reach a figure ONLY through a pay item mapped
 * to that EA box (ea54fe6e routing) — so a 0 there with nothing mapped (or routing inactive for the year)
 * is "we cannot tell", and the line prints nothing. It prints 0.00 only when a mapped item exists and the
 * processed payroll paid none of it.
 *
 * "HINGGA" IS THE END OF THE LAST PROCESSED PERIOD, NEVER THE CESSATION DATE. The form is due 30 days
 * BEFORE the last day, normally before the final pay is run; printing the cessation date over a sum that
 * stops a month earlier would state a period the figure does not cover. "Dari" is 1 January, or the hire
 * date when it is later. No processed payroll in the period ⇒ every B and D box is blank.
 *
 * D2 / D3 / D4 are the EA's own year sums of statutory.pcb, statutory.zakat and statutory.epfEmployee over
 * the SAME narrowed slips — one derivation, the EA's, not a second sum here.
 *
 * A13 a) is the EA's item 8 count (the same child-relief-mode rule). A13 b) — the AMOUNT — stays blank:
 * the monthly MTD and the annual child reliefs are different schedules and no single figure answers it.
 *
 * SECTION E: the LHDN signatory on `company_statutory_authority` (the officer CP39 and the EA print), else
 * the session's own person exactly as CP22's section F does, else blank. Never the company's name.
 *
 * NO DOMAIN EVENT: a read. Downloading a CP22A is not filing one.
 */
export type Cp22aParticulars = Cp22aPdfData & {
  companyId: string;
  /** The tax year section B covers (the cessation year). */
  year: string;
  /** Pay items with money on these slips and no EA line — shown on the preview, as the EA screen does. */
  unmappedPayItems: { code: string; name: string }[];
  /** Whether a mapped pay item can reach the routing-only lines for this year (see above). */
  routingActive: boolean;
};

/** A2 — LHDN's three kinds. retired → Bersara, death → Meninggal dunia, everything else → Berhenti kerja. */
export function cp22aCessationFor(terminationType: string | null | undefined): Cp22aCessation {
  if (terminationType === 'retired') return 'retired';
  if (terminationType === 'death') return 'death';
  return 'resigned';
}

/** Line 12's components, named in the form's language for its "nyatakan" rule. */
const CP22A_LINE12_PARTS = [
  { field: 'arrears', label: 'Tunggakan gaji' },
  { field: 'unapprovedFundRefund', label: 'Bayaran balik kumpulan wang tidak diluluskan' },
  { field: 'annuity', label: 'Anuiti' },
] as const;

/**
 * r415 — THE YEAR'S PAY SO FAR, ON LHDN'S CP22A LINE NUMBERS, FOR EVERY LHDN NOTICE THAT ASKS FOR IT.
 *
 * Moved out of `cp22aParticulars` word for word (r413's derivation, its two verify fixes included) so the
 * CP21 [Pin.1/2025], whose section B is the same eleven lines plus nothing, reads the SAME derivation rather
 * than a copy of it. Everything the doc-comment on `Cp22aParticulars` says about section B is true here:
 * the EA engine narrowed to processed batches up to `throughPeriod` with no whole-year override; blank, not
 * 0.00, for a line nothing could reach; line 6 blank when the employer bears the tax and no pay item carries
 * it; "dari" 1 January or the hire date; "hingga" the end of the last processed period, never past `capAt`.
 *
 * `capAt` is the date the form's own header gives as the end (CP22A: the leaving date; CP21: the expected
 * departure date when one is typed, else nothing).
 */
async function lhdnYearSoFar(
  ctx: SessionContext,
  p: {
    employmentId: string;
    companyId: string;
    year: string;
    throughPeriod: string;
    hiredOn: string | null;
    capAt: string | null;
    bearsTax: boolean | null;
  },
): Promise<{
  ea: EaStatement | null;
  pay: Cp22aPdfData['pay'];
  deductions: Cp22aPdfData['deductions'];
}> {
  const { year, throughPeriod } = p;
  // The last PROCESSED pay period inside [year-01, throughPeriod], for this employer.
  const lastPeriod = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ last: sql<string | null>`max(${payrollBatch.payPeriod})` })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .where(
        and(
          eq(payslip.employmentId, p.employmentId),
          eq(payrollBatch.companyId, p.companyId),
          inArray(payrollBatch.status, ['processed', 'closed']),
          gte(payrollBatch.payPeriod, `${year}-01`),
          lte(payrollBatch.payPeriod, throughPeriod),
        ),
      );
    return row?.last ?? null;
  });

  // The EMPLOYER's pack — the callers' `cp22Particulars` already refused a company no pack owns.
  const pack = packFor(await companyCountry(ctx, p.companyId));
  const ea = lastPeriod && pack
    ? await pack.eaStatement(ctx, {
        employmentId: p.employmentId,
        year,
        companyId: p.companyId,
        throughPeriod,
        processedOnly: true,
        applyOverrides: false,
      })
    : null;

  const lines: Partial<Record<Cp22aPayLine, number>> = {};
  const line12Items: string[] = [];
  let esos: number | null = null;
  let deductions: Cp22aPdfData['deductions'] = { pcb: null, zakat: null, epf: null };
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (ea) {
    const b = ea.partB;
    const mapped = new Set<string>(ea.routing.active ? (ea.routing.mappedFields ?? []) : []);
    const has = (field: string, value: number) => value !== 0 || mapped.has(field);
    lines[1] = r2(b.grossSalary);
    lines[3] = r2(b.bonus + b.directorFee);
    // ⚠️ r413 verify (HIGH) — line 6 is captioned "termasuk cukai ditanggung oleh majikan". When the employer
    // bears the tax (A7 Ya) but no pay item carries that tax, the EA engine has nothing for it, and a figure
    // here would understate income on a form that says Ya. Blank — never a number we cannot stand behind.
    if (!(p.bearsTax === true && !has('taxBorneByEmployer', b.taxBorneByEmployer))) {
      lines[6] = r2(b.allowances + b.tipsPerquisites + b.taxBorneByEmployer);
    }
    if (has('gratuity', b.gratuity)) lines[4] = r2(b.gratuity);
    if (has('compensation', b.compensation)) lines[5] = r2(b.compensation);
    if (has('pension', ea.partC.pension)) lines[7] = r2(ea.partC.pension);
    if (has('benefitsInKind', b.benefitsInKind)) lines[8] = r2(b.benefitsInKind);
    if (has('livingAccommodation', b.livingAccommodation)) lines[9] = r2(b.livingAccommodation);
    const parts12 = { arrears: b.arrears, unapprovedFundRefund: b.unapprovedFundRefund, annuity: ea.partC.annuity };
    if (CP22A_LINE12_PARTS.some(({ field }) => has(field, parts12[field]))) {
      lines[12] = r2(CP22A_LINE12_PARTS.reduce((sum, { field }) => sum + parts12[field], 0));
      for (const { field, label } of CP22A_LINE12_PARTS) if (parts12[field] !== 0) line12Items.push(label);
    }
    if (has('esos', b.esos)) esos = r2(b.esos);
    deductions = { pcb: r2(ea.partD.mtd), zakat: r2(ea.partD.zakat), epf: r2(ea.partE.epf) };
  }

  const yearStart = `${year}-01-01`;
  const hired = p.hiredOn;
  const from = lastPeriod ? (hired && hired > yearStart ? hired : yearStart) : null;
  const periodEnd = lastPeriod
    ? `${lastPeriod}-${String(daysInMonth(Number(lastPeriod.slice(0, 4)), Number(lastPeriod.slice(5, 7)))).padStart(2, '0')}`
    : null;
  // r413 verify (MEDIUM) — "hingga" never runs past the date the form's own header says the employment ended:
  // once the leaving month's payroll is processed, the month end would otherwise print a date after it.
  const to = periodEnd && p.capAt && p.capAt < periodEnd ? p.capAt : periodEnd;

  return { ea, pay: { from, to, lines, line12Items, esos }, deductions };
}

export async function cp22aParticulars(
  ctx: SessionContext,
  p: { employmentId: string; today?: string },
): Promise<Cp22aParticulars | null> {
  const today = p.today ?? todayInKualaLumpur();
  const base = await cp22Particulars(ctx, { employmentId: p.employmentId, today });
  if (!base) return null;

  const extra = await withTenant(ctx, async (tx) => {
    const [emp] = await tx
      .select({ terminatedOn: employment.terminatedOn, terminationType: employment.terminationType })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    const [corr] = await tx
      .select({ personalEmail: person.personalEmail, primaryEmail: person.primaryEmail })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    // A7 — whether the employer bears this person's tax: the flag payroll funds the PCB from. A missing
    // statutory row is null (both A7 boxes blank), never a "Tidak".
    const [bears] = await tx
      .select({ tax: employeeStatutoryMy.employerBearsTax })
      .from(employment)
      .innerJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    // Section E — the company's LHDN signatory first (the same row CP39 and the EA read).
    const [auth] = await tx
      .select({ signatoryPersonId: companyStatutoryAuthority.signatoryPersonId })
      .from(companyStatutoryAuthority)
      .where(and(eq(companyStatutoryAuthority.companyId, base.companyId), eq(companyStatutoryAuthority.authority, 'lhdn')))
      .limit(1);
    const officerOf = async (personId: string) => {
      const [o] = await tx
        .select({ name: person.fullName, email: person.primaryEmail, title: position.title })
        .from(person)
        .leftJoin(employment, and(eq(employment.personId, person.id), eq(employment.companyId, base.companyId)))
        .leftJoin(
          assignment,
          and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo), isNull(assignment.supersededAt)),
        )
        .leftJoin(position, eq(position.id, assignment.positionId))
        .where(eq(person.id, personId))
        .orderBy(desc(assignment.validFrom))
        .limit(1);
      return o ?? null;
    };
    const signatory = auth?.signatoryPersonId ? await officerOf(auth.signatoryPersonId) : null;
    const sessionEmail = !signatory && ctx.personId
      ? (await tx.select({ email: person.primaryEmail }).from(person).where(eq(person.id, ctx.personId)).limit(1))[0]?.email ?? null
      : null;
    return { emp, corr, signatory, sessionEmail, bearsTax: bears ? bears.tax : null };
  });
  if (!extra.emp?.terminatedOn) return null;
  const cessationDate = extra.emp.terminatedOn;
  const year = cessationDate.slice(0, 4);
  // r415 — the year-so-far derivation moved, UNCHANGED, into `lhdnYearSoFar` above, so the CP21 reads the
  // same lines, the same line-6 rule and the same "hingga" as this form instead of a second copy of them.
  const { ea, pay, deductions } = await lhdnYearSoFar(ctx, {
    employmentId: p.employmentId,
    companyId: base.companyId,
    year,
    throughPeriod: cessationDate.slice(0, 7),
    hiredOn: base.employee.commencementDate,
    capAt: cessationDate,
    bearsTax: extra.bearsTax,
  });

  const corrAddr = base.employee.correspondenceAddress;
  const corrTail = [[corrAddr.postcode, corrAddr.town].filter(Boolean).join(' '), corrAddr.state].filter(Boolean).join(', ');
  const officer = extra.signatory
    ? { name: extra.signatory.name, designation: extra.signatory.title ?? null, email: extra.signatory.email ?? null }
    : { name: base.declarant.name, designation: base.declarant.designation, email: base.declarant.name ? extra.sessionEmail : null };

  return {
    companyId: base.companyId,
    year,
    unmappedPayItems: ea?.routing.unmapped ?? [],
    routingActive: ea?.routing.active ?? false,
    employer: {
      name: base.employer.name,
      addressLines: base.employer.addressLines,
      eNumber: base.employer.eNumber,
      phone: base.employer.phone,
    },
    employee: {
      fullName: base.employee.fullName,
      icNo: base.employee.icNo,
      passportNo: base.employee.passportNo,
      taxNo: base.employee.incomeTaxNo,
      commencementDate: base.employee.commencementDate,
      cessationDate,
      cessation: cp22aCessationFor(extra.emp.terminationType),
      taxBorneByEmployer: extra.bearsTax,
      dateOfBirth: base.employee.dateOfBirth,
      maritalStatus: base.employee.maritalStatus,
      childrenCount: ea?.employee.children ?? null,
      phone: base.employee.phone,
      // The leaver's OWN address first: the work mailbox is the one about to stop working.
      email: extra.corr?.personalEmail || extra.corr?.primaryEmail || null,
      correspondenceAddress: [...corrAddr.lines, corrTail].map((s) => s.trim()).filter(Boolean),
    },
    spouse: base.spouse ? { fullName: base.spouse.fullName, icOrPassport: base.spouse.icOrPassport } : null,
    pay,
    deductions,
    officer,
    today,
    typed: {
      deathNotifiedDate: null,
      retirement: null,
      scheme: null,
      rep: { name: null, icNo: null, relationship: null, address: [], phone: null },
    },
  };
}

// ── CP21 (the notice of an employee leaving Malaysia, r415 / 79f3f64d step 3) ──────────────────────────
/**
 * Everything LHDN's CP21 [Pin.1/2025] can be filled from, for one employee.
 *
 * BUILT ON `cp22Particulars` AND `lhdnYearSoFar`, NOT BESIDE THEM. The employer block, the identity numbers,
 * date of birth, nationality, telephone, correspondence address and the position title are the same facts
 * the CP22 reads, under the same RLS and pack gate; section B and D are the CP22A's derivation, read once.
 *
 * NOTHING RECORDS AN INTENDED DEPARTURE, so the departure date (A3) is the OPERATOR'S, typed on the preview
 * and passed in here as `departureDate` (lib/cp21-review.ts validates it). It decides the period:
 *   the tax year is the departure year (section B: "bagi tahun beliau meninggalkan negara ini"), else
 *   today's; payslips count up to the departure month, else up to today's month; "hingga" is the end of
 *   the last processed period, never past the departure date when one is typed.
 * NULL — the routes' 404 — only for what `cp22Particulars` refuses: an employment the caller cannot see and
 * a company no pack owns. A CP21 is not refused for an employee with a leaving date: they may still be
 * leaving the country.
 *
 * SECTION B, RENUMBERED FROM THE CP22A's LINES (lib/cp21-fields.ts): 1–10 are the same lines; CP21's 11
 * "Bayaran-bayaran lain (jika ada, nyatakan)" takes CP22A's 12 (arrears, unapproved-fund refund, annuity);
 * and because CP21 [Pin.1/2025] prints NO share-scheme line, the EA's ESOS benefit — employment income the
 * EA reports — goes on line 11 too, NAMED on its "nyatakan", rather than being left off the total.
 * DECISION (r415): that is the reading under which nothing the EA counts disappears from the form.
 *
 * A4 "Mastautin dalam tahun meninggalkan Malaysia". The column the brief named, employee_statutory_my's
 * residency, is no longer the owner: since migration 0505 the per-employment, per-company
 * `employment_tax_selection_my.scheme` is ("The Income Tax Resident field owns the scoped scheme",
 * localization/my/tax-selection.ts). So A4 reads the CONFIGURED scheme exactly as `resolveTaxSelectionMY`
 * computes it — the selection's scheme, else the legacy profile (tax_residency with is_resident) — and
 * marks non_resident as Tidak and the resident schemes (resident, rep, knowledge_worker, c_suite: "Approved
 * incentive categories are resident", setTaxProfileMY) as Ya. No selection and no profile: blank.
 *
 * A9 "Tempat lahir" has no column and stays blank (CP21_UNFILLABLE_REASONS). A10 "Jenis pekerjaan" is the
 * current position title — on this form there is no separate "Jawatan" box for it to belong to.
 *
 * NO DOMAIN EVENT: a read. Downloading a CP21 is not filing one.
 */
export type Cp21Particulars = Omit<Cp21PdfData, 'typed'> & {
  companyId: string;
  /** The tax year section B covers. */
  year: string;
  unmappedPayItems: { code: string; name: string }[];
  routingActive: boolean;
};

/** What goes on CP21's line-11 "nyatakan" for the ESOS benefit, in the form's language. */
export const CP21_ESOS_ITEM = 'Manfaat Skim Pemberian Saham (ESOS)';

const RESIDENT_SCHEMES = new Set(['resident', 'rep', 'knowledge_worker', 'c_suite']);

export async function cp21Particulars(
  ctx: SessionContext,
  p: { employmentId: string; today?: string; departureDate?: string | null },
): Promise<Cp21Particulars | null> {
  const today = p.today ?? todayInKualaLumpur();
  const base = await cp22Particulars(ctx, { employmentId: p.employmentId, today });
  if (!base) return null;
  const departure = p.departureDate ?? null;

  const extra = await withTenant(ctx, async (tx) => {
    const [corr] = await tx
      .select({ personalEmail: person.personalEmail, primaryEmail: person.primaryEmail })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    const [profile] = await tx
      .select({
        bearsTax: employeeStatutoryMy.employerBearsTax,
        taxResidency: employeeStatutoryMy.taxResidency,
        isResident: employeeStatutoryMy.isResident,
      })
      .from(employment)
      .innerJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    const [selection] = await tx
      .select({ scheme: employmentTaxSelectionMy.scheme })
      .from(employmentTaxSelectionMy)
      .where(
        and(
          eq(employmentTaxSelectionMy.employmentId, p.employmentId),
          eq(employmentTaxSelectionMy.companyId, base.companyId),
        ),
      )
      .limit(1);
    const [auth] = await tx
      .select({ signatoryPersonId: companyStatutoryAuthority.signatoryPersonId })
      .from(companyStatutoryAuthority)
      .where(and(eq(companyStatutoryAuthority.companyId, base.companyId), eq(companyStatutoryAuthority.authority, 'lhdn')))
      .limit(1);
    // Section E — the company's LHDN signatory first, the same lookup cp22aParticulars makes.
    const signatory = auth?.signatoryPersonId
      ? ((
          await tx
            .select({ name: person.fullName, email: person.primaryEmail, title: position.title })
            .from(person)
            .leftJoin(employment, and(eq(employment.personId, person.id), eq(employment.companyId, base.companyId)))
            .leftJoin(
              assignment,
              and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo), isNull(assignment.supersededAt)),
            )
            .leftJoin(position, eq(position.id, assignment.positionId))
            .where(eq(person.id, auth.signatoryPersonId))
            .orderBy(desc(assignment.validFrom))
            .limit(1)
        )[0] ?? null)
      : null;
    const sessionEmail = !signatory && ctx.personId
      ? (await tx.select({ email: person.primaryEmail }).from(person).where(eq(person.id, ctx.personId)).limit(1))[0]?.email ?? null
      : null;
    return { corr, profile: profile ?? null, selection: selection ?? null, signatory, sessionEmail };
  });

  // A4 — the configured scheme, by resolveTaxSelectionMY's own `configured` rule.
  const legacy = extra.profile
    ? extra.profile.taxResidency === 'resident' && extra.profile.isResident === false
      ? 'non_resident'
      : extra.profile.taxResidency ?? (extra.profile.isResident === false ? 'non_resident' : 'resident')
    : null;
  const scheme = extra.selection?.scheme ?? legacy;
  const resident = scheme === 'non_resident' ? false : scheme && RESIDENT_SCHEMES.has(scheme) ? true : null;
  const bearsTax = extra.profile ? extra.profile.bearsTax : null;

  const anchor = departure ?? today;
  const year = anchor.slice(0, 4);
  const { ea, pay, deductions } = await lhdnYearSoFar(ctx, {
    employmentId: p.employmentId,
    companyId: base.companyId,
    year,
    throughPeriod: anchor.slice(0, 7),
    hiredOn: base.employee.commencementDate,
    capAt: departure,
    bearsTax,
  });

  // CP22A's line numbers → CP21's (see the doc-comment): 1–10 as they are, 12 + ESOS → 11.
  const lines: Partial<Record<Cp21PayLine, number>> = {};
  for (const n of [1, 3, 4, 5, 6, 7, 8, 9] as const) if (pay.lines[n] != null) lines[n] = pay.lines[n];
  const line11Items = [...pay.line12Items];
  if (pay.lines[12] != null || pay.esos != null) {
    lines[11] = Math.round(((pay.lines[12] ?? 0) + (pay.esos ?? 0)) * 100) / 100;
    if (pay.esos) line11Items.push(CP21_ESOS_ITEM);
  }

  const corrAddr = base.employee.correspondenceAddress;
  const corrTail = [[corrAddr.postcode, corrAddr.town].filter(Boolean).join(' '), corrAddr.state].filter(Boolean).join(', ');
  const officer = extra.signatory
    ? { name: extra.signatory.name, designation: extra.signatory.title ?? null, email: extra.signatory.email ?? null }
    : { name: base.declarant.name, designation: base.declarant.designation, email: base.declarant.name ? extra.sessionEmail : null };

  return {
    companyId: base.companyId,
    year,
    unmappedPayItems: ea?.routing.unmapped ?? [],
    routingActive: ea?.routing.active ?? false,
    employer: {
      name: base.employer.name,
      addressLines: base.employer.addressLines,
      eNumber: base.employer.eNumber,
      phone: base.employer.phone,
    },
    employee: {
      fullName: base.employee.fullName,
      icNo: base.employee.icNo,
      passportNo: base.employee.passportNo,
      taxNo: base.employee.incomeTaxNo,
      commencementDate: base.employee.commencementDate,
      resident,
      citizen: base.employee.citizen,
      dateOfBirth: base.employee.dateOfBirth,
      natureOfEmployment: base.employee.designation,
      phone: base.employee.phone,
      // The employee's OWN address first: the work mailbox may stop working once they leave.
      email: extra.corr?.personalEmail || extra.corr?.primaryEmail || null,
      correspondenceAddress: [...corrAddr.lines, corrTail].map((s) => s.trim()).filter(Boolean),
      taxBorneByEmployer: bearsTax,
    },
    pay: { from: pay.from, to: pay.to, lines, line11Items },
    deductions,
    officer,
    today,
  };
}

/** One row of the CP21 employee list. */
export type ActiveStaffRow = { employmentId: string; name: string; hiredOn: string; title: string | null };

/**
 * r415 — THE LIST FOR A FORM WHOSE EVENT NOTHING RECORDS (CP21): EVERY ACTIVE EMPLOYEE OF THE COMPANY.
 * Nothing records an intended departure, so there is no event to narrow by (the approved plan: "CP21 lists all current staff").
 *
 * Active = employed by this company today: `employment.company_id` is the company (the same column the
 * compliance worklist reads), joined on or before today, and no leaving date or one today or later — a
 * person serving notice is still staff. Gated like the worklist: a company no pack owns has no statutory
 * list. The name search is a case-insensitive substring applied AFTER RLS (it can only hide). Ordered by
 * name, then employment id, so the list is reproducible.
 */
export function activeStaff(
  ctx: SessionContext,
  p: { companyId: string; today?: string; nameQuery?: string },
): Promise<ActiveStaffRow[]> {
  const today = p.today ?? todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    const [co] = await tx.select({ country: company.country }).from(company).where(eq(company.id, p.companyId)).limit(1);
    if (!packFor(co?.country ?? null)) return [];
    const rows = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        hiredOn: employment.hiredOn,
        title: position.title,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(
        assignment,
        and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo), isNull(assignment.supersededAt)),
      )
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(
        and(
          eq(employment.companyId, p.companyId),
          lte(employment.hiredOn, today),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, today)),
        ),
      )
      .orderBy(person.fullName, employment.id);
    const needle = (p.nameQuery ?? '').trim().toLocaleLowerCase();
    // One row per employment even if a stray second open assignment exists.
    const seen = new Set<string>();
    return rows
      .filter((r) => (seen.has(r.employmentId) ? false : (seen.add(r.employmentId), true)))
      .filter((r) => !needle || r.name.toLocaleLowerCase().includes(needle))
      .map((r) => ({ ...r, title: r.title ?? null }));
  });
}

/** Recently recorded report artefacts for a company (audit trail). */
export function recentReports(ctx: SessionContext, companyId: string) {
  // `filed_by` holds an APP_USER id (like `generated_by` beside it), so the filer's name is two hops
  // away: app_user → person. Both joins are aliased, because this module joins `person` for other
  // reasons, and both are LEFT joins — an unfiled row has a null `filed_by`, and an INNER join would
  // silently drop every draft from the audit list this table exists to be.
  const filedByUser = alias(appUser, 'statutory_report_filed_by_user');
  const filedByPerson = alias(person, 'statutory_report_filed_by_person');
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: statutoryReport.id,
        reportType: statutoryReport.reportType,
        periodKey: statutoryReport.periodKey,
        status: statutoryReport.status,
        rowCount: statutoryReport.rowCount,
        totals: statutoryReport.totals,
        statutoryVersion: statutoryReport.statutoryVersion,
        generatedAt: statutoryReport.generatedAt,
        // r292 — the filing evidence travels WITH the row. A screen that shows a status chip reading
        // "Submitted" without the acknowledgement beside it is asking the reader to take the chip on
        // trust, which is what "filed" used to mean here.
        filedOn: statutoryReport.filedOn,
        filedAt: statutoryReport.filedAt,
        ackRef: statutoryReport.ackRef,
        filedByName: filedByPerson.fullName,
      })
      .from(statutoryReport)
      .leftJoin(filedByUser, eq(filedByUser.id, statutoryReport.filedBy))
      .leftJoin(filedByPerson, eq(filedByPerson.id, filedByUser.personId))
      .where(eq(statutoryReport.companyId, companyId))
      .orderBy(desc(statutoryReport.generatedAt))
      .limit(20),
  );
}

// ─────────────────────────── Overtime report (Overtime Rate Config, #e410da83) ───────────────────────────
// A per-employee monthly overtime view that reconciles with the actual payslip: normal + total worked hours,
// OT hours split by category, the configured rate per category, the RM amount computed by the SAME
// `overtimePay` path payroll uses (so eligibility gate + configured excess multipliers are reflected), and an
// explicit eligibility label. Pure READ — no DomainEvent is appended (per substrate rules, read-only surfaces
// skip the event; this comment documents the deliberate skip). The report is exported via lib/report-export
// (CSV / XLSX / PDF) from the admin-gated route app/attendance/ot-report/export.

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const minToHours = (m: number) => r2(m / 60);

/** Structured OT report (for the export route + tests). Amounts reflect eligibility + configured rates. */
export type OvertimeReportRow = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  normalWorkingHours: number;
  totalWorkedHours: number;
  totalOtHours: number;
  normalDayOtHours: number;
  restDayOtHours: number;
  publicHolidayOtHours: number;
  workdayMultiplier: number;
  restDayExcessMultiplier: number;
  holidayExcessMultiplier: number;
  otAmount: number;
  /** ISO-4217 of the employee's COMPANY. Amounts across differing currencies must never be summed (D-9). */
  currency: string;
  eligible: boolean;
  otSource: 'system' | 'requested' | 'none';
  otApprovalStatus: 'approved' | 'pending' | 'none';
};

export type OvertimeReport = {
  month: string;
  /** The statutory version that produced the rate columns (for the report footnote / audit). */
  statutoryVersion: string | null;
  rows: OvertimeReportRow[];
};

/**
 * Build the monthly overtime report for the given companies. Resolves the effective OT ruleset once at
 * month-end (the same asOf payroll's prefill uses for the period), reads each active employee's current s.2
 * wages + per-day classified attendance OT, and monetizes via `overtimePay` so the RM figure equals what the
 * payslip would pay (including the >RM4,000 eligibility gate ⇒ RM 0.00, labelled "Above ceiling").
 */
export async function overtimeReport(
  ctx: SessionContext,
  p: { month: string; companyIds?: string[] },
): Promise<OvertimeReport> {
  return withTenant(ctx, async (tx) => {
    const [y, m] = p.month.split('-').map(Number);
    const monthStart = `${p.month}-01`;
    const monthEnd = `${p.month}-${String(daysInMonth(y, m)).padStart(2, '0')}`;

    const emps = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: employment.companyId,
        country: company.country,
        currency: company.currency,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(
        and(
          p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined,
          lte(employment.hiredOn, monthEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, monthStart)),
        ),
      )
      .orderBy(person.fullName);
    if (emps.length === 0) return { month: p.month, statutoryVersion: null, rows: [] };
    const empIds = emps.map((e) => e.employmentId);

    // ADR-0077 slice 6 — the OT ruleset resolves PER COMPANY COUNTRY, not once for the whole report.
    //
    // This used to say "All companies in scope share the tenant-wide ruleset; resolve via the pack of the
    // first company that has one" and did exactly that. With MY the only pack it is byte-identical. With
    // two, a report spanning a Malaysian and a Singaporean company would have applied ONE jurisdiction's
    // overtime multipliers and wage ceiling to BOTH — computing foreign employees under Malaysian rules
    // and labelling the result as theirs. That is the same harm the two-tier company (D-14) exists to
    // prevent, arriving through a report instead of a mis-keyed country.
    //
    // Resolved once PER DISTINCT COUNTRY rather than per employee: a 500-employee report still issues one
    // loadRuleset per jurisdiction, not 500.
    const countries = [...new Set(emps.map((e) => e.country))];
    const rulesByCountry = new Map<
      string | null,
      { pack: ReturnType<typeof packFor>; ruleset: Awaited<ReturnType<NonNullable<ReturnType<typeof packFor>>['payroll']['loadRuleset']>> | null }
    >();
    for (const c of countries) {
      const cPack = packFor(c);
      rulesByCountry.set(c, {
        pack: cPack,
        ruleset: cPack ? await cPack.payroll.loadRuleset(tx, { asOf: monthEnd }) : null,
      });
    }
    // The footnote version stays single-valued for now and reports the FIRST resolved jurisdiction's
    // version; when a second pack ships this becomes a per-country footnote. Recorded rather than hidden:
    // a report spanning two jurisdictions has more than one statutory version behind it.
    const firstResolved = countries.map((c) => rulesByCountry.get(c)?.ruleset).find((r) => r) ?? null;

    // Current s.2 wages (basic + fixed allowance) — the ORP basis, same as prefillOvertimeFromAttendance.
    const comps = await tx
      .select({
        employmentId: compensation.employmentId,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
      })
      .from(compensation)
      .where(
        and(
          inArray(compensation.employmentId, empIds),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      );
    const wagesBy = new Map(comps.map((c) => [c.employmentId, r2(Number(c.basic) + Number(c.allowance ?? 0))]));

    // Per-day attendance rows (the rest-day ½/1-day rule is per-day, so aggregates would be wrong).
    const attRows = await tx
      .select({
        employmentId: attendance.employmentId,
        dayType: attendance.dayType,
        workedMinutes: attendance.workedMinutes,
        otMinutes: attendance.otMinutes,
      })
      .from(attendance)
      .where(
        and(
          inArray(attendance.employmentId, empIds),
          gte(attendance.attendanceDate, monthStart),
          lte(attendance.attendanceDate, monthEnd),
        ),
      );

    // OT provenance/approval per employee, from the correction workflow (ADR-0069): a decided OT correction in
    // the month ⇒ employee-requested; a pending OT correction ⇒ approval still outstanding.
    const corrections = await tx
      .select({
        employmentId: attendanceCorrection.employmentId,
        status: attendanceCorrection.status,
        requestedOtMinutes: attendanceCorrection.requestedOtMinutes,
      })
      .from(attendanceCorrection)
      .where(
        and(
          inArray(attendanceCorrection.employmentId, empIds),
          gte(attendanceCorrection.attendanceDate, monthStart),
          lte(attendanceCorrection.attendanceDate, monthEnd),
        ),
      );
    const hasRequestedOt = new Set<string>();
    const hasPendingOt = new Set<string>();
    for (const c of corrections) {
      if (c.requestedOtMinutes == null) continue;
      hasRequestedOt.add(c.employmentId);
      if (c.status === 'pending') hasPendingOt.add(c.employmentId);
    }

    type Agg = { worked: number; ot: { workday: number; rest: number; holiday: number } };
    const aggBy = new Map<string, Agg>();
    const daysBy = new Map<string, { dayType: 'workday' | 'rest_day' | 'holiday'; minutes: number }[]>();
    for (const row of attRows) {
      const agg = aggBy.get(row.employmentId) ?? { worked: 0, ot: { workday: 0, rest: 0, holiday: 0 } };
      agg.worked += row.workedMinutes ?? 0;
      const otMin = row.otMinutes ?? 0;
      const dayType = row.dayType ?? 'workday';
      if (dayType === 'rest_day') agg.ot.rest += otMin;
      else if (dayType === 'holiday') agg.ot.holiday += otMin;
      else agg.ot.workday += otMin;
      aggBy.set(row.employmentId, agg);
      if (otMin > 0) {
        const arr = daysBy.get(row.employmentId) ?? [];
        arr.push({ dayType, minutes: otMin });
        daysBy.set(row.employmentId, arr);
      }
    }

    const rows: OvertimeReportRow[] = emps.map((e) => {
      const agg = aggBy.get(e.employmentId) ?? { worked: 0, ot: { workday: 0, rest: 0, holiday: 0 } };
      const otMinutesTotal = agg.ot.workday + agg.ot.rest + agg.ot.holiday;
      const wages = wagesBy.get(e.employmentId);
      // THIS employee's jurisdiction, not the report's.
      const rules = rulesByCountry.get(e.country);
      const pack = rules?.pack;
      const ot = rules?.ruleset?.ot;
      const restMult = ot?.restDayExcessMultiplier ?? 2;
      const holidayMult = ot?.holidayExcessMultiplier ?? 3;
      const result =
        pack && wages != null
          ? pack.payroll.overtimePay({
              monthlyWages: wages,
              days: daysBy.get(e.employmentId) ?? [],
              wageCeiling: ot?.wageCeiling,
              restDayExcessMultiplier: restMult,
              holidayExcessMultiplier: holidayMult,
            })
          : null;
      const eligible = result?.eligible ?? false;
      const hasOt = otMinutesTotal > 0;
      return {
        employmentId: e.employmentId,
        name: e.name,
        employeeCode: e.employeeCode,
        // Normal working hours = worked minus OT (OT is over-and-above normal). Total = worked (already ex-OT).
        normalWorkingHours: minToHours(Math.max(0, agg.worked - otMinutesTotal)),
        totalWorkedHours: minToHours(agg.worked),
        totalOtHours: minToHours(otMinutesTotal),
        normalDayOtHours: minToHours(agg.ot.workday),
        restDayOtHours: minToHours(agg.ot.rest),
        publicHolidayOtHours: minToHours(agg.ot.holiday),
        // The workday rate is the EA s.60A statutory 1.5× (a higher per-employee policy multiplier is applied
        // downstream in payroll, not here); the two excess factors are the configured ruleset values.
        workdayMultiplier: 1.5,
        restDayExcessMultiplier: restMult,
        holidayExcessMultiplier: holidayMult,
        otAmount: result ? r2(result.total) : 0,
        // The company's own currency. Without it `otAmount` is a bare number that a reader — or a
        // spreadsheet — will happily add to another company's, and the export header used to assert 'RM'
        // for every row regardless of where the employee works.
        currency: e.currency,
        eligible,
        otSource: hasOt ? (hasRequestedOt.has(e.employmentId) ? 'requested' : 'system') : 'none',
        otApprovalStatus: hasOt ? (hasPendingOt.has(e.employmentId) ? 'pending' : 'approved') : 'none',
      };
    });

    return { month: p.month, statutoryVersion: firstResolved?.version ?? null, rows };
  });
}

/** English report column labels (export headers stay English by design, matching app/analytics/export). */
export const OVERTIME_REPORT_COLUMNS = [
  'Employee',
  'Employee code',
  'Normal working hours',
  'Total worked hours',
  'Total OT hours',
  'Normal day OT (h)',
  'Rest day OT (h)',
  'Public holiday OT (h)',
  'Workday rate',
  'Rest day excess rate',
  'Public holiday excess rate',
  // Not 'OT amount (RM)': that literal was false for any company not in Malaysia. The currency travels
  // in its own column so a mixed-currency export is visibly mixed rather than silently addable (D-9).
  'OT amount',
  'Currency',
  'Eligibility status',
  'OT source',
  'OT approval status',
] as const;

/** Serialize the structured report into the neutral ReportData shape for lib/report-export. */
export function overtimeReportToReportData(report: OvertimeReport): ReportData {
  const eligibility = (row: OvertimeReportRow) =>
    row.eligible ? 'Eligible' : 'Above ceiling — no OT pay';
  const sourceLabel: Record<OvertimeReportRow['otSource'], string> = {
    system: 'System-calculated',
    requested: 'Employee-requested',
    none: '—',
  };
  const approvalLabel: Record<OvertimeReportRow['otApprovalStatus'], string> = {
    approved: 'Approved',
    pending: 'Pending',
    none: '—',
  };
  return {
    title: `Overtime report — ${report.month}`,
    filename: `overtime-report_${report.month}`,
    columns: [...OVERTIME_REPORT_COLUMNS],
    rows: report.rows.map((r) => [
      r.name,
      r.employeeCode ?? '',
      r.normalWorkingHours,
      r.totalWorkedHours,
      r.totalOtHours,
      r.normalDayOtHours,
      r.restDayOtHours,
      r.publicHolidayOtHours,
      `${r.workdayMultiplier}x`,
      `${r.restDayExcessMultiplier}x`,
      `${r.holidayExcessMultiplier}x`,
      r.otAmount.toFixed(2),
      r.currency,
      eligibility(r),
      sourceLabel[r.otSource],
      approvalLabel[r.otApprovalStatus],
    ]),
  };
}

// ─────────────────────────── Daily attendance report (c440b365 gap-6) ───────────────────────────
// A per-day attendance view exposing the reporter's full field list (Branch, Position, Shift, Clock In/Out,
// Late Minutes, Early Out, Attendance Status, Clocking Location, Geofencing Status, Remarks, …) — the raw
// punch grid the OT summary omits. Pure READ (no DomainEvent — read-only surface, deliberate skip). Rows are
// keyed by field id for the custom-report registry to project. Company scope is enforced by the caller's
// scopeIds (already RLS-fenced); one month at a time.

const _toMin = (t: string | null): number | null => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const _hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

export type AttendanceDailyRow = Record<string, string | number | null>;

/** Build the per-day attendance grid for a month across the given companies. */
export async function attendanceDailyReport(
  ctx: SessionContext,
  p: { month: string; companyIds?: string[] },
): Promise<AttendanceDailyRow[]> {
  const base = await withTenant(ctx, async (tx) => {
    const monthStart = `${p.month}-01`;
    const [y, m] = p.month.split('-').map(Number);
    const monthEnd = `${p.month}-${String(daysInMonth(y, m)).padStart(2, '0')}`;

    // One attendance policy per company → work-end / late-after thresholds for late/early-out minutes.
    const policies = await tx
      .select({ companyId: attendancePolicy.companyId, lateAfter: attendancePolicy.lateAfter, workEnd: attendancePolicy.workEnd })
      .from(attendancePolicy);
    const polByCompany = new Map(policies.map((pp) => [pp.companyId, pp]));

    const rows = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        position: position.title,
        companyName: company.legalName,
        companyId: employment.companyId,
        departmentName: department.name,
        attendanceDate: attendance.attendanceDate,
        checkInAt: attendance.checkInAt,
        checkOutAt: attendance.checkOutAt,
        dayType: attendance.dayType,
        status: attendance.status,
        workedMinutes: attendance.workedMinutes,
        otMinutes: attendance.otMinutes,
        // 7c834696 stage 1 — the ENGINE's own lateness / early-out figures. This report has always had
        // both columns, but derived them from the COMPANY policy's late_after / work_end, which is simply
        // the wrong yardstick for anyone on a shift: a 22:00 night-shift worker was measured against a
        // 09:15 office threshold. Where the engine has stored a figure it wins; where it has not (every
        // row from before this release) the policy fallback below is unchanged.
        storedLateMinutes: attendance.lateMinutes,
        storedEarlyOutMinutes: attendance.earlyOutMinutes,
        remarks: attendance.remarks,
        geofenceStatus: attendance.checkInGeofenceStatus,
        // f9afd1ce rev 2 (r267) — the REPORT LABEL, when the site has one, else the name. This is the ONE
        // place the label is printed; the list, the profile and the clock screen keep the name. The
        // service stores NULL for a blank label, and nullif() keeps a '' written any other way from
        // printing as an empty cell (there is no CHECK on the column by design).
        clockingLocationName: sql<string | null>`coalesce(nullif(${clockingLocation.reportLabel}, ''), ${clockingLocation.name})`,
        // Replacement leave (TOIL, ADR-0033): at most one accrual per employee+worked-date (unique index),
        // so the left join cannot multiply rows. daysCredited = replacement-leave days banked for THIS day.
        toilDaysCredited: toilAccrual.daysCredited,
      })
      .from(attendance)
      .innerJoin(employment, eq(employment.id, attendance.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      // Current assignment (validTo/supersededAt null) → department + position.
      .leftJoin(
        assignment,
        and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo), isNull(assignment.supersededAt)),
      )
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .leftJoin(clockingLocation, eq(clockingLocation.id, attendance.checkInClockingLocationId))
      // 3fb1a611 (migration 0469): the unique index now covers UNREVERSED credits only, so a reversed credit
      // and its replacement can share a worked date. Excluding 'reversed' keeps this join at one row per day
      // and keeps a reversed (never-banked) credit out of the Replacement Leave column.
      .leftJoin(
        toilAccrual,
        and(
          eq(toilAccrual.employmentId, attendance.employmentId),
          eq(toilAccrual.workedDate, attendance.attendanceDate),
          sql`${toilAccrual.status} <> 'reversed'`,
        ),
      )
      .where(
        and(
          p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined,
          gte(attendance.attendanceDate, monthStart),
          lte(attendance.attendanceDate, monthEnd),
        ),
      )
      .orderBy(attendance.attendanceDate, person.fullName);

    return rows.map((r) => {
      const pol = polByCompany.get(r.companyId);
      const ci = _toMin(r.checkInAt);
      const co = _toMin(r.checkOutAt);
      const lateAfter = _toMin(pol?.lateAfter ?? null);
      const workEnd = _toMin(pol?.workEnd ?? null);
      const lateMinutes = ci != null && lateAfter != null && ci > lateAfter ? ci - lateAfter : 0;
      const earlyOut = co != null && workEnd != null && co < workEnd ? workEnd - co : 0;
      return {
        employmentId: r.employmentId,
        name: r.name,
        employeeCode: r.employeeCode ?? null,
        branch: r.companyName,
        department: r.departmentName ?? null,
        position: r.position,
        attendanceDate: r.attendanceDate,
        shift: r.dayType ?? null,
        clockIn: _hhmm(r.checkInAt),
        clockOut: _hhmm(r.checkOutAt),
        workingHours: r.workedMinutes == null ? null : r2(r.workedMinutes / 60),
        otHours: r.otMinutes == null ? null : r2(r.otMinutes / 60),
        lateMinutes: r.storedLateMinutes ?? lateMinutes,
        earlyOutMinutes: r.storedEarlyOutMinutes ?? earlyOut,
        attendanceStatus: r.status,
        clockingLocation: r.clockingLocationName ?? null,
        geofencingStatus: r.geofenceStatus ?? null,
        remarks: r.remarks ?? null,
        // Replacement leave (TOIL / leave-in-lieu): days credited for this specific worked date; null = none.
        replacementLeave: r.toilDaysCredited == null ? null : Number(r.toilDaysCredited),
      };
    });
  });

  // ── Attendance Allowance (c440b365 — reporter field) ─────────────────────────────────────────
  // The allowance engine (ADR-0072) is MONTHLY-only: qualification is decided per employee per MONTH
  // against the active policies' criteria, never per day. The closest correct per-day representation is
  // therefore the month's qualified allowance total repeated on each of the employee's day rows:
  //   • an amount ("120.00")  ⇒ the employee is in scope of ≥1 active policy and qualified for that total
  //   • "0.00"                ⇒ in scope but NOT qualified this month
  //   • null                  ⇒ no active attendance-allowance policy covers this employee.
  // Evaluation is the same pure read the admin evaluation screen uses (evaluateAllowancesForPeriod), run
  // in its own session-scoped tx — RLS-fenced like every other dataset read.
  const activePolicies = await withTenant(ctx, (tx) =>
    tx
      .select({ id: attendanceAllowancePolicy.id })
      .from(attendanceAllowancePolicy)
      .where(
        and(
          eq(attendanceAllowancePolicy.status, 'active'),
          isNull(attendanceAllowancePolicy.archivedAt),
          p.companyIds && p.companyIds.length
            ? inArray(attendanceAllowancePolicy.companyId, p.companyIds)
            : undefined,
        ),
      ),
  );
  const covered = new Set<string>();
  const qualifiedTotal = new Map<string, number>();
  for (const pol of activePolicies) {
    const ev = await evaluateAllowancesForPeriod(ctx, { policyId: pol.id, month: p.month });
    for (const r of ev.rows) {
      covered.add(r.employmentId);
      if (r.qualified) qualifiedTotal.set(r.employmentId, (qualifiedTotal.get(r.employmentId) ?? 0) + Number(r.amount));
    }
  }

  return base.map(({ employmentId, ...row }) => ({
    ...row,
    attendanceAllowance: covered.has(String(employmentId))
      ? (qualifiedTotal.get(String(employmentId)) ?? 0).toFixed(2)
      : null,
  }));
}

// ─────────────────────────── Performance reports (c440b365 gap fix) ───────────────────────────
// Flat, admin-facing tabular reads over the performance module (ADR-0013/0022) for the custom-report
// registry: one row per review (cycle + ratings + reviewer) and one row per goal (title/status/progress).
// PURE READS (no DomainEvent — read-only surfaces, deliberate skip). RLS on performance_review /
// performance_goal (can_see_employment) still fences the rows inside the session-scoped tx; company scope
// comes from the caller's scopeIds like every other dataset read.

const _d10 = (t: Date | null): string | null => (t ? t.toISOString().slice(0, 10) : null);

export type PerformanceReportRow = Record<string, string | number | null>;

/** One row per performance review: subject, cycle, statuses, ratings, reviewer, key dates. */
export async function performanceReviewReport(
  ctx: SessionContext,
  p: { companyIds?: string[] },
): Promise<PerformanceReportRow[]> {
  return withTenant(ctx, async (tx) => {
    const reviewerEmp = alias(employment, 'reviewer_emp');
    const reviewerPerson = alias(person, 'reviewer_person');
    const rows = await tx
      .select({
        employeeCode: employment.employeeCode,
        name: person.fullName,
        companyName: company.legalName,
        departmentName: department.name,
        positionTitle: position.title,
        cycleName: reviewCycle.name,
        cycleStatus: reviewCycle.status,
        periodStart: reviewCycle.periodStart,
        periodEnd: reviewCycle.periodEnd,
        reviewStatus: performanceReview.status,
        reviewerName: reviewerPerson.fullName,
        selfRating: performanceReview.selfRating,
        managerRating: performanceReview.managerRating,
        overallRating: performanceReview.overallRating,
        finalScore: performanceReview.finalScore,
        abcClass: performanceReview.abcClass,
        submittedAt: performanceReview.submittedAt,
        acknowledgedAt: performanceReview.acknowledgedAt,
      })
      .from(performanceReview)
      .innerJoin(reviewCycle, eq(reviewCycle.id, performanceReview.cycleId))
      .innerJoin(employment, eq(employment.id, performanceReview.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      // Current assignment (validTo/supersededAt null) → department + position.
      .leftJoin(
        assignment,
        and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo), isNull(assignment.supersededAt)),
      )
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .leftJoin(reviewerEmp, eq(reviewerEmp.id, performanceReview.reviewerEmploymentId))
      .leftJoin(reviewerPerson, eq(reviewerPerson.id, reviewerEmp.personId))
      .where(p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined)
      .orderBy(desc(reviewCycle.periodStart), person.fullName);
    return rows.map((r) => ({
      employeeCode: r.employeeCode ?? null,
      name: r.name,
      company: r.companyName,
      department: r.departmentName ?? null,
      position: r.positionTitle ?? null,
      cycleName: r.cycleName,
      cycleStatus: r.cycleStatus,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      reviewStatus: r.reviewStatus,
      reviewer: r.reviewerName ?? null,
      selfRating: r.selfRating,
      managerRating: r.managerRating,
      overallRating: r.overallRating,
      finalScore: r.finalScore == null ? null : Number(r.finalScore),
      abcClass: r.abcClass ?? null,
      submittedAt: _d10(r.submittedAt),
      acknowledgedAt: _d10(r.acknowledgedAt),
    }));
  });
}

/** One row per performance goal/OKR: owner, goal, approval + progress, cycle binding, due date. */
export async function performanceGoalReport(
  ctx: SessionContext,
  p: { companyIds?: string[] },
): Promise<PerformanceReportRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        employeeCode: employment.employeeCode,
        name: person.fullName,
        companyName: company.legalName,
        departmentName: department.name,
        title: performanceGoal.title,
        metric: performanceGoal.metric,
        target: performanceGoal.target,
        weight: performanceGoal.weight,
        progress: performanceGoal.progress,
        status: performanceGoal.status,
        approvalStatus: performanceGoal.approvalStatus,
        dueOn: performanceGoal.dueOn,
        cycleName: reviewCycle.name,
        updatedAt: performanceGoal.updatedAt,
      })
      .from(performanceGoal)
      .innerJoin(employment, eq(employment.id, performanceGoal.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(
        assignment,
        and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo), isNull(assignment.supersededAt)),
      )
      .leftJoin(department, eq(department.id, assignment.departmentId))
      // cycle_id nullable — a continuous goal has no cycle (renders null).
      .leftJoin(reviewCycle, eq(reviewCycle.id, performanceGoal.cycleId))
      .where(p.companyIds && p.companyIds.length ? inArray(employment.companyId, p.companyIds) : undefined)
      .orderBy(person.fullName, desc(performanceGoal.updatedAt));
    return rows.map((r) => ({
      employeeCode: r.employeeCode ?? null,
      name: r.name,
      company: r.companyName,
      department: r.departmentName ?? null,
      goalTitle: r.title,
      metric: r.metric ?? null,
      target: r.target ?? null,
      weight: r.weight == null ? null : Number(r.weight),
      progress: r.progress,
      goalStatus: r.status,
      approvalStatus: r.approvalStatus,
      dueOn: r.dueOn ?? null,
      cycleName: r.cycleName ?? null,
      updatedAt: _d10(r.updatedAt),
    }));
  });
}
