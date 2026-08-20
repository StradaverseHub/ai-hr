/**
 * cc74dcb2 — THE KWSP BORANG A UPLOAD FILE for i-Akaun (Employer). PURE: no DB, no pack, no React.
 *
 * ⚠️ THE SPECIFICATION IS A REAL KWSP FILE, NOT A DESCRIPTION OF ONE. Every width, offset, pad rule and
 * literal below is read off `test/fixtures/kwsp-borang-a-epforma2.txt` — the EPFORMA2 file the customer
 * attached to cc74dcb2, decoded 2026-08-20: 17 lines, each exactly 129 characters, CRLF between them.
 * The previous transcription came from the field tables in item 3aae0789, which were reverse-engineered
 * WITHOUT a sample, and it put the wages where the employer's contribution belongs and the two
 * contributions added together where the employee's belongs. A file with the right shape and the wrong
 * numbers in it is the worst kind: it looks valid. `BORANG_A_FILE_FIELDS` states the layout ONCE, as
 * data, so the writer, the verifier, the report and test/kwsp-borang-a-file.test.ts all read the same
 * numbers — and the golden test in that file rebuilds the fourteen employees of the sample and asserts
 * the output equals it byte for byte, so the layout is checked against a real KWSP file rather than
 * against a description of one.
 *
 * ── FOUR RECORD TYPES, IN ORDER ───────────────────────────────────────────────────────────────────
 *   00  header          — file date, batch no., total EMPLOYER, total EMPLOYEE, employer reference
 *   01  employer        — employer reference, contribution period MMYYYY, 3-char short code, batch no.
 *   02  employee detail — one per employee; member no., IC, name, staff no., EMPLOYER, EMPLOYEE, WAGES
 *   99  trailer         — 02 count, total EMPLOYER, total EMPLOYEE, control total
 * 129 characters per line, space-padded to the full width, CRLF BETWEEN lines and none after the last —
 * the sample is 2,225 bytes, which is 17 × 129 + 16 × 2, so the accepted file ends at the last character
 * of its 99 record. That is the only real file anyone here has seen, and it is followed rather than
 * improved on.
 *
 * ── WHICH AMOUNT IS WHICH, AND THE ARITHMETIC THAT SETTLES IT ─────────────────────────────────────
 * On the sample's 02 lines the three amounts read EMPLOYER, EMPLOYEE, WAGES. AHMAD MUHAIMIN's line is
 * `000067200 000061600 000000000560000` — 672.00, 616.00 and 5,600.00 — and 672 is 12% of 5,600 while
 * 616 is 11%, which is the employer's rate and the employee's. The two summary lines carry the same
 * pair: employer 10,394.00 and employee 9,379.00 appear in both the 00 and the 99 record, and the wage
 * total 84,995.65 appears NOWHERE in the file. So there is no wage total to check the wage column
 * against, and this module does not invent one.
 *
 * ── THE INVARIANT, ENFORCED BEFORE THE FILE IS EVER OFFERED ───────────────────────────────────────
 * header totals == trailer totals == the sum over the 02 records, for BOTH contribution columns, and the
 * trailer's record count == the number of 02 lines. `buildBorangAFile` re-reads its OWN output through
 * `assertBorangAFileBalances` before returning it, so the check runs against the emitted bytes rather
 * than against the numbers the writer intended — the two are different things, and only the first is
 * what i-Akaun sees. Refusing to emit is the whole point: a file that does not add up is rejected at the
 * portal, which is a slower and more expensive way to learn the same fact.
 *
 * ── THE TRAILER'S CONTROL TOTAL IS A HASH TOTAL OF MEMBER NUMBERS, AND IS DERIVED ─────────────────
 * The sample's trailer ends `000000000000266741200`, and the fourteen member numbers on that file sum to
 * exactly 266,741,200. It is a hash total — a sum of identifiers that is not money and means nothing on
 * its own, whose only job is to prove no 02 line was lost or duplicated in transit. It is therefore
 * DERIVED here, from the very member numbers written into the 02 records, and summed in BigInt because
 * fourteen nineteen-digit numbers exceed what a double can carry exactly.
 *
 * ⚠️ HOW WIDE THE FIELD IS, THE SAMPLE CANNOT SETTLE, AND THIS IS THE HONEST ANSWER. The trailer's tail
 * is `000000000000266741200` — twenty-one characters. That is equally consistent with ONE 21-wide field
 * and with a 12-zero filler followed by a 9-wide control, because this sample's hash total happens to fit
 * in nine digits. The two readings only diverge once the sum passes 999,999,999, at roughly 46 employees
 * on eight-digit member numbers, where the 21-wide reading writes digits into columns 40-51 that the only
 * real KWSP file we have shows as zeros. We take the NARROW reading, for two reasons that are evidence
 * rather than preference: the 00 record ends in exactly that shape (a 12-zero filler at [63,12] then a
 * 9-wide employer reference at [75,9]), and item 3aae0789's independent transcription of the layout —
 * made before this sample existed — also had filler [39,12] + control [51,9].
 *
 * SO: derive the hash total when it fits in nine digits. When it does NOT, write zeros (which is what
 * this file did before the total was derivable at all, and what KWSP has evidently accepted) and SAY SO
 * in the validation report. We do not refuse the file — a 46-employee employer must still be able to
 * file — and we do not truncate to the low nine digits, which would be inventing a rule.
 * `trailerControlNumber` remains as an override for the case where KWSP asks for something else.
 *
 * ── WHAT THIS REFUSES, AND WHY EACH REFUSAL IS A REFUSAL RATHER THAN A FIX-UP ─────────────────────
 * A fixed-width record has no way to say "this value did not fit". Silently truncating a member number or
 * an employer reference would file somebody else's contributions under a number that happens to be a
 * prefix. So a value that is not what the field can hold stops the file, names the person, and is fixed
 * on their record. The ONE exception is the NAME and the STAFF NUMBER, which are free text in a 40- and a
 * 20-character box: those are truncated, because a long legal name is not a data error and a form is not
 * worth refusing over it.
 */

