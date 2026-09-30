/**
 * 8ca344bf — BORANG 8A (PERKESO monthly contribution schedule): the READ.
 *
 * Everything MY-specific and database-shaped lives here; the form's rules, its pagination and its text
 * rendering are pure and live in `lib/borang-8a.ts`; the drawing lives in `lib/borang-8a-pdf.ts`. The
 * split is not tidiness — it is what lets the two dating rules be asserted without a database, and what
 * keeps `app/` from importing this pack directly (ADR-0080 D1: app/ reaches the pack only through
 * core/reporting's `reportPreview`, never through this file).
 *
 * ── NOTHING NEW IS STORED, AND NO MIGRATION IS NEEDED ─────────────────────────────────────────────
 * Every field this form needs already exists:
 *   • `company_statutory_my.socso_employer_code` — No. Kod Majikan, already labelled "SOCSO employer code"
 *     under Organization.
 *   • `company_statutory_my.ssm_registration_no` — the MyCoID box. REUSED, not duplicated: it is already
 *     what feeds the ASSIST upload file's ssm/MyCoID field (localization/my/socso-eis-file.ts ~line 140).
 *     Adding a `mycoid_no` column beside it would give one number two homes that can disagree.
 *   • `employee_statutory_my.ic_number` — column (3), and the only per-employee field this form needs.
 *   • `employment.join_date` / `hired_on` / `terminated_on` — column (1).
 * `socso_status_code` is the one field that genuinely does not exist, and it is deliberately NOT added.
 * See THE STATUS COLUMN below.
 *
 * ── THE CONTRIBUTION FIGURE IS TAKEN, NEVER RECALCULATED ──────────────────────────────────────────
 * `statutory.socsoEmployee + statutory.socsoEmployer`, off the payslips the run already produced. The form
 * therefore always agrees with what was actually paid, and a change to the PERKESO bands cannot make a
 * re-printed past month disagree with the month that was filed.
 *
 * ⚠️ r372 — THE SALARY BASE IS THE MONTH'S WAGE ONCE, AND IS NOT SUMMED ACROSS THE MONTH'S RUNS. It used
 * to be, and in a month that held more than one run that overstated it by about a month's wage per extra
 * run (item d4f6848f). `bases.socsoEis` is the WHOLE month's figure, re-derived on EVERY run and identical
 * on each of them, so summing it multiplies the month by the run count. It is now resolved by
 * `monthWagesFrom` (localization/my/statutory-month-wage.ts) — ONE derivation, shared with the Borang A
 * read and with the PERKESO upload-file read, taking the greatest `run_seq`. THE CONTRIBUTIONS ARE STILL
 * SUMMED and none of their figures moved: they are deltas (ADR-0024) and summing them is correct. Nothing
 * printed on the paper Borang 8A changed at all — the salary base has no column on it and rides here only
 * for the PERKESO ASSIST upload file.
 *
 * EIS IS NOT FOLDED IN. Employment insurance is its own PERKESO filing (Borang SIP), and adding it to this
 * column would inflate every line against the payroll it is supposed to reconcile to. SKBBK / Lindung 24
 * Jam is likewise excluded and, because that is a judgement somebody may want to revisit, both figures are
 * carried onto the preview beside the form total rather than dropped silently (`meta.summary`).
 *
 * ⚠️ THE SPECIMEN IS NOT AN ARITHMETIC FIXTURE. Its 202.35 does not reconcile to the EPF specimen's 6,200
 * wage under the current PERKESO table on either a SOCSO-only or a SOCSO+EIS reading. It was used for the
 * LAYOUT and the two dating rules, and for nothing else.
 *
 * ── THE STATUS COLUMN ─────────────────────────────────────────────────────────────────────────────
 * PERKESO's official code list for column (2) is not in the specimen, and we are not inventing one. The
 * reporter's own attachment leaves the column blank for a continuing employee and leaves Tarikh Mula /
 * Berhenti blank too. So: the dates are filled from the dates we already hold WHEN THEY FALL INSIDE THE
 * CONTRIBUTION MONTH, the status is blank for everyone who neither joined nor left, and the review screen
 * accepts a typed status per row which is never persisted. When PERKESO's list is confirmed, nothing here
 * has to be rebuilt.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import {
  company,
  companyStatutoryMy,
  employeeStatutoryMy,
  employment,
  payrollBatch,
  payslip,
  person,
} from '../../db/schema';
import {
  contributionMonthLabel,
  contributionPeriodFor,
  fallsInMonth,
  formDate,
  paymentDueDateFor,
  type Borang8ARow,
} from '../../lib/borang-8a';
import { MY_STATUTORY_VERSION } from './statutory-tables';
// r372 — the month's wage, once, for all three statutory read paths. See that module's header for why
// summing `bases` across the month's runs was wrong and why the per-payslip stamp is not touched.
import { SOCSO_WAGE_INCONSISTENT_REASON, monthWageFor, monthWagesFrom } from './statutory-month-wage';
import type { ReportColumn, ReportResult, ReportRow, ReportParams } from './reports';

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v ?? 0);

/** The schedule's own columns, in the specimen's own order and numbering. */
/**
 * The schedule's columns, in the agency form's own numbering and — since 16f2aac1 — its own full wording,
 * so a figures table and the drawn page cannot describe the same column differently.
 *
 * TWO DATE COLUMNS HERE, ONE ON THE FORM, AND THAT IS DELIBERATE. The drawn page merges (1) Mula and (1)
 * Berhenti into a single "TARIKH MULA/BERHENTI KERJA" cell because that is what the agency form does. A
 * TABLE is not a form: two sortable, separately-readable date columns are easier to check a month's
 * joiners and leavers against, which is the entire job of the review screen. They keep the same `(1)`
 * number as the form gives them, so the mapping stays obvious in both directions.
 */
