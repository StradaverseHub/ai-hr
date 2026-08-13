/**
 * 3aae0789 — THE KWSP BORANG A UPLOAD FILE for i-Akaun (Employer). PURE: no DB, no pack, no React.
 *
 * ⚠️ THE REQUEST IS THE SPECIFICATION AND IS NOT RE-DERIVED HERE. Every width, offset, pad rule and
 * literal below is transcribed from the field tables in feedback item 3aae0789, which the reporter
 * produced by reverse-engineering a real sample file and validating its totals. The reference module they
 * mention (`generateEpfBorangA.js`) is NOT in this repository, so the tables are the only source — and
 * `BORANG_A_FILE_FIELDS` states them ONCE, as data, so the writer and the verifier read the same numbers
 * and test/kwsp-borang-a-file.test.ts can assert against the table rather than against a second copy of it.
 *
 * ── FOUR RECORD TYPES, IN ORDER ───────────────────────────────────────────────────────────────────
 *   00  header          — file date, batch no., total wages, total contribution, employer reference
 *   01  employer        — employer reference, contribution period MMYYYY, 3-char short code, batch no.
 *   02  employee detail — one per employee; member no., IC, name, staff no., wages, contribution, balance
 *   99  trailer         — 02 count, total wages, total contribution, control number
 * 129 characters per line, space-padded to the full width, CRLF endings, trailing CRLF on the last line.
 *
 * ── THE INVARIANT, ENFORCED BEFORE THE FILE IS EVER OFFERED ───────────────────────────────────────
 * header totals == trailer totals == the sum over the 02 records, and the trailer's record count == the
 * number of 02 lines. `buildBorangAFile` re-reads its OWN output through `assertBorangAFileBalances`
 * before returning it, so the check runs against the emitted bytes rather than against the numbers the
 * writer intended — the two are different things, and only the first is what i-Akaun sees. Refusing to
 * emit is the whole point: a file that does not add up is rejected at the portal, which is a slower and
 * more expensive way to learn the same fact.
 *
 * ── THE TRAILER'S CONTROL NUMBER (positions 51-60) IS UNRESOLVED, AND STAYS THAT WAY ──────────────
 * The reporter could not derive it from their sample: it is NOT the employer reference and matches no
 * simple sum. It is a PARAMETER defaulting to nine zeros. NOTHING here guesses a derivation — an invented
 * control number would produce files that look right and are rejected for a reason nobody can see.
 *
 * ── THE ACCOUNT BALANCE IS ZERO, AND THAT IS A FACT ABOUT WHO HOLDS IT ────────────────────────────
 * Positions 114-129 of the 02 record are the member's EPF account balance. An employer does not hold that
 * figure — KWSP does — and this system stores it nowhere. It is written as zeros, which the request's own
 * signature already allows ("balance … optional, defaults to 0").
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
/** CRLF, as the request specifies. Not the platform's newline — this file crosses machines. */
export const BORANG_A_FILE_EOL = '\r\n';
/** The 00 record's literal description, 18 characters wide. */
export const BORANG_A_FILE_DESCRIPTION = 'EPF MONTHLY FORM A';

/**
 * The field tables from item 3aae0789, transcribed once. `[offset, width]`, both 0-based, so a field
 * occupies `[offset, offset + width)`. The writer, the verifier and the tests all read THESE numbers;
 * nothing below restates an offset.
 */
export const BORANG_A_FILE_FIELDS = {
  header: {
    recordType: [0, 2],
    description: [2, 18],
    fileDate: [20, 8],
    batchNo: [28, 5],
    totalWages: [33, 15],
    totalContribution: [48, 15],
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
    wages: [96, 9],
    contribution: [105, 9],
    balance: [114, 15],
  },
  trailer: {
    recordType: [0, 2],
    recordCount: [2, 7],
    totalWages: [9, 15],
    totalContribution: [24, 15],
    filler: [39, 12],
    controlNumber: [51, 9],
  },
} as const;

