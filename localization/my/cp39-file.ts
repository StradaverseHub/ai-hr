/**
 * CP39 / e-Data PCB submission text file (Layer-B, ADR-0010 §6D) — DRAFT, not for submission
 * until verified against the live e-PCB Plus portal.
 *
 * Source (verbatim): LHDN "Specification for MTD Calculations Using Computerized Calculation
 * for 2026", Exhibit 4 "Specification Format for MTD Text File Data" (pp. 43–44, incl. the
 * Exhibit-5 worked sample file). Full layout: docs/architecture/REPORT-FORMATS.md §1.
 *
 * Header (57 chars):  H | employerNo(HQ) 10N | employerNo 10N | year 4N | month 2N |
 *                     total MTD cents 10N | MTD records 5N | total CP38 cents 10N | CP38 records 5N
 * Detail (136 chars): D | TIN 11N (mandatory) | name 60A | old IC 12 | new IC 12 | passport 12 |
 *                     country 2 | MTD cents 8N | CP38 cents 8N | employee no 10A
 *
 * Line terminator: CRLF — ⚠ not specified by Exhibit 4; confirm on first live upload.
 *
 * ── THE FOUR IDENTITY BOXES, AND WHY THREE OF THEM WERE EMPTY UNTIL 00806b4c ─────────────────────
 * `buildCp39File` has accepted `oldIc`, `passport` and `countryCode` since it was written, and places
 * them at 73–84, 97–108 and 109–110. `cp39FileForBatch` did not FETCH them, so every line LHDN received
 * carried the new identity card and nothing else — and a foreign employee holding only a passport went
 * out with an empty identity block that no upload error would ever mention. The read now carries all
 * three, and refuses (naming the employees) when a person has no identity number of any kind on file.
 * The layout, the field positions, the padding and the totals are unchanged and stay golden-tested
 * against Exhibit 5.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import {
  companyStatutoryMy,
  employeeStatutoryMy,
  employment,
  payrollBatch,
  payslip,
  person,
} from '../../db/schema';
import { MY_STATUTORY_VERSION } from './statutory-tables';

export type Cp39Row = {
  /** TIN digits (with or without the "IG" prefix / dashes) — MANDATORY per Exhibit 4. */
  tin: string;
  name: string;
  oldIc?: string | null;
  newIc?: string | null;
  passport?: string | null;
  countryCode?: string | null;
  /** Monthly MTD in RM (e.g. 110.00). */
  mtd: number;
  /** CP38 instalment in RM (1.2.3 — the LHDN/court instalment, distinct from MTD; 0 if none). */
  cp38?: number;
  employeeNo?: string | null;
};

const digits = (v: string) => v.replace(/\D/g, '');
/** Numeric field: right-justified, zero-padded. Throws on overflow — a silently truncated
 *  amount in a statutory file is worse than a refusal. */
const num = (v: string | number, len: number, label: string): string => {
  const s = String(v);
  if (!/^\d*$/.test(s)) throw new Error(`${label} must be numeric, got “${s}”`);
  if (s.length > len) throw new Error(`${label} exceeds ${len} digits: “${s}”`);
  return s.padStart(len, '0');
};
/** Alphanumeric field: left-justified, space-padded, hard-truncated to width. */
const alpha = (v: string | null | undefined, len: number): string =>
  (v ?? '').toUpperCase().slice(0, len).padEnd(len, ' ');
const cents = (rm: number) => Math.round(rm * 100);

/** Exhibit-4 width of the detail "employee no" field. Employee IDs may legitimately be longer in the
 *  product (feedback de2823cc lifted the 9-char cap to 30), but a statutory file must never silently
 *  truncate an identifier — over-long codes REFUSE generation, listing the employees (fail-loud). */
export const CP39_EMPLOYEE_NO_LEN = 10;

