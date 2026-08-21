/**
 * 18c1d92b — THE PERKESO ASSIST PORTAL UPLOAD FILE (combined SOCSO + EIS). PURE: no DB, no pack, no React.
 *
 * ⚠️ THE SPECIFICATION IS A REAL FILED FILE, NOT A DESCRIPTION OF ONE. Every width, offset and pad rule
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

/** Every record is exactly this wide, before the CRLF. */
export const PERKESO_FILE_LINE_LENGTH = 278;
/** CRLF between records. NOT after the last one — see the header. */
export const PERKESO_FILE_EOL = '\r\n';

/**
 * The layout of the attached file, transcribed ONCE. `[offset, width]`, both 0-based, so a field occupies
 * `[offset, offset + width)`. The writer, the shape check, the report and the tests all read THESE
 * numbers; nothing below restates an offset.
 */
export const PERKESO_FILE_FIELDS = {
  employerCode: [0, 12],
  myCoId: [12, 20],
  identityNo: [32, 12],
  name: [44, 150],
  contributionMonth: [194, 6],
  wage: [200, 14],
  socsoEmployer: [214, 6],
  socsoEmployee: [220, 6],
  eisEmployer: [226, 6],
  eisEmployee: [232, 6],
  filler1: [238, 20],
  filler2: [258, 20],
} as const;

/** The six boxes that carry money, in the order the record writes them. Named once so the shape check and
 *  the report cannot disagree with the writer about which fields are numeric. */
export const PERKESO_FILE_AMOUNT_FIELDS = [
  'wage',
  'socsoEmployer',
  'socsoEmployee',
  'eisEmployer',
  'eisEmployee',
] as const;

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

/** Right-justified digits, SPACE-padded to exactly `width`. Refuses an overflow — never truncates money. */
function amountField(value: number, width: number, field: string, who: string): string {
  const s = String(value);
  if (s.length > width) {
    fail(`${who}: ${field} needs ${s.length} characters and the box holds ${width}. The file cannot carry it.`);
  }
  return s.padStart(width, ' ');
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

/** `slice` by a `[offset, width]` entry from PERKESO_FILE_FIELDS. One reader, so no offset is restated. */
export function perkesoField(record: string, spec: readonly [number, number]): string {
  return record.slice(spec[0], spec[0] + spec[1]);
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
  }));
}

/**
 * Build the upload file. Returns the whole file as one string, CRLF between records and none after the
 * last, exactly as the attached file is.
 */
