/**
 * 18c1d92b — THE PERKESO ASSIST PORTAL UPLOAD FILE (combined SOCSO + EIS). PURE: no DB, no pack, no React.
 *
 * ⚠️ r296 — THIS IS NOW THE ONLY WRITER OF THIS FILE, AND IT WRITES TWO REVISIONS OF ONE FORMAT.
 * `localization/my/socso-eis-file.ts` used to hold a SECOND fixed-width writer at v2.0, reachable from
 * Reports and from the statutory-forms shelf while this one was reachable from the Borang 8A review
 * screen. The two emitted different bytes for the same employees in the same month and nothing on either
 * screen said which was which; readiness item 3.1 is that defect. That module is now the READ only, both
 * screens come here, and the difference between the two revisions — the SKBBK box — is decided by a
 * DATE, `PERKESO_SKBBK_MANDATORY_FROM`, in the one function `perkesoLayoutForPeriod`.
 *
 * ⚠️ EVERYTHING BELOW THIS PARAGRAPH DESCRIBES v1.0 UNLESS IT SAYS OTHERWISE, and v1.0 is the revision
 * with the evidence behind it: the customer's accepted BRG8A.txt. v2.0 is transcribed from a published
 * specification and has never been uploaded from this system — see `PERKESO_LAYOUT_UNVERIFIED`. WHICH
 * REVISION ASSIST ACCEPTS TODAY IS UNKNOWN and is not settled by anything in this file.
 *
 * ⚠️ TWO SOURCES NOW AGREE, AND THAT IS WORTH MORE THAN EITHER ALONE. The layout was derived from a REAL
 * FILED FILE and has since been checked, field for field, against PERKESO's own "Spesifikasi Format Text
 * File Untuk SOCSO + EIS Contribution" v1.0 of 22 July 2022 (attached to item 5d3acdc2): all twelve rows
 * agree — offsets, widths, alignment, both mandatory-N fillers, "cents, no decimal point".
 *
 * ⚠️ THE EMPLOYER CODE'S CHECK DIGIT IS NOT IMPLEMENTED, AND THAT IS DELIBERATE. The spec's field-1 remark
 * says "Verify employer code using check digit checking" and does NOT publish the algorithm. An invented
 * check would refuse VALID employer codes, which is worse than not checking: this module's whole design
 * is that a refusal is trustworthy. Length and shape are checked; the check digit is not, and the next
 * reader should know it was considered rather than missed. If the rule is ever obtained, it belongs in
 * `idField`'s caller for the employer code, not in a route.
 *
 * ⚠️ THE PAD CHARACTER COMES FROM THE FILE, NOT THE SPEC. The spec says "right justified" and never says
 * WHAT to pad with. The filed file uses SPACES, so spaces it is — the one place the two sources could
 * diverge, recorded here because somebody will ask.
 *
 * Every width, offset and pad rule
 * below is read off `test/fixtures/perkeso-brg8a.txt` — the BRG8A.txt the customer attached to 18c1d92b,
 * decoded 2026-08-21: 14 records, each exactly 278 characters, CRLF BETWEEN records and NONE after the
 * last (3,918 bytes = 14 x 278 + 13 x 2). The reporter also wrote the field table out by hand and, unlike
 * the KWSP request, their table and their file AGREE — but the file is what this module follows, because
 * a description can be mistaken about itself and a filed document cannot.
 *
 * ── THE ONE THING THE WRITTEN SPEC LEFT OPEN, AND THE FILE SETTLED ────────────────────────────────
 * "Left-pad with zeroes or spaces according to the official specification", it says. The file pads every
 * numeric field with SPACES: `"        590000"`, `" 10235"`, `"  2925"`. Zero-padding would produce a
 * file of exactly the right length that looks equally plausible and is a different file.
 *
 * ── ONE RECORD PER EMPLOYEE, TWELVE FIELDS, NO SEPARATORS ────────────────────────────────────────
 * There is no header record and no trailer: the file is nothing but 02-style employee lines, which is why
 * there are no totals to self-check against. `assertPerkesoFileShape` checks what CAN be checked — every
 * line exactly 278 characters, every numeric box digits-or-spaces, and both fillers blank.
 *
 * ── THE MAPPING LIVES IN ONE PLACE, AND THAT IS THE LESSON r210 PAID FOR ─────────────────────────
 * `perkesoFileEmployeesFrom` is the ONLY place a payroll row becomes a file record. On the KWSP file the
 * same mapping was written out at two call sites and guarded at neither; transposing the employer and
 * employee shares there produced a file of the right length whose own totals still agreed, and 214 tests
 * stayed green. FOUR of the six numeric boxes here are six characters wide and ADJACENT —
 * socsoEmployer, socsoEmployee, eisEmployer, eisEmployee — so that trap is here four fields wide, and the
 * golden test drives this function rather than restating it.
 *
 * ── WHAT IT REFUSES, AND WHY EACH REFUSAL IS A REFUSAL ───────────────────────────────────────────
 * A fixed-width record cannot say "this did not fit". Silently truncating an identity number files
 * somebody else's contributions under a number that happens to be a prefix, and a missing wage written as
 * zero tells PERKESO the employee earned nothing. So: an identity number that is not twelve characters,
 * an employer code longer than twelve, an amount too large for its box, or a MISSING SOCSO WAGE BASE all
 * stop the file and name the employee. The only field allowed to lose information is the NAME, which is
 * free text in a 150-character box — and at 150 characters that is a legal name, not a data error.
 */

import { isUnfinishedPersonName } from './unfinished-name';

/** Every record is exactly this wide, before the CRLF. */
export const PERKESO_FILE_LINE_LENGTH = 278;
/** CRLF between records. NOT after the last one — see the header. */
export const PERKESO_FILE_EOL = '\r\n';

/**
 * WHICH DOCUMENT THIS FILE IS WRITTEN TO, named once so the report cannot claim a specification the
 * module was not built from.
 *
 * The reporter asked for "format/version used" at the top of the validation report and they are right to:
 * every other line of that report is a measurement, and a measurement is only worth something once you
 * know what it was measured against. ASCII spelling deliberately — the report is us-ascii.
 *
 * ⚠️ DO NOT EDIT THESE THREE STRINGS to describe a newer PERKESO document unless the field table above
 * has ALSO been re-derived from it. The version line is a claim about the layout, not a label on it.
 */
export const PERKESO_FILE_SPEC = {
  name: 'Spesifikasi Format Text File Untuk SOCSO + EIS Contribution',
  version: 'v1.0',
  dated: '22 July 2022',
} as const;