/** Every line in the file is exactly this wide, before the CRLF. */
export const BORANG_A_FILE_LINE_LENGTH = 129;
/** CRLF, as the sample has. Not the platform's newline — this file crosses machines. */
export const BORANG_A_FILE_EOL = '\r\n';
/** The 00 record's literal description, 18 characters wide. */
export const BORANG_A_FILE_DESCRIPTION = 'EPF MONTHLY FORM A';

/**
 * The layout of the sample file, transcribed once. `[offset, width]`, both 0-based, so a field occupies
 * `[offset, offset + width)`. The writer, the verifier, the validation report and the tests all read
 * THESE numbers; nothing below restates an offset.
 */
export const BORANG_A_FILE_FIELDS = {
  header: {
    recordType: [0, 2],
    description: [2, 18],
    fileDate: [20, 8],
    batchNo: [28, 5],
    totalEmployer: [33, 15],
    totalEmployee: [48, 15],
    filler: [63, 12],
    employerRef: [75, 9],
  },
  employer: {
    recordType: [0, 2],
    filler1: [2, 10],
    employerRef: [12, 9],
    period: [21, 6],
    shortCode: [27, 3],
    batchNo: [30, 5],
    filler2: [35, 8],
  },
  detail: {
    recordType: [0, 2],
    memberNo: [2, 19],
    ic: [21, 12],
    filler: [33, 3],
    name: [36, 40],
    staffNo: [76, 20],
    employerContribution: [96, 9],
    employeeContribution: [105, 9],
    wages: [114, 15],
  },
  trailer: {
    recordType: [0, 2],
    recordCount: [2, 7],
    totalEmployer: [9, 15],
    totalEmployee: [24, 15],
    // 12 zeros then a 9-wide control total — NOT one 21-wide field. See the header note: the sample
    // cannot tell the two apart and this is the reading the 00 record's own shape supports.
    filler: [39, 12],
    controlTotal: [51, 9],
  },
} as const;

/**
 * The record-type field, which every group declares at the same place. Named once here so a line's type
 * can be read BEFORE its layout is known, without anybody writing `slice(0, 2)` and quietly becoming a
 * second copy of the table.
 */
const RECORD_TYPE = BORANG_A_FILE_FIELDS.header.recordType;

/** The record-type literal each group of fields describes. Used by the validation report to pick one. */
export const BORANG_A_FILE_RECORD_TYPES = {
  '00': 'header',
  '01': 'employer',
  '02': 'detail',
  '99': 'trailer',
} as const satisfies Record<string, keyof typeof BORANG_A_FILE_FIELDS>;

/** One employee line of the upload file. The three amounts are in the sample's own order. */
export type BorangAFileEmployee = {
  /** No. Ahli. Digits only; zero-padded to 19 in the record. */
  epfMemberNo: string;
  /** IC. Dashes and spaces are stripped; must be exactly 12 digits once stripped. */
  icNumber: string;
  /** Uppercased and truncated to 40 characters. */
  name: string;
  /** Employee/staff number. Truncated to 20 characters. */
  staffNo?: string;
  /** RM, plain number — the EMPLOYER's share for the month. 12% of the wage in the sample. */
  employerContribution: number;
  /** RM, plain number — the EMPLOYEE's share for the month. 11% of the wage in the sample. */
  employeeContribution: number;
  /** RM, plain number — the EPF-liable wage the two shares were worked out from. */
  wages: number;
};

/**
 * THE ONE PLACE A PAYROLL ROW BECOMES A FILE LINE, and the reason it is here rather than at the call
 * site. The 02 record's three amounts are EMPLOYER, EMPLOYEE, WAGES, and the two contributions are
 * adjacent nine-wide digit fields — so transposing them produces a file that is the right length, whose
 * header and trailer totals still agree with the 02 lines (both sides are summed from the same swapped
 * values), and which the portal accepts while filing every employee's two shares the wrong way round.
 * NOTHING downstream can see that. It was written out by hand at two call sites and guarded at neither;
 * the verifier swapped one of them and 214 tests stayed green.
 *
 * Structurally typed on purpose: this module stays free of the report's own types, and any row carrying
 * these seven fields — `borangARows`' output does — can be mapped by it. The golden test builds the
 * sample's fourteen employees THROUGH this function, so a swap here fails against the real KWSP file's
 * bytes rather than against a restatement of them.
 */
