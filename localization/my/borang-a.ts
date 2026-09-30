/**
 * 9c8dad7a / 3aae0789 — BORANG A (KWSP monthly contribution form): the READ.
 *
 * Everything MY-specific and database-shaped lives here; the form's rules, its carry-forward pagination
 * and its text rendering are pure and live in `lib/borang-a.ts`; the drawing lives in `lib/borang-a-pdf.ts`
 * and the i-Akaun upload file in `lib/kwsp-borang-a-file.ts`. The split is not tidiness — it is what lets
 * the +1 dating rule be asserted without a database, and what keeps `app/` from importing this pack
 * directly (ADR-0080 D1: app/ reaches the pack only through core/reporting's `reportPreview`).
 *
 * ── NOTHING NEW IS STORED, AND NO MIGRATION IS NEEDED ─────────────────────────────────────────────
 * Every field this form needs already exists:
 *   • `company_statutory_my.epf_employer_no` — No. Rujukan Majikan, already shown as "EPF employer no."
 *     under Organization. MEASURED on production 2026-08-13: 3 of 8 rows populated, and one of those
 *     three is the literal `xx`.
 *   • `employee_statutory_my.epf_number` — No. Ahli. MEASURED: 9 of 33, and FOUR of those nine are
 *     `EPF9203030`-style values that no numeric upload field can carry (see the readiness note below).
 *   • `employee_statutory_my.ic_number` — No. Kad Pengenalan. MEASURED: 33 of 33, all exactly 12 digits.
 *   • `employment.employee_code` — the upload file's staff-number field. Not printed on the form.
 *   • `company_statutory_authority` for authority `epf` — the authorised-representative block at the foot
 *     of the form, with its own admin screen at app/admin/organization/[companyId]. MEASURED: ONE row
 *     across nine companies, carrying a signatory but no phone and no e-mail.
 * The reporter's own wording, "add an epf_reference_no column and an epf_member_no column", describes
 * fields that were already there under different names. No migration.
 *
 * ── UPAH IS THE WAGE EPF WAS CHARGED ON, TAKEN, NEVER RE-DERIVED AND NEVER GROSS PAY ──────────────
 * `payslip.statutory.bases` (stamped since r187, core/payroll.ts ~4376) carries `epf` (the normal-stream
 * base after exclusions and deduction reductions) and `epfAdditional` (the bonus/off-cycle stream). Upah
 * is their sum. The contributions are `statutory.epfEmployee` / `epfEmployer` exactly as the run produced
 * them, so the form always agrees with what was actually paid and a change to the KWSP table cannot make a
 * re-printed past month disagree with the month that was filed.
 *
 * ⚠️ r371 — UPAH IS THE MONTH'S WAGE ONCE, AND IS NOT SUMMED ACROSS THE MONTH'S RUNS. It used to be, and
 * in a month that held more than one run that overstated it by about a month's wage per extra run
 * (item d4f6848f). `bases.epf` is the WHOLE month's figure, re-derived from compensation on EVERY run and
 * identical on each of them, so summing it multiplies the month by the run count. The month's wage is now
 * resolved by `monthWagesFrom` (localization/my/statutory-month-wage.ts) — ONE derivation, shared with the
 * Borang 8A read and the PERKESO upload-file read, taking the greatest `run_seq`. THE CONTRIBUTIONS BELOW
 * ARE STILL SUMMED and their figures did not move: they are deltas (ADR-0024) and summing them is correct.
 *
 * ⚠️ 61 OF 121 PRODUCTION PAYSLIPS PREDATE THAT STAMP. There is no fallback to gross pay and there must
 * not be: gross includes overtime, which EPF excludes, so a "close enough" wage would under- or
 * over-report a statutory figure. Such a row is marked `wageRecorded: false`, named on the review screen,
 * and BLOCKS the downloads exactly like a missing member number. "We do not know" is a different
 * statement from "it was zero", and only one of them may be printed.
 *
 * ── THE +1 RULE LIVES IN lib/borang-a.ts AND NOWHERE ELSE ─────────────────────────────────────────
 * There is exactly one call to `epfContributionPeriodFor` in this file and no other month arithmetic, so
 * the rule cannot be quietly copied from the Borang 8A module, whose rule is the opposite. Both halves are
 * pinned by source-shape assertions in test/borang-a.test.ts.
 *
 * ── THE ROWS ARE NOT FILTERED BY READINESS ────────────────────────────────────────────────────────
 * Everybody the run paid is returned, including the people who cannot yet appear on a filed form. The
 * review screen has to NAME them, which it cannot do if the read has already dropped them; the gate lives
 * in `app/payroll/borang-a/shared.ts` and refuses the DOCUMENT, not the preview. Anyone who left before
 * the cycle simply has no payslip in it and is therefore already absent (the form's own note 3).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import {
  assignment,
  company,
  companyStatutoryAuthority,
  companyStatutoryMy,
  employeeStatutoryMy,
  employment,
  payrollBatch,
  payslip,
  person,
  position,
} from '../../db/schema';
import {
  contributionMonthCode,
  contributionMonthLabel,
  epfContributionPeriodFor,
  formDate,
  type BorangARow,
} from '../../lib/borang-a';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { MY_STATUTORY_VERSION } from './statutory-tables';
// r371 — the month's wage, once, for all three statutory read paths. See that module's header for why
// summing `bases` across the month's runs was wrong and why the per-payslip stamp is not touched.
import { EPF_WAGE_INCONSISTENT_REASON, monthWageFor, monthWagesFrom } from './statutory-month-wage';
import type { ReportColumn, ReportResult, ReportRow, ReportParams } from './reports';

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown) => Number(v ?? 0);

/** The form's own columns, in the specimen's own order. `Bil` is the printed row number, not a field. */
export const BORANG_A_COLUMNS: ReportColumn[] = [
  { key: 'memberNo', label: 'No. Ahli' },
  { key: 'ic', label: 'No. Kad Pengenalan' },
  { key: 'name', label: 'Nama Pekerja' },
  { key: 'wage', label: 'Upah (RM)', numeric: true },
  { key: 'employer', label: 'Caruman Majikan (RM)', numeric: true },
  { key: 'employee', label: 'Caruman Pekerja (RM)', numeric: true },
];