/**
 * The SAME document, one revision later — the one that adds the SKBBK column. Named separately and
 * carried by `PERKESO_FILE_LAYOUTS['v2.0']`, so a report about a v2.0 file cannot claim v1.0's
 * specification and a report about a v1.0 file cannot claim v2.0's. The same warning applies to these
 * three strings as to the three above: they are a claim about a layout, not a label on one.
 */
export const PERKESO_FILE_SPEC_V2 = {
  name: 'Combine SOCSO + EIS Contribution Text File Format',
  version: 'v2.0',
  dated: '13 February 2026',
} as const;

/** One row of the specification's own table, as this module holds it. */
export type PerkesoFileField = {
  /** The agency's field NO., 1-12, exactly as its table numbers the rows. */
  readonly no: number;
  /** The agency's own FIELD NAME (EN), verbatim from its table. Not our words for it. */
  readonly label: string;
  /** 0-based start. The specification prints POSITION 1-based; `offset + 1` is that number. */
  readonly offset: number;
  /** The specification's LENGTH. */
  readonly width: number;
};

/**
 * The layout of the attached file, transcribed ONCE — and, since 64c09b0e, carrying the agency's own NO.
 * and FIELD NAME (EN) for each row beside the numbers. `offset` is 0-based, so a field occupies
 * `[offset, offset + width)` and the specification's 1-based POSITION column is `offset + 1`-`offset + width`.
 * The writer, the shape check, the report and the tests all read THESE numbers; nothing below restates an
 * offset.
 *
 * ⚠️ `no` AND `label` ARE LABELS, NOT A SECOND SOURCE OF POSITIONS. They exist so a line of the validation
 * report can be laid beside PERKESO's table without anybody translating our camelCase keys into the
 * agency's wording — which is precisely how 64c09b0e came to propose renaming four money boxes. Nothing
 * reads a position out of `no`, and `no` never orders anything: `offset` does.
 *
 * ⚠️ THE FOUR AMOUNT ROWS ARE THE ONES A READER GETS WRONG, so their labels are the agency's in full:
 * 7 and 8 are SOCSO employer/employee, 9 and 10 are EIS employer/employee. 64c09b0e asked for 215-220 to
 * become a "wage class" and 227-238 to become the employer/employee pair; the specification (v1.0, 22 July
 * 2022) and the customer's own filed BRG8A.txt both say otherwise, and following the request would have
 * credited every SOCSO amount to EIS in a file that still measured 278 characters. DO NOT MOVE THESE.
 */
export const PERKESO_FILE_FIELDS = {
  employerCode: { no: 1, label: 'Employer Code', offset: 0, width: 12 },
  myCoId: { no: 2, label: 'MyCoID/SSM Number', offset: 12, width: 20 },
  identityNo: { no: 3, label: 'Identification Number / SOCSO Foreign Worker Number', offset: 32, width: 12 },
  name: { no: 4, label: 'Employee Name', offset: 44, width: 150 },
  contributionMonth: { no: 5, label: 'Month Contribution', offset: 194, width: 6 },
  wage: { no: 6, label: 'Employee Salary', offset: 200, width: 14 },
  socsoEmployer: { no: 7, label: 'Contribution Amount SOCSO (Employer share)', offset: 214, width: 6 },
  socsoEmployee: { no: 8, label: 'Contribution Amount SOCSO (Employee share)', offset: 220, width: 6 },
  eisEmployer: { no: 9, label: 'Contribution Amount EIS (Employer share)', offset: 226, width: 6 },
  eisEmployee: { no: 10, label: 'Contribution Amount EIS (Employee share)', offset: 232, width: 6 },
  filler1: { no: 11, label: 'Filler 1', offset: 238, width: 20 },
  filler2: { no: 12, label: 'Filler 2', offset: 258, width: 20 },
} as const satisfies Record<string, PerkesoFileField>;

/**
 * r296 — THE SAME FORMAT, ONE REVISION LATER: v2.0 of 13 February 2026, which carves the SKBBK /
 * Lindung-24-Jam employee leg out of Filler 1.
 *
 * ⚠️ NOTHING ABOVE MOVES. Fields 1-10 are at the SAME offsets and the SAME widths as v1.0 — the byte the
 * customer's accepted file carries at position 215 is still SOCSO employer there. v2.0 changes exactly
 * two things: positions 239-244 become a sixth money box, and Filler 1 shrinks from 20 to 14 (245-258).
 * Field 12 Filler 2 is untouched at 259-278, and the record is still 278 characters.
 *
 * ⚠️ THIS TABLE HAS NEVER BEEN CHECKED AGAINST AN ACCEPTED FILE, and the one above has. There is no
 * v2.0 BRG8A.txt in this repository and nobody here has uploaded one to ASSIST. It is transcribed from
 * PERKESO's published v2.0 specification and its sample line, which is a weaker kind of evidence than a
 * filed document — see `PERKESO_LAYOUT_UNVERIFIED` and the RISK recorded there.
 *
 * Source (sourced 2026-06-20, verified against the specification's own sample line): PERKESO "Combine
 * SOCSO + EIS Contribution Text File Format" v2.0 (13 Feb 2026),
 * <https://www.perkeso.gov.my/images/borang/lindung24jam/formatteksfail.pdf>. Recorded in
 * docs/architecture/STATUTORY-SOURCES.md §3 as an open go-live gate.
 */
export const PERKESO_FILE_FIELDS_V2 = {
  employerCode: { no: 1, label: 'Employer Code', offset: 0, width: 12 },
  myCoId: { no: 2, label: 'MyCoID/SSM Number', offset: 12, width: 20 },
  identityNo: { no: 3, label: 'Identification Number / SOCSO Foreign Worker Number', offset: 32, width: 12 },
  name: { no: 4, label: 'Employee Name', offset: 44, width: 150 },
  contributionMonth: { no: 5, label: 'Month Contribution', offset: 194, width: 6 },
  wage: { no: 6, label: 'Employee Salary', offset: 200, width: 14 },
  socsoEmployer: { no: 7, label: 'Contribution Amount SOCSO (Employer share)', offset: 214, width: 6 },
  socsoEmployee: { no: 8, label: 'Contribution Amount SOCSO (Employee share)', offset: 220, width: 6 },
  eisEmployer: { no: 9, label: 'Contribution Amount EIS (Employer share)', offset: 226, width: 6 },
  eisEmployee: { no: 10, label: 'Contribution Amount EIS (Employee share)', offset: 232, width: 6 },
  skbbk: { no: 11, label: 'Contribution Amount SKBBK (Employee share)', offset: 238, width: 6 },
  filler1: { no: 12, label: 'Filler 1', offset: 244, width: 14 },
  filler2: { no: 13, label: 'Filler 2', offset: 258, width: 20 },
} as const satisfies Record<string, PerkesoFileField>;