export function borangAFileEmployeesFrom(
  rows: readonly {
    memberNo: string;
    ic: string;
    name: string;
    staffNo?: string;
    wage: number;
    employer: number;
    employee: number;
  }[],
): BorangAFileEmployee[] {
  return rows.map((r) => ({
    epfMemberNo: r.memberNo,
    icNumber: r.ic,
    name: r.name,
    staffNo: r.staffNo,
    employerContribution: r.employer,
    employeeContribution: r.employee,
    wages: r.wage,
  }));
}

export type BorangAFileInput = {
  employer: {
    /** Employer EPF reference. Digits only, zero-padded to 9. */
    epfRefNo: string;
    /** 3-character employer short code. NO COLUMN EXISTS FOR THIS — see below. Blank ⇒ three spaces. */
    code?: string;
    /** Contribution period month, 1-12. */
    periodMonth: number;
    /** Contribution period year. */
    periodYear: number;
  };
  employees: readonly BorangAFileEmployee[];
  /** Defaults to now. */
  fileDate?: Date;
  /** Defaults to 1. Written identically into the 00 and 01 records. */
  batchNo?: number;
  /**
   * Override for the trailer's control total. Blank ⇒ the sum of the member numbers, which is what the
   * sample carries. Kept only for the case where KWSP asks a particular employer for something else.
   */
  trailerControlNumber?: string;
};

/** Thrown by every refusal in this module, so a route can answer 422 without matching on a message. */
export class BorangAFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BorangAFileError';
  }
}

const fail = (msg: string): never => {
  throw new BorangAFileError(msg);
};

const digitsOf = (v: string | null | undefined): string => String(v ?? '').replace(/\D/g, '');

/** Amount → integer cents. Refuses a negative or non-finite value rather than writing a `-` into a digit field. */
function cents(amount: number, field: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) fail(`${field}: not a number (${String(amount)})`);
  if (n < 0) fail(`${field}: a Borang A upload file has no way to express a negative amount (${n})`);
  return Math.round(n * 100);
}

/** Zero-padded integer of exactly `width` digits. Refuses an overflow — see the header comment. */
function numField(value: number, width: number, field: string): string {
  if (!Number.isInteger(value) || value < 0) fail(`${field}: expected a non-negative integer, got ${value}`);
  const s = String(value);
  if (s.length > width) {
    fail(`${field}: ${value} needs ${s.length} digits and the field holds ${width}. The file cannot carry it.`);
  }
  return s.padStart(width, '0');
}

/** Zero-padded digit string of exactly `width`. Non-digits and overflows are refused, never stripped-and-hoped. */
function digitField(raw: string, width: number, field: string): string {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) fail(`${field}: must be digits only, got "${s}"`);
  if (s.length > width) fail(`${field}: "${s}" is ${s.length} digits and the field holds ${width}.`);
  return s.padStart(width, '0');
}

/** Left-aligned text, space-padded, TRUNCATED to width. The only fields allowed to lose information. */
function textField(raw: string, width: number): string {
  const s = String(raw ?? '')
    .toUpperCase()
    // Non-ASCII would change the BYTE length of a fixed-width record read as latin-1 by the portal.
    .replace(/[^\x20-\x7E]/g, ' ')
    .slice(0, width);
  return s.padEnd(width, ' ');
}

/** Right-pad a built record to the full line width. */
const line = (s: string): string => (s.length > BORANG_A_FILE_LINE_LENGTH ? fail(`record overflows ${BORANG_A_FILE_LINE_LENGTH} characters: ${s.length}`) : s.padEnd(BORANG_A_FILE_LINE_LENGTH, ' '));

const zeros = (n: number) => '0'.repeat(n);
const spaces = (n: number) => ' '.repeat(n);

/** `slice` by a `[offset, width]` entry from BORANG_A_FILE_FIELDS. One reader, so no offset is restated. */
export function fileField(record: string, spec: readonly [number, number]): string {
  return record.slice(spec[0], spec[0] + spec[1]);
}

/**
 * Build the upload file. Returns the whole file as one string: CRLF between the lines and none after the
 * last, which is how the sample ends.
 *
 * Refuses — rather than emitting something i-Akaun will reject — when: the employer reference is not
 * 1-9 digits, a member number is not digits or too long, an IC is not exactly 12 digits, an amount is
 * negative or too large for its field, the short code is longer than 3 characters, the batch number does
 * not fit 5 digits, or the control total does not fit its field. Every message names the field and, for a
 * per-employee problem, the person.
 */
