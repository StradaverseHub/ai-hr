/**
 * e0cd4583 — CP39 PRINTED FORM: the READ.
 *
 * Everything MY-specific and database-shaped lives here; the form's rules, its pagination and its text
 * rendering are pure and live in `lib/cp39-form.ts`; the drawing lives in `lib/cp39-form-pdf.ts`. The
 * split is not tidiness — it is what lets the dating rule be asserted without a database, and what keeps
 * `app/` from importing this pack directly (ADR-0080 D1: app/ reaches the pack only through
 * core/reporting's `reportPreview`).
 *
 * ── THIS ENRICHES THE EXISTING `my.cp39`, IT DOES NOT ADD A SECOND CARD ───────────────────────────
 * `cp39()` in `localization/my/reports.ts` already produces the figures table (Employee / Tax no / IC /
 * MTD) and already feeds the e-Data PCB upload file. A second catalogue entry would give the LHDN shelf
 * two CP39 cards with two readiness gates that could disagree about who is ready — the exact failure the
 * one-generator rule exists to stop. So this module supplies the EXTRA header and per-employee fields the
 * printed page needs, `cp39()` merges them, and `CP39_COLS` is untouched: the figures screen renders the
 * same four columns it always did, and the extra row keys are invisible to it and to the CSV/XLSX export
 * (both map `result.columns`, never `Object.keys(row)`).
 *
 * ── NOTHING NEW IS STORED, AND NO MIGRATION IS NEEDED ─────────────────────────────────────────────
 * Every field the printed form needs already exists:
 *   • `company_statutory_my.lhdn_employer_no` — No. Majikan, the employer "E" number. Already read by
 *     `cp39FileForBatch` for the e-Data file's header (`localization/my/cp39-file.ts:167`).
 *   • `company_statutory_my.ssm_registration_no` — No. Pendaftaran Perniagaan.
 *   • `company.legal_name` + the address columns — Nama dan Alamat Syarikat / Perniagaan.
 *   • `employee_statutory_my.tax_number` — No. Cukai Pendapatan. The reporter's ticket asks to ADD this
 *     field; it is already there, already editable on the profile (Identity & Tax card), and the e-Data
 *     file already reads it (`cp39-file.ts:178`). No new field, no data change.
 *   • `employee_statutory_my.ic_number` — No. K/P Baru. `employment.employee_code` — No. Pekerja.
 *     `employee_statutory_my.passport_number` — No. Pasport.
 *   • `company_statutory_authority` for authority `lhdn` — the preparer block's defaults.
 *
 * ⚠️ TWO COLUMNS ON THE FORM HAVE NO SOURCE AND ARE LEFT BLANK, WHICH IS WHAT THE PLAN WAS APPROVED
 * WITH. There is no old-identity-card column anywhere in the schema (No. K/P Lama), and the passport's
 * issuing country is stored as FREE TEXT from an international picker rather than the two-letter code
 * Kod Negara wants — with no name→ISO-2 helper in the repo to convert it. Guessing either onto a tax
 * document is worse than an empty box, and the e-Data PCB file already leaves both blank. They are
 * emitted as explicit empty strings rather than omitted so the printed column has something to render.
 *
 * ── THE PREPARER BLOCK DEFAULTS FROM THE COMPANY, NOT FROM WHOEVER IS LOGGED IN ───────────────────
 * The ticket asks for it to default from the logged-in HR user's profile. It defaults from
 * `company_statutory_authority` (authority `lhdn`) instead — the company-level record that already has
 * an admin screen under Organization, and the same source `borangAReport` uses for its authorised
 * representative. A statutory record whose named officer changes depending on who happened to press
 * Download is not a record, and the pack has no notion of the acting user's PERSON anyway. The four
 * fields remain editable per generation on the preview screen, which is the half of the request that
 * carries the actual value.
 *
 * ── THE ROWS ARE NOT FILTERED BY READINESS ────────────────────────────────────────────────────────
 * Everybody the run paid is returned, including people who cannot yet appear on a completed statement.
 * The review screen has to NAME them, which it cannot do if the read has already dropped them; the gate
 * lives in `app/payroll/cp39/shared.ts` and refuses the DOCUMENT, not the preview.
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
  person,
  position,
} from '../../db/schema';
import { cp39DeductionPeriodFor, deductionMonthLabel, formDate } from '../../lib/cp39-form';
import { todayInKualaLumpur } from '@/lib/hr-date';
import type { ReportParams } from './reports';

/**
 * What the CP39 card and the review screen both say about the printed page, in the operator's face
 * rather than in a tooltip.
 *
 * THE FIRST NOTE IS THE ONE THAT MATTERS AND IT IS NOT DECORATION. We hold no copy of the Borang CP39
 * (Pin.2015) artwork — `public/forms/` contains one file and it is the CP22 — so what comes out is our
 * layout of the agency's fields, and `my.cp39` keeps `fidelity: 'figures'` because of it. Overstating
 * that is precisely the failure the fidelity vocabulary exists to prevent.
 */