/** The field table's own keys — the internal names, which the report no longer prints. */
export type PerkesoFieldKey = keyof typeof PERKESO_FILE_FIELDS_V2;

/**
 * How a field is named ANYWHERE a person reads it: the agency's number and the agency's words.
 *
 * ONE definition, because the report's field dump, its totals block and its refusal sentences all name
 * fields and must not come to name them differently. "socsoEmployer" is a variable; "Field 7 Contribution
 * Amount SOCSO (Employer share)" is a row in a document the reporter can hold up beside it.
 */
export const perkesoFieldName = (f: { readonly no: number; readonly label: string }): string =>
  `Field ${f.no} ${f.label}`;

/** The six boxes that carry money, in the order the record writes them. Named once so the shape check and
 *  the report cannot disagree with the writer about which fields are numeric. */
export const PERKESO_FILE_AMOUNT_FIELDS = [
  'wage',
  'socsoEmployer',
  'socsoEmployee',
  'eisEmployer',
  'eisEmployee',
] as const;

/** v2.0's six: the five above plus the SKBBK leg carved out of Filler 1. Same order as the record. */
export const PERKESO_FILE_AMOUNT_FIELDS_V2 = [...PERKESO_FILE_AMOUNT_FIELDS, 'skbbk'] as const;

/* ─── r296 — THE TWO LAYOUTS, AND THE DATE THAT CHOOSES BETWEEN THEM ─────────────────────────────── */

/**
 * WHY THERE ARE TWO. Until r296 this repository held TWO WRITERS for this one artefact — this module, at
 * v1.0, reachable from the Borang 8A review screen; and `localization/my/socso-eis-file.ts`, at v2.0,
 * reachable from Reports and from the statutory-forms shelf. They emitted DIFFERENT BYTES for the same
 * employees in the same month (space- versus zero-padded amounts, a SKBBK box versus a blank filler, and
 * a trailing CRLF versus none), and an operator had no way to know which of the two files they were
 * holding. There is one PERKESO ASSIST combined SOCSO+EIS upload file, so there is now one writer, and
 * the revision it writes is a NAMED, DATED choice instead of a second code path.
 *
 * `v1.0` is the layout of the customer's own accepted BRG8A.txt (test/fixtures/perkeso-brg8a.txt).
 * `v2.0` is PERKESO's published successor. Only `v1.0` has ever been accepted by the portal as far as
 * anything in this repository can show.
 */
export type PerkesoFileLayout = 'v1.0' | 'v2.0';

/**
 * THE CUTOVER, AS A DATE RATHER THAN AS A CODE PATH.
 *
 * PERKESO's v2.0 specification states that the SKBBK column becomes MANDATORY on 1 October 2026 and that
 * the legacy layout is accepted until 30 September 2026. This constant is that sentence, and it is the
 * only thing that decides which table a file is written to. Recorded as the go-live gate
 * "new combined SOCSO+EIS textfile (mandatory 1 Oct 2026)" in docs/architecture/STATUTORY-SOURCES.md §3.
 *
 * ⚠️ WHAT THIS DATE IS MEASURED AGAINST IS **UNKNOWN**, and the choice made here is written down rather
 * than hidden. We compare it to the CONTRIBUTION MONTH the file is for, not to the day somebody presses
 * download. The specification says when the format changes; it does not say whether a December-2026
 * upload of an August-2026 return must use v2.0. The contribution month was chosen because it is the
 * only period a file has (a re-download of an old month must not silently change shape), and because a
 * PERKESO return is due on the LAST DAY OF ITS OWN CONTRIBUTION MONTH, so for a return filed on time the
 * two readings coincide. A LATE or AMENDED return filed after 1 Oct 2026 for an earlier month is the one
 * case where they differ, and that case needs the specification or a submission to settle.
 */
export const PERKESO_SKBBK_MANDATORY_FROM = { year: 2026, month: 10 } as const;

/**
 * ⚠️ NEITHER LAYOUT'S ACCEPTANCE BY ASSIST **TODAY** IS KNOWN, and this constant exists so that no reader
 * has to infer it from the code's confidence. v1.0 is byte-for-byte a file PERKESO accepted (January
 * 2026). v2.0 has NEVER been uploaded from this system, and its pad character, its SKBBK box and its
 * shortened Filler 1 are transcribed from a published specification, not read off an accepted file.
 *
 * RISK: on 1 October 2026 this system starts writing a layout nobody here has ever seen accepted. The
 * first v2.0 upload is the test, and it must be watched. There is no way to close this from inside the
 * repository — see docs/CUSTOMER-DEPLOYMENT-READINESS.md §3.1.
 */
export const PERKESO_LAYOUT_UNVERIFIED = 'v2.0' as const satisfies PerkesoFileLayout;

export type PerkesoFileLayoutDef = {
  layout: PerkesoFileLayout;
  spec: { readonly name: string; readonly version: string; readonly dated: string };
  fields: Record<string, PerkesoFileField>;
  /** The money boxes this revision has, in record order. */
  amountFields: readonly string[];
  /** The boxes this revision requires to be blank. */
  fillerFields: readonly string[];
  /**
   * WHAT A RIGHT-JUSTIFIED AMOUNT IS PADDED WITH, per revision, and it is NOT the same character.
   *
   * v1.0's specification says "right justified" and never says with what; the customer's filed file pads
   * with SPACES (`"        590000"`, `" 10235"`), so v1.0 pads with spaces — the file settles what the
   * document left open. v2.0's specification publishes a sample line that is ZERO-padded
   * (`"00000000345799"`), so v2.0 pads with zeroes. Two revisions, two sources, two answers; writing
   * either one into the other's file produces a file of exactly the right length that is a different file.
   */
  amountPad: ' ' | '0';
};

export const PERKESO_FILE_LAYOUTS: Record<PerkesoFileLayout, PerkesoFileLayoutDef> = {
  'v1.0': {
    layout: 'v1.0',
    spec: PERKESO_FILE_SPEC,
    fields: PERKESO_FILE_FIELDS,
    amountFields: PERKESO_FILE_AMOUNT_FIELDS,
    fillerFields: ['filler1', 'filler2'],
    amountPad: ' ',
  },
  'v2.0': {
    layout: 'v2.0',
    spec: PERKESO_FILE_SPEC_V2,
    fields: PERKESO_FILE_FIELDS_V2,
    amountFields: PERKESO_FILE_AMOUNT_FIELDS_V2,
    fillerFields: ['filler1', 'filler2'],
    amountPad: '0',
  },
};