export function buildBorangAFile(input: BorangAFileInput): string {
  const { employer, employees } = input;
  const employerRef = digitField(employer.epfRefNo, BORANG_A_FILE_FIELDS.header.employerRef[1], 'Employer EPF reference');

  const month = Number(employer.periodMonth);
  const year = Number(employer.periodYear);
  if (!Number.isInteger(month) || month < 1 || month > 12) fail(`Contribution period month must be 1-12, got ${employer.periodMonth}`);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) fail(`Contribution period year must be four digits, got ${employer.periodYear}`);
  // MMYYYY — the 01 record's own order, which is NOT the header's YYYYMMDD. Two different orders in one
  // file is exactly the kind of thing a single transcription of the layout above prevents.
  const period = `${String(month).padStart(2, '0')}${year}`;

  const codeRaw = String(employer.code ?? '').trim();
  const codeWidth = BORANG_A_FILE_FIELDS.employer.shortCode[1];
  if (codeRaw.length > codeWidth) fail(`Employer short code must be at most ${codeWidth} characters, got "${codeRaw}"`);
  const shortCode = textField(codeRaw, codeWidth);

  const batchNo = numField(input.batchNo ?? 1, BORANG_A_FILE_FIELDS.header.batchNo[1], 'Batch number');

  const d = input.fileDate ?? new Date();
  if (Number.isNaN(d.getTime())) fail('File date is not a valid date');
  const fileDate = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

  // ── 02 records, and the totals THEY produce ─────────────────────────────────────────────────────
  // The totals are summed from the very rows that get written, never passed in beside them. That is the
  // structural half of the invariant; `assertBorangAFileBalances` below is the check that it held.
  let totalEmployerCents = 0;
  let totalEmployeeCents = 0;
  // BigInt via the constructor rather than a `0n` literal: this repo targets ES2017, where the literal
  // is a syntax error. Nineteen-digit member numbers exceed what a double holds exactly, so the sum has
  // to be arbitrary-precision or it is not a hash total, it is an approximation of one.
  let memberNoSum = BigInt(0);
  const detail = employees.map((e, i) => {
    const who = e.name?.trim() || `employee ${i + 1}`;
    const memberNo = digitField(e.epfMemberNo, BORANG_A_FILE_FIELDS.detail.memberNo[1], `${who}: EPF member number`);
    const icDigits = digitsOf(e.icNumber);
    const icWidth = BORANG_A_FILE_FIELDS.detail.ic[1];
    if (icDigits.length !== icWidth) {
      fail(`${who}: identity card number must be exactly ${icWidth} digits once dashes are removed, got "${e.icNumber}" (${icDigits.length}).`);
    }
    const employerCents = cents(e.employerContribution, `${who}: employer contribution`);
    const employeeCents = cents(e.employeeContribution, `${who}: employee contribution`);
    const wageCents = cents(e.wages, `${who}: wages`);
    totalEmployerCents += employerCents;
    totalEmployeeCents += employeeCents;
    // The hash total is summed from the DIGITS that are written, not from the caller's string, so the
    // trailer counts exactly the member numbers the 02 records carry.
    memberNoSum += BigInt(memberNo);
    return line(
      '02' +
        memberNo +
        icDigits +
        spaces(BORANG_A_FILE_FIELDS.detail.filler[1]) +
        textField(e.name, BORANG_A_FILE_FIELDS.detail.name[1]) +
        textField(e.staffNo ?? '', BORANG_A_FILE_FIELDS.detail.staffNo[1]) +
        numField(employerCents, BORANG_A_FILE_FIELDS.detail.employerContribution[1], `${who}: employer contribution`) +
        numField(employeeCents, BORANG_A_FILE_FIELDS.detail.employeeContribution[1], `${who}: employee contribution`) +
        numField(wageCents, BORANG_A_FILE_FIELDS.detail.wages[1], `${who}: wages`),
    );
  });

  const controlWidth = BORANG_A_FILE_FIELDS.trailer.controlTotal[1];
  const controlRaw = String(input.trailerControlNumber ?? '').trim();
  // DERIVED: the hash total of the member numbers, which is what the sample's own trailer carries. An
  // override is honoured verbatim; a derived sum too big for the field is a refusal, never a truncation.
  const derivedControl = memberNoSum.toString();
  // A sum too big for the nine-digit field is NOT a refusal — see the header. Zeros, exactly as this
  // file wrote before the total was derivable, and the report says the total could not be carried.
  const controlTotal = controlRaw
    ? digitField(controlRaw, controlWidth, 'Trailer control number')
    : derivedControl.length > controlWidth
      ? zeros(controlWidth)
      : derivedControl.padStart(controlWidth, '0');

  const header = line(
    '00' +
      textField(BORANG_A_FILE_DESCRIPTION, BORANG_A_FILE_FIELDS.header.description[1]) +
      fileDate +
      batchNo +
      numField(totalEmployerCents, BORANG_A_FILE_FIELDS.header.totalEmployer[1], 'Total employer contribution') +
      numField(totalEmployeeCents, BORANG_A_FILE_FIELDS.header.totalEmployee[1], 'Total employee contribution') +
      zeros(BORANG_A_FILE_FIELDS.header.filler[1]) +
      employerRef,
  );

  const employerRecord = line(
    '01' +
      zeros(BORANG_A_FILE_FIELDS.employer.filler1[1]) +
      employerRef +
      period +
      shortCode +
      batchNo +
      zeros(BORANG_A_FILE_FIELDS.employer.filler2[1]),
  );

  const trailer = line(
    '99' +
      numField(detail.length, BORANG_A_FILE_FIELDS.trailer.recordCount[1], 'Record count') +
      numField(totalEmployerCents, BORANG_A_FILE_FIELDS.trailer.totalEmployer[1], 'Total employer contribution') +
      numField(totalEmployeeCents, BORANG_A_FILE_FIELDS.trailer.totalEmployee[1], 'Total employee contribution') +
      zeros(BORANG_A_FILE_FIELDS.trailer.filler[1]) +
      controlTotal,
  );

  // NO TRAILING CRLF, and the sample is why: EPFORMA2 is 2,225 bytes, which is 17 x 131 MINUS 2 — the
  // last record ends at its 129th character with no line ending after it. main wrote one; the plan's
  // prose says "every line ... plus CRLF"; the real file KWSP accepted says otherwise, and the file wins.
  const text = [header, employerRecord, ...detail, trailer].join(BORANG_A_FILE_EOL);
  // THE FILE CHECKS ITSELF, from the bytes rather than from the intent. See the header comment.
  assertBorangAFileBalances(text);
  return text;
}

