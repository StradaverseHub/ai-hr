/**
 * r412 (item e74af58c, step 2) — BORANG 8B (PERKESO, under-paid contributions, PER. 44D): the READ.
 *
 * WHAT IT READS, AND ONLY THAT. The employer's header, from the same columns the Borang 8A read takes it
 * from (one home per fact): `company_statutory_my.socso_employer_code` (No. Kod Majikan),
 * `company_statutory_my.ssm_registration_no` (MyCoID), the company's legal name and address. And the
 * signatory block the 8B's guide asks for on every sheet ("Nama, tandatangan, no telefon dan cop majikan"):
 * the NAME and TELEPHONE from the company's `company_statutory_authority` row for `socso` — the record the
 * Organization screen maintains, read exactly as the Borang A read reads its `epf` row. No row ⇒ both
 * blank, never somebody plausible. The signature and stamp are the employer's by hand.
 *
 * WHAT IT DOES NOT READ: any payslip. An 8B pays SOCSO under-paid for an earlier month, and the system has
 * no such record — core/back-pay.ts charges arrears in the month they are actually paid. So there are no
 * rows, no totals and no readiness list: the employee lines are the employer's to fill (lib/borang-8b.ts).
 * `hasBatch: true` here means only "there is nothing to wait for" — the 8B is not drawn from a payroll run,
 * and a company with no run for the month can still owe for it.
 *
 * NO DEADLINE — PERKESO's own 8B sentence ends "…yang dilantik" with no date, so none is computed.
 */
import { and, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import { company, companyStatutoryAuthority, companyStatutoryMy, person } from '../../db/schema';
import { borang8BMonth } from '../../lib/borang-8b';
import { MY_STATUTORY_VERSION } from './statutory-tables';
import type { ReportColumn, ReportParams, ReportResult } from './reports';

/** The schedule's own columns — listed so the figures screen names them, though every line is blank. */
export const BORANG_8B_COLUMNS: ReportColumn[] = [
  { key: 'startDate', label: '(1) Tarikh Mula/Berhenti Kerja (hhbbtttt)' },
  { key: 'status', label: '(2) Status' },
  { key: 'ic', label: '(3) No. Kad Pengenalan' },
  { key: 'name', label: '(4) Nama Pekerja (Mengikut Kad Pengenalan)' },
  { key: 'contribution', label: '(5) Caruman (RM)', numeric: true },
];

const NOTE_BLANK =
  'Borang 8B opens with your company details and the month filled in. The employee lines and the under-paid ' +
  'amounts are left for you to fill in: when back pay is paid, the system charges SOCSO in the month it is ' +
  'actually paid, so it holds no record of an amount under-paid for an earlier month.';
const NOTE_LAYOUT =
  'This is our own drawing of PERKESO’s Borang 8B, box for box to the agency’s page 1, on a page of ours — not ' +
  'PERKESO’s own file. PERKESO’s 8B names no payment deadline, and neither does this.';

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

export function borang8BReport(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  // Throws on a malformed month rather than drawing a plausible one.
  const month = borang8BMonth(params.periodKey);
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
    const [auth] = await tx
      .select({ phone: companyStatutoryAuthority.phone, signatoryPersonId: companyStatutoryAuthority.signatoryPersonId })
      .from(companyStatutoryAuthority)
      .where(
        and(
          eq(companyStatutoryAuthority.companyId, params.companyId),
          eq(companyStatutoryAuthority.authority, 'socso'),
        ),
      )
      .limit(1);
    let signatoryName = '';
    if (auth?.signatoryPersonId) {
      const [rep] = await tx
        .select({ name: person.fullName })
        .from(person)
        .where(eq(person.id, auth.signatoryPersonId))
        .limit(1);
      signatoryName = rep?.name ?? '';
    }

    const header: Record<string, string> = {
      employerCode: stat?.code ?? '',
      mycoid: stat?.ssm ?? '',
      employerName: co?.legalName ?? '',
      employerAddress: co ? addressLines(co).join('\n') : '',
      contributionMonth: month.contributionMonth,
      contributionPeriodKey: month.contributionPeriodKey,
      signatoryName,
      signatoryPhone: auth?.phone ?? '',
    };
    return {
      columns: BORANG_8B_COLUMNS,
      rows: [],
      totals: {},
      readiness: [],
      meta: {
        hasBatch: true,
        statutoryVersion: MY_STATUTORY_VERSION,
        formHeader: header,
        notes: [NOTE_BLANK, NOTE_LAYOUT],
      },
    };
  });
}