/** The layout definition for a revision. One lookup, so no caller indexes the record by hand. */
export function perkesoLayoutDef(layout: PerkesoFileLayout = 'v1.0'): PerkesoFileLayoutDef {
  return PERKESO_FILE_LAYOUTS[layout];
}

/**
 * WHICH REVISION A CONTRIBUTION MONTH IS WRITTEN TO. The ONLY place the cutover date is applied, so the
 * two screens cannot come to answer it differently, and so the answer can be read off a date rather than
 * off which button was pressed. See `PERKESO_SKBBK_MANDATORY_FROM` for what the date is measured against
 * and what about that is still unknown.
 */
export function perkesoLayoutForPeriod(year: number, month: number): PerkesoFileLayout {
  const key = year * 100 + month;
  const cutover = PERKESO_SKBBK_MANDATORY_FROM.year * 100 + PERKESO_SKBBK_MANDATORY_FROM.month;
  return key >= cutover ? 'v2.0' : 'v1.0';
}

export type PerkesoFileEmployee = {
  /** No. Kad Pengenalan, or the PERKESO foreign-worker number. Exactly 12 characters once dashes go. */
  identityNo: string;
  /** Uppercased and truncated to 150 — the one field allowed to lose information. */
  name: string;
  /** The SOCSO/EIS wage the contributions were worked out from, in RM. NULL means "no run in this period
   *  recorded one", which is a REFUSAL, not a zero. */
  wage: number | null;
  socsoEmployer: number;
  socsoEmployee: number;
  eisEmployer: number;
  eisEmployee: number;
  /**
   * r296 — the SKBBK / Lindung-24-Jam EMPLOYEE leg, in RM. Always supplied; whether it reaches the file
   * depends on the revision, which is what `PERKESO_SKBBK_MANDATORY_FROM` decides.
   *
   * ⚠️ v1.0 HAS NOWHERE TO PUT THIS, and that is a property of the accepted layout rather than of this
   * code: its positions 239-258 are Filler 1 and the specification requires them blank. A v1.0 file
   * therefore carries none of this money, and `perkesoSkbbkNotCarried` exists so that nobody has to
   * discover that from a total that reads 0.00. Absent is treated as 0 — for a payslip written before
   * SKBBK existed that is the truth, not a substitution.
   */
  skbbk?: number;
};

export type PerkesoFileInput = {
  employer: {
    /** No. Majikan PERKESO. Up to 12 characters, left-justified, written as given. */
    employerCode: string;
    /** MyCoID / SSM. Optional — twenty spaces when absent, and the following fields do not move. */
    myCoId?: string | null;
    /** Contribution period month, 1-12. */
    periodMonth: number;
    /** Contribution period year. */
    periodYear: number;
  };
  employees: readonly PerkesoFileEmployee[];
  /** Defaults to now. Injectable ONLY so the future-month refusal can be tested without a clock. */
  today?: Date;
  /**
   * r296 — which revision of the format to write. Defaults to `perkesoLayoutForPeriod(year, month)`,
   * which is the cutover date and nothing else. Passed explicitly only by tests and by a caller that has
   * been told which revision the portal wants; a screen never chooses.
   */
  layout?: PerkesoFileLayout;
};

/** Thrown by every refusal here, so a route can answer 422 without matching on a message. */
export class PerkesoFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PerkesoFileError';
  }
}

const fail = (msg: string): never => {
  throw new PerkesoFileError(msg);
};

/** Amount → integer sen. Refuses a negative or non-finite value rather than writing a `-` into a box. */
function sen(amount: number, field: string, who: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) fail(`${who}: ${field} is not a number (${String(amount)})`);
  if (n < 0) fail(`${who}: a PERKESO file has no way to express a negative ${field} (${n})`);
  return Math.round(n * 100);
}

/**
 * Right-justified digits, padded to exactly `width` with THE REVISION'S OWN PAD CHARACTER. Refuses an
 * overflow — never truncates money. See `PerkesoFileLayoutDef.amountPad` for why the character is a
 * property of the revision and not a constant.
 */
function amountField(value: number, width: number, field: string, who: string, pad: ' ' | '0'): string {
  const s = String(value);
  if (s.length > width) {
    fail(`${who}: ${field} needs ${s.length} characters and the box holds ${width}. The file cannot carry it.`);
  }
  return s.padStart(width, pad);
}

/** Left-justified text, space-padded, TRUNCATED to width. Only the name may use this. */
function textField(raw: string, width: number): string {
  return String(raw ?? '')
    .toUpperCase()
    // Non-ASCII would change the BYTE length of a fixed-width record read as latin-1 at the portal.
    .replace(/[^\x20-\x7E]/g, ' ')
    .slice(0, width)
    .padEnd(width, ' ');
}

/** Left-justified text that must FIT — an identifier is never truncated. */
function idField(raw: string, width: number, field: string, who: string): string {
  const s = String(raw ?? '').trim();
  if (s.length > width) fail(`${who}: ${field} is ${s.length} characters and the box holds ${width}.`);
  return s.padEnd(width, ' ');
}

const spaces = (n: number) => ' '.repeat(n);

/** `slice` by an entry from PERKESO_FILE_FIELDS. One reader, so no offset is restated. */
export function perkesoField(record: string, spec: PerkesoFileField): string {
  return record.slice(spec.offset, spec.offset + spec.width);
}

/**
 * THE ONE PLACE A PAYROLL ROW BECOMES A FILE RECORD. Structurally typed so this module stays free of the
 * report's own types, and so the golden test can drive the very function the download drives. See the
 * header for why this is not written out at the call site.
 */
export function perkesoFileEmployeesFrom(
  rows: readonly {
    ic: string;
    name: string;
    wage: number | null;
    socsoEmployer: number;
    socsoEmployee: number;
    eisEmployer: number;
    eisEmployee: number;
    /** r296 — the SKBBK employee leg. Optional so a row shape that predates it still maps. */
    skbbk?: number;
  }[],
): PerkesoFileEmployee[] {
  return rows.map((r) => ({
    identityNo: r.ic,
    name: r.name,
    wage: r.wage,
    socsoEmployer: r.socsoEmployer,
    socsoEmployee: r.socsoEmployee,
    eisEmployer: r.eisEmployer,
    eisEmployee: r.eisEmployee,
    skbbk: r.skbbk ?? 0,
  }));
}