/** What a parsed file says about itself. Returned by `parseBorangAFileTotals` for tests and diagnostics. */
export type BorangAFileTotals = {
  headerEmployerCents: number;
  headerEmployeeCents: number;
  trailerEmployerCents: number;
  trailerEmployeeCents: number;
  trailerCount: number;
  detailEmployerCents: number;
  detailEmployeeCents: number;
  /**
   * The sum of the 02 wage fields. NOTHING in the file carries a wage total to compare it against — the
   * sample's own 84,995.65 appears in no record — so this is reported and never asserted.
   */
  detailWageCents: number;
  detailCount: number;
  /** The trailer's control total, leading zeros stripped, as a decimal string. */
  controlTotal: string;
  /** The sum of the 02 member numbers, which is what the control total is. Decimal string, from BigInt. */
  memberNoSum: string;
};

/**
 * Read the totals back OUT of an emitted file. Deliberately re-parses the characters rather than trusting
 * anything the writer held: the invariant is a property of the FILE, and a check that reads the writer's
 * own variables cannot see a mis-placed field.
 */
export function parseBorangAFileTotals(text: string): BorangAFileTotals {
  const lines = borangAFileLines(text);
  if (lines.length < 3) fail(`a Borang A file needs at least a 00, a 01 and a 99 record; got ${lines.length} lines`);
  for (const [i, l] of lines.entries()) {
    if (l.length !== BORANG_A_FILE_LINE_LENGTH) {
      fail(`line ${i + 1} is ${l.length} characters, and every line must be ${BORANG_A_FILE_LINE_LENGTH}`);
    }
  }
  const header = lines[0];
  const employerRecord = lines[1];
  const trailer = lines[lines.length - 1];
  const typeOf = (l: string) => fileField(l, RECORD_TYPE);
  if (typeOf(header) !== '00') fail(`the first record must be 00, got "${typeOf(header)}"`);
  if (typeOf(employerRecord) !== '01') fail(`the second record must be 01, got "${typeOf(employerRecord)}"`);
  if (typeOf(trailer) !== '99') fail(`the last record must be 99, got "${typeOf(trailer)}"`);

  // Two records at the front and one at the back are a fact about the ORDER of the file, not about any
  // column, so this is the one place a literal index is not a second copy of the field table.
  const detail = lines.slice(2, -1);
  for (const [i, l] of detail.entries()) {
    if (typeOf(l) !== '02') fail(`record ${i + 3} must be 02, got "${typeOf(l)}"`);
  }

  const int = (s: string, what: string): number => {
    if (!/^\d+$/.test(s)) fail(`${what} is not numeric: "${s}"`);
    return Number(s);
  };
  const big = (s: string, what: string): bigint => {
    if (!/^\d+$/.test(s)) fail(`${what} is not numeric: "${s}"`);
    return BigInt(s);
  };

  const F = BORANG_A_FILE_FIELDS;
  let detailEmployerCents = 0;
  let detailEmployeeCents = 0;
  let detailWageCents = 0;
  // BigInt via the constructor rather than a `0n` literal: this repo targets ES2017, where the literal
  // is a syntax error. Nineteen-digit member numbers exceed what a double holds exactly, so the sum has
  // to be arbitrary-precision or it is not a hash total, it is an approximation of one.
  let memberNoSum = BigInt(0);
  for (const [i, l] of detail.entries()) {
    detailEmployerCents += int(fileField(l, F.detail.employerContribution), `02 record ${i + 1} employer contribution`);
    detailEmployeeCents += int(fileField(l, F.detail.employeeContribution), `02 record ${i + 1} employee contribution`);
    detailWageCents += int(fileField(l, F.detail.wages), `02 record ${i + 1} wages`);
    memberNoSum += big(fileField(l, F.detail.memberNo), `02 record ${i + 1} member number`);
  }

  return {
    headerEmployerCents: int(fileField(header, F.header.totalEmployer), 'header total employer contribution'),
    headerEmployeeCents: int(fileField(header, F.header.totalEmployee), 'header total employee contribution'),
    trailerEmployerCents: int(fileField(trailer, F.trailer.totalEmployer), 'trailer total employer contribution'),
    trailerEmployeeCents: int(fileField(trailer, F.trailer.totalEmployee), 'trailer total employee contribution'),
    trailerCount: int(fileField(trailer, F.trailer.recordCount), 'trailer record count'),
    detailEmployerCents,
    detailEmployeeCents,
    detailWageCents,
    detailCount: detail.length,
    controlTotal: big(fileField(trailer, F.trailer.controlTotal), 'trailer control total').toString(),
    memberNoSum: memberNoSum.toString(),
  };
}

