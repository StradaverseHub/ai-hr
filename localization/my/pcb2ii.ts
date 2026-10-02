/**
 * 72b100cd — the READ behind PCB 2(II): one employee, one year, twelve months of tax deducted and paid.
 *
 * ⚠️ THREE FACTS, THREE OWNERS, AND THIS FILE OWNS NONE OF THEM. That is the whole design:
 *
 *   1. WHICH MONTH A DEDUCTION BELONGS TO is `cp39DeductionPeriodFor` (lib/cp39-form.ts) — imported, not
 *      restated. Its own header warns what happens when somebody copies the EPF form's +1 rule over it:
 *      "a month's PCB is reported against the wrong period, on a page that looks entirely normal." CP39
 *      and PCB 2(II) report the SAME deductions to the SAME body, so a second dating rule here would let
 *      two of our own forms disagree about one month.
 *   2. HOW MUCH WAS DEDUCTED is `payslip.statutory.pcb` / `.cp38`, summed across the month's runs —
 *      the same two fields, read the same way, that `Cp39FormRow` documents.
 *   3. WHAT WAS PAID AND WHEN is `pcb_payment` (r321, migration 0476), through `pcbPaymentsForYear`.
 *      That table exists precisely because `statutory_report.ack_ref` is ONE acknowledgement for the
 *      RETURN, while this form wants a receipt per PAYMENT, split MTD/CP38, per month.
 *   4. WHICH EMPLOYER THE SHEET SPEAKS FOR is `companyId` — and r328 made every box about that employer
 *      come from that ONE company row. r323 read the E number, the months and the receipts from it and
 *      the NAME AND ADDRESS from the employment's CURRENT company, which is the same company for
 *      everybody who has never transferred and a different one for exactly the case the parameter exists
 *      for. See the block by `employerId` below, and `eaStatement`, which got this right first.
 *
 * ⚠️ AN ABSENT MONTH STAYS ABSENT ALL THE WAY THROUGH. A month with no payslip yields `null`, never 0 —
 * see lib/pcb2ii-form.ts on why an empty box and a zero are different statements to LHDN. This read must
 * not "helpfully" default, and the twelve-month skeleton is built from `emptyPcb2iiMonths()` so a month
 * that was never touched is structurally indistinguishable from one that was considered and found empty.
 *
 * SCOPE IS RLS's, NOT THIS FILE'S. Every read runs inside `withTenant`; an employment the caller may not
 * see simply is not found, and the caller gets null rather than a differently-worded refusal.
 */
import { and, eq, like, sql } from 'drizzle-orm';
import type { SessionContext } from '../../db/client';
import { withTenant } from '../../db/client';
import {
  company,
  companyStatutoryMy,
  companyStatutoryAuthority,
  employeeStatutoryMy,
  employment,
  payrollBatch,
  payslip,
  person,
} from '../../db/schema';
import { cp39DeductionPeriodFor } from '../../lib/cp39-form';
import { pcbPaymentsForYear } from '../../core/pcb-payment';
import {
  emptyPcb2iiMonths,
  pcb2iiTotals,
  Pcb2iiPreparationError,
  validPcb2iiSelectedDate,
  type Pcb2iiForm,
} from '../../lib/pcb2ii-form';

type Stat = { pcb?: unknown; cp38?: unknown };
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The employer block's address, one line, skipping the parts a company has not filled in. */
const addressOf = (c: {
  legalName: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
}): string =>
  [c.legalName, c.addressLine1, c.addressLine2, c.addressLine3, [c.postcode, c.city].filter(Boolean).join(' '), c.state]
    .map((s) => (s ?? '').trim())
    .filter((s) => s !== '')
    .join(', ');

/**
 * One employee's PCB 2(II) for one year, or null when the employment is not visible or does not exist.
 *
 * RETURNS A FORM EVEN WHEN NO TAX WAS DEDUCTED, and that is deliberate rather than an oversight: an
 * employee with twelve empty months is a legitimate statement (nothing was deducted, nothing is claimed),
 * and refusing to produce one would leave an operator unable to show LHDN exactly that. What the CALLER
 * must not do is offer the form for somebody with no payroll at all — see the screen, which takes its
 * population from the year's actual payslips for the same reason the EA screen does.
 */
