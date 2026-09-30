/**
 * Item 2983802f — PER-SECTION IMPORT: the column contract, the fence, and the shared result shapes.
 *
 * Client-safe (no DB imports), for the same reason `lib/import-schema.ts` is: the screen builds the
 * templates from this list and the server (`core/import-sections.ts`) validates against the SAME list,
 * so a column can never be on a template the importer refuses or absent from one it accepts.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * The wide employee template (`IMPORT_COLUMNS`) CREATES employees, all 49 columns at once, and it is
 * untouched by this file. A SECTION import is the other half the reporter asked for: a narrow file,
 * one subject area, that UPDATES people who already exist. The two live side by side on the import
 * screen — the reporter was promised they would never be without a working import.
 *
 * THREE RULES ARE DECIDED HERE, because each of them silently corrupts a workforce if left to chance.
 *
 *  1. A BLANK CELL MEANS "LEAVE THIS AS IT IS". Never "clear it". A section file is narrow BY DESIGN,
 *     so most of an employee's record is absent from it; a file that nulled what it omitted would wipe
 *     data across hundreds of people in one confirm. Implemented in `core/import-sections.ts` by only
 *     ever putting a cell in a payload when the column is present AND the cell is non-blank, and it is
 *     pinned by a test that imports a Bank & Statutory file and reads the employee's ADDRESS back.
 *
 *  2. THE FENCE IS SERVER-SIDE, NOT "WHICH COLUMNS THE TEMPLATE SHIPPED WITH". The file is
 *     user-supplied: anyone can paste a Profile column into a Bank & Statutory sheet, or upload the
 *     wide template against a narrow section. So the section a column belongs to is declared here,
 *     once, and `foreignColumns()` below is what the server refuses on. A recognised column that
 *     belongs to a DIFFERENT section rejects the whole file — it is not silently ignored, because
 *     "I put the address in and nothing happened" is exactly as bad as writing it.
 *
 *  3. A COLUMN THAT NO SECTION OWNS MUST SAY WHY. `UNSECTIONED_COLUMNS` is not a leftovers bin: every
 *     entry carries the reason it cannot be bulk-updated, and `test/import-sections.test.ts` asserts
 *     that the sections plus that list plus the key column account for EVERY main-sheet column. A
 *     column added to the wide template in future therefore cannot quietly fail to be considered.
 */
import { DEPENDENT_IMPORT_COLUMNS, IMPORT_COLUMNS } from './import-schema';

/** The four sections the reporter named. Ordered as they appear in the chooser. */
export const IMPORT_SECTION_KEYS = ['profile', 'employment', 'bank_statutory', 'family'] as const;

export type ImportSection = (typeof IMPORT_SECTION_KEYS)[number];

export function isImportSection(v: string): v is ImportSection {
  return (IMPORT_SECTION_KEYS as readonly string[]).includes(v);
}

/**
 * THE KEY. Every section file is keyed on Employee ID and nothing else.
 *
 * Not email: an email address is edited (marriage, a domain migration), and the whole promise of this
 * feature is that the row you upload lands on the person you meant. `employee_code` is tenant-unique
 * and is the identifier HR already types on every other screen.
 */
export const SECTION_KEY_COLUMN = 'employee_code';

/** One section's contract: which columns its template carries, and which of those are required. */
export type ImportSectionDef = {
  key: ImportSection;
  /** Columns beyond the key that the row MUST carry a value for. Family needs a name + relationship;
   *  the other three need nothing, because "change only the bank account" is a legitimate file. */
  required: readonly string[];
  /** Everything else the section owns. Blank ⇒ left as it is. */
  optional: readonly string[];
  /** True when the section's rows are read against the FAMILY contract (`DEPENDENT_IMPORT_COLUMNS`)
   *  rather than the main employee sheet's. Family is the one section whose columns are a different
   *  contract entirely — `full_name` there names a spouse, not the employee. */
  family: boolean;
};

/**
 * PROFILE — who the person is: their name, how to reach them, their identity documents, their home
 * address and who to call in an emergency. Every one of these has a writer with presence semantics
 * (`updatePerson`) or a narrow partial setter (`setIc`, `setPassport`), which is precisely why they
 * are here and the organisational columns are not.
 */
const PROFILE_COLUMNS = [
  'full_name',
  'email',
  'phone',
  'ic_number',
  'passport_number',
  'passport_issue_date',
  'passport_expiry_date',
  'passport_issuing_country',
  'address_line_1',
  'address_line_2',
  'address_line_3',
  'postcode',
  'city',
  'state',
  'country',
  'emergency_contact_name',
  'emergency_contact_relationship',
  'emergency_contact_phone',
  'emergency_contact_home_phone',
  'emergency_contact_address',
] as const;