/**
 * THE MONEY THE CHOSEN REVISION CANNOT CARRY, IN RINGGIT — 0 when it can.
 *
 * Read off the INPUT rather than out of the file, unlike every total in this module, and deliberately:
 * the whole point is money that is NOT in the file. There is nothing in the bytes to read.
 *
 * SKBBK has been mandatory since 1 June 2026 (Akta A1788) but the layout PERKESO accepted has no box for
 * it until v2.0. So between 1 June and 30 September 2026 this system can write a file PERKESO is known
 * to accept, or a file that carries the SKBBK, and not both. It writes the accepted one and says this
 * out loud — in the validation report and in the artefact it records — because a SKBBK total of 0.00
 * printed beside a file that simply has no such box is an assertion that the money does not exist.
 */
export function perkesoSkbbkNotCarried(
  layout: PerkesoFileLayout,
  // Structurally typed, like `perkesoFileEmployeesFrom` above, so a caller can hand over its own payroll
  // rows without first mapping them into the file's shape just to ask this question.
  rows: readonly { skbbk?: number | null }[],
): number {
  if (perkesoLayoutDef(layout).amountFields.includes('skbbk')) return 0;
  const sen = rows.reduce((acc, e) => acc + Math.round((Number(e.skbbk) || 0) * 100), 0);
  return sen / 100;
}

/**
 * Build the upload file. Returns the whole file as one string, CRLF between records and none after the
 * last, exactly as the attached file is.
 */
export function buildPerkesoSocsoFile(input: PerkesoFileInput): string {
  const { employer, employees } = input;

  const month = Number(employer.periodMonth);
  const year = Number(employer.periodYear);
  if (!Number.isInteger(month) || month < 1 || month > 12) fail(`Contribution month must be 1-12, got ${employer.periodMonth}`);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) fail(`Contribution year must be four digits, got ${employer.periodYear}`);

  // r296 — the revision, decided from the contribution month by the cutover date and by nothing else
  // unless a caller names one. Chosen AFTER the month is validated, so a malformed period is still a
  // period error rather than a mysterious layout.
  const layout = input.layout ?? perkesoLayoutForPeriod(year, month);
  const def = perkesoLayoutDef(layout);
  const F = def.fields;
  // MMYYYY — the request is explicit that YYYYMM and MM/YY are both wrong, and the attached file agrees.
  const contributionMonth = `${String(month).padStart(2, '0')}${year}`;

  // 5d3acdc2 — "Month due cannot be advanced date" (PERKESO spec v1.0, field 5 remark). A contribution
  // month that has not happened yet is refused here rather than at the portal. `today` is injectable so
  // the check is testable without a clock, and defaults to the caller's own date.
  const today = input.today ?? new Date();
  const currentKey = today.getFullYear() * 100 + (today.getMonth() + 1);
  if (year * 100 + month > currentKey) {
    fail(
      `Contribution month ${contributionMonth} has not happened yet. PERKESO refuses a return filed for a future month.`,
    );
  }

  const employerCode = idField(employer.employerCode, F.employerCode.width, 'employer code', 'Employer');
  if (!String(employer.employerCode ?? '').trim()) fail('Employer: the PERKESO employer code is required and is not on file.');
  const myCoId = idField(employer.myCoId ?? '', F.myCoId.width, 'MyCoID / SSM number', 'Employer');

  if (employees.length === 0) fail('There is nobody to file for in this period.');

  const records = employees.map((e, i) => {
    const who = e.name?.trim() || `employee ${i + 1}`;
    // The identity box is twelve characters and the request is explicit that it must not be treated as a
    // number: dashes are removed, everything else is written as given and must FIT.
    const identity = String(e.identityNo ?? '').replace(/[-\s]/g, '');
    if (identity.length !== F.identityNo.width) {
      fail(
        `${who}: the identity number must be exactly ${F.identityNo.width} characters once dashes are removed, got "${e.identityNo}" (${identity.length}).`,
      );
    }
    // ⚠️ THE WAGE IS A REFUSAL, NOT A ZERO. See the module header: a payslip written before the wage base
    // was stamped cannot produce this box, and gross pay is a different number.
    if (e.wage == null) {
      throw new PerkesoFileError(
        `${who}: no SOCSO wage was recorded on their payslip for this month, so the salary box cannot be filled. Reprocess the run, or file this employee by hand.`,
      );
    }
    const pad = def.amountPad;
    return (
      employerCode +
      myCoId +
      identity +
      textField(e.name, F.name.width) +
      contributionMonth +
      amountField(sen(e.wage, 'wage', who), F.wage.width, 'wage', who, pad) +
      amountField(sen(e.socsoEmployer, 'SOCSO employer contribution', who), F.socsoEmployer.width, 'SOCSO employer contribution', who, pad) +
      amountField(sen(e.socsoEmployee, 'SOCSO employee contribution', who), F.socsoEmployee.width, 'SOCSO employee contribution', who, pad) +
      amountField(sen(e.eisEmployer, 'EIS employer contribution', who), F.eisEmployer.width, 'EIS employer contribution', who, pad) +
      amountField(sen(e.eisEmployee, 'EIS employee contribution', who), F.eisEmployee.width, 'EIS employee contribution', who, pad) +
      // r296 — the SKBBK box exists only in v2.0. In v1.0 the same twenty positions are Filler 1 and the
      // specification requires them BLANK, so the money is not written and `perkesoSkbbkNotCarried` says
      // so instead. Driven off the field table, never off the revision name.
      (F.skbbk
        ? amountField(sen(e.skbbk ?? 0, 'SKBBK contribution', who), F.skbbk.width, 'SKBBK contribution', who, pad)
        : '') +
      spaces(F.filler1.width) +
      spaces(F.filler2.width)
    );
  });

  const text = records.join(PERKESO_FILE_EOL);
  // THE FILE CHECKS ITSELF, from the bytes rather than from the intent.
  assertPerkesoFileShape(text, layout);
  return text;
}

/**
 * r296 — ONE NAME FOR ONE ARTEFACT.
 *
 * The two screens that hand over this file used to name it two different ways —
 * `perkeso-socso-<code>-<YYYYMM>.txt` from the Borang 8A review screen and `PERKESO_<digits>_<MMYYYY>.txt`
 * from Reports — so the same bytes arrived in an operator's Downloads folder twice under names that share
 * nothing, with the two spellings of the period differing as well. Kept as the Borang 8A screen's name,
 * which is the one beside the accepted file, and moved here so neither screen can drift from it.
 *
 * `periodKey` is `YYYY-MM`; the name carries `YYYYMM`, which sorts.
 */