export const BORANG_8A_COLUMNS: ReportColumn[] = [
  { key: 'startDate', label: '(1) Tarikh Mula Kerja (hhbbtttt)' },
  { key: 'stopDate', label: '(1) Tarikh Berhenti Kerja (hhbbtttt)' },
  { key: 'status', label: '(2) Status' },
  { key: 'ic', label: '(3) No. Kad Pengenalan' },
  { key: 'name', label: '(4) Nama Pekerja (Mengikut Kad Pengenalan)' },
  { key: 'contribution', label: '(5) Caruman (RM)', numeric: true },
];

const NOTE_NOT_ARTWORK =
  'This is our own layout, drawn line for line to match a completed Borang 8A. PERKESO does not publish ' +
  'a blank Borang 8A to print onto, so this is not the agency’s own page — check it before you file it.';
const NOTE_NO_OFFSET =
  'The contribution month is the payroll month itself, with no shift, and the payment deadline is the last ' +
  'day of that same month. (The EPF Borang A for the same payroll month is stamped the month after — the ' +
  'two rules are different on purpose.)';
const NOTE_STATUS =
  'Column (2) STATUS is left blank for anyone who neither joined nor left in the month, exactly as a filed ' +
  'Borang 8A does. Type a status against any row on the review screen if you need one.';

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
 * The Borang 8A for a company's payroll month, as the generic `ReportResult` every statutory-form surface
 * already speaks.
 *
 * WHY A ReportResult AND NOT A BESPOKE TYPE. The shelf card, the [formId] preview screen, the readiness
 * banner, the CSV/XLSX/PDF exports and "Record generation" are all driven off this one shape through
 * `core/reporting.ts` — which is also the ONLY seam `app/` is allowed to reach the pack through. The form's
 * own header (employer code, the two dates, MyCoID) has no column on a table, so it rides on
 * `meta.formHeader`, whose key list is owned by `lib/borang-8a.ts` (BORANG_8A_HEADER_KEYS) precisely so
 * the two halves of that contract can be pinned against one list.
 */