/**
 * EMPLOYMENT — the contractual periods the Employment tab maintains, plus the reporting line.
 *
 * DELIBERATELY NARROW. Department, position, cost centre, company, employment type and the join date
 * are NOT here: moving somebody between departments or companies is a dated organisational MOVEMENT
 * with its own history row, not a cell edit, and `setEmploymentInfo` refuses the join date outright
 * unless a movement tag accompanies it (core/org.ts). A spreadsheet column that silently did nothing
 * would be worse than no column at all. See `UNSECTIONED_COLUMNS`.
 *
 * WHAT THE PERIOD COLUMNS ACTUALLY WRITE, and why it is not the column of the same name. Migration
 * 0213 (955c7de4) redesigned the Employment tab's periods into a VALUE + UNIT pair — `probation_value`
 * / `probation_unit`, `notice_before_confirmation_value` / `_unit` — and the tab reads
 * `probationValue ?? probationMonths`. So an import that wrote only the legacy `probation_months`
 * column was INVISIBLE on that screen for every employee whose Employment tab had ever been saved:
 * a run that reported success and changed nothing anybody could see. `core/import-sections.ts` maps
 * `probation_months` → (value = N, unit = 'month') and `probation_days` → (value = N, unit = 'day'),
 * writing the matching legacy column alongside so the two never disagree. The screen holds ONE period
 * per field, so a row supplying BOTH months and days for the same period is refused rather than
 * silently losing half of it.
 */
const EMPLOYMENT_COLUMNS = [
  'probation_months',
  'probation_days',
  'confirmation_date',
  'resignation_notice_months',
  'resignation_notice_days',
  'direct_superior',
] as const;

/**
 * BANK AND STATUTORY — the salary-payment destination and the tax inputs.
 *
 * ALSO DELIBERATELY NARROW, and for a reason worth writing down: the EPF/SOCSO numbers, the EIS flag,
 * EPF citizenship and tax residency have NO partial writer. Their only writer is the full-row
 * statutory setter, which rewrites every column on the row from its arguments — so a file supplying
 * an EPF number alone would clear the employee's zakat election, TP3 opening balances, SOCSO category
 * and employer-bears flags. That is the exact catastrophe rule 1 exists to prevent, so those columns
 * are fenced out rather than written through an unsafe setter. `setBank` and `setTax` are the two
 * narrow setters that DO exist, and this list is exactly what they cover.
 */
const BANK_STATUTORY_COLUMNS = ['bank_name', 'bank_account_no', 'tax_number', 'tax_category', 'num_children'] as const;

export const IMPORT_SECTION_DEFS: Record<ImportSection, ImportSectionDef> = {
  profile: { key: 'profile', required: [], optional: PROFILE_COLUMNS, family: false },
  employment: { key: 'employment', required: [], optional: EMPLOYMENT_COLUMNS, family: false },
  bank_statutory: { key: 'bank_statutory', required: [], optional: BANK_STATUTORY_COLUMNS, family: false },
  family: {
    key: 'family',
    // The family sheet's own contract, minus the key it shares with the employee row.
    required: DEPENDENT_IMPORT_COLUMNS.required.filter((c) => c !== SECTION_KEY_COLUMN),
    optional: DEPENDENT_IMPORT_COLUMNS.optional,
    family: true,
  },
};

/**
 * Columns of the WIDE template that no section owns, each with the reason — see rule 3 above. The
 * reason strings are developer-facing (the screen shows a translated message); they exist so that the
 * next person to add a column has to answer the same question rather than guess.
 */
export const UNSECTIONED_COLUMNS: Record<string, string> = {
  company: 'moving an employee between legal entities is an Entity Transfer movement, not a cell edit',
  department: 'a department change is a dated organisational assignment with its own history row',
  position: 'a position change is a dated organisational assignment with its own history row',
  cost_center: 'a cost-centre change is a dated organisational assignment with its own history row',
  employment_type: 'employment type is carried by the dated assignment, not by a flat column',
  hired_on: 'the Group Join Date is movement-only (core/org.ts) — an untagged write is ignored',
  probation_end_date: 'the provisional end date is set at hire; there is no update writer for it',
  basic_salary: 'compensation is effective-dated; an import carries no effective date to price it from',
  monthly_allowance: 'compensation is effective-dated (see basic_salary)',
  pay_mode: 'compensation is effective-dated (see basic_salary)',
  payment_term: 'compensation is effective-dated (see basic_salary)',
  rate_amount: 'compensation is effective-dated (see basic_salary)',
  // r369 (item eb949191) — the remark belongs to ONE salary revision and says why THAT revision has
  // no basic amount. A section file carries no effective date, so it could not name the revision it
  // would be explaining; and on its own the column would let a file attach a reason to a record whose
  // basic salary it cannot see. It travels with the wide template, beside the amount it explains.
  salary_remarks:
    'the reason ONE salary revision has no basic amount; a section file carries no effective date, so it cannot name which revision it would be explaining (see basic_salary)',
  epf_number: 'no partial writer — the only setter rewrites the whole statutory row',
  socso_number: 'no partial writer — the only setter rewrites the whole statutory row',
  eis_eligible: 'no partial writer — the only setter rewrites the whole statutory row',
  epf_citizenship: 'no partial writer — the only setter rewrites the whole statutory row',
  is_resident:
    'tax residency is a four-way status (resident + three incentive statuses); a yes/no cell cannot express it',
};