export function perkesoUploadFilename(employerCode: string, periodKey: string): string {
  const code = (employerCode || 'EMP').replace(/[^A-Za-z0-9]+/g, '');
  return `perkeso-socso-${code}-${periodKey.replace('-', '')}.txt`;
}

/** The records of an emitted file, without the line endings. */
export function perkesoFileRecords(text: string): string[] {
  return text.split(PERKESO_FILE_EOL).filter((l) => l.length > 0);
}

/**
 * Re-read an emitted file and refuse anything the portal would reject on shape alone. There is no header
 * or trailer to reconcile against, so this checks the properties the request itself lists: every record
 * exactly 278 characters, every money box digits-or-spaces with no separator or sign, and both fillers
 * blank.
 */
export function assertPerkesoFileShape(text: string, layout: PerkesoFileLayout = 'v1.0'): void {
  const records = perkesoFileRecords(text);
  if (records.length === 0) fail('the file has no records');
  for (const [i, r] of records.entries()) {
    const problems = perkesoRecordProblems(r, `record ${i + 1}`, layout);
    if (problems.length > 0) fail(problems[0]);
  }
}

/**
 * EVERYTHING WRONG WITH ONE RECORD, as sentences, rather than the first thing wrong with it as a throw.
 *
 * ONE DEFINITION OF "VALID", read by two callers with opposite jobs. `assertPerkesoFileShape` above stops
 * the download on the first problem; the validation report has to NAME the records it could not validate
 * and leave their figures out of the totals, which a throw cannot do. Writing the rules out twice is how
 * a report comes to reassure somebody about a file the writer would have refused — so they are written
 * once, here, and the refusal messages are exactly the sentences this returns.
 *
 * `at` is the caller's name for the record ("record 3"), so the same sentence reads correctly in a thrown
 * message and in a list.
 */
export function perkesoRecordProblems(record: string, at: string, layout: PerkesoFileLayout = 'v1.0'): string[] {
  const def = perkesoLayoutDef(layout);
  const problems: string[] = [];
  if (record.length !== PERKESO_FILE_LINE_LENGTH) {
    problems.push(`${at} is ${record.length} characters and every record must be ${PERKESO_FILE_LINE_LENGTH}`);
  }
  // 64c09b0e — NAMED THE AGENCY'S WAY, not ours. These same sentences are what a refusal says and what
  // the report lists, and "socsoEmployer" sends a reader to our source where "Field 7 Contribution Amount
  // SOCSO (Employer share)" sends them to the row of the specification that settles it.
  //
  // r296 — `^ *\d+$` accepts BOTH pad characters by construction: v1.0's spaces are the leading run, and
  // v2.0's zeroes are digits. One rule, two revisions, and neither is loosened for the other.
  for (const key of def.amountFields) {
    const field = def.fields[key];
    const v = perkesoField(record, field);
    if (!/^ *\d+$/.test(v)) {
      problems.push(`${at}: ${perkesoFieldName(field)} reads "${v}", which is not a right-justified number`);
    }
  }
  for (const key of def.fillerFields) {
    const field = def.fields[key];
    const v = perkesoField(record, field);
    if (v !== spaces(field.width)) problems.push(`${at}: ${perkesoFieldName(field)} must be blank, got "${v}"`);
  }
  return problems;
}

export type PerkesoFieldView = {
  /** The field table's INTERNAL key. Kept because the totals and the MyCoID notice look fields up by it;
   *  it is not what the report prints — see `no` / `label`. */
  name: string;
  /** 64c09b0e — the agency's own NO., so a report line can be found in its table by number. */
  no: number;
  /** 64c09b0e — the agency's own FIELD NAME (EN). */
  label: string;
  position: string;
  length: number;
  value: string;
};
export type PerkesoRecordView = {
  recordNo: number;
  length: number;
  /** Nothing wrong with this record — see `problems`. */
  ok: boolean;
  /** Every reason this record could not be validated, in the shape check's own words. Empty when `ok`. */
  problems: string[];
  fields: PerkesoFieldView[];
};

/**
 * The validation report the request asks for: every record, field by field, with the 1-based character
 * positions a person can count against a PERKESO sample. Reads the SAME field table the writer used.
 */
export function describePerkesoFile(text: string, layout: PerkesoFileLayout = 'v1.0'): PerkesoRecordView[] {
  const def = perkesoLayoutDef(layout);
  return perkesoFileRecords(text).map((r, i) => {
    const problems = perkesoRecordProblems(r, `record ${i + 1}`, layout);
    return {
      recordNo: i + 1,
      length: r.length,
      ok: problems.length === 0,
      problems,
      fields: Object.keys(def.fields).map((name) => {
        const field = def.fields[name];
        return {
          name,
          no: field.no,
          label: field.label,
          position: `${field.offset + 1}-${field.offset + field.width}`,
          length: field.width,
          value: perkesoField(r, field),
        };
      }),
    };
  });
}

/** Every money box either revision has — v2.0's set, which is v1.0's plus `skbbk`. */
export type PerkesoAmountField = (typeof PERKESO_FILE_AMOUNT_FIELDS_V2)[number];

export type PerkesoFileTotals = {
  /** How many records the figures below were added up over. */
  records: number;
  /** Records left OUT because they did not validate. Naming them is the point — see below. */
  excluded: number[];
  /**
   * Integer sen per money box, exactly as the file carries them: no decimal point, no separator.
   *
   * ⚠️ A KEY IS PRESENT ONLY IF THE REVISION HAS THAT BOX. The five boxes both revisions share are always
   * there; `skbbk` exists on a v2.0 total and is ABSENT — not zero — on a v1.0 one. A zero would be a
   * figure, and a figure about a box that does not exist is an assertion nobody can stand behind.
   */
  sen: Record<(typeof PERKESO_FILE_AMOUNT_FIELDS)[number], number> & Partial<Record<PerkesoAmountField, number>>;
};

/**
 * ⚠️ THE TOTALS ARE READ BACK OUT OF THE FILE, AND THAT IS THE WHOLE VALUE OF THEM.
 *
 * The obvious implementation is to add up the payroll rows the file was written from. It would be shorter,
 * it would always agree with the payslips — and it would agree with itself just as happily if the writer
 * had put the EIS employer share into the SOCSO employee box, which is the exact failure this report
 * exists to catch (four of the six money boxes here are six characters wide and adjacent; the KWSP file
 * shipped precisely that transposition in r210). So the input is the emitted TEXT, the values come out of
 * `describePerkesoFile`'s own field views — the same views the field-by-field dump prints — and a
 * misplaced value shows up as a total that does not match the payroll.
 *
 * A record that did not validate contributes NOTHING and is named instead. Its bytes have moved, so the
 * digits standing in a money box are not evidence of anything; adding them in would produce a confident
 * total from a file we have just said we could not read.
 */