/**
 * THE INVARIANT: for BOTH contribution columns, header total == trailer total == the sum over the 02
 * records, and the trailer's count == the number of 02 records. Throws `BorangAFileError` naming the
 * first thing that does not agree.
 *
 * THE WAGE COLUMN IS NOT IN HERE, and that is a fact about the file rather than an omission: no record
 * carries a wage total, so there is nothing to check the 02 wage fields against. The control total is not
 * in here either — it is derived from the member numbers by default but may be overridden, so a check on
 * it would refuse the very case the override exists for.
 *
 * Pinned by mutating one 02 line of a good file and asserting the refusal — the only test that proves the
 * check reads the FILE rather than the writer's arithmetic.
 */
export function assertBorangAFileBalances(text: string): void {
  const t = parseBorangAFileTotals(text);
  if (t.headerEmployerCents !== t.detailEmployerCents) {
    fail(`total employer contribution does not add up: the header says ${t.headerEmployerCents} and the ${t.detailCount} employee records sum to ${t.detailEmployerCents}.`);
  }
  if (t.trailerEmployerCents !== t.detailEmployerCents) {
    fail(`total employer contribution does not add up: the trailer says ${t.trailerEmployerCents} and the ${t.detailCount} employee records sum to ${t.detailEmployerCents}.`);
  }
  if (t.headerEmployeeCents !== t.detailEmployeeCents) {
    fail(`total employee contribution does not add up: the header says ${t.headerEmployeeCents} and the ${t.detailCount} employee records sum to ${t.detailEmployeeCents}.`);
  }
  if (t.trailerEmployeeCents !== t.detailEmployeeCents) {
    fail(`total employee contribution does not add up: the trailer says ${t.trailerEmployeeCents} and the ${t.detailCount} employee records sum to ${t.detailEmployeeCents}.`);
  }
  if (t.trailerCount !== t.detailCount) {
    fail(`record count does not match: the trailer says ${t.trailerCount} and the file carries ${t.detailCount} employee records.`);
  }
}

/**
 * ── THE VALIDATION REPORT ─────────────────────────────────────────────────────────────────────────
 *
 * A READ-ONLY VIEW OVER THE EMITTED TEXT, so an operator can hold it beside a KWSP sample and check the
 * layout position by position before uploading anything. It reads `BORANG_A_FILE_FIELDS` and nothing
 * else: there is no second copy of the layout anywhere in this file or in the report's own rendering, so
 * a report that agrees with the file is not evidence the file is right — it is the same table read
 * twice — but a report that shows a value in the wrong box IS visible, which is the point. What it can
 * prove on its own is line length, that every field's characters are what they claim, and that the
 * totals and the hash total add up.
 */
export type BorangAFileFieldView = {
  /** The name the field has in `BORANG_A_FILE_FIELDS`, or `padding` for the trailing spaces. */
  name: string;
  /** 0-based offset, straight from the table. */
  offset: number;
  length: number;
  /** 1-based inclusive columns, which is how a text editor counts them. Derived from `offset`. */
  firstColumn: number;
  lastColumn: number;
  value: string;
};

export type BorangAFileLineView = {
  /** 1-based, as the report prints it. */
  lineNo: number;
  recordType: string;
  /** The record group in `BORANG_A_FILE_FIELDS` this line was read with, or null if the type is unknown. */
  layout: keyof typeof BORANG_A_FILE_FIELDS | null;
  length: number;
  fields: BorangAFileFieldView[];
};

/** The file's lines, without the CRLFs and without a phantom empty last line. One splitter, shared. */
export function borangAFileLines(text: string): string[] {
  return text.split(BORANG_A_FILE_EOL).filter((l) => l.length > 0);
}