/**
 * 00806b4c — THE SAME FAIL-LOUD RULE, FOR THE THREE IDENTITY BOXES THIS FILE NOW FILLS.
 *
 * Exhibit 4 fixes the widths: `No. K/P Lama` 12, `No. Passport` 12, `Kod Negara` 2. `alpha()` HARD-
 * TRUNCATES to width, so a 14-character passport would be filed as its first twelve characters — a
 * perfectly well-formed 136-character line carrying an identity number that belongs to NOBODY. That is
 * strictly worse than the blank box it replaced: a blank is visibly incomplete, an invented number
 * matches the wrong taxpayer or none, and neither the operator nor the portal is told anything.
 *
 * Before 00806b4c these boxes were permanently empty, so no truncation was reachable. Filling them makes
 * it reachable: `old_ic_number`, `passport_number` and `passport_issuing_country_code` are all unbounded
 * `text` (db/schema.ts), and the first two are FREE-TEXT inputs with no maxLength
 * (components/personnel-identity.tsx) — the old card deliberately so, because the pre-1990 format is not
 * uniform and a validator would refuse genuine cards. So the guard belongs here, at the file, exactly
 * where feedback de2823cc put the employee-number guard: refuse and name the people, never truncate.
 */
export const CP39_OLD_IC_LEN = 12;
export const CP39_PASSPORT_LEN = 12;
export const CP39_COUNTRY_CODE_LEN = 2;

/** The identity value AS IT IS FILED — trimmed, so the gate below measures exactly the characters
 *  `alpha()` will place in the box. Without the trim a leading space would let a 13-character passport
 *  pass a "12 after trimming" check and still lose its last character to the slice. */
const idValue = (v: string | null | undefined) => (v ?? '').trim();

type Cp39IdentityRow = {
  name: string;
  oldIc?: string | null;
  passport?: string | null;
  countryCode?: string | null;
};

/** Every identity value that would not survive its fixed-width box, described so HR knows what to fix:
 *  who, which box, and the value that does not fit. Empty array = nothing would be truncated. */
export function overlongCp39Identities(rows: Cp39IdentityRow[]): string[] {
  const boxes = [
    ['oldIc', 'old identity card number', CP39_OLD_IC_LEN],
    ['passport', 'passport number', CP39_PASSPORT_LEN],
    ['countryCode', 'passport country code', CP39_COUNTRY_CODE_LEN],
  ] as const;
  const out: string[] = [];
  for (const r of rows) {
    for (const [key, label, len] of boxes) {
      const v = idValue(r[key]);
      if (v.length > len) {
        out.push(`${r.name} — ${label} “${v}” (${v.length} characters; the CP39 box holds ${len})`);
      }
    }
  }
  return out;
}

/** Employer E-number → 10-digit form (Exhibit 5: "E 908915-10" → "0090891510"). */
export const normalizeEmployerNo = (e: string): string => {
  const d = digits(e);
  if (!d || d.length > 10) throw new Error(`Employer E-number must be 1–10 digits, got “${e}”`);
  return d.padStart(10, '0');
};

/**
 * THE LHDN FILE NAME, STATED ONCE. Exhibit 4's own convention is `xxxxxxxxxxmm_yyyy.txt` — the ten-digit
 * employer number, the two-digit month of deduction, an underscore, the four-digit year of deduction.
 *
 * ⚠️ EXPORTED FOR THE SAME REASON `borangAUploadFilename` AND `perkesoUploadFilename` ARE. r336 made those
 * two helpers the one definition each of their file's name precisely so two screens offering one month's
 * file cannot name it differently — an operator who cannot match a downloaded file to a month uploads the
 * wrong one, and LHDN's portal keys the submission off the name. `buildCp39File` calls this rather than
 * formatting the name inline, so a second surface that comes to offer this file (the Payment Submission
 * shelf is the one waiting on it — see app/payroll/payment-submission/registry.ts) asks THIS function and
 * is not able to invent a second spelling.
 *
 * `employerNo` is normalised here, so a caller holding the employer's raw "E 908915-10" gets the same name
 * as one holding "0090891510". The month is zero-padded; the year is written as given, because a year that
 * is not four digits is a caller bug the file's own header field would refuse anyway.
 */
export function cp39UploadFilename(p: { employerNo: string; year: number | string; month: number | string }): string {
  return `${normalizeEmployerNo(String(p.employerNo))}${String(p.month).padStart(2, '0')}_${p.year}.txt`;
}