/** Every column this section's template ships with, key first. */
export function sectionColumns(section: ImportSection): string[] {
  const def = IMPORT_SECTION_DEFS[section];
  return [SECTION_KEY_COLUMN, ...def.required, ...def.optional];
}

/**
 * THE FENCE, as a pure function so the server and a test can ask the same question.
 *
 * Given the header of an uploaded file, which of its columns does this section refuse? A column is
 * refused when it is one the importer RECOGNISES (a main-sheet column, or a family column) and this
 * section does not own it. Columns the importer has never heard of — a "Remarks" column somebody
 * keeps for themselves, a stray "Notes" — are NOT refused: they are ignored, exactly as they are on
 * the wide template today, because refusing them would reject real spreadsheets for no safety gain.
 */
export function foreignColumns(section: ImportSection, present: readonly string[]): string[] {
  const owned = new Set(sectionColumns(section));
  const recognised = new Set<string>([
    ...IMPORT_COLUMNS.required,
    ...IMPORT_COLUMNS.optional,
    ...DEPENDENT_IMPORT_COLUMNS.required,
    ...DEPENDENT_IMPORT_COLUMNS.optional,
  ]);
  const out: string[] = [];
  for (const c of present) {
    const col = c.trim();
    if (!col || owned.has(col) || !recognised.has(col)) continue;
    if (!out.includes(col)) out.push(col);
  }
  return out;
}

/**
 * Which section owns a column, or `null` when none does. Derived from the defs so it cannot drift.
 *
 * Family is searched LAST and the first match wins, which matters for the three names the family sheet
 * shares with the employee sheet (`full_name`, `phone`, `passport_number` — on the family contract they
 * describe a spouse, not the employee). Somebody who put `full_name` in a Bank and Statutory file meant
 * the employee's, so Profile is the section they are pointed at.
 */
export function sectionOwning(column: string): ImportSection | null {
  const order = [...IMPORT_SECTION_KEYS].sort((a, b) => Number(IMPORT_SECTION_DEFS[a].family) - Number(IMPORT_SECTION_DEFS[b].family));
  for (const s of order) {
    const def = IMPORT_SECTION_DEFS[s];
    if (def.required.includes(column) || def.optional.includes(column)) return s;
  }
  return null;
}

/** The section labels the REFUSAL message names. English, like every other server-side import message
 *  (`core/import.ts` does the same); the screen's own chrome is translated. */
export const SECTION_DISPLAY_NAMES: Record<ImportSection, string> = {
  profile: 'Profile',
  employment: 'Employment',
  bank_statutory: 'Bank and Statutory',
  family: 'Family',
};

/**
 * THE FENCE, SPLIT INTO THE TWO ANSWERS A REFUSAL HAS TO GIVE.
 *
 * The refusal used to tell everybody to "choose the section that owns them" — and for 17 of the wide
 * template's 49 columns NO SECTION OWNS THEM, so that instruction sent people looking for a door that
 * does not exist. The commonest bulk update HR would attempt (an EPF number) landed exactly there.
 * So a refused column is now classified:
 *
 *   `movable`     — another section owns it, and the message NAMES that section.
 *   `unsectioned` — no section owns it. The message says so plainly instead of implying one does.
 */