export function perkesoFileTotals(text: string, layout: PerkesoFileLayout = 'v1.0'): PerkesoFileTotals {
  const def = perkesoLayoutDef(layout);
  // ONE KEY PER BOX THIS REVISION ACTUALLY HAS. A v1.0 total has no `skbbk` key — see the type.
  const sen = Object.fromEntries(def.amountFields.map((k) => [k, 0])) as PerkesoFileTotals['sen'];
  const excluded: number[] = [];
  let records = 0;
  for (const view of describePerkesoFile(text, layout)) {
    if (!view.ok) {
      excluded.push(view.recordNo);
      continue;
    }
    records += 1;
    for (const key of def.amountFields) {
      const field = view.fields.find((f) => f.name === key);
      const k = key as PerkesoAmountField;
      sen[k] = (sen[k] ?? 0) + Number((field?.value ?? '').trim());
    }
  }
  return { records, excluded, sen };
}

/** Integer sen as RM with two decimals, from the integer itself — never through a float. */
function rm(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const n = Math.abs(cents);
  return `${sign}${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

/**
 * 64c09b0e — THE WIDEST THING THE REPORT PRINTS A FIELD NAME INTO, so the totals block and the per-record
 * dump line up as columns instead of ragging. Derived from the labels themselves rather than typed, so a
 * label can never outgrow its column silently. (Field 3's name is the long one, at 51 characters.)
 */
const labelColumn = (def: PerkesoFileLayoutDef) =>
  Math.max(...Object.values(def.fields).map((f) => perkesoFieldName(f).length));

/**
 * The report as plain ASCII, for reading beside a PERKESO sample. ASCII only, deliberately: it describes
 * a us-ascii file and a curly quote in a document about byte positions would be its own joke.
 *
 * ⚠️ THERE IS NO SKBBK / LINDUNG 24 JAM TOTAL ON A v1.0 REPORT AND THERE MUST NOT BE ONE. The request
 * asks for it; the v1.0 specification has no such field, so a v1.0 file carries no such contribution. A
 * line reading "SKBBK: RM 0.00" would be a statement about money on a return that does not mention it —
 * an assurance nobody can stand behind, which is worse than the gap it fills. r296 followed exactly the
 * rule this paragraph set: the FIELD TABLE gained the column first (`PERKESO_FILE_FIELDS_V2`), and only a
 * report about a v2.0 file totals it.
 *
 * `p.skbbkNotCarried` is the OTHER half of the same discipline, and it is a figure the file cannot
 * supply: SKBBK money that exists on the payslips and that THIS revision has no box for. Absent or zero
 * ⇒ the report says nothing about SKBBK at all, exactly as it always has.
 */
export function perkesoFileReport(
  text: string,
  p: { layout?: PerkesoFileLayout; skbbkNotCarried?: number } = {},
): string {
  const layout = p.layout ?? 'v1.0';
  const def = perkesoLayoutDef(layout);
  const LABEL_COLUMN = labelColumn(def);
  const views = describePerkesoFile(text, layout);
  const totals = perkesoFileTotals(text, layout);
  const out: string[] = [];
  out.push('PERKESO SOCSO + EIS UPLOAD FILE - RECORD BY RECORD CHECK');
  out.push('');
  out.push('Every position below is read out of the one field table this system writes the file with, and');
  out.push('every value is read back out of the file itself. Every field is named with PERKESO\'s own NO. and');
  out.push('FIELD NAME (EN), so a line of this report can be laid straight beside the specification\'s table.');
  out.push('');
  // 64c09b0e — THE SENTENCE THIS WHOLE ROUND EXISTS FOR, and it goes at the TOP. Two items in a row
  // reported records "split across two lines" and attached screenshots of an editor with word wrap on.
  // The bytes were right both times. Said here before any field position, because a reader who believes
  // the file is broken will not read a table that says it is not.
  out.push(`EVERY RECORD IS A SINGLE LINE OF ${PERKESO_FILE_LINE_LENGTH} CHARACTERS.`);
  out.push('A text editor with word wrap turned ON will show one record folded over two lines on screen.');
  out.push('That is the editor wrapping a long line, not a line break in the file: there is no line break');
  out.push('inside a record. Turn word wrap off and each employee sits on one line.');
  out.push('');
  out.push(`Specification: PERKESO "${def.spec.name}",`);
  out.push(
    `${def.spec.version} of ${def.spec.dated}. One record per employee, ` +
      `${PERKESO_FILE_LINE_LENGTH} characters per record, no header, no trailer.`,
  );
  out.push('');
  out.push(`Records: ${views.length}. Characters including line endings: ${text.length}.`);
  const wrongLength = views.filter((v) => v.length !== PERKESO_FILE_LINE_LENGTH);
  out.push(
    wrongLength.length === 0
      ? `Record length: every record is ${PERKESO_FILE_LINE_LENGTH} characters.`
      : `Record length: ${wrongLength.length} record(s) are NOT ${PERKESO_FILE_LINE_LENGTH}: ${wrongLength.map((v) => `record ${v.recordNo} is ${v.length}`).join(', ')}.`,
  );
  out.push(`Line endings: CRLF between records, ${text.endsWith(PERKESO_FILE_EOL) ? 'and one after the last.' : 'none after the last.'}`);

  // NAMED, NOT COUNTED. "12 of 14 records validated" tells a reader that something is wrong and gives them
  // nothing to go and look at; the record number and the reason send them to a line they can count.
  const failed = views.filter((v) => !v.ok);
  if (failed.length === 0) {
    out.push('Records that could not be validated: none.');
  } else {
    out.push(`Records that could not be validated: ${failed.length} of ${views.length}.`);
    for (const v of failed) for (const p of v.problems) out.push(`  - ${p}`);
    out.push('Their figures are NOT included in the totals below.');
  }

  const notice = perkesoFileMycoidNotice(views);
  if (notice.length > 0) {
    out.push('');
    for (const line of notice) out.push(line);
  }

  // THE NAMES, NAMED. Same standing as the MyCoID notice above: it does not stop the file and it does not
  // change a byte of it. See `perkesoFileUnfinishedNames` for why this is here at all.
  const unfinished = perkesoFileUnfinishedNames(text);
  if (unfinished.length > 0) {
    out.push('');
    out.push(`EMPLOYEE NAMES THAT DO NOT LOOK FINISHED: ${unfinished.length} of ${views.length}.`);
    out.push('PERKESO field 4 is "Name as per IC or passport". These are the names on the staff records, so');
    out.push('the file carries them as they are - it does not invent or shorten anybody. Uploading as they');
    out.push('stand files these contributions under these names. Nothing here stops the file.');
    for (const u of unfinished) {
      out.push(`  - record ${u.recordNo}, identity number ${u.identityNo}: name reads "${u.name}"`);
    }
  }

  out.push('');
  out.push('TOTALS, ADDED UP FROM THE VALUES READ BACK OUT OF THIS FILE');
  out.push('Not from the payroll figures the file was written from. A total taken from the input would');
  out.push('agree with itself even if a value had been written into the wrong box, which is the one thing');
  out.push('these totals exist to catch.');
  out.push('The file carries every amount as CENTS WITH NO DECIMAL POINT, so the digits it actually holds');
  out.push('are printed beside each RM figure. Check both.');
  for (const key of def.amountFields) {
    // 64c09b0e — the agency's number and the agency's words, the same ones the dump below prints, so the
    // five money lines can be checked off against the specification's rows 6 to 10 without translation.
    const name = perkesoFieldName(def.fields[key]);
    const v = totals.sen[key as PerkesoAmountField] ?? 0;
    out.push(`  ${name.padEnd(LABEL_COLUMN)}  RM ${rm(v).padStart(11)}   in the file: ${v}`);
  }
  out.push(`Added up over ${totals.records} record(s) of ${views.length}.`);

  // r296 — THE MONEY THAT IS NOT IN THIS FILE, named, and only when there is some. See
  // `perkesoSkbbkNotCarried`: silence here means the question does not arise, which is what it has always
  // meant on a v1.0 report and is why this block cannot print a reassuring zero.
  if ((p.skbbkNotCarried ?? 0) > 0) {
    const notCarried = Math.round((p.skbbkNotCarried ?? 0) * 100);
    out.push('');
    out.push(`SKBBK / LINDUNG 24 JAM IS NOT IN THIS FILE: RM ${rm(notCarried)}.`);
    out.push(`This file is written to ${def.spec.version} of ${def.spec.dated}, which has no box for it -`);
    out.push(`positions ${def.fields.filler1.offset + 1}-${def.fields.filler1.offset + def.fields.filler1.width} are Filler 1 and the specification requires them blank. The payroll`);
    out.push('for this month DID deduct the amount above from the employees, so it is owed to PERKESO and');
    out.push('this upload does not pay it. PERKESO adds the column in v2.0 of 13 February 2026, which this');
    out.push(
      `system writes for contribution months from ${String(PERKESO_SKBBK_MANDATORY_FROM.month).padStart(2, '0')}/${PERKESO_SKBBK_MANDATORY_FROM.year} onward.`,
    );
    out.push('Settle this month\'s SKBBK the way PERKESO tells you to for the transition period. Nothing');
    out.push('here stops the file, and the file is correct for the format it is written to.');
  }

  for (const v of views) {
    out.push('');
    out.push(`Record ${v.recordNo} (${v.length} characters, one line)`);
    for (const f of v.fields) {
      out.push(`  ${f.position.padStart(7)}  ${perkesoFieldName(f).padEnd(LABEL_COLUMN)}  [${f.value}]`);
    }
  }
  return out.join('\n') + '\n';
}

/**
 * NAMES THAT ARE NOT YET NAMES, READ BACK OUT OF THE FILE.
 *
 * r218 generated this file from the customer's own January 2026 run and FOURTEEN of the nineteen records
 * carried `TEST0001` … `TEST0014` in field 4, with a fifteenth reading `ISMAIL` where their filed file
 * says `MOHD RIDHUAN BIN ISMAIL`. The format was right to the character; the names were placeholders.
 * PERKESO's field 4 is "Name as per IC or passport", so uploading that files real contributions under
 * test names — and nothing in a fixed-width file can tell you so, because a placeholder pads exactly
 * like a person.
 *
 * ⚠️ REPORTED, NEVER REPAIRED, NEVER BLOCKING — the same standing this warning has on the CP39, and for
 * the same reasons: it is the operator's own data, the file carries what the staff record says, and the
 * correction belongs on the staff record. The identity number rides along because a placeholder name
 * leaves nothing else to find the person by, and it is the one field here that is certainly theirs.
 *
 * Read out of the FILE rather than from the input rows, like the totals: the point is what PERKESO will
 * receive.
 */
export function perkesoFileUnfinishedNames(text: string): { recordNo: number; identityNo: string; name: string }[] {
  const out: { recordNo: number; identityNo: string; name: string }[] = [];
  perkesoFileRecords(text).forEach((r, i) => {
    const name = perkesoField(r, PERKESO_FILE_FIELDS.name).trim();
    if (!isUnfinishedPersonName(name)) return;
    out.push({ recordNo: i + 1, identityNo: perkesoField(r, PERKESO_FILE_FIELDS.identityNo).trim(), name });
  });
  return out;
}

/**
 * THE ONE BOX THAT GOES OUT EMPTY WITHOUT ANYBODY BEING TOLD, said out loud — in the report, and in the
 * same words the preview screen says it in.
 *
 * MyCoID is Mandatory = N in the specification, so a blank one does NOT stop the file and this is
 * deliberately a notice and not a refusal (`missingBorang8AHeader` excludes it for the same reason). But
 * the reporter's own accepted file carries a number there and ours would not, and an empty fixed-width box
 * looks exactly like a full one from outside. Read out of the FILE rather than off the form, so it can
 * only ever describe the bytes that were actually written.
 *
 * Empty array when every record carries a number — there is nothing to say, and a reassuring line saying
 * so is a line a future reader has to check.
 */
export function perkesoFileMycoidNotice(views: readonly PerkesoRecordView[]): string[] {
  const blank = views.filter((v) => !(v.fields.find((f) => f.name === 'myCoId')?.value ?? '').trim());
  if (blank.length === 0) return [];
  const { offset, width } = PERKESO_FILE_FIELDS.myCoId;
  const where = blank.length === views.length ? 'on every record' : `on ${blank.map((v) => `record ${v.recordNo}`).join(', ')}`;
  return [
    `MyCoID / business registration number: positions ${offset + 1}-${offset + width} are EMPTY ${where}.`,
    'PERKESO marks this field as not mandatory, so the file is valid without it and the portal should',
    'accept it. If the file you filed before carries a number in that box, set it under Organization ->',
    'the company -> Statutory identity, then download the file again.',
  ];
}