export function borang8AReport(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  // Throws on a malformed period rather than reading it as a literal batch key — "2026-13" would otherwise
  // produce a plausible-looking empty form.
  const periodKey = contributionPeriodFor(params.periodKey);
  // Annotated, not inferred: the no-batch branch returns `totals: {}`, which infers as
  // `{ contribution?: undefined }` and stops being assignable to `Record<string, number>`.
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
      .select({ code: companyStatutoryMy.socsoEmployerCode, ssm: companyStatutoryMy.ssmRegistrationNo })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, params.companyId))
      .limit(1);

    const header: Record<string, string> = {
      employerCode: stat?.code ?? '',
      mycoid: stat?.ssm ?? '',
      employerName: co?.legalName ?? '',
      // Scalar, because ReportResult.meta values are scalars; lib/borang-8a.ts splits it back into lines.
      employerAddress: co ? addressLines(co).join('\n') : '',
      contributionMonth: contributionMonthLabel(periodKey),
      contributionPeriodKey: periodKey,
      payrollPeriodKey: params.periodKey,
      paymentDueDate: paymentDueDateFor(periodKey),
    };

    const batches = await tx
      .select({ id: payrollBatch.id, status: payrollBatch.status, runSeq: payrollBatch.runSeq })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, params.companyId), eq(payrollBatch.payPeriod, periodKey)));

    const baseMeta = {
      statutoryVersion: MY_STATUTORY_VERSION,
      formHeader: header,
      notes: [NOTE_NOT_ARTWORK, NOTE_NO_OFFSET, NOTE_STATUS],
    };
    if (batches.length === 0) {
      return {
        columns: BORANG_8A_COLUMNS,
        rows: [],
        totals: {},
        readiness: [],
        meta: { hasBatch: false, ...baseMeta },
      };
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
        joinDate: employment.joinDate,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        statutory: payslip.statutory,
        // r372 — WHICH RUN OF THE MONTH WROTE THIS PAYSLIP. Joined rather than mapped off `batches` so the
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

    // THE MONTH'S SALARY BASE, ONCE. Resolved from the whole month BEFORE the accumulation loop, because
    // "which run stamped the wage the file carries" is a property of the month and not of a row the loop
    // happens to be standing on. The fold is order-independent, so the `orderBy` above is presentation.
    const monthWages = monthWagesFrom(
      slips.map((s) => ({ employmentId: s.employmentId, runSeq: s.runSeq, statutory: s.statutory })),
    );

    type Acc = {
      employmentId: string;
      name: string;
      ic: string | null;
      startIso: string | null;
      stopIso: string | null;
      socso: number;
      eis: number;
      skbbk: number;
      /**
       * 18c1d92b — THE FOUR LEGS, KEPT APART. The printed Borang 8A carries ONE combined figure per
       * employee (column 5) and this read has always added the pairs before anybody downstream saw them.
       * The PERKESO ASSIST upload file has a separate six-character box for each of the four, so the
       * paper form's sum is not enough. Same payslip figures, not re-derived — only not collapsed.
       */
      socsoEmployer: number;
      socsoEmployee: number;
      eisEmployer: number;
      eisEmployee: number;
      /**
       * The SOCSO/EIS WAGE the contributions were worked out from (`statutory.bases.socsoEis`) — the
       * MONTH'S figure ONCE, from the month's greatest `run_seq`, NOT a sum across the runs. r372 / item
       * d4f6848f: it used to be summed like the contributions beside it, and because the base is the whole
       * month's figure on every run of the month that put one extra month in the salary box per extra run.
       *
       * ⚠️ NULL WHEN NO RUN IN THE PERIOD STAMPED A BASE. `bases` arrived in r187 and 34 of the 109
       * payslips on production predate it. The upload file has a mandatory salary box, so a missing base
       * must REFUSE the file for that employee by name — never fall back to gross pay, which is a
       * different number, and never write zero, which asserts the employee earned nothing.
       */
      wage: number | null;
      /**
       * r372 — the month's runs were charged on DIFFERENT SOCSO/EIS wages (a mid-month change), so no
       * single salary figure is the month's. Named on the review screen and the document is HELD; see the
       * readiness list below. A `null` would be the wrong refusal: it says "no base was recorded", and
       * `lib/perkeso-socso-file.ts` words its message that way. Two bases WERE recorded; they disagree.
       */
      wageInconsistent: boolean;
    };
    const byEmp = new Map<string, Acc>();
    const versions = new Set<string>();
    // Summed straight off the payslips, INDEPENDENTLY of the per-employee aggregation below, so the
    // reconciliation strip compares two different paths to the same number rather than printing one
    // number twice. A divergence here means the grouping dropped or double-counted somebody.
    let runSocso = 0;
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Record<string, number> & { version?: string };
      if (st.version) versions.add(st.version);
      runSocso = round2(runSocso + num(st.socsoEmployee) + num(st.socsoEmployer));
      let r = byEmp.get(s.employmentId);
      if (!r) {
        const w = monthWageFor(monthWages, s.employmentId);
        r = {
          employmentId: s.employmentId,
          name: s.name,
          ic: s.ic,
          // The date they joined THIS employer, not the group service date — the same distinction Form E
          // Part A makes, and the one an entity transfer moves.
          startIso: s.joinDate ?? s.hiredOn,
          stopIso: s.terminatedOn,
          socso: 0,
          eis: 0,
          skbbk: 0,
          socsoEmployer: 0,
          socsoEmployee: 0,
          eisEmployer: 0,
          eisEmployee: 0,
          // THE WAGE IS ASSIGNED ONCE, HERE, AND NEVER ACCUMULATED. See the Acc comment above.
          wage: w.socsoEis,
          wageInconsistent: w.socsoEisInconsistent,
        };
        byEmp.set(s.employmentId, r);
      }
      // Summed across the period's runs (ADR-0024: a month may hold a regular plus an off-cycle run, and
      // the statutory legs are deltas), so this is the month's true figure and is identical to the single
      // stored value when there is only one run.
      r.socso = round2(r.socso + num(st.socsoEmployee) + num(st.socsoEmployer));
      r.eis = round2(r.eis + num(st.eisEmployee) + num(st.eisEmployer));
      r.skbbk = round2(r.skbbk + num(st.socsoSkbbk));
      // 18c1d92b — the same four numbers the two lines above add in pairs, kept apart for the upload
      // file. Deliberately summed from the SAME `st` in the SAME loop: a second pass over the slips
      // could drift from the paper form's total, and the two must always describe one month.
      r.socsoEmployer = round2(r.socsoEmployer + num(st.socsoEmployer));
      r.socsoEmployee = round2(r.socsoEmployee + num(st.socsoEmployee));
      r.eisEmployer = round2(r.eisEmployer + num(st.eisEmployer));
      r.eisEmployee = round2(r.eisEmployee + num(st.eisEmployee));
      // NOTHING TOUCHES `r.wage` HERE, AND THAT IS THE ROUND (r372 / item d4f6848f). `bases.socsoEis` is
      // the WHOLE MONTH'S figure on every run of the month, so adding it up put one extra month in the
      // salary box per extra run. Absent on EVERY run ⇒ still null, and the upload file still refuses this
      // employee by name; present on ANY run ⇒ the month's figure from the greatest `run_seq`. Both rules
      // live in `monthWagesFrom` and are read in at `byEmp` init above.
    }

    const accs = [...byEmp.values()].sort((a, b) => a.name.localeCompare(b.name));
    const rows: ReportRow[] = accs.map((a) => {
      // Filled ONLY when the event falls inside the contribution month — the specimen leaves both blank
      // for a continuing employee, and a joining date printed every month would read as a new joiner.
      const started = fallsInMonth(a.startIso, periodKey);
      const stopped = fallsInMonth(a.stopIso, periodKey);
      const row: Borang8ARow = {
        employmentId: a.employmentId,
        startDate: started ? formDate(a.startIso) : '',
        stopDate: stopped ? formDate(a.stopIso) : '',
        // Blank unless the review screen types one in. No code list is invented here.
        status: '',
        ic: a.ic ?? '',
        name: a.name,
        contribution: a.socso,
        socsoEmployer: a.socsoEmployer,
        socsoEmployee: a.socsoEmployee,
        eisEmployer: a.eisEmployer,
        eisEmployee: a.eisEmployee,
        wage: a.wage,
        // r296 — the same `a.skbbk` the reconciliation strip below totals, now also carried to the upload
        // file. Summed once, in the loop above, so the strip and the file can never describe two months.
        skbbk: a.skbbk,
      };
      return { ...row };
    });

    const total = round2(rows.reduce((acc, r) => acc + num(r.contribution), 0));
    const eisTotal = round2(accs.reduce((acc, a) => acc + a.eis, 0));
    const skbbkTotal = round2(accs.reduce((acc, a) => acc + a.skbbk, 0));

    return {
      columns: BORANG_8A_COLUMNS,
      rows,
      totals: { contribution: total },
      // WHAT STOPS A ROW GOING ON A FILED RETURN. Named before the download, not discovered after it.
      //
      // r372 ADDED THE SECOND REASON, AND IT IS NOT AN ABSENCE. The IC is something we do not have; an
      // inconsistent wage is a month whose own runs disagree, where we have TWO figures and neither is the
      // month's. The existing gate (app/payroll/borang-8a/shared.ts) blocks the PDF, the text export and
      // the PERKESO upload file on ANY entry in this list, so naming it here is what holds the document —
      // and the review screen still renders the table, which is the only way the person gets named.
      readiness: accs
        .map((a) => ({
          employmentId: a.employmentId,
          name: a.name,
          missing: [!a.ic ? 'IC' : null, a.wageInconsistent ? SOCSO_WAGE_INCONSISTENT_REASON : null].filter(
            (m): m is string => m !== null,
          ),
        }))
        .filter((r) => r.missing.length > 0),
      meta: {
        hasBatch: true,
        batchStatus,
        statutoryVersion: versions.size ? [...versions].sort().join(',') : MY_STATUTORY_VERSION,
        formHeader: header,
        notes: [NOTE_NOT_ARTWORK, NOTE_NO_OFFSET, NOTE_STATUS],
        // THE RECONCILIATION STRIP the build notes asked for: the run's own figures beside the form's, so
        // any divergence is visible BEFORE filing rather than at the counter. `Amaun Caruman` is the form
        // total; the two beneath it are what this form deliberately does not carry.
        summary: [
          { label: 'Amaun Caruman (form)', value: total.toFixed(2) },
          { label: 'SOCSO in this run (EE+ER)', value: runSocso.toFixed(2) },
          { label: 'EIS — filed separately', value: eisTotal.toFixed(2) },
          { label: 'SKBBK — not on this form', value: skbbkTotal.toFixed(2) },
        ],
      },
    };
  });
}