/**
 * Every line of an emitted file, decomposed field by field. The offsets come from `BORANG_A_FILE_FIELDS`;
 * the trailing `padding` entry is computed from where the last declared field ends, so it is not an
 * offset this function knows.
 */
export function describeBorangAFile(text: string): BorangAFileLineView[] {
  return borangAFileLines(text).map((l, i) => {
    const recordType = fileField(l, RECORD_TYPE);
    const layout = (BORANG_A_FILE_RECORD_TYPES as Record<string, keyof typeof BORANG_A_FILE_FIELDS | undefined>)[recordType] ?? null;
    const specs: [string, readonly [number, number]][] = layout
      ? Object.entries(BORANG_A_FILE_FIELDS[layout] as Record<string, readonly [number, number]>).map(([name, spec]) => [name, spec])
      : [];
    specs.sort((a, b) => a[1][0] - b[1][0]);
    const fields: BorangAFileFieldView[] = specs.map(([name, spec]) => ({
      name,
      offset: spec[0],
      length: spec[1],
      firstColumn: spec[0] + 1,
      lastColumn: spec[0] + spec[1],
      value: fileField(l, spec),
    }));
    const declaredEnd = fields.length ? Math.max(...fields.map((f) => f.offset + f.length)) : 0;
    if (l.length > declaredEnd) {
      fields.push({
        name: 'padding',
        offset: declaredEnd,
        length: l.length - declaredEnd,
        firstColumn: declaredEnd + 1,
        lastColumn: l.length,
        value: l.slice(declaredEnd),
      });
    }
    return { lineNo: i + 1, recordType, layout, length: l.length, fields };
  });
}

/** Cents → `10394.00`. The report prints money as money and everything else as characters. */
const ringgit = (c: number): string => `${Math.trunc(c / 100)}.${String(Math.abs(c % 100)).padStart(2, '0')}`;

/**
 * The validation report as plain ASCII text, for reading beside a KWSP sample.
 *
 * ASCII ONLY, deliberately: it describes a us-ascii file and is served as one, and a curly quote in the
 * report would be the one non-ASCII character in a document whose entire subject is byte positions.
 */
export function borangAFileReport(text: string): string {
  const lines = borangAFileLines(text);
  const views = describeBorangAFile(text);
  const out: string[] = [];

  out.push('KWSP BORANG A UPLOAD FILE - FIELD BY FIELD CHECK');
  out.push('');
  out.push('Every position below is read out of the one field table this system writes the file with,');
  out.push('and every value is read back out of the file itself. Hold it beside a KWSP sample line and');
  out.push('check that each value sits in the same columns.');
  out.push('');
  out.push(`Lines: ${lines.length}. Characters including line endings: ${text.length}.`);
  out.push(`Line endings: CRLF between lines, ${text.endsWith(BORANG_A_FILE_EOL) ? 'and one after the last line.' : 'none after the last line.'}`);
  const wrong = views.filter((v) => v.length !== BORANG_A_FILE_LINE_LENGTH);
  out.push(
    wrong.length === 0
      ? `Line length: every line is ${BORANG_A_FILE_LINE_LENGTH} characters.`
      : `Line length: ${wrong.length} line(s) are NOT ${BORANG_A_FILE_LINE_LENGTH} characters: ${wrong.map((v) => `line ${v.lineNo} is ${v.length}`).join(', ')}.`,
  );

  // The totals, stated only if the file parses as one. A malformed file still gets its field table.
  try {
    const t = parseBorangAFileTotals(text);
    out.push('');
    out.push(`Employee records: ${t.detailCount}, and the trailer says ${t.trailerCount}.`);
    out.push(
      `Employer contribution: RM ${ringgit(t.detailEmployerCents)} on the employee lines, RM ${ringgit(t.headerEmployerCents)} in the header, RM ${ringgit(t.trailerEmployerCents)} in the trailer.`,
    );
    out.push(
      `Employee contribution: RM ${ringgit(t.detailEmployeeCents)} on the employee lines, RM ${ringgit(t.headerEmployeeCents)} in the header, RM ${ringgit(t.trailerEmployeeCents)} in the trailer.`,
    );
    out.push(`Wages: RM ${ringgit(t.detailWageCents)} on the employee lines. No record in this format carries a wage total, so there is nothing to check that against.`);
    // Three states, not two: derived, could-not-be-carried, or supplied. The middle one is the reason
    // this report exists — it is the only place the operator can learn that the field went out as zeros.
    const controlWidth = BORANG_A_FILE_FIELDS.trailer.controlTotal[1];
    const sumTooWide = String(t.memberNoSum).length > controlWidth;
    out.push(
      t.controlTotal === t.memberNoSum
        ? `Control total: ${t.controlTotal}, which is the sum of the ${t.detailCount} EPF member numbers on the file.`
        : sumTooWide && Number(t.controlTotal) === 0
          ? `Control total: written as zeros. The ${t.detailCount} EPF member numbers sum to ${t.memberNoSum}, which needs ${String(t.memberNoSum).length} digits and this field holds ${controlWidth}. Zeros is what this file carried before the total could be derived at all; if KWSP rejects the file on this field, ask them what belongs in columns ${BORANG_A_FILE_FIELDS.trailer.controlTotal[0] + 1}-${BORANG_A_FILE_FIELDS.trailer.controlTotal[0] + controlWidth} for an employer of this size and supply it with the control parameter.`
          : `Control total: ${t.controlTotal}. It was supplied rather than derived - the ${t.detailCount} EPF member numbers on the file sum to ${t.memberNoSum}.`,
    );
  } catch (e) {
    out.push('');
    out.push(`This file does not parse as a Borang A upload file: ${e instanceof Error ? e.message : String(e)}`);
  }

  const w = Math.max(...views.flatMap((v) => v.fields.map((f) => f.name.length)), 5);
  for (const v of views) {
    out.push('');
    out.push(`LINE ${v.lineNo} - record type ${v.recordType}${v.layout ? '' : ' (UNKNOWN record type)'} - ${v.length} characters`);
    out.push(`  ${'columns'.padEnd(11)} ${'len'.padStart(3)}  ${'field'.padEnd(w)}  value`);
    for (const f of v.fields) {
      const cols = `${f.firstColumn}-${f.lastColumn}`.padEnd(11);
      out.push(`  ${cols} ${String(f.length).padStart(3)}  ${f.name.padEnd(w)}  [${f.value}]`);
    }
  }
  out.push('');
  return out.join('\n');
}