export async function pcb2iiStatement(
  ctx: SessionContext,
  p: { employmentId: string; year: string; companyId?: string; selectedDate: string },
): Promise<Pcb2iiForm | null> {
  const year = Number(p.year);
  if (!/^\d{4}$/.test(p.year) || !Number.isFinite(year)) return null;

  return withTenant(ctx, async (tx) => {
    const [info] = await tx
      .select({
        name: person.fullName,
        ic: employeeStatutoryMy.icNumber,
        passport: employeeStatutoryMy.passportNumber,
        taxNo: employeeStatutoryMy.taxNumber,
        staffNo: employment.employeeCode,
        companyId: employment.companyId,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      // The employment's OWN company, joined but no longer SELECTED (r328). It stays because it is part of
      // this read's visibility: an employment whose company the caller cannot see has never resolved here,
      // and dropping the join would quietly widen that. The employer BLOCK is read separately, below.
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!info) return null;

    /**
     * ⚠️ r328 — THE EMPLOYER THIS FORM SPEAKS FOR, AND EVERY BOX ABOUT IT COMES FROM THAT ONE COMPANY.
     *
     * r323 read the E number from `employerId` and the NAME AND ADDRESS from the employment's CURRENT
     * company. Those are the same company for everyone who has never transferred, which is why it shipped
     * green — and they are different companies for exactly the case `companyId` was added for. Print
     * company A's PCB 2(II) for an employee who moved to B in July and the sheet carried A's employer
     * number, A's deducted months and **B's letterhead**: a statement of tax filed under a name that did
     * not deduct it. That is the same defect `eaStatement` names two files away ("a form carrying one
     * company's name and another's employer number is worse than either alone") — the EA got this right
     * and this form did not copy it.
     *
     * ONE ROW, so the name, the address and the E number cannot come from two places. No row — an employer
     * outside the caller's company scope, or an id that is not a company — is `null`, not a form with an
     * empty letterhead.
     */
    const employerId = p.companyId ?? info.companyId;
    const [employer] = await tx
      .select({
        legalName: company.legalName,
        addressLine1: company.addressLine1,
        addressLine2: company.addressLine2,
        addressLine3: company.addressLine3,
        city: company.city,
        state: company.state,
        postcode: company.postcode,
        eNumber: companyStatutoryMy.lhdnEmployerNo,
      })
      .from(company)
      .leftJoin(companyStatutoryMy, eq(companyStatutoryMy.companyId, company.id))
      .where(eq(company.id, employerId))
      .limit(1);
    if (!employer) return null;

    // THE YEAR'S PAYSLIPS FOR THIS EMPLOYMENT, at this employer. `like('YYYY-%')` is the same filter
    // `loadYearRows` uses; the batch's pay period is what the dating rule below consumes.
    const slips = await tx
      .select({ payPeriod: payrollBatch.payPeriod, statutory: payslip.statutory })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .where(
        and(
          eq(payslip.employmentId, p.employmentId),
          eq(payrollBatch.companyId, employerId),
          like(payrollBatch.payPeriod, `${p.year}-%`),
        ),
      );

    /**
     * ⚠️ r328 — AN EMPLOYER THAT NEVER EMPLOYED THIS PERSON GETS NO FORM AT ALL.
     *
     * `companyId` arrives from a URL. Before this check, ANY company the caller could reach produced a
     * statement: the employee's name, identity card number and tax number under that company's letterhead
     * and E number, with that company's PCB receipts beside twelve empty months — a document asserting a
     * relationship that does not exist, assembled out of two companies' facts.
     *
     * THE TEST IS THE TWO FACTS THIS READ ALREADY HAS, so it is not a third population to keep in step
     * with `eaCompaniesInYear`: an employer is legitimate when it is where the employment SITS, or when it
     * PAID this employment in the year. Anything else is `null`, which the routes turn into the same bare
     * 404 a malformed id gets — so the URL cannot be used to test which companies a person has worked for.
     *
     * An employment that currently sits here and has never been paid still gets its (empty) form: that is
     * a legitimate statement and this file's header says so.
     */
    if (employerId !== info.companyId && slips.length === 0) return null;

    if (!validPcb2iiSelectedDate(p.selectedDate)) throw new Pcb2iiPreparationError('selectedDate');
    // Reviewed 0499 contract: selected-company LHDN identity, tenant/company/subject/year fences and
    // only name/title output. This admin-only form is stricter than the existing self-or-admin helper.
    const officer = await tx.execute<{ officer_name: string | null; officer_position: string | null }>(
      sql`select * from app.ea_signatory(${p.employmentId}::uuid, ${employerId}::uuid, ${p.year})`,
    );
    const officerName = officer[0]?.officer_name?.trim();
    if (!officerName) throw new Pcb2iiPreparationError('signatory');
    const [authority] = await tx
      .select({ phone: companyStatutoryAuthority.phone })
      .from(companyStatutoryAuthority)
      .where(and(eq(companyStatutoryAuthority.companyId, employerId), eq(companyStatutoryAuthority.authority, 'lhdn')))
      .limit(1);

    const months = emptyPcb2iiMonths();
    for (const s of slips) {
      // THE DATING RULE, IMPORTED. It also VALIDATES: a malformed pay period throws here rather than
      // silently landing a month's tax in the wrong row of a tax form.
      const deductionPeriod = cp39DeductionPeriodFor(s.payPeriod);
      const idx = Number(deductionPeriod.slice(5, 7)) - 1;
      if (idx < 0 || idx > 11) continue;
      const st = (s.statutory ?? {}) as Stat;
      const pcb = num(st.pcb);
      const cp38 = num(st.cp38);
      const m = months[idx];
      // A payslip EXISTS for this month, so the month is no longer absent — its figure becomes a real
      // number, including a real 0.00 where a run genuinely deducted nothing. That is the one place a
      // zero is honest: somebody ran payroll and the answer was zero.
      m.mtd = round2((m.mtd ?? 0) + pcb);
      m.cp38 = round2((m.cp38 ?? 0) + cp38);
    }

    // WHAT WAS PAID, keyed by the operator (r321). A receipt with no payroll behind it still prints —
    // it is a fact somebody recorded, and hiding it would make the form disagree with the payment screen.
    const payments = await pcbPaymentsForYear(ctx, { companyId: employerId, year });
    for (const m of months) {
      const key = `${p.year}-${String(m.month).padStart(2, '0')}`;
      const mtd = payments.get(`${key}|mtd`);
      const cp38 = payments.get(`${key}|cp38`);
      if (mtd) {
        m.mtdReceiptRef = mtd.receiptRef;
        m.mtdPaidOn = mtd.paidOn;
      }
      if (cp38) {
        m.cp38ReceiptRef = cp38.receiptRef;
        m.cp38PaidOn = cp38.paidOn;
      }
    }

    return {
      year,
      printedOnIso: p.selectedDate,
      branch: '',
      employeeName: info.name,
      // The form's box is "New Identity Card No./Passport No." — one box, the IC when there is one.
      newIcOrPassport: (info.ic ?? '').trim() || (info.passport ?? '').trim(),
      employeeTaxNo: (info.taxNo ?? '').trim(),
      staffNo: (info.staffNo ?? '').trim(),
      employerNo: (employer.eNumber ?? '').trim(),
      months,
      // Section 3 — always empty; see lib/pcb2ii-form.ts for why this is a refusal and not a gap.
      priorYearRows: [],
      officerName,
      officerDesignation: officer[0]?.officer_position?.trim() ?? '',
      officerPhone: authority?.phone?.trim() ?? '',
      // r328 — the EMPLOYER's own row, not the employment's current company. See the block above.
      employerNameAddress: addressOf(employer),
    } satisfies Pcb2iiForm;
  });
}

/** Re-exported so a caller totals the form the same way the renderer does. */
export { pcb2iiTotals };