export type Cp39File = {
  filename: string;
  content: string;
  totals: { mtdCents: number; mtdRecords: number; cp38Cents: number; cp38Records: number };
};

/** Pure builder — golden-tested against the Exhibit-5 sample lines. */
export function buildCp39File(p: {
  employerNo: string;
  year: number;
  month: number;
  rows: Cp39Row[];
}): Cp39File {
  const employer = normalizeEmployerNo(p.employerNo);
  const mm = String(p.month).padStart(2, '0');
  // Fail-loud on over-long employee numbers (feedback de2823cc): alpha() hard-truncates to width, which
  // would silently corrupt the identifier in a government file. Refuse instead, listing every employee.
  const overlongNos = p.rows.filter((r) => (r.employeeNo ?? '').trim().length > CP39_EMPLOYEE_NO_LEN);
  if (overlongNos.length) {
    throw new Error(
      `Employee no exceeds the ${CP39_EMPLOYEE_NO_LEN}-character CP39 field for: ` +
        overlongNos.map((r) => `${r.name} (${(r.employeeNo ?? '').trim()})`).join(', '),
    );
  }
  // 00806b4c — the same refusal for the three identity boxes, for the same reason (see the widths above).
  // Here at the pure builder so every caller is covered, including tests and any future direct use; the
  // DB path refuses one step earlier with a Cp39NotReadyError so the download answers 422 and not 500.
  const overlongIds = overlongCp39Identities(p.rows);
  if (overlongIds.length) {
    throw new Error(
      'Identity number does not fit its fixed-width CP39 field and must not be filed truncated: ' +
        overlongIds.join('; '),
    );
  }
  const lines: string[] = [];
  let mtdCents = 0;
  let mtdRecords = 0;
  let cp38Cents = 0;
  let cp38Records = 0;

  for (const r of p.rows) {
    const tin = digits(r.tin);
    if (!tin) throw new Error(`TIN is mandatory (Exhibit 4 field 11) — missing for “${r.name}”`);
    const rowMtd = cents(r.mtd);
    const rowCp38 = cents(r.cp38 ?? 0);
    mtdCents += rowMtd;
    if (rowMtd > 0) mtdRecords += 1;
    cp38Cents += rowCp38;
    if (rowCp38 > 0) cp38Records += 1;
    const line =
      'D' +
      num(tin, 11, `TIN (${r.name})`) +
      alpha(r.name, 60) +
      alpha(idValue(r.oldIc), CP39_OLD_IC_LEN) +
      alpha(r.newIc ? digits(r.newIc) : '', 12) +
      alpha(idValue(r.passport), CP39_PASSPORT_LEN) +
      alpha(idValue(r.countryCode), CP39_COUNTRY_CODE_LEN) +
      num(rowMtd, 8, `MTD (${r.name})`) +
      num(rowCp38, 8, `CP38 (${r.name})`) +
      alpha(r.employeeNo, CP39_EMPLOYEE_NO_LEN);
    if (line.length !== 136) throw new Error(`detail record is ${line.length} chars, expected 136`);
    lines.push(line);
  }

  const header =
    'H' +
    employer +
    employer +
    num(p.year, 4, 'year') +
    num(mm, 2, 'month') +
    num(mtdCents, 10, 'total MTD') +
    num(mtdRecords, 5, 'MTD records') +
    num(cp38Cents, 10, 'total CP38') +
    num(cp38Records, 5, 'CP38 records');
  if (header.length !== 57) throw new Error(`header record is ${header.length} chars, expected 57`);

  return {
    // The ONE definition of this file's name (see `cp39UploadFilename`), never a second formatting of it.
    filename: cp39UploadFilename({ employerNo: employer, year: p.year, month: mm }),
    content: [header, ...lines].join('\r\n') + '\r\n',
    totals: { mtdCents, mtdRecords, cp38Cents, cp38Records },
  };
}

export class Cp39NotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Cp39NotReadyError';
  }
}

/** Build the CP39 file for a company's pay period from its generated payslips. Refuses to emit
 *  with missing identifiers (ADR-0010 readiness gate). */
