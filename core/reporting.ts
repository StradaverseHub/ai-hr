/**
 * Statutory reporting seam (ADR-0010). Generic over jurisdiction: it asks the localization pack for
 * its report registry, then lists / previews / records reports. Reports are derived from payroll, but
 * a recorded generation is persisted as an append-only `statutory_report` artefact + domain event
 * (audit / idempotency / reproducibility). Filed per legal entity — RLS gates on is_admin_for.
 */
import { and, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  assignment,
  attendance,
  attendanceAllowancePolicy,
  attendanceCorrection,
  attendancePolicy,
  clockingLocation,
  company,
  companyStatutoryMy,
  compensation,
  department,
  employeeDependent,
  employeeStatutoryMy,
  employment,
  employmentPayComponent,
  payComponent,
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
// Rung 5a (ADR-0080 D1): report/EA types come from the pack CONTRACT, never from localization/my.
import type {
  EaStatement,
  ReportDef,
  ReportResult,
  StatutoryFormLink,
} from '../localization/country-pack';
import type { ReportData } from '../lib/report-export';
// TYPE-ONLY, and that matters: lib/cp22-pdf.ts imports pdf-lib, and `import type` is erased at compile
// time so this read pulls no PDF machinery into every caller of core/reporting.
import type { Cp22PdfData } from '../lib/cp22-pdf';
import { daysInMonth } from './payroll';

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

/** Report definitions (metadata only) available for a company's jurisdiction. */
export async function listReports(ctx: SessionContext, companyId: string) {
  const country = await companyCountry(ctx, companyId);
  return reportsForCountry(country).map((r) => ({
    id: r.id,
    label: r.label,
    cadence: r.cadence,
    periodKind: r.periodKind,
    // 956cec85 — where this form is filed and by when, as the pack declares it. Absent for reports that
    // are not themselves a submission, which is how the Statutory Forms screen tells the two apart.
    // 6babf4f6 added `submission.body`, the shelf key — it rides through here untouched, so a newly
    // registered form lands in its authority's section with no change to this seam or to the screen.
    submission: r.submission ?? null,
  }));
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
  p: { companyId: string; reportId: string; periodKey: string },
): Promise<ReportResult> {
  const def = await resolveDef(ctx, p.companyId, p.reportId);
  return def.generate(ctx, { companyId: p.companyId, periodKey: p.periodKey });
}

/** Generate and RECORD a report: persist a statutory_report artefact + append a domain event. */
export async function recordReport(
  ctx: SessionContext,
  p: { companyId: string; reportId: string; periodKey: string },
) {
  const def = await resolveDef(ctx, p.companyId, p.reportId);
  const result = await def.generate(ctx, { companyId: p.companyId, periodKey: p.periodKey });
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

/**
 * Per-employee EA statement for a tax year, via the employment's jurisdiction pack. RLS scopes
 * visibility: an employee sees only their own (+ reports'); admins see their company scope.
 */
export async function employeeEaStatement(
  ctx: SessionContext,
  p: { employmentId: string; year: string; companyId?: string },
): Promise<EaStatement | null> {
  const country = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ country: company.country })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    return row?.country ?? null;
  });
  const pack = packFor(country);
  if (!pack) return null;
  return pack.eaStatement(ctx, p);
}

/** b7b22514 — the employers that owe this employee an EA form for the year, oldest first. Drives the
 *  employer switcher on the EA screen and the PDF route's `company` parameter. */
export async function employeeEaCompanies(
  ctx: SessionContext,
  p: { employmentId: string; year: string },
): Promise<{ companyId: string; name: string; isCurrent: boolean }[]> {
  const country = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ country: company.country })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    return row?.country ?? null;
  });
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
 */