export const CP39_FORM_NOTES = [
  'The printed CP39 is OUR layout of the form’s fields, not LHDN’s own page — we hold no copy of the ' +
    'Borang CP39 (Pin.2015) artwork, and the agency’s printed A / B / C notes are not reproduced. ' +
    'Check every figure before you key or pay it.',
  'LHDN has not accepted a paper CP39 since September 2019. Use the printed form for your own records ' +
    'and as a payment cover document; the filing itself goes through e-PCB / e-Data PCB / e-CP39, which ' +
    'is the “Download e-Data PCB file” button on this screen.',
  'The deduction month is the payroll month itself, with no shift. (The EPF Borang A for the same ' +
    'payroll month is stamped one month LATER — the two rules are different on purpose.)',
];

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

/** The per-employee fields the FIGURES table has no column for and the printed page needs. */
export type Cp39FormRowExtras = {
  /**
   * WHO the row is. Not printed and not a column — it is what lets the printed form's duplicate
   * tax-number warning tell ONE PERSON'S TWO EMPLOYMENTS (same `person_id`, therefore the same
   * `employee_statutory_my.tax_number` by construction) from two people sharing one number. Without it
   * that warning accused a concurrently-employed person of being two people, twice by name.
   */
  personId: string;
  employeeNo: string;
  passport: string;
  /** Always ''. See the block comment above — no ISO-2 column exists and none is guessed. */
  countryCode: string;
  /** Always ''. See the block comment above — no old-identity-card column exists. */
  oldIc: string;
};

export type Cp39FormExtras = {
  /** Scalar strings, as `ReportResult.meta.formHeader` requires; the address is '\n'-joined. */
  header: Record<string, string>;
  byEmployment: Map<string, Cp39FormRowExtras>;
};

/**
 * The employer header and the per-employee extras for a company's payroll month.
 *
 * SEPARATE FROM `loadBatchRows` ON PURPOSE. That loader is shared by six reports; widening its SELECT to
 * carry a passport number and an employee code would put two more columns on every one of them for the
 * benefit of one. This is a second, narrow query keyed on the employment ids the batch already yielded.
 *
 * `params.periodKey` IS THE DEDUCTION MONTH, unshifted — `cp39DeductionPeriodFor` says so and validates
 * it, so `2026-13` throws here rather than producing a plausible-looking empty statement stamped with
 * nonsense.
 *
 * ⚠️ THAT THROW IS A BACKSTOP, NOT A SCREEN'S ERROR PATH, AND `cp39()` MUST KEEP CALLING IT AFTER ITS
 * `hasBatch` CHECK. Two screens hand `reportPreview` an unvalidated period with no try/catch around it —
 * `/payroll/reports` (a free-text period box that still holds "2026" when the report dropdown is switched
 * from an annual form) and `/payroll/statutory-forms/my.cp39` (which accepts `?periodKey=2026-13`). Both
 * have always degraded to the "No payroll run" card, because a period that cannot name a month cannot
 * name a batch; calling this before that branch turns both of them into a 500. See the ordering note in
 * `cp39()` (localization/my/reports.ts).
 */