/**
 * ── THE READINESS CHECK, AND WHY IT IS NOT THE SAME LIST AS THE PRINTED FORM'S ────────────────────
 *
 * A value the DRAWN page can print quite happily may be one this file cannot carry. MEASURED on
 * production 2026-08-13: of the nine employees who have an EPF member number at all, FOUR carry a value
 * like `EPF9203030` — letters and digits. That prints on paper and is refused by a 19-digit numeric
 * field. Likewise one of the three companies with an EPF employer reference has `xx` in the box.
 *
 * So the file's readiness is its OWN list: the printed form blocks on ABSENCE, and this additionally
 * blocks on FORMAT, with a message that says which and why. Neither list is a superset of the other by
 * accident — they are computed from the same rows by two functions with two different jobs.
 */
export type BorangAFileProblem = { employmentId: string; name: string; problem: string };

export type BorangAFileReadiness = {
  /** Employer-level blockers — one gap here stops the whole file. */
  employer: string[];
  /** Per-employee blockers, each naming the person and what is wrong with their record. */
  employees: BorangAFileProblem[];
  /** True when nothing is in the way. */
  ok: boolean;
};

/**
 * What stops this company producing an upload file TODAY, named before the download rather than
 * discovered from a portal rejection. Pure; the review screen and the download route share it.
 */
export function borangAFileReadiness(p: {
  employerRef: string;
  rows: readonly { employmentId: string; name: string; memberNo: string; ic: string; wageRecorded: boolean }[];
}): BorangAFileReadiness {
  const employer: string[] = [];
  const ref = String(p.employerRef ?? '').trim();
  const refWidth = BORANG_A_FILE_FIELDS.header.employerRef[1];
  if (!ref) {
    employer.push('The company has no EPF employer reference number on file.');
  } else if (!/^\d+$/.test(ref)) {
    employer.push(`The EPF employer reference "${ref}" is not numeric, and the upload file's reference field holds ${refWidth} digits.`);
  } else if (ref.length > refWidth) {
    employer.push(`The EPF employer reference "${ref}" is ${ref.length} digits and the upload file's field holds ${refWidth}.`);
  }

  const memberWidth = BORANG_A_FILE_FIELDS.detail.memberNo[1];
  const icWidth = BORANG_A_FILE_FIELDS.detail.ic[1];
  const employees: BorangAFileProblem[] = [];
  for (const r of p.rows) {
    const memberNo = String(r.memberNo ?? '').trim();
    const icDigits = digitsOf(r.ic);
    if (!memberNo) {
      employees.push({ employmentId: r.employmentId, name: r.name, problem: 'no EPF member number' });
    } else if (!/^\d+$/.test(memberNo)) {
      employees.push({ employmentId: r.employmentId, name: r.name, problem: `EPF member number "${memberNo}" is not digits only` });
    } else if (memberNo.length > memberWidth) {
      employees.push({ employmentId: r.employmentId, name: r.name, problem: `EPF member number "${memberNo}" is longer than ${memberWidth} digits` });
    }
    if (icDigits.length !== icWidth) {
      employees.push({
        employmentId: r.employmentId,
        name: r.name,
        problem: icDigits.length === 0 ? 'no identity card number' : `identity card number has ${icDigits.length} digits, not ${icWidth}`,
      });
    }
    if (!r.wageRecorded) {
      employees.push({
        employmentId: r.employmentId,
        name: r.name,
        problem: 'this payroll run recorded no EPF wage basis, so the wage on the file would be a guess',
      });
    }
  }

  return { employer, employees, ok: employer.length === 0 && employees.length === 0 };
}