export async function employeeEaStatements(
  ctx: SessionContext,
  p: { employmentId: string; year: string },
): Promise<EaStatement[]> {
  const country = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ country: company.country })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    return row?.country ?? null;
  });
  const pack = packFor(country);
  if (!pack) return [];
  const companies = await pack.eaCompaniesInYear(ctx, p);
  const out: EaStatement[] = [];
  for (const c of companies) {
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
  dueBy: string;
  status: 'overdue' | 'due_soon' | 'upcoming';
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
export function complianceWorklist(
  ctx: SessionContext,
  p: { companyId: string; today?: string },
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
        const dueBy = isoAddDays(e.terminatedOn, -30); // notify ≥30 days before cessation
        items.push({ employmentId: e.id, name: e.name, form: 'CP22A', reason: 'Cessation', eventDate: e.terminatedOn, dueBy, status: statusFor(today, dueBy) });
      }
    }
    const rank = { overdue: 0, due_soon: 1, upcoming: 2 };
    return items.sort((a, b) => rank[a.status] - rank[b.status] || a.dueBy.localeCompare(b.dueBy));
  });
}

// ── CP22 particulars (the new-hire notice itself, d3a9383c) ─────────────────
/**
 * Everything the CP22 (Pin. 1/2020) form can be filled from, for one employment.
 *
 * SITS BESIDE complianceWorklist DELIBERATELY: that read says WHO needs a CP22 and by when, this one
 * produces the document for a row of it, and they are gated identically — RLS decides whether the
 * employment is visible at all (a foreign id simply reads as absent, so this returns null rather than
 * throwing or leaking existence), and the company's pack decides whether the form applies at all. CP22 is
 * an LHDN form; a company no pack owns has no CP22 and gets null, exactly as the worklist gets [].
 *
 * NOTHING IS INVENTED. Every field is nullable end to end and an absent record travels as null all the way
 * to an EMPTY, still-editable box on the page (lib/cp22-pdf.ts documents the seven that can never be
 * filled). In particular: employeeDependent.companyName / employerAddress are the SPOUSE'S employer and are
 * NOT the form's "previous employer in Malaysia", so they are not read here at all.
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

/** Address parts → the lines an address block prints, blanks dropped. */
function addressLines(p: {
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
      .select({ fullName: employeeDependent.fullName, icOrPassport: employeeDependent.icOrPassport })
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

    // The signature block's name and designation, ONLY when the session resolves to a person who holds a
    // current assignment. SessionContext.personId is documented null for an admin not tied to an employee,
    // and there is no honest fallback — the company name is NOT a person's name. Blank is the right answer.
    let signatory: { name: string | null; designation: string | null } = { name: null, designation: null };
    if (ctx.personId) {
      const [me] = await tx
        .select({ name: person.fullName, title: position.title })
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
        .where(eq(person.id, ctx.personId))
        .limit(1);
      if (me) signatory = { name: me.name, designation: me.title ?? null };
    }

    const allowances: Cp22Particulars['pay']['allowances'] = [];
    if (comp && asMoney(comp.monthlyAllowance) > 0) {
      allowances.push({ label: CP22_FIXED_ALLOWANCE_LABEL, amount: asMoney(comp.monthlyAllowance) });
    }
    for (const r of recurring) allowances.push({ label: r.label || r.name, amount: asMoney(r.amount) });

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
        addressLines: addressLines({
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
        natureOfEmployment: current?.title ?? null,
        commencementDate: base.hiredOn,
        expectedDuration,
        residentialAddressLines: addressLines({
          line1: base.permLine1,
          line2: base.permLine2,
          line3: base.permLine3,
          postcode: base.permPostcode,
          city: base.permCity,
          state: base.permState,
        }),
        correspondenceAddressLines: addressLines({
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
      spouse: spouse ? { fullName: spouse.fullName, icOrPassport: spouse.icOrPassport ?? null } : null,
      pay: {
        monthlyFixedRemuneration: comp ? asMoney(comp.basicSalary) : null,
        allowances,
      },
      signatory,
      today,
    };
  });
}

/** Recently recorded report artefacts for a company (audit trail). */
export function recentReports(ctx: SessionContext, companyId: string) {
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
      })
      .from(statutoryReport)
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
        clockingLocationName: clockingLocation.name,
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
      .leftJoin(
        toilAccrual,
        and(eq(toilAccrual.employmentId, attendance.employmentId), eq(toilAccrual.workedDate, attendance.attendanceDate)),
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