export function cp39FormExtras(
  ctx: SessionContext,
  p: ReportParams & { employmentIds: string[] },
): Promise<Cp39FormExtras> {
  const deductionPeriodKey = cp39DeductionPeriodFor(p.periodKey);
  return withTenant(ctx, async (tx): Promise<Cp39FormExtras> => {
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
      .where(eq(company.id, p.companyId))
      .limit(1);
    const [stat] = await tx
      .select({
        employerNo: companyStatutoryMy.lhdnEmployerNo,
        registrationNo: companyStatutoryMy.ssmRegistrationNo,
      })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, p.companyId))
      .limit(1);
    // The preparer block's defaults. `authority = 'lhdn'` is the row the Organization screen already
    // maintains; a company with no row simply has an empty block, which the form leaves blank rather
    // than filling with somebody plausible.
    const [auth] = await tx
      .select({ phone: companyStatutoryAuthority.phone, signatoryPersonId: companyStatutoryAuthority.signatoryPersonId })
      .from(companyStatutoryAuthority)
      .where(
        and(eq(companyStatutoryAuthority.companyId, p.companyId), eq(companyStatutoryAuthority.authority, 'lhdn')),
      )
      .limit(1);

    let preparerName = '';
    let preparerIc = '';
    let preparerPosition = '';
    if (auth?.signatoryPersonId) {
      const [rep] = await tx
        .select({ name: person.fullName, ic: employeeStatutoryMy.icNumber, title: position.title })
        .from(person)
        .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, person.id))
        // The signatory's CURRENT assignment (valid_to null) is where their Jawatan comes from. LEFT
        // joined throughout: a signatory who is not an employee of this company still prints their name.
        .leftJoin(employment, and(eq(employment.personId, person.id), eq(employment.companyId, p.companyId)))
        .leftJoin(assignment, and(eq(assignment.employmentId, employment.id), isNull(assignment.validTo)))
        .leftJoin(position, eq(position.id, assignment.positionId))
        .where(eq(person.id, auth.signatoryPersonId))
        .limit(1);
      preparerName = rep?.name ?? '';
      preparerIc = rep?.ic ?? '';
      preparerPosition = rep?.title ?? '';
    }

    const header: Record<string, string> = {
      employerNo: stat?.employerNo ?? '',
      registrationNo: stat?.registrationNo ?? '',
      employerName: co?.legalName ?? '',
      // Scalar, because ReportResult.meta values are scalars; lib/cp39-form.ts splits it back into lines.
      employerAddress: co ? addressLines(co).join('\n') : '',
      deductionPeriodKey,
      deductionMonth: deductionMonthLabel(deductionPeriodKey),
      deductionMonthNo: deductionPeriodKey.slice(5, 7),
      deductionYear: deductionPeriodKey.slice(0, 4),
      // Tarikh — the generation date, in MALAYSIAN time. Never `new Date().toISOString()`: MYT is UTC+8,
      // so between 00:00 and 08:00 that yields YESTERDAY, and a statutory form would carry the wrong
      // printed date for a third of every day (r194's own defect, guarded by
      // test/today-in-myt-drift.test.ts).
      printedOn: formDate(todayInKualaLumpur()),
      preparerName,
      preparerIc,
      preparerPosition,
      preparerPhone: auth?.phone ?? '',
    };

    const byEmployment = new Map<string, Cp39FormRowExtras>();
    if (p.employmentIds.length > 0) {
      const rows = await tx
        .select({
          employmentId: employment.id,
          // The PERSON behind the employment — see `Cp39FormRowExtras.personId`. Already on the row
          // this query joins through, so it costs nothing.
          personId: employment.personId,
          employeeNo: employment.employeeCode,
          passport: employeeStatutoryMy.passportNumber,
          // e4b541c6 (migration 0450) — the two columns this file has carried as permanently empty since
          // it was written. They exist now; the block comment on Cp39FormRowExtras has been corrected.
          oldIc: employeeStatutoryMy.oldIcNumber,
          countryCode: employeeStatutoryMy.passportIssuingCountryCode,
        })
        .from(employment)
        .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
        .where(inArray(employment.id, p.employmentIds));
      for (const r of rows) {
        byEmployment.set(r.employmentId, {
          personId: r.personId,
          employeeNo: r.employeeNo ?? '',
          passport: r.passport ?? '',
          countryCode: r.countryCode ?? '',
          oldIc: r.oldIc ?? '',
        });
      }
    }

    return { header, byEmployment };
  });
}