/** One employee line of the upload file. Mirrors the request's own `generateBorangAFile` signature. */
export type BorangAFileEmployee = {
  /** No. Ahli. Digits only; zero-padded to 19 in the record. */
  epfMemberNo: string;
  /** IC. Dashes and spaces are stripped; must be exactly 12 digits once stripped. */
  icNumber: string;
  /** Uppercased and truncated to 40 characters. */
  name: string;
  /** Employee/staff number. Truncated to 20 characters. */
  staffNo?: string;
  /** RM, plain number. */
  wages: number;
  /** RM, plain number — employer + employee for the month. */
  contribution: number;
  /** RM. Optional and effectively always 0: an employer does not hold a member's EPF balance. */
  balance?: number;
};

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
  /** The unresolved trailer field. Defaults to nine zeros. Never derived. */
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
 * Build the upload file. Returns the whole file as one string, CRLF-terminated including the last line.
 *
 * Refuses — rather than emitting something i-Akaun will reject — when: the employer reference is not
 * 1-9 digits, a member number is not digits or too long, an IC is not exactly 12 digits, an amount is
 * negative or too large for its field, the short code is longer than 3 characters, the batch number does
 * not fit 5 digits, or the control number is not up to 9 digits. Every message names the field and, for a
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
  // file is exactly the kind of thing a single transcription of the tables above prevents.
  const period = `${String(month).padStart(2, '0')}${year}`;

  const codeRaw = String(employer.code ?? '').trim();
  const codeWidth = BORANG_A_FILE_FIELDS.employer.shortCode[1];
  if (codeRaw.length > codeWidth) fail(`Employer short code must be at most ${codeWidth} characters, got "${codeRaw}"`);
  const shortCode = textField(codeRaw, codeWidth);

  const batchNo = numField(input.batchNo ?? 1, BORANG_A_FILE_FIELDS.header.batchNo[1], 'Batch number');

  const controlWidth = BORANG_A_FILE_FIELDS.trailer.controlNumber[1];
  const controlRaw = String(input.trailerControlNumber ?? '').trim();
  // UNRESOLVED, AND NOT DERIVED. Blank ⇒ zeros, exactly as the request instructs.
  const controlNumber = controlRaw ? digitField(controlRaw, controlWidth, 'Trailer control number') : zeros(controlWidth);

  const d = input.fileDate ?? new Date();
  if (Number.isNaN(d.getTime())) fail('File date is not a valid date');
  const fileDate = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

  // ── 02 records, and the totals THEY produce ─────────────────────────────────────────────────────
  // The totals are summed from the very rows that get written, never passed in beside them. That is the
  // structural half of the invariant; `assertBorangAFileBalances` below is the check that it held.
  let totalWageCents = 0;
  let totalContribCents = 0;
  const detail = employees.map((e, i) => {
    const who = e.name?.trim() || `employee ${i + 1}`;
    const memberNo = digitField(e.epfMemberNo, BORANG_A_FILE_FIELDS.detail.memberNo[1], `${who}: EPF member number`);
    const icDigits = digitsOf(e.icNumber);
    const icWidth = BORANG_A_FILE_FIELDS.detail.ic[1];
    if (icDigits.length !== icWidth) {
      fail(`${who}: identity card number must be exactly ${icWidth} digits once dashes are removed, got "${e.icNumber}" (${icDigits.length}).`);
    }
    const wageCents = cents(e.wages, `${who}: wages`);
    const contribCents = cents(e.contribution, `${who}: contribution`);
    const balanceCents = cents(e.balance ?? 0, `${who}: account balance`);
    totalWageCents += wageCents;
    totalContribCents += contribCents;
    return line(
      '02' +
        memberNo +
        icDigits +
        spaces(BORANG_A_FILE_FIELDS.detail.filler[1]) +
        textField(e.name, BORANG_A_FILE_FIELDS.detail.name[1]) +
        textField(e.staffNo ?? '', BORANG_A_FILE_FIELDS.detail.staffNo[1]) +
        numField(wageCents, BORANG_A_FILE_FIELDS.detail.wages[1], `${who}: wages`) +
        numField(contribCents, BORANG_A_FILE_FIELDS.detail.contribution[1], `${who}: contribution`) +
        numField(balanceCents, BORANG_A_FILE_FIELDS.detail.balance[1], `${who}: account balance`),
    );
  });

  const header = line(
    '00' +
      textField(BORANG_A_FILE_DESCRIPTION, BORANG_A_FILE_FIELDS.header.description[1]) +
      fileDate +
      batchNo +
      numField(totalWageCents, BORANG_A_FILE_FIELDS.header.totalWages[1], 'Total wages') +
      numField(totalContribCents, BORANG_A_FILE_FIELDS.header.totalContribution[1], 'Total contribution') +
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
      numField(totalWageCents, BORANG_A_FILE_FIELDS.trailer.totalWages[1], 'Total wages') +
      numField(totalContribCents, BORANG_A_FILE_FIELDS.trailer.totalContribution[1], 'Total contribution') +
      zeros(BORANG_A_FILE_FIELDS.trailer.filler[1]) +
      controlNumber,
  );

  const text = [header, employerRecord, ...detail, trailer].map((l) => l + BORANG_A_FILE_EOL).join('');
  // THE FILE CHECKS ITSELF, from the bytes rather than from the intent. See the header comment.
  assertBorangAFileBalances(text);
  return text;
}