export function cp39FileForBatch(
  ctx: SessionContext,
  p: { companyId: string; periodKey: string },
): Promise<Cp39File & { statutoryVersion: string }> {
  return withTenant(ctx, async (tx) => {
    // Wave 2C (ADR-0024): aggregate the month's MTD across ALL runs of the period — CP39 is one monthly
    // filing, so each employee's row is the SUM of their regular + bonus/off-cycle MTD. With a single
    // run this is byte-identical to before.
    const batches = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.payPeriod, p.periodKey)));
    if (batches.length === 0)
      throw new Cp39NotReadyError(`No payroll batch for ${p.periodKey} — generate payslips first.`);
    const batchIds = batches.map((x) => x.id);
    const [co] = await tx
      .select({ eNo: companyStatutoryMy.lhdnEmployerNo })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, p.companyId))
      .limit(1);
    if (!co?.eNo) {
      throw new Cp39NotReadyError('Company LHDN E-number is not set (Organization → statutory identity).');
    }
    const slips = await tx
      .select({
        employmentId: payslip.employmentId,
        name: person.fullName,
        tin: employeeStatutoryMy.taxNumber,
        ic: employeeStatutoryMy.icNumber,
        // 00806b4c — THE THREE IDENTITY BOXES THAT USED TO GO OUT EMPTY ON EVERY LINE.
        // `buildCp39File` has always placed old IC at 73–84, passport at 97–108 and the country code at
        // 109–110; this read simply never fetched them, so a foreign employee holding only a passport was
        // filed with NO identity number at all — a line LHDN cannot match to a taxpayer, and nothing on any
        // screen said so. Migration 0450 (r217) gave `old_ic_number` and `passport_issuing_country_code`
        // their columns; `passport_number` predates it. Same three columns the PRINTED form reads
        // (localization/my/cp39-form.ts) — the two modules share the source, never code.
        // ⚠️ `passportIssuingCountryCode`, NEVER `passportIssuingCountry`: the latter is fed from the
        // tenant's NATIONALITY list and holds a demonym ("Malaysian"), not the ISO-2 ("MY") this file's
        // Kod Negara box wants. Deriving one from the other would file an invented country code.
        oldIc: employeeStatutoryMy.oldIcNumber,
        passport: employeeStatutoryMy.passportNumber,
        countryCode: employeeStatutoryMy.passportIssuingCountryCode,
        employeeNo: employment.employeeCode,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(inArray(payslip.batchId, batchIds))
      .orderBy(person.fullName);
    // One CP39 row per employee: sum MTD across the period's runs (= the month's total MTD).
    type Agg = {
      name: string;
      tin: string | null;
      ic: string | null;
      oldIc: string | null;
      passport: string | null;
      countryCode: string | null;
      employeeNo: string | null;
      mtd: number;
      cp38: number;
    };
    const byEmp = new Map<string, Agg>();
    const versionSet = new Set<string>();
    for (const s of slips) {
      const v = (s.statutory as { version?: string } | null)?.version;
      if (v) versionSet.add(v);
      let r = byEmp.get(s.employmentId);
      if (!r) {
        r = {
          name: s.name,
          tin: s.tin,
          ic: s.ic,
          oldIc: s.oldIc,
          passport: s.passport,
          countryCode: s.countryCode,
          employeeNo: s.employeeNo,
          mtd: 0,
          cp38: 0,
        };
        byEmp.set(s.employmentId, r);
      }
      r.mtd = Math.round((r.mtd + Number((s.statutory as { pcb?: number } | null)?.pcb ?? 0)) * 100) / 100;
      // 1.2.3 CP38 — distinct from MTD. Stamped non-zero on the REGULAR run only (kernel), so summing across
      // the period's runs single-counts the month's one instalment (asserted by the cross-run agg test).
      r.cp38 = Math.round((r.cp38 + Number((s.statutory as { cp38?: number } | null)?.cp38 ?? 0)) * 100) / 100;
    }
    const empRows = [...byEmp.values()];
    const missing = empRows.filter((r) => !r.tin || !digits(r.tin)).map((r) => r.name);
    if (missing.length) {
      throw new Cp39NotReadyError(
        `TIN is mandatory for the CP39 file — missing for: ${missing.join(', ')}`,
      );
    }
    // 00806b4c — AN IDENTITY NUMBER OF SOME KIND IS MANDATORY, AND ITS ABSENCE MUST BE LOUD.
    // Exhibit 4 gives the detail record three identity boxes — old K/P, new K/P and passport. An employee
    // who fills NONE of them produces a perfectly well-formed 136-character line with an empty identity
    // block: LHDN cannot match it to a taxpayer, the upload does not fail in any way the operator sees, and
    // the deduction goes unattributed. Refuse instead, naming the people, exactly as the TIN and
    // employee-no gates above do — the operator can then enter the passport or the card and try again.
    //
    // ⚠️ THE TEST OF READINESS IS "ANY IDENTITY NUMBER", NOT "A MyKad". A foreign employee legitimately
    // holds only a passport, and a passport line is a complete line; so is one carrying only a pre-1990
    // old card. Narrowing this to `!ic` would refuse an entire month's filing for employees whose records
    // are correct and complete — far worse than the blank box it replaces.
    const hasIdentity = (r: Agg) =>
      Boolean((r.ic ?? '').trim() || (r.passport ?? '').trim() || (r.oldIc ?? '').trim());
    const noIdentity = empRows.filter((r) => !hasIdentity(r)).map((r) => r.name);
    if (noIdentity.length) {
      throw new Cp39NotReadyError(
        'An identity number (identity card or passport) is required on every CP39 line — none on file for: ' +
          noIdentity.join(', '),
      );
    }
    // 00806b4c — AND IT MUST FIT THE BOX IT IS FILED IN. The refusal above catches an EMPTY identity
    // block; this one catches the opposite failure the same change makes reachable. The three columns are
    // unbounded `text` and two of them are free-text inputs, so a value longer than Exhibit 4's 12/12/2
    // is enterable today — and `alpha()` would file its first characters silently. A half passport number
    // is not "most of an identity"; it is a different identity, on a tax filing, with nothing to say so.
    // Refuse, naming the person AND the box, so HR can correct the record (feedback de2823cc, same call
    // as the employee number below). A Cp39NotReadyError, so the download answers 422 with this sentence
    // rather than the builder's 500.
    const overlongIds = overlongCp39Identities(empRows);
    if (overlongIds.length) {
      throw new Cp39NotReadyError(
        'An identity number is longer than the CP39 file allows and must not be filed cut short — correct it for: ' +
          overlongIds.join('; '),
      );
    }
    // Fail-closed pre-check (feedback de2823cc): the CP39 employee-no field is fixed at 10 characters.
    // Longer Employee IDs are fully valid in the product, but must not be silently truncated in a
    // statutory file — refuse with the affected employees listed so HR can shorten or hand-assign codes.
    const overlong = empRows.filter((r) => (r.employeeNo ?? '').trim().length > CP39_EMPLOYEE_NO_LEN);
    if (overlong.length) {
      throw new Cp39NotReadyError(
        `Employee ID exceeds the ${CP39_EMPLOYEE_NO_LEN} characters the LHDN CP39 format allows for: ` +
          overlong.map((r) => `${r.name} (${(r.employeeNo ?? '').trim()})`).join(', '),
      );
    }
    const [yy, mm] = p.periodKey.split('-').map(Number);
    const file = buildCp39File({
      employerNo: co.eNo,
      year: yy,
      month: mm,
      rows: empRows.map((r) => ({
        tin: r.tin!,
        name: r.name,
        // 00806b4c — all four identity boxes, from the employee record. `oldIc` and `countryCode` are free
        // text/ISO-2 and go through `alpha()`; `newIc` is digit-stripped by the builder.
        oldIc: r.oldIc,
        newIc: r.ic,
        passport: r.passport,
        countryCode: r.countryCode,
        mtd: r.mtd,
        cp38: r.cp38,
        employeeNo: r.employeeNo,
      })),
    });
    // ADR-0020: stamp the version(s) the payslips were ACTUALLY computed with (the snapshot in each
    // payslip's `statutory` blob), not the code constant — so the file filed to LHDN reports the real figures.
    const versions = [...versionSet].sort();
    return { ...file, statutoryVersion: versions.length ? versions.join(',') : MY_STATUTORY_VERSION };
  });
}
