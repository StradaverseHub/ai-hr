/**
 * 18c1d92b — THE PERKESO ASSIST PORTAL UPLOAD FILE (combined SOCSO + EIS). PURE: no DB, no pack, no React.
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
  /** Defaults to now. Injectable ONLY so the future-month refusal can be tested without a clock. */
  today?: Date;
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
    const problems = perkesoRecordProblems(r, `record ${i + 1}`);
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
export function perkesoRecordProblems(record: string, at: string): string[] {
  const problems: string[] = [];
  if (record.length !== PERKESO_FILE_LINE_LENGTH) {
    problems.push(`${at} is ${record.length} characters and every record must be ${PERKESO_FILE_LINE_LENGTH}`);
  }
  for (const key of PERKESO_FILE_AMOUNT_FIELDS) {
    const v = perkesoField(record, PERKESO_FILE_FIELDS[key]);
    if (!/^ *\d+$/.test(v)) problems.push(`${at}: ${key} reads "${v}", which is not a right-justified number`);
  }
  for (const key of ['filler1', 'filler2'] as const) {
    const v = perkesoField(record, PERKESO_FILE_FIELDS[key]);
    if (v !== spaces(PERKESO_FILE_FIELDS[key][1])) problems.push(`${at}: ${key} must be blank, got "${v}"`);
  }
  return problems;
}

export type PerkesoFieldView = { name: string; position: string; length: number; value: string };
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
export function describePerkesoFile(text: string): PerkesoRecordView[] {
  return perkesoFileRecords(text).map((r, i) => {
    const problems = perkesoRecordProblems(r, `record ${i + 1}`);
    return {
      recordNo: i + 1,
      length: r.length,
      ok: problems.length === 0,
      problems,
      fields: (Object.keys(PERKESO_FILE_FIELDS) as (keyof typeof PERKESO_FILE_FIELDS)[]).map((name) => {
        const [offset, width] = PERKESO_FILE_FIELDS[name];
        return { name, position: `${offset + 1}-${offset + width}`, length: width, value: perkesoField(r, [offset, width]) };
      }),
    };
  });
}

export type PerkesoAmountField = (typeof PERKESO_FILE_AMOUNT_FIELDS)[number];

export type PerkesoFileTotals = {
  /** How many records the figures below were added up over. */
  records: number;
  /** Records left OUT because they did not validate. Naming them is the point — see below. */
  excluded: number[];
  /** Integer sen per money box, exactly as the file carries them: no decimal point, no separator. */
  sen: Record<PerkesoAmountField, number>;
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
export function perkesoFileTotals(text: string): PerkesoFileTotals {
  const sen = Object.fromEntries(PERKESO_FILE_AMOUNT_FIELDS.map((k) => [k, 0])) as Record<PerkesoAmountField, number>;
  const excluded: number[] = [];
  let records = 0;
  for (const view of describePerkesoFile(text)) {
    if (!view.ok) {
      excluded.push(view.recordNo);
      continue;
    }
    records += 1;
    for (const key of PERKESO_FILE_AMOUNT_FIELDS) {
      const field = view.fields.find((f) => f.name === key);
      sen[key] += Number((field?.value ?? '').trim());
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

/** What each money box is called in a sentence, rather than in the field table's camelCase. */
const AMOUNT_LABEL: Record<PerkesoAmountField, string> = {
  wage: 'Salary (the SOCSO/EIS wage)',
  socsoEmployer: 'SOCSO employer contribution',
  socsoEmployee: 'SOCSO employee contribution',
  eisEmployer: 'EIS employer contribution',
  eisEmployee: 'EIS employee contribution',
};

/**
 * The report as plain ASCII, for reading beside a PERKESO sample. ASCII only, deliberately: it describes
 * a us-ascii file and a curly quote in a document about byte positions would be its own joke.
 *
 * ⚠️ THERE IS NO SKBBK / LINDUNG 24 JAM TOTAL HERE AND THERE MUST NOT BE ONE. The request asks for it;
 * the specification this file is written to has no such field, so this file carries no such contribution.
 * A line reading "SKBBK: RM 0.00" would be a statement about money on a return that does not mention it —
 * an assurance nobody can stand behind, which is worse than the gap it fills. If PERKESO publishes a
 * format that adds the column, the FIELD TABLE gains it first and this report follows.
 */
export function perkesoFileReport(text: string): string {
  const views = describePerkesoFile(text);
  const totals = perkesoFileTotals(text);
  const out: string[] = [];
  out.push('PERKESO SOCSO + EIS UPLOAD FILE - RECORD BY RECORD CHECK');
  out.push('');
  out.push('Every position below is read out of the one field table this system writes the file with, and');
  out.push('every value is read back out of the file itself. Hold it beside a PERKESO sample and check that');
  out.push('each value sits in the same columns.');
  out.push('');
  out.push(`Specification: PERKESO "${PERKESO_FILE_SPEC.name}",`);
  out.push(
    `${PERKESO_FILE_SPEC.version} of ${PERKESO_FILE_SPEC.dated}. One record per employee, ` +
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

  out.push('');
  out.push('TOTALS, ADDED UP FROM THE VALUES READ BACK OUT OF THIS FILE');
  out.push('Not from the payroll figures the file was written from. A total taken from the input would');
  out.push('agree with itself even if a value had been written into the wrong box, which is the one thing');
  out.push('these totals exist to catch.');
  out.push('The file carries every amount as CENTS WITH NO DECIMAL POINT, so the digits it actually holds');
  out.push('are printed beside each RM figure. Check both.');
  for (const key of PERKESO_FILE_AMOUNT_FIELDS) {
    out.push(`  ${AMOUNT_LABEL[key].padEnd(28)} RM ${rm(totals.sen[key]).padStart(11)}   in the file: ${totals.sen[key]}`);
  }
  out.push(`Added up over ${totals.records} record(s) of ${views.length}.`);

  for (const v of views) {
    out.push('');
    out.push(`Record ${v.recordNo} (${v.length} characters)`);
    for (const f of v.fields) {
      out.push(`  ${f.position.padStart(7)}  ${f.name.padEnd(18)} [${f.value}]`);
    }
  }
  return out.join('\n') + '\n';
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
  const [offset, width] = PERKESO_FILE_FIELDS.myCoId;
  const where = blank.length === views.length ? 'on every record' : `on ${blank.map((v) => `record ${v.recordNo}`).join(', ')}`;
  return [
    `MyCoID / business registration number: positions ${offset + 1}-${offset + width} are EMPTY ${where}.`,
    'PERKESO marks this field as not mandatory, so the file is valid without it and the portal should',
    'accept it. If the file you filed before carries a number in that box, set it under Organization ->',
    'the company -> Statutory identity, then download the file again.',
  ];
}