/** What a parsed file says about itself. Returned by `parseBorangAFileTotals` for tests and diagnostics. */
export type BorangAFileTotals = {
  headerWageCents: number;
  headerContribCents: number;
  trailerWageCents: number;
  trailerContribCents: number;
  trailerCount: number;
  detailWageCents: number;
  detailContribCents: number;
  detailCount: number;
};

/**
 * Read the totals back OUT of an emitted file. Deliberately re-parses the characters rather than trusting
 * anything the writer held: the invariant is a property of the FILE, and a check that reads the writer's
 * own variables cannot see a mis-placed field.
 */
export function parseBorangAFileTotals(text: string): BorangAFileTotals {
  const lines = text.split(BORANG_A_FILE_EOL).filter((l) => l.length > 0);
  if (lines.length < 3) fail(`a Borang A file needs at least a 00, a 01 and a 99 record; got ${lines.length} lines`);
  for (const [i, l] of lines.entries()) {
    if (l.length !== BORANG_A_FILE_LINE_LENGTH) {
      fail(`line ${i + 1} is ${l.length} characters, and every line must be ${BORANG_A_FILE_LINE_LENGTH}`);
    }
  }
  const header = lines[0];
  const employerRecord = lines[1];
  const trailer = lines[lines.length - 1];
  if (header.slice(0, 2) !== '00') fail(`the first record must be 00, got "${header.slice(0, 2)}"`);
  if (employerRecord.slice(0, 2) !== '01') fail(`the second record must be 01, got "${employerRecord.slice(0, 2)}"`);
  if (trailer.slice(0, 2) !== '99') fail(`the last record must be 99, got "${trailer.slice(0, 2)}"`);

  const detail = lines.slice(2, -1);
  for (const [i, l] of detail.entries()) {
    if (l.slice(0, 2) !== '02') fail(`record ${i + 3} must be 02, got "${l.slice(0, 2)}"`);
  }

  const int = (s: string, what: string): number => {
    if (!/^\d+$/.test(s)) fail(`${what} is not numeric: "${s}"`);
    return Number(s);
  };

  const F = BORANG_A_FILE_FIELDS;
  let detailWageCents = 0;
  let detailContribCents = 0;
  for (const [i, l] of detail.entries()) {
    detailWageCents += int(fileField(l, F.detail.wages), `02 record ${i + 1} wages`);
    detailContribCents += int(fileField(l, F.detail.contribution), `02 record ${i + 1} contribution`);
  }

  return {
    headerWageCents: int(fileField(header, F.header.totalWages), 'header total wages'),
    headerContribCents: int(fileField(header, F.header.totalContribution), 'header total contribution'),
    trailerWageCents: int(fileField(trailer, F.trailer.totalWages), 'trailer total wages'),
    trailerContribCents: int(fileField(trailer, F.trailer.totalContribution), 'trailer total contribution'),
    trailerCount: int(fileField(trailer, F.trailer.recordCount), 'trailer record count'),
    detailWageCents,
    detailContribCents,
    detailCount: detail.length,
  };
}

/**
 * THE INVARIANT: header totals == trailer totals == the sum over the 02 records, and the trailer's count
 * == the number of 02 records. Throws `BorangAFileError` naming the first thing that does not agree.
 *
 * Pinned by mutating one 02 line of a good file and asserting the refusal — the test the item asks for
 * by name, and the only one that proves the check reads the FILE rather than the writer's arithmetic.
 */
export function assertBorangAFileBalances(text: string): void {
  const t = parseBorangAFileTotals(text);
  if (t.headerWageCents !== t.detailWageCents) {
    fail(`total wages do not add up: the header says ${t.headerWageCents} and the ${t.detailCount} employee records sum to ${t.detailWageCents}.`);
  }
  if (t.trailerWageCents !== t.detailWageCents) {
    fail(`total wages do not add up: the trailer says ${t.trailerWageCents} and the ${t.detailCount} employee records sum to ${t.detailWageCents}.`);
  }
  if (t.headerContribCents !== t.detailContribCents) {
    fail(`total contribution does not add up: the header says ${t.headerContribCents} and the ${t.detailCount} employee records sum to ${t.detailContribCents}.`);
  }
  if (t.trailerContribCents !== t.detailContribCents) {
    fail(`total contribution does not add up: the trailer says ${t.trailerContribCents} and the ${t.detailCount} employee records sum to ${t.detailContribCents}.`);
  }
  if (t.trailerCount !== t.detailCount) {
    fail(`record count does not match: the trailer says ${t.trailerCount} and the file carries ${t.detailCount} employee records.`);
  }
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