export function buildPerkesoSocsoFile(input: PerkesoFileInput): string {
  const F = PERKESO_FILE_FIELDS;
  const { employer, employees } = input;

  const month = Number(employer.periodMonth);
  const year = Number(employer.periodYear);
  if (!Number.isInteger(month) || month < 1 || month > 12) fail(`Contribution month must be 1-12, got ${employer.periodMonth}`);
  if (!Number.isInteger(year) || year < 1900 || year > 9999) fail(`Contribution year must be four digits, got ${employer.periodYear}`);
  // MMYYYY — the request is explicit that YYYYMM and MM/YY are both wrong, and the attached file agrees.
  const contributionMonth = `${String(month).padStart(2, '0')}${year}`;

  const employerCode = idField(employer.employerCode, F.employerCode[1], 'employer code', 'Employer');
  if (!String(employer.employerCode ?? '').trim()) fail('Employer: the PERKESO employer code is required and is not on file.');
  const myCoId = idField(employer.myCoId ?? '', F.myCoId[1], 'MyCoID / SSM number', 'Employer');

  if (employees.length === 0) fail('There is nobody to file for in this period.');

  const records = employees.map((e, i) => {
    const who = e.name?.trim() || `employee ${i + 1}`;
    // The identity box is twelve characters and the request is explicit that it must not be treated as a
    // number: dashes are removed, everything else is written as given and must FIT.
    const identity = String(e.identityNo ?? '').replace(/[-\s]/g, '');
    if (identity.length !== F.identityNo[1]) {
      fail(
        `${who}: the identity number must be exactly ${F.identityNo[1]} characters once dashes are removed, got "${e.identityNo}" (${identity.length}).`,
      );
    }
    // ⚠️ THE WAGE IS A REFUSAL, NOT A ZERO. See the module header: a payslip written before the wage base
    // was stamped cannot produce this box, and gross pay is a different number.
    if (e.wage == null) {
      throw new PerkesoFileError(
        `${who}: no SOCSO wage was recorded on their payslip for this month, so the salary box cannot be filled. Reprocess the run, or file this employee by hand.`,
      );
    }
    return (
      employerCode +
      myCoId +
      identity +
      textField(e.name, F.name[1]) +
      contributionMonth +
      amountField(sen(e.wage, 'wage', who), F.wage[1], 'wage', who) +
      amountField(sen(e.socsoEmployer, 'SOCSO employer contribution', who), F.socsoEmployer[1], 'SOCSO employer contribution', who) +
      amountField(sen(e.socsoEmployee, 'SOCSO employee contribution', who), F.socsoEmployee[1], 'SOCSO employee contribution', who) +
      amountField(sen(e.eisEmployer, 'EIS employer contribution', who), F.eisEmployer[1], 'EIS employer contribution', who) +
      amountField(sen(e.eisEmployee, 'EIS employee contribution', who), F.eisEmployee[1], 'EIS employee contribution', who) +
      spaces(F.filler1[1]) +
      spaces(F.filler2[1])
    );
  });

  const text = records.join(PERKESO_FILE_EOL);
  // THE FILE CHECKS ITSELF, from the bytes rather than from the intent.
  assertPerkesoFileShape(text);
  return text;
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
export function assertPerkesoFileShape(text: string): void {
  const records = perkesoFileRecords(text);
  if (records.length === 0) fail('the file has no records');
  for (const [i, r] of records.entries()) {
    const at = `record ${i + 1}`;
    if (r.length !== PERKESO_FILE_LINE_LENGTH) {
      fail(`${at} is ${r.length} characters and every record must be ${PERKESO_FILE_LINE_LENGTH}`);
    }
    for (const key of PERKESO_FILE_AMOUNT_FIELDS) {
      const v = perkesoField(r, PERKESO_FILE_FIELDS[key]);
      if (!/^ *\d+$/.test(v)) fail(`${at}: ${key} reads "${v}", which is not a right-justified number`);
    }
    for (const key of ['filler1', 'filler2'] as const) {
      const v = perkesoField(r, PERKESO_FILE_FIELDS[key]);
      if (v !== spaces(PERKESO_FILE_FIELDS[key][1])) fail(`${at}: ${key} must be blank, got "${v}"`);
    }
  }
}

export type PerkesoFieldView = { name: string; position: string; length: number; value: string };
export type PerkesoRecordView = { recordNo: number; length: number; ok: boolean; fields: PerkesoFieldView[] };

/**
 * The validation report the request asks for: every record, field by field, with the 1-based character
 * positions a person can count against a PERKESO sample. Reads the SAME field table the writer used.
 */
export function describePerkesoFile(text: string): PerkesoRecordView[] {
  return perkesoFileRecords(text).map((r, i) => ({
    recordNo: i + 1,
    length: r.length,
    ok: r.length === PERKESO_FILE_LINE_LENGTH,
    fields: (Object.keys(PERKESO_FILE_FIELDS) as (keyof typeof PERKESO_FILE_FIELDS)[]).map((name) => {
      const [offset, width] = PERKESO_FILE_FIELDS[name];
      return { name, position: `${offset + 1}-${offset + width}`, length: width, value: perkesoField(r, [offset, width]) };
    }),
  }));
}

/** The report as plain ASCII, for reading beside a PERKESO sample. ASCII only, deliberately: it describes
 *  a us-ascii file and a curly quote in a document about byte positions would be its own joke. */
export function perkesoFileReport(text: string): string {
  const views = describePerkesoFile(text);
  const out: string[] = [];
  out.push('PERKESO SOCSO + EIS UPLOAD FILE - RECORD BY RECORD CHECK');
  out.push('');
  out.push('Every position below is read out of the one field table this system writes the file with, and');
  out.push('every value is read back out of the file itself. Hold it beside a PERKESO sample and check that');
  out.push('each value sits in the same columns.');
  out.push('');
  out.push(`Records: ${views.length}. Characters including line endings: ${text.length}.`);
  const wrong = views.filter((v) => !v.ok);
  out.push(
    wrong.length === 0
      ? `Record length: every record is ${PERKESO_FILE_LINE_LENGTH} characters.`
      : `Record length: ${wrong.length} record(s) are NOT ${PERKESO_FILE_LINE_LENGTH}: ${wrong.map((v) => `record ${v.recordNo} is ${v.length}`).join(', ')}.`,
  );
  out.push(`Line endings: CRLF between records, ${text.endsWith(PERKESO_FILE_EOL) ? 'and one after the last.' : 'none after the last.'}`);
  for (const v of views) {
    out.push('');
    out.push(`Record ${v.recordNo} (${v.length} characters)`);
    for (const f of v.fields) {
      out.push(`  ${f.position.padStart(7)}  ${f.name.padEnd(18)} [${f.value}]`);
    }
  }
  return out.join('\n') + '\n';
}