export function classifyForeignColumns(
  section: ImportSection,
  present: readonly string[],
): { movable: { column: string; section: ImportSection }[]; unsectioned: string[] } {
  const movable: { column: string; section: ImportSection }[] = [];
  const unsectioned: string[] = [];
  for (const col of foreignColumns(section, present)) {
    const owner = sectionOwning(col);
    if (owner) movable.push({ column: col, section: owner });
    else unsectioned.push(col);
  }
  return { movable, unsectioned };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// RESULT SHAPES — shared by the server service, the server action and the screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * WHAT IS ABOUT TO HAPPEN TO THIS ROW, decided in the dry run and shown in the preview before anything
 * is written. This is the reporter's "which of the two is about to happen is shown per row".
 *
 *   update  — the Employee ID matched somebody; the cells on this row will be applied to them.
 *   create  — the Employee ID matched nobody.
 *   skip    — matched, but there is nothing to do (every cell blank, or the family member is already
 *             on file). Distinguished from `update` so the preview never promises a change it will
 *             not make, and counted apart in the result so the numbers add up.
 *
 * `create` IS REFUSED IN THIS ROUND, on every section, and the row carries the reason. A narrow file
 * has no name, no work email, no IC, no department and no salary — there is nothing to bring a person
 * into existence FROM. The verdict is still computed and displayed rather than the row being quietly
 * dropped, because "this ID matched nobody" is the single most likely mistake in a bulk update and HR
 * has to see it before they confirm. The wide template remains the create path.
 */
export type SectionRowVerdict = 'create' | 'update' | 'skip';

export type SectionRowResult = {
  /** 1-based data row (header excluded). */
  rowNum: number;
  employeeCode: string;
  /** The matched employee's name, so the preview shows WHO the row is about to change — the row
   *  itself usually carries only an ID. Empty when nothing matched. */
  employeeName: string;
  verdict: SectionRowVerdict;
  ok: boolean;
  errors: string[];
  warnings: string[];
  /**
   * The human labels of the fields this row will actually change. This is the other half of
   * "check before you confirm": a per-row verdict of "Update" says nothing about WHAT is being
   * updated, and on a wide-ish Profile file that is the whole question.
   */
  changes: string[];
};

export type SectionImportPreview = {
  section: ImportSection;
  total: number;
  /** Rows that will be written. */
  updateCount: number;
  /** Rows that matched but have nothing to do. */
  skipCount: number;
  /** Rows whose Employee ID matched nobody (all refused this round — see `SectionRowVerdict`). */
  createCount: number;
  rows: SectionRowResult[];
  /** Required columns (the key, plus the section's own) that the file does not carry at all. */
  missingColumns: string[];
  /** WHOLE-FILE refusals — the fence, and a missing key column. Non-empty ⇒ nothing is written. */
  fileErrors: string[];
};

export type SectionImportResult = {
  section: ImportSection;
  /** Rows applied. */
  updated: number;
  /** Rows that matched but had nothing to change, plus rows rejected by the dry run. */
  skipped: number;
  /** Rows that matched and were valid, but whose write threw. */
  failed: { rowNum: number; employeeCode: string; message: string }[];
  fileErrors: string[];
  /** cf43c909 — the history row this run wrote, so the screen can link to it. Null when the history
   *  write itself failed: recording a run must never fail an update that already happened. */
  runId: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// TEMPLATE SHAPE — the workbook each section downloads
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The data sheet's name per section. Kept in English and stable: `readImportFile` reads the FIRST
 * worksheet, so the name is not load-bearing on upload — but a renamed sheet in a saved file that
 * somebody re-downloads next year should still look like the one they filled in last time.
 */
export const SECTION_SHEET_NAMES: Record<ImportSection, string> = {
  profile: 'Profile',
  employment: 'Employment',
  bank_statutory: 'Bank and Statutory',
  family: 'Family',
};

export const SECTION_TEMPLATE_FILENAMES: Record<ImportSection, string> = {
  profile: 'profile-update-template.xlsx',
  employment: 'employment-update-template.xlsx',
  bank_statutory: 'bank-statutory-update-template.xlsx',
  family: 'family-update-template.xlsx',
};

/**
 * Columns stamped as TEXT (`z: '@'`) in a section template — identifiers whose digits must survive
 * verbatim. Excel turns `0123456789` in a General cell into the NUMBER 123456789 IN THE FILE, and no
 * importer can undo that. Same list and same reasoning as the wide template's; the Employee ID is on
 * it because here it is the KEY — mangle it and the row matches nobody.
 */
export const SECTION_TEXT_COLUMN_KEYS: readonly string[] = [
  SECTION_KEY_COLUMN,
  'ic_number',
  'phone',
  'bank_account_no',
  'tax_number',
  'passport_number',
  'ic_or_passport',
];

/** 0-based positions of those columns within this section's header row. */
export function sectionTextColumnIndexes(section: ImportSection): number[] {
  const cols = sectionColumns(section);
  return SECTION_TEXT_COLUMN_KEYS.map((k) => cols.indexOf(k)).filter((i) => i >= 0);
}