const NOTE_NOT_ARTWORK =
  'This is our own layout, drawn to match a completed Borang A. KWSP does not publish a blank Borang A ' +
  'to print onto, so this is not the agency’s own page — check it before you file it.';
const NOTE_PLUS_ONE =
  'The contribution month is the payroll month PLUS ONE, which is note 6 printed on the form itself. ' +
  '(The PERKESO Borang 8A for the same payroll month is stamped that month, with no shift — the two ' +
  'rules are different on purpose.) You can change the month; we warn you and still let you through.';
const NOTE_WAGE =
  'Upah is the wage EPF was actually charged on — basic plus the EPF-liable allowances, commission and ' +
  'bonus, never gross pay and never a fresh calculation. It is the month’s wage ONCE, whatever number of ' +
  'payroll runs the month held. A payroll run from before this figure was recorded shows the person as ' +
  'not ready rather than borrowing gross pay.';

/** Employer address as printed: three free lines plus a postcode/town, state tail. */
function addressLines(c: {
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
 * The Borang A for a company's payroll month, as the generic `ReportResult` every statutory-form surface
 * already speaks — the same reason `borang8AReport` returns one: the shelf card, the [formId] preview
 * screen, the readiness banner, the exports and "Record generation" are all driven off this one shape
 * through `core/reporting.ts`, which is also the ONLY seam `app/` may reach the pack through.
 *
 * `params.periodKey` IS THE PAYROLL MONTH, always. The contribution month is derived from it here and may
 * be overridden downstream on the form (`withContributionPeriod`) — the pack never learns about the
 * operator's per-generation inputs, so `ReportParams` is untouched.
 */
export function borangAReport(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  // Throws on a malformed period rather than reading it as a literal batch key — "2026-13" would
  // otherwise produce a plausible-looking EMPTY form stamped with nonsense.
  const contributionPeriodKey = epfContributionPeriodFor(params.periodKey);
  // Annotated, not inferred: the no-batch branch returns `totals: {}`, which infers as
  // `{ wage?: undefined }` and stops being assignable to `Record<string, number>`.
  return withTenant(ctx, async (tx): Promise<ReportResult> => {
    const [co] = await tx
      .select({
        legalName: company.legalName,
        addressLine1: company.addressLine1,
        addressLine2: company.addressLine2,
        addressLine3: company.addressLine3,
        postcode: company.postcode,
        city: company.city,
        state: company.state,
      })
      .from(company)
      .where(eq(company.id, params.companyId))
      .limit(1);
    const [stat] = await tx
      .select({ epfRef: companyStatutoryMy.epfEmployerNo })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, params.companyId))
      .limit(1);
    // The authorised-representative block. `authority = 'epf'` is the row the Organization screen already
    // maintains; a company with no row simply has an empty block, which the form leaves blank rather than
    // filling with somebody plausible.
    const [auth] = await tx
      .select({
        phone: companyStatutoryAuthority.phone,
        email: companyStatutoryAuthority.email,
        signatoryPersonId: companyStatutoryAuthority.signatoryPersonId,
      })
      .from(companyStatutoryAuthority)
      .where(
        and(
          eq(companyStatutoryAuthority.companyId, params.companyId),
          eq(companyStatutoryAuthority.authority, 'epf'),
        ),
      )
      .limit(1);

    let repName = '';
    let repIc = '';
    let repPosition = '';
    if (auth?.signatoryPersonId) {
      const [rep] = await tx
        .select({ name: person.fullName, ic: employeeStatutoryMy.icNumber, title: position.title })
        .from(person)
        .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, person.id))
        // The signatory's CURRENT assignment (valid_to null) is where their Jawatan comes from. LEFT
        // joined throughout: a signatory who is not an employee of this company still prints their name.
        .leftJoin(
          employment,
          and(eq(employment.personId, person.id), eq(employment.companyId, params.companyId)),
        )
        .leftJoin(
          assignment,
          and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo)),
        )
        .leftJoin(position, eq(position.id, assignment.positionId))
        .where(eq(person.id, auth.signatoryPersonId))
        .limit(1);
      repName = rep?.name ?? '';
      repIc = rep?.ic ?? '';
      repPosition = rep?.title ?? '';
    }

    const header: Record<string, string> = {
      employerRef: stat?.epfRef ?? '',
      employerName: co?.legalName ?? '',
      // Scalar, because ReportResult.meta values are scalars; lib/borang-a.ts splits it back into lines.
      employerAddress: co ? addressLines(co).join('\n') : '',
      contributionMonth: contributionMonthLabel(contributionPeriodKey),
      contributionMonthCode: contributionMonthCode(contributionPeriodKey),
      contributionPeriodKey,
      payrollPeriodKey: params.periodKey,
      // Tarikh DiCetak — the generation date, which is what the specimen's box holds.
      printedOn: formDate(todayInKualaLumpur()),
      repName,
      repIc,
      repPosition,
      repPhone: auth?.phone ?? '',
      repEmail: auth?.email ?? '',
    };

    const batches = await tx
      .select({ id: payrollBatch.id, status: payrollBatch.status, runSeq: payrollBatch.runSeq })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, params.companyId), eq(payrollBatch.payPeriod, params.periodKey)));

    const baseMeta = {
      statutoryVersion: MY_STATUTORY_VERSION,
      formHeader: header,
      notes: [NOTE_NOT_ARTWORK, NOTE_PLUS_ONE, NOTE_WAGE],
    };
    if (batches.length === 0) {
      return { columns: BORANG_A_COLUMNS, rows: [], totals: {}, readiness: [], meta: { hasBatch: false, ...baseMeta } };
    }
    const batchIds = batches.map((b) => b.id);
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
        memberNo: employeeStatutoryMy.epfNumber,
        staffNo: employment.employeeCode,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
        // r371 — WHICH RUN OF THE MONTH WROTE THIS PAYSLIP. Joined rather than mapped off `batches` so the
        // pairing is an invariant of the query and cannot acquire a "?? 1" fallback that silently decides
        // a wage. `run_seq` is NOT NULL DEFAULT 1 and unique per (pay_period_id, run_seq).
        runSeq: payrollBatch.runSeq,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(inArray(payslip.batchId, batchIds))
      .orderBy(person.fullName);

    // THE MONTH'S WAGE, ONCE. Resolved BEFORE the accumulation loop and from the whole month at once,
    // because "which run stamped the wage we print" is a property of the month and not of a row the loop
    // happens to be standing on. The fold is order-independent, so the `orderBy` above is presentation.
    const monthWages = monthWagesFrom(
      slips.map((s) => ({ employmentId: s.employmentId, runSeq: s.runSeq, statutory: s.statutory })),
    );

    type Acc = {
      employmentId: string;
      name: string;
      ic: string | null;
      memberNo: string | null;
      staffNo: string | null;
      /**
       * UPAH — the month's EPF wage ONCE (`bases.epf + bases.epfAdditional` from the month's greatest
       * `run_seq`), NOT a sum across the runs. Set when the employee is first seen, from the whole-month
       * derivation above, so no branch of this loop can add a second month to it. r371 / item d4f6848f.
       */
      wage: number;
      employer: number;
      employee: number;
      /** False as soon as ONE slip in the month carried no `bases` — the month's wage is then incomplete. */
      wageRecorded: boolean;
      /**
       * r371 — the month's runs were charged on DIFFERENT EPF wages (a mid-month change), so no single
       * Upah is the month's wage. Named on the review screen and the document is HELD; see the readiness
       * list below. Printing whichever run happened to be last would be a figure nobody can stand behind.
       */
      wageInconsistent: boolean;
      /** Gross across the month. Carried for the reconciliation strip ONLY; never used as a wage. */
      gross: number;
    };
    const byEmp = new Map<string, Acc>();
    const versions = new Set<string>();
    // Summed straight off the payslips, INDEPENDENTLY of the per-employee aggregation below, so the
    // reconciliation strip compares two different paths to the same number rather than printing one number
    // twice. A divergence means the grouping dropped or double-counted somebody.
    let runEpf = 0;
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Record<string, unknown> & { version?: string };
      if (st.version) versions.add(st.version);
      runEpf = round2(runEpf + num(st.epfEmployee) + num(st.epfEmployer));
      let r = byEmp.get(s.employmentId);
      if (!r) {
        const w = monthWageFor(monthWages, s.employmentId);
        r = {
          employmentId: s.employmentId,
          name: s.name,
          ic: s.ic,
          memberNo: s.memberNo,
          staffNo: s.staffNo,
          // THE WAGE IS ASSIGNED ONCE, HERE, AND NEVER ACCUMULATED. See the Acc comment above.
          wage: w.epf,
          employer: 0,
          employee: 0,
          wageRecorded: w.epfRecorded,
          wageInconsistent: w.epfInconsistent,
          gross: 0,
        };
        byEmp.set(s.employmentId, r);
      }
      // Summed across the period's runs (ADR-0024: a month may hold a regular plus an off-cycle run, and
      // the statutory legs are deltas), so this is the month's true figure and is identical to the single
      // stored value when there is only one run.
      r.employer = round2(r.employer + num(st.epfEmployer));
      r.employee = round2(r.employee + num(st.epfEmployee));
      r.gross = round2(r.gross + num(s.gross));
      // NOTHING TOUCHES `r.wage` HERE, AND THAT IS THE ROUND (r371 / item d4f6848f). `bases.epf` is the
      // normal stream and `bases.epfAdditional` the bonus/off-cycle one, both already net of the EPF
      // exclusions — and `bases.epf` is the WHOLE MONTH'S figure on every run of the month, so adding it
      // up here put one extra month in the Upah column per extra run. The month's wage, and whether it is
      // recorded and self-consistent, are resolved once by `monthWagesFrom` and read in at `byEmp` init.
      // A slip with no `bases` object at all predates r187 and makes the month's wage unknown for this
      // person — ONE such slip is enough, and that rule is preserved inside the derivation.
    }

    const accs = [...byEmp.values()].sort((a, b) => a.name.localeCompare(b.name));
    const rows: ReportRow[] = accs.map((a) => {
      const row: BorangARow = {
        employmentId: a.employmentId,
        memberNo: a.memberNo ?? '',
        ic: a.ic ?? '',
        name: a.name,
        staffNo: a.staffNo ?? '',
        // A row whose basis was never recorded reports ZERO here and says so through `wageRecorded`.
        // It is never allowed onto a document; see the block comment at the top of this file.
        wage: a.wageRecorded ? a.wage : 0,
        employer: a.employer,
        employee: a.employee,
        wageRecorded: a.wageRecorded,
      };
      // ReportRow is Record<string, string | number | null>, so the boolean crosses as 'yes'/''.
      // `borangAFrom` reads it back by VALUE ('yes'), never by presence — a key that is always present
      // would read an unrecorded basis as recorded, which is the trap that shipped an unturnoffable pay
      // setting once already.
      return { ...row, wageRecorded: row.wageRecorded ? 'yes' : '' };
    });

    const totalWage = round2(rows.reduce((acc, r) => acc + num(r.wage), 0));
    const totalEmployer = round2(rows.reduce((acc, r) => acc + num(r.employer), 0));
    const totalEmployee = round2(rows.reduce((acc, r) => acc + num(r.employee), 0));
    const totalGross = round2(accs.reduce((acc, a) => acc + a.gross, 0));

    return {
      columns: BORANG_A_COLUMNS,
      rows,
      totals: { wage: totalWage, employer: totalEmployer, employee: totalEmployee },
      // THE FOUR THINGS A ROW CANNOT GO ON A FILED FORM WITHOUT. Named before the download, not
      // discovered after it. Sorted so the list reads the same way twice.
      //
      // r371 ADDED THE FOURTH, AND IT IS NOT AN ABSENCE. The first three are things we do not have; the
      // fourth is a month whose own runs disagree about the wage, where we have TWO figures and neither is
      // the month's. The existing gate (app/payroll/borang-a/shared.ts) blocks the PDF, the text export and
      // the i-Akaun file on ANY entry in this list, so naming it here is what holds the document — and the
      // review screen still renders the table, which is the only way the person gets named at all.
      readiness: accs
        .map((a) => ({
          employmentId: a.employmentId,
          name: a.name,
          missing: [
            !a.memberNo ? 'EPF member no.' : null,
            !a.ic ? 'IC' : null,
            !a.wageRecorded ? 'EPF wage basis (this run predates the record of what EPF was charged on)' : null,
            a.wageInconsistent ? EPF_WAGE_INCONSISTENT_REASON : null,
          ].filter((m): m is string => m !== null),
        }))
        .filter((r) => r.missing.length > 0),
      meta: {
        hasBatch: true,
        batchStatus,
        statutoryVersion: versions.size ? [...versions].sort().join(',') : MY_STATUTORY_VERSION,
        formHeader: header,
        notes: [NOTE_NOT_ARTWORK, NOTE_PLUS_ONE, NOTE_WAGE],
        // THE RECONCILIATION STRIP: the run's own EPF total beside the form's, and the gross the form
        // deliberately does NOT use, so the difference between Upah and gross is visible rather than
        // arguable. Any divergence shows up BEFORE filing rather than at KWSP.
        summary: [
          { label: 'Amaun Caruman (form)', value: round2(totalEmployer + totalEmployee).toFixed(2) },
          { label: 'EPF in this run (EE+ER)', value: runEpf.toFixed(2) },
          { label: 'Upah — the EPF-liable wage', value: totalWage.toFixed(2) },
          { label: 'Gross pay — NOT what the form uses', value: totalGross.toFixed(2) },
        ],
      },
    };
  });
}
