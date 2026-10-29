import {createHash} from 'node:crypto';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import { getPeopleGeneral, readPeopleGeneralTx, occupiedNricsTx } from './people-general';
import { NRIC_DUPLICATE_MESSAGE, NRIC_FILE_DUPLICATE_MESSAGE } from '../lib/nric-policy-message';
import { pgSqlState } from '../lib/db-error';
import { publicErrorMessage } from '../lib/public-error';
import {assertWorkforceEmploymentTx,assertWorkforcePersonTx} from './workforce-access';
import {personnelOperationalValues,PERSONNEL_OPERATIONAL_FIELDS,type PersonnelOperationalPatch} from '../lib/personnel-operational-import';
import {applyPersonnelOperationalValuesTx} from './personnel-import-operations';
import {assertCardIdFree} from './attendance-card';
import {bankTransferLacksBank} from '../lib/payment-methods';
import {isPersonnelRegisterKind} from '../lib/personnel-register-import';
import {validateRegisterSection,commitRegisterSection} from './personnel-register-import';
import { PersonnelImportCatalog, normalizePersonnelCatalogRecord } from '../lib/personnel-import-catalog';
import { dependentImportMatch, type DependentIdentity } from '../lib/dependent-identity';
import { PERSONNEL_FIELDS } from '../lib/personnel-field-registry';
import { personnelBankValues, type PersonnelBankValues } from '../lib/personnel-bank-import';
import { personnelFamilyValues, personnelFamilyCatalogErrors } from '../lib/personnel-family-import';
import { personnelImportProposedValues, PERSONNEL_PROFILE_IMPORT_FIELDS, PERSONNEL_COMPLIANCE_IMPORT_FIELDS, personnelScalarIssue } from '../lib/personnel-import-contract';
import { isCalendarDate } from '../lib/calendar-date';
import { setPersonComplianceFields } from './workforce-commands';
import {applyBankStatutoryPatchTx,bankStatutoryDiff,bankStatutoryRefusal,buildBankStatutoryPatch,readBankStatutoryStateTx,readTaxResidencyTx} from './bank-statutory-import';
import {bankStatutoryStateFrom,MERGED_STATUTORY_COLUMNS,type BankStatutoryItemState,type BankStatutoryState} from '../lib/bank-statutory-import';
import {BANK_STATUTORY_LEGACY_COLUMNS} from '../lib/import-sections';
import {lockImportAttemptTx,lockImportAttemptHeaderTx,recordImportEventTx,recordImportItemTx} from './import-history';
/**
 * Item 2983802f — THE PER-SECTION IMPORTER: update people who already exist, one subject area at a time.
 *
 * `core/import.ts` is the day-one bulk loader: one wide file, 49 columns, and it CREATES. This is the
 * other half the reporter asked for — a narrow file for one section (Profile, Bank and
 * Statutory, Family), keyed on Employee ID, that UPDATES. Both live side by side on the import screen;
 * neither is built on top of the other, and this file does not modify `core/import.ts` at all, so the
 * working import the reporter has today cannot regress because of anything here.
 *
 * TWO PHASES, exactly as the wide importer has:
 *   - `analyze()`     pure validation + a per-row verdict, writing nothing.
 *   - `commitSectionImport()` re-runs `analyze()` server-side (never trusts a client preview) and applies
 *     the rows that passed, row by row.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS FILE EXISTS TO ENFORCE: A BLANK CELL MEANS "LEAVE THIS AS IT IS".
 *
 * A section file is narrow by construction, so nearly everything about an employee is ABSENT from it.
 * If an absent or blank cell meant "clear it", one Bank and Statutory upload would wipe the home
 * address, emergency contact and passport of every employee named in it — hundreds of people, one
 * confirm, no warning. So the rule is mechanical here, not a convention:
 *
 *   · a column not in the file contributes nothing;
 *   · a blank cell contributes nothing;
 *   · a row whose every cell is blank is a SKIP, and says so in the preview.
 *
 * The second half of the rule is subtler and is the reason several writers below are called with a
 * MERGED payload rather than the file's cells alone. Three of this product's setters rewrite their
 * whole block from their arguments — `setBank`, `setTax` and `setPassport` — so passing "only what the
 * file supplied" would blank the rest of THAT BLOCK even though it blanked nothing outside it. Every
 * such call below therefore reads the stored row first and overlays the file's cells onto it. The
 * merge is the implementation of the rule; the test that reads an untouched address back from the
 * database is the proof.
 *
 * WHAT IS DELIBERATELY NOT WRITEABLE and why is declared in `lib/import-sections.ts`
 * (`UNSECTIONED_COLUMNS`) — organisational moves, effective-dated pay, and the statutory columns whose
 * only writer is the full-row setter.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * UPDATE-ONLY, AND THE PRODUCT SAYS SO OUT LOUD.
 *
 * The approved plan asked for create-if-not-found on every section file. It cannot be built: a narrow
 * file carries no full name, no work email, no department, no join date and no basic salary — every
 * one of them required by `IMPORT_COLUMNS.required` — so there is nothing to bring a person into
 * existence FROM, and a "create" would be an invented employee record. So this importer refuses an
 * unmatched Employee ID, and the divergence is stated where the reader is, not left to be inferred:
 * the row's refusal names the full employee template, the preview carries a banner explaining WHY
 * when any row is unmatched, and the template chooser + this section's own notice say it BEFORE a
 * file is uploaded. The correction is being put to the reporter in the same words (AGENTS 31).
 */
import { getTableColumns, and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import {
  appUser,
  company,
  employeeDependent,
  employeeImportRun,
  employeeStatutoryMy,
  employment,
  person,
  profileOption,
} from '../db/schema';
import { updatePerson, type PersonProfileFields } from './org';
import { primaryEmergencyContactSql } from './emergency-contacts';
import { addDependentTx, syncChildReliefFromFamily, assertDependentsValid, type DependentInput, DEPENDENT_GENDERS, DEPENDENT_RELATIONSHIPS } from './dependents';
import { requirePackFor, type CountryPack } from '../localization/registry';
import { normalizeEmployeeCode } from '../lib/employee-code';
import { IMPORT_RUN_ERROR_CAP, type ImportRecord, type ImportRunError } from './import';
import {
  isImportSection,
  classifyForeignColumns,
  IMPORT_SECTION_DEFS,
  SECTION_DISPLAY_NAMES,
  SECTION_KEY_COLUMN,
  type ImportSection,
  type SectionImportPreview,
  type SectionImportResult,
  type SectionRowResult,
} from '../lib/import-sections';

export type {
  ImportSection,
  SectionImportPreview,
  SectionImportResult,
  SectionRowResult,
} from '../lib/import-sections';

const PERSONNEL_BANK_FIELDS=PERSONNEL_FIELDS.filter(field=>field.import.writer==='bank');
const PERSONNEL_BANK_COLUMNS=PERSONNEL_BANK_FIELDS.map(field=>field.import.column!);
const norm = (s: string | undefined) => (s ?? '').trim();
const lc = (s: string | undefined) => norm(s).toLowerCase();
const enumCell = (s: string | undefined) => lc(s).replace(/[\s-]+/g, '_');
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRUTHY = new Set(['true', 'yes', 'y', '1']);
const FALSY = new Set(['false', 'no', 'n', '0']);

/** One employee this file can address: the employment, its person, and the current values every
 *  merge below overlays onto. Read once, up front, so the DRY RUN can decide truthfully. */
type Subject = {
  employmentId: string;
  personId: string;
  companyId: string;
  employeeCode: string;
  fullName: string;
  primaryEmail: string;
  phone: string | null;
  hiredOn: string;
  pack: CountryPack;
  /** The employee's company country (the pack that resolves their statutory rules). */
  country: string;
  /** 0db97f14 — the Bank & Statutory tab's view of this employee (bank_statutory files only). */
  bankState?: BankStatutoryState;
  /** The person's stored profile columns this importer can write, for the merge + change diff. EVERY
   *  column in `PROFILE_PERSON_COLUMNS` is loaded here: a field the diff cannot see is a field the
   *  preview reports as changed when the cell equals what is already stored, which turns a re-uploaded
   *  corrected file (the exact thing the preview is sold on) into a page of phantom updates. */
  personRow: Record<string, string | null>;
  /** The statutory row, or null when the employee has none yet (no IC ever saved). */
  operations:{cardId:string|null;attendancePhotoSetting:string|null;paymentMethod:string|null};
  statutory: Record<string, unknown> | null;
  /** Family already on file, lowercased `name|relationship`, so a re-uploaded family file does not
   *  double somebody's children. */
  familyMembers:DependentIdentity[];
};

/**
 * The three payloads below are spelled out FIELD BY FIELD rather than kept as loose records, and that
 * is deliberate: each one is handed to a setter that rewrites its whole block, so a field forgotten
 * here is a column silently cleared on every employee in the file. A named type makes the compiler the
 * thing that notices.
 */
type PassportPatch = {
  passportNumber: string | null;
  passportIssueDate: string | null;
  passportExpiryDate: string | null;
  passportRemark: string | null;
  passportIssuingCountry: string | null;
  passportIssuingCountryCode: string | null;
};
type BankPatch = {
  bankName: string | null;
  bankAccountNo: string | null;
  enableCustomHolderName: boolean;
  customHolderName: string | null;
  enableCustomHolderId: boolean;
  customHolderId: string | null;
};
type DependentPatch = DependentInput;

/** Everything one valid row will do at commit. Built in the dry run; applied verbatim afterwards. */
type ResolvedSectionRow = {
  result: SectionRowResult;
  subject?: Subject;
  /** `updatePerson` payload — the core trio merged with the person's stored values (that writer
   *  rewrites all three from its arguments), plus only the profile fields the file supplied. */
  personPatch?: { fullName?: string; primaryEmail?: string; phone?: string; fields: PersonProfileFields };
  /** The Malaysian NRIC, with the stored `oldIcNumber` carried through so a save cannot clear it. */
  ic?: { icNumber?: string; oldIcNumber?: string };
  passportSupplied?:(keyof PassportPatch)[];
  compliance?: {dateOfBirth?:string;gender?:string;maritalStatus?:string};
  passport?: PassportPatch;
  operations?:PersonnelOperationalPatch;
  bank?: BankPatch;
  bankSupplied?:(keyof PersonnelBankValues)[];
  registrations?:{epfNumber?:string;socsoNumber?:string};
  /** 0db97f14 — the supplied EPF/SOCSO/EIS/HRDF/tax cells, canonical, written by the merged statutory
   *  writer over the locked row (never the file's cells alone). */
  statutoryPatch?: Record<string,string>;
  /** One family member to add. */
  dependent?: DependentPatch;
};

/** Column → the person column it writes. The address block is the PERMANENT one — the block the
 *  Personnel Contact & Address card maintains, matching the wide importer (the flat legacy columns
 *  are rollback history only). */
const PROFILE_PERSON_COLUMNS = Object.fromEntries(PERSONNEL_PROFILE_IMPORT_FIELDS.map(field=>[field.import.column!,field.import.writerField!])) as Record<string,keyof PersonProfileFields>;
const PROFILE_CATALOG_CATEGORY: Record<string,string> = {
  ...Object.fromEntries(PERSONNEL_PROFILE_IMPORT_FIELDS.filter(field=>field.import.catalog).map(field=>[field.import.column!,field.import.catalog!])),
  passport_issuing_country:'nationality',
};


async function analyze(
  ctx: SessionContext,
  section: ImportSection,
  records: ImportRecord[],
  suppliedTx?:Tx,
  /** Commit re-analysis of ONE row: only that row's employee needs the (per-employee) residency read. */
  focusRowNum?:number,
): Promise<{ preview: SectionImportPreview; resolved: ResolvedSectionRow[] }> {
  const def = IMPORT_SECTION_DEFS[section];
  const present = records.length ? Object.keys(records[0]).map((c) => c.trim()) : [];
  const presentSet = new Set(present);

  // ── WHOLE-FILE CHECKS, first: nothing is worth validating row by row if the file is the wrong file.
  const fileErrors: string[] = [];
  const missingColumns: string[] = [];
  if (records.length > 0) {
    for (const c of [SECTION_KEY_COLUMN, ...def.required]) if (!presentSet.has(c)) missingColumns.push(c);
    if (missingColumns.length > 0) {
      fileErrors.push(
        `This file is missing required column(s): ${missingColumns.join(', ')}. Nothing was imported.`,
      );
    }
    // THE FENCE (lib/import-sections.ts). Server-side, because the file is user-supplied: a Profile
    // column pasted into a Bank and Statutory sheet must be refused, not silently ignored — "I filled
    // it in and nothing happened" is as bad as writing it.
    //
    // THE REFUSAL NAMES THE DOOR, and only a door that exists. A refused column that ANOTHER SECTION
    // owns is answered with that section's name. A refused column NO section owns — 17 of the wide
    // template's 49, the EPF/SOCSO numbers among them — is answered plainly: no section file can
    // change it. The old single sentence told everybody to "choose the section that owns them", which
    // for those 17 was an instruction to go looking for something that is not there.
    const { movable, unsectioned } = classifyForeignColumns(section, present);
    for (const { column, section: owner } of movable) {
      fileErrors.push(
        `Column "${column}" belongs to the ${SECTION_DISPLAY_NAMES[owner]} section, not this one. Nothing was imported — remove the column, or import it with the ${SECTION_DISPLAY_NAMES[owner]} template.`,
      );
    }
    if (unsectioned.length > 0) {
      fileErrors.push(
        `No section file can change these columns: ${unsectioned.join(', ')}. They are not importable per section yet — change them on the employee's own Personnel record (a department, position, company or join date is a dated movement; pay is effective-dated; the EPF/SOCSO/EIS and residency fields are saved together on the Statutory card). Nothing was imported — remove these columns and upload again.`,
      );
    }
  }

  // ── The people this file can address, read once. Everything below is decided in memory.
  const codes = new Set<string>();
  for (const rec of records) {
    const c = normalizeEmployeeCode(norm(rec[SECTION_KEY_COLUMN]));
    if (c) codes.add(c);
  }
  const { byCode, catalog, icOwners, emailOwners } = await loadSubjects(
    ctx,
    codes,
    section,
    records.map(record=>norm(record.ic_number).replace(/\D/g,'')),
    suppliedTx,
    {present:presentSet,residencyCodes:new Set(records.filter(record=>['tax_residency','is_resident','tax_circumstance','tax_category','epf_citizenship'].some(column=>norm(record[column]))).map(record=>normalizeEmployeeCode(record[SECTION_KEY_COLUMN]))),focusCode:focusRowNum?normalizeEmployeeCode(norm(records[focusRowNum-1]?.[SECTION_KEY_COLUMN])):undefined},
  );

  const { allowDuplicatedNric, allowDuplicatedEmail } = await (suppliedTx?readPeopleGeneralTx(suppliedTx):getPeopleGeneral(ctx));
  const seenCodes = new Set<string>();
  /**
   * IN-FILE COLLISIONS ON THE TWO IDENTIFIERS THAT MUST STAY UNIQUE PER PERSON.
   *
   * The pre-loop `icOwners` / `emailOwners` snapshots answer "does somebody ELSE already have this?".
   * They cannot answer "did an EARLIER ROW OF THIS FILE already claim it?" — and a column-shifted
   * spreadsheet is exactly how two employees end up with one work email or one NRIC. Unchecked, the
   * email case previewed clean and wrote silently (there is no unique index behind it), and the NRIC
   * case previewed clean and died at commit on a raw driver error. Both are caught here, in the DRY
   * RUN, where the spreadsheet can still be corrected. Row numbers only — never the value.
   */
  const seenEmails = new Map<string, number>();
  const seenIcs = new Map<string, {rowNum:number;personId:string}>();
  const resolved: ResolvedSectionRow[] = [];

  records.forEach((rawRecord, idx) => {
    const {record:rec,errors}=normalizePersonnelCatalogRecord(rawRecord,section==='family'?'family':'employee',catalog);
    const warnings: string[] = [];
    const changes: string[] = [];
    const codeRaw = norm(rec[SECTION_KEY_COLUMN]);
    const codeNorm = normalizeEmployeeCode(codeRaw);
    const subject = codeNorm ? byCode.get(codeNorm) : undefined;

    /** The cell for a column the section owns — `undefined` when the column is absent OR blank. THIS
     *  IS THE BLANK RULE, and every payload below is built only from what this returns. */
    const cell = (column: string): string | undefined => {
      if (!presentSet.has(column)) return undefined;
      const v = norm(rec[column]);
      return v === '' ? undefined : v;
    };

    if (!codeRaw) errors.push('Missing employee_code — it is the link to the employee being updated');
    else if (!subject) {
      // UPDATE-ONLY, SAID OUT LOUD. A section file carries no full name, no work email, no department,
      // no join date and no salary — the five things a new employee record cannot exist without — so
      // there is nothing here to create a person FROM. Rather than leave that as an implementation
      // detail the reader has to infer from "not found", the refusal states the rule and names the
      // template that DOES add people. The screen says the same thing before a file is uploaded.
      errors.push(
        `No employee has Employee ID "${codeRaw}". A section file can only UPDATE people who are already in the system — it cannot add anyone. To add this person, choose "Everything — new employees" at the top of this page and use the full employee template, then run this file again.`,
      );
    }
    // Two rows for one employee would apply in file order and leave whichever won invisible. Refused.
    if (codeNorm && section !== 'family') {
      if (seenCodes.has(codeNorm)) errors.push('Duplicate employee_code in this file');
      seenCodes.add(codeNorm);
    }

    const row: ResolvedSectionRow = {
      result: {
        rowNum: idx + 1,
        proposed:personnelImportProposedValues(rec,section==='family'?'family':'employee'),
        employeeCode: codeRaw,
        employeeName: subject?.fullName ?? '',
        verdict: subject ? 'update' : 'create',
        ok: false,
        errors,
        warnings,
        changes,
      },
      subject,
    };

    if (subject) {
      if (section === 'profile')
        buildProfile(rec, cell, subject, row, {
          catalog,
          icOwners,
          allowDuplicatedNric,
          allowDuplicatedEmail,
          warnings,
          emailOwners,
          seenIcs,
          seenEmails,
          rowNum: idx + 1,
          errors,
          changes,
        });
      else if (section === 'bank_statutory') buildBankStatutory(cell, subject, row, { errors, changes });
      else buildFamily(rec, cell, subject, row, { catalog, errors, warnings, changes });
    }

    if(subject && (section==='profile'||section==='bank_statutory')) {
      const operational=personnelOperationalValues(rec);errors.push(...operational.errors);
      if(Object.keys(operational.values).length)row.operations=operational.values;
      for(const field of PERSONNEL_OPERATIONAL_FIELDS){const key=field.import.writerField! as keyof PersonnelOperationalPatch;const value=operational.values[key];if(value!==undefined && value!==(subject.operations[key]??''))changes.push(field.import.column!);}
      if(operational.values.paymentMethod==='bank_transfer' && bankTransferLacksBank(row.bank??{bankName:subject.statutory?.bankName as string|null,bankAccountNo:subject.statutory?.bankAccountNo as string|null}))errors.push('Bank Transfer requires a bank name and account number.');
    }

    // MATCHED, VALID, AND NOTHING TO DO. Reported as its own verdict rather than counted as an update:
    // a preview that says "12 will be updated" when four of them carry no values is a preview that
    // cannot be checked. (Calling the writers with an empty payload would also throw.)
    //
    // A ROW THAT REPEATS WHAT IS ALREADY RECORDED IS ALSO NOTHING TO DO. Re-uploading a corrected file
    // is the normal way this feature is used, and most of its rows are unchanged; counting them as
    // updates would inflate the headline, write audit events for changes nobody made, and hide the
    // handful of rows that really do move. `changes` is the truth here — every section pushes a column
    // onto it only when the cell DIFFERS from what is stored.
    const willWrite =
      row.operations || row.personPatch || row.compliance || row.ic || row.passport || row.bank || row.registrations || row.statutoryPatch || row.dependent;
    if (subject && errors.length === 0 && (!willWrite || changes.length === 0)) {
      row.result.verdict = 'skip';
      if (warnings.length === 0) {
        warnings.push(
          willWrite
            ? 'Nothing to change on this row — every value it carries is already recorded'
            : 'Nothing to change on this row — every cell is blank',
        );
      }
    }
    row.result.ok = errors.length === 0 && row.result.verdict === 'update';
    resolved.push(row);
  });

  for(const row of resolved)if(row.result.ok && row.operations?.cardId && resolved.some(other=>other!==row && other.operations?.cardId?.toLowerCase()===row.operations!.cardId!.toLowerCase())) {row.result.ok=false;row.result.errors.push('Duplicate card_id in this file.');}

  for(const row of resolved)if(row.result.ok && row.subject && row.operations?.cardId) {
    try {await (suppliedTx?assertCardIdFree(suppliedTx,row.subject!.employmentId,row.operations!.cardId!):withTenant(ctx,tx=>assertCardIdFree(tx,row.subject!.employmentId,row.operations!.cardId!)));}
    catch {row.result.ok=false;row.result.errors.push('card_id already identifies another employee; choose an unused card ID.');}
  }

  for(const row of resolved)if(row.result.ok && row.dependent) {
    try { await assertDependentsValid(ctx,[row.dependent],suppliedTx); }
    catch(error) { row.result.ok=false;row.result.errors.push(error instanceof Error?error.message:'Invalid Family values'); }
  }

  const preview: SectionImportPreview = {
    section,
    total: records.length,
    updateCount: resolved.filter((r) => r.result.ok).length,
    skipCount: resolved.filter((r) => r.result.verdict === 'skip').length,
    createCount: resolved.filter((r) => r.result.verdict === 'create').length,
    rows: resolved.map((r) => r.result),
    missingColumns,
    fileErrors,
  };
  return { preview, resolved };
}

/** Read every employee this file names, plus the catalogs and the IC ownership map, in one pass. */
async function loadSubjects(ctx: SessionContext, codes: Set<string>, section: ImportSection, submittedNrics: string[],suppliedTx?:Tx,scope:{present?:Set<string>;focusCode?:string;residencyCodes?:Set<string>}={}) {
  if(section==='bank_statutory'){const read=(tx:Tx)=>loadBankImportSubjects(tx,ctx,codes,scope);return suppliedTx?read(suppliedTx):withTenant(ctx,read);}
  const read=async (tx:Tx) => {
    // The tenant's employments, keyed by Employee ID and by work email. Both keys are needed: the
    // Direct Superior column accepts either, exactly as the wide importer's does.
    const rows = await tx
      .select({
        employmentId: employment.id,
        personId: employment.personId,
        companyId: employment.companyId,
        employeeCode: employment.employeeCode,
        hiredOn: employment.hiredOn,
        cardId:employment.cardId,attendancePhotoSetting:employment.attendancePhotoSetting,paymentMethod:employment.paymentMethod,
        fullName: person.fullName,
        primaryEmail: person.primaryEmail,
        phone: person.phone,
        country: company.country,
        salutation:person.salutation,firstName:person.firstName,lastName:person.lastName,preferredName:person.preferredName,nationality:person.nationality,religion:person.religion,race:person.race,homePhone:person.homePhone,personalEmail:person.personalEmail,
        correspondenceAddressLine1:person.correspondenceAddressLine1,correspondenceAddressLine2:person.correspondenceAddressLine2,correspondenceAddressLine3:person.correspondenceAddressLine3,correspondencePostcode:person.correspondencePostcode,correspondenceCity:person.correspondenceCity,correspondenceState:person.correspondenceState,correspondenceCountry:person.correspondenceCountry,correspondenceMobilePhone:person.correspondenceMobilePhone,correspondenceHomePhone:person.correspondenceHomePhone,
        dateOfBirth:person.dateOfBirth,gender:person.gender,maritalStatus:person.maritalStatus,
        permanentAddressLine1: person.permanentAddressLine1,
        permanentAddressLine2: person.permanentAddressLine2,
        permanentAddressLine3: person.permanentAddressLine3,
        permanentPostcode: person.permanentPostcode,
        permanentCity: person.permanentCity,
        permanentState: person.permanentState,
        permanentCountry: person.permanentCountry,
        // The emergency-contact block is loaded for the SAME reason the address is: the change diff
        // compares the cell against the stored value, and a column it cannot see always looks changed.
        // 23ad620e moved these five off `person` into the per-person register, so they are read the way
        // every other single-contact reader reads them — the highest-priority live row.
        emergencyContactName: section==='profile'?primaryEmergencyContactSql('full_name'):sql<string|null>`null`,
        emergencyContactRelationship: section==='profile'?primaryEmergencyContactSql('relationship'):sql<string|null>`null`,
        emergencyContactPhone: section==='profile'?primaryEmergencyContactSql('mobile_phone'):sql<string|null>`null`,
        emergencyContactPhone2: section==='profile'?primaryEmergencyContactSql('home_phone'):sql<string|null>`null`,
        emergencyContactAddress: section==='profile'?primaryEmergencyContactSql('address'):sql<string|null>`null`,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(and(eq(employment.tenantId,ctx.tenantId),codes.size?inArray(employment.employeeCode,[...codes]):sql`false`));

    const byCode = new Map<string, Subject>();
    const wanted: typeof rows = [];
    for (const r of rows) {
      const code = r.employeeCode ? normalizeEmployeeCode(r.employeeCode) : '';
      if (code && codes.has(code)) wanted.push(r);
    }
    const personIds = wanted.map((r) => r.personId);

    // The statutory rows of the employees this file names — the current values every whole-block
    // setter below is merged over. Read here rather than at write time so the DRY RUN can tell an
    // incomplete passport or a half-filled bank block from a complete one.
    const statByPerson = new Map<string, Record<string, unknown>>();
    if (personIds.length > 0) {
      const stat = await tx.select().from(employeeStatutoryMy).where(inArray(employeeStatutoryMy.personId, personIds));
      for (const s of stat) statByPerson.set(s.personId, s as unknown as Record<string, unknown>);
    }

    // Family already on file, so a re-uploaded Family sheet does not add somebody's spouse twice.
    const familyByPerson = new Map<string, DependentIdentity[]>();
    if (section === 'family' && personIds.length > 0) {
      const deps = await tx
        .select({
          personId: employeeDependent.personId,
          fullName: employeeDependent.fullName,
          relationship: employeeDependent.relationship,
          dateOfBirth: employeeDependent.dateOfBirth,
          icOrPassport:employeeDependent.icOrPassport,passportNumber:employeeDependent.passportNumber,
        })
        .from(employeeDependent)
        .where(and(inArray(employeeDependent.personId, personIds), isNull(employeeDependent.archivedAt)));
      for (const d of deps) {
        const members = familyByPerson.get(d.personId) ?? [];
        members.push(d);
        familyByPerson.set(d.personId, members);
      }
    }

    for (const r of wanted) {
      const s: Subject = {
        employmentId: r.employmentId,
        personId: r.personId,
        companyId: r.companyId,
        employeeCode: normalizeEmployeeCode(r.employeeCode ?? ''),
        fullName: r.fullName,
        primaryEmail: r.primaryEmail,
        phone: r.phone,
        hiredOn: String(r.hiredOn),
        // The employee's own company's country pack decides IC rules (ADR-0080 D1/D6) — a section file
        // may name people at several companies, and each is validated under its own jurisdiction.
        pack: requirePackFor(r.country),
        personRow: {
          ...Object.fromEntries([...PERSONNEL_PROFILE_IMPORT_FIELDS,...PERSONNEL_COMPLIANCE_IMPORT_FIELDS].map(field=>[field.import.writerField!, (r as unknown as Record<string,string|null>)[field.import.writerField!]??null])),
          permanentAddressLine1: r.permanentAddressLine1,
          permanentAddressLine2: r.permanentAddressLine2,
          permanentAddressLine3: r.permanentAddressLine3,
          permanentPostcode: r.permanentPostcode,
          permanentCity: r.permanentCity,
          permanentState: r.permanentState,
          permanentCountry: r.permanentCountry,
          emergencyContactName: r.emergencyContactName,
          emergencyContactRelationship: r.emergencyContactRelationship,
          emergencyContactPhone: r.emergencyContactPhone,
          emergencyContactPhone2: r.emergencyContactPhone2,
          emergencyContactAddress: r.emergencyContactAddress,
        },
        operations:{cardId:r.cardId,attendancePhotoSetting:r.attendancePhotoSetting,paymentMethod:r.paymentMethod},
        statutory: statByPerson.get(r.personId) ?? null,
        familyMembers: familyByPerson.get(r.personId) ?? [],
        country: r.country,
      };
      byCode.set(s.employeeCode, s);
    }
    // Catalog-governed vocabularies, so a typo in State / Country / a relationship is a DRY-RUN error
    // where the spreadsheet can still be fixed. An EMPTY catalog means the tenant never configured that
    // list and free text is accepted — the same rule the Personnel screens apply.
    const options = await tx
      .select({ category: profileOption.category, value: profileOption.value,label:profileOption.label,isActive:profileOption.isActive })
      .from(profileOption);
    const catalog = new PersonnelImportCatalog();
    for(const option of options)catalog.addOption(option);
    const icOwners = new Map<string, Set<string>>();
    // …and who owns which WORK EMAIL, which is the login identity and has NO unique index behind it
    // (db/schema.ts: `primaryEmail` carries only `person_tenant_idx`). Without this check a Profile
    // file quietly gave two employees one login address and the preview said nothing at all.
    const emailOwners = new Map<string, string>();
    if (section === 'profile') {
      if(wanted[0])for(const key of await occupiedNricsTx(tx,{personId:wanted[0].personId,keys:submittedNrics}))icOwners.set(key,new Set(['occupied']));
      const allStat = await tx
        .select({ personId: employeeStatutoryMy.personId, icNumber: employeeStatutoryMy.icNumber })
        .from(employeeStatutoryMy);
      for (const s of allStat) if (s.icNumber) {
        const key=s.icNumber.replace(/\D/g,'');const owners=icOwners.get(key)??new Set<string>();
        owners.add(s.personId);icOwners.set(key,owners);
      }
      const allPeople = await tx.select({ id: person.id, primaryEmail: person.primaryEmail }).from(person);
      for (const p of allPeople) if (p.primaryEmail) emailOwners.set(p.primaryEmail.trim().toLowerCase(), p.id);
    }

    return { byCode, catalog, icOwners, emailOwners };
  };
  return suppliedTx?read(suppliedTx):withTenant(ctx,read);
}

/** Explicit bounded projection with the same legacy HR floor plus live Workforce target checks. */
async function loadBankImportSubjects(tx:Tx,ctx:SessionContext,codes:Set<string>,scope:{focusCode?:string;residencyCodes?:Set<string>}){
 type Row={employment_id:string;person_id:string;company_id:string;employee_code:string;hired_on:string;card_id:string|null;attendance_photo_setting:string|null;payment_method:string|null;full_name:string;primary_email:string;phone:string|null;country:string;statutory:Record<string,unknown>|null};
 const byCode=new Map<string,Subject>(),columns=getTableColumns(employeeStatutoryMy),wanted=[...codes];
 for(let offset=0;offset<wanted.length;offset+=1000){
  const rows=await tx.execute<Row>(sql`select * from app.bank_import_subjects(${JSON.stringify(wanted.slice(offset,offset+1000))}::jsonb)`);
  for(const row of rows){
   const statutory=row.statutory?Object.fromEntries(Object.entries(columns).map(([key,column])=>[key,row.statutory![column.name]])):null;
   const subject:Subject={employmentId:row.employment_id,personId:row.person_id,companyId:row.company_id,employeeCode:normalizeEmployeeCode(row.employee_code),fullName:row.full_name,primaryEmail:row.primary_email,phone:row.phone,hiredOn:String(row.hired_on),country:row.country,pack:requirePackFor(row.country),personRow:{},statutory,familyMembers:[],operations:{cardId:row.card_id,attendancePhotoSetting:row.attendance_photo_setting,paymentMethod:row.payment_method}};
   const needsResidency=scope.residencyCodes?.has(subject.employeeCode)&&(!scope.focusCode||scope.focusCode===subject.employeeCode);
   const taxResidency=needsResidency?await readTaxResidencyTx(tx,ctx,{employmentId:subject.employmentId,personId:subject.personId,pack:subject.pack,country:subject.country},statutory as {taxCircumstance?:string|null}|null):'';
   subject.bankState=bankStatutoryStateFrom(statutory,{taxResidency,paymentMethod:row.payment_method});
   byCode.set(subject.employeeCode,subject);
  }
 }
 const options=await tx.select({category:profileOption.category,value:profileOption.value,label:profileOption.label,isActive:profileOption.isActive}).from(profileOption);
 const catalog=new PersonnelImportCatalog();for(const option of options)catalog.addOption(option);
 return{byCode,catalog,icOwners:new Map<string,Set<string>>(),emailOwners:new Map<string,string>()};
}

type BuildCtx = { errors: string[]; changes: string[] };

/** Blank ⇒ nothing. Non-blank ⇒ checked against the catalog, and a refusal contributes NOTHING (it
 *  must never fall through to the raw text, which would put a value in the record the catalog forbids). */
function catalogValue(
  raw: string | undefined,
  column: string,
  catalog: Map<string, Set<string>>,
  errors: string[],
): string | undefined {
  if (raw === undefined) return undefined;
  const category = PROFILE_CATALOG_CATEGORY[column];
  if (!category) return raw;
  const active = catalog.get(category);
  if (!active) return raw; // never configured ⇒ free text, as on the screens
  if (active.has(raw)) return raw;
  errors.push(`"${raw}" is not an active ${category} option — column ${column}`);
  return undefined;
}

function buildProfile(
  rec: ImportRecord,
  cell: (c: string) => string | undefined,
  subject: Subject,
  row: ResolvedSectionRow,
  x: BuildCtx & {
    catalog: Map<string, Set<string>>;
    icOwners: Map<string, Set<string>>;
    allowDuplicatedNric: boolean;
    /** 5e0b2154 — People General "Allow Duplicated Work Email or Personal Email". */
    allowDuplicatedEmail: boolean;
    warnings: string[];
    emailOwners: Map<string, string>;
    seenIcs: Map<string, {rowNum:number;personId:string}>;
    seenEmails: Map<string, number>;
    rowNum: number;
  },
) {
  const { errors, changes, catalog } = x;
  const patch: PersonProfileFields = {};

  // The core trio. `updatePerson` REWRITES all three from its arguments — omitting the phone number
  // nulls it — so the stored values are carried through and only what the file supplied replaces them.
  const fullName = cell('full_name');
  let email = cell('email');
  const phone = cell('phone');

  /**
   * THE WORK EMAIL IS THE LOGIN IDENTITY, AND NOTHING BEHIND IT ENFORCES UNIQUENESS. Two employees on
   * one address is not a cosmetic defect: it is two people sharing a login. Both halves are checked —
   * an address an EARLIER ROW of this file already assigned, and an address somebody else already
   * holds — and a failure REMOVES the cell rather than leaving it to be written, so a rejected email
   * can never fall through into the merged payload below.
   */
  if (email !== undefined) {
    const key = email.toLowerCase();
    const alreadyInFile = x.seenEmails.get(key);
    const owner = x.emailOwners.get(key);
    if (!EMAIL_RE.test(email)) {
      errors.push(`Invalid email "${email}"`);
      email = undefined;
    } else if (alreadyInFile !== undefined && !x.allowDuplicatedEmail) {
      errors.push(`Duplicate email in this file — row ${alreadyInFile} already assigns "${email}"`);
      email = undefined;
    } else if (owner && owner !== subject.personId && !x.allowDuplicatedEmail) {
      errors.push(`Another employee already has the work email "${email}" — duplicate emails are not allowed under the current People General Settings`);
      email = undefined;
    } else {
      // 5e0b2154 — allowed to share, but said so: HR should see that the address is not unique.
      if (alreadyInFile !== undefined) x.warnings.push(`Row ${alreadyInFile} also uses the email "${email}"`);
      else if (owner && owner !== subject.personId) x.warnings.push(`Another employee also uses the email "${email}"`);
      x.seenEmails.set(key, x.rowNum);
    }
  }

  if (fullName !== undefined && fullName !== subject.fullName) changes.push('full_name');
  if (email !== undefined && email !== subject.primaryEmail) changes.push('email');
  if (phone !== undefined && phone !== (subject.phone ?? '')) changes.push('phone');

  for (const [column, field] of Object.entries(PROFILE_PERSON_COLUMNS)) {
    const v = catalogValue(cell(column), column, catalog, errors);
    if (v === undefined) continue;
    (patch as Record<string, string | null>)[field] = v;
    if (v !== (subject.personRow[field] ?? '')) changes.push(column);
  }

  if(patch.personalEmail && !EMAIL_RE.test(patch.personalEmail))errors.push('Invalid personal_email');
  const compliance:NonNullable<ResolvedSectionRow['compliance']>={};
  for(const field of PERSONNEL_COMPLIANCE_IMPORT_FIELDS) {
    const column=field.import.column!;const value=cell(column);if(value===undefined)continue;
    const issue=personnelScalarIssue(field,value);
    if(issue)errors.push(`${column}: invalid ${issue} value`);
    else { (compliance as Record<string,string>)[field.ownerField]=value; if(value!==(subject.personRow[field.ownerField]??''))changes.push(column); }
  }
  if(Object.keys(compliance).length)row.compliance=compliance;
  const touchesPerson = fullName !== undefined || email !== undefined || phone !== undefined || Object.keys(patch).length > 0;
  if (touchesPerson) {
    row.personPatch = {
      fullName,
      primaryEmail: email,
      phone,
      fields: patch,
    };
  }

  // NRIC. Validated under the employee's OWN company pack, checked for tenant uniqueness, and written
  // through `setIc` with the stored `oldIcNumber` carried across — that setter rewrites the old-card
  // column from its argument, so omitting it would clear a value nobody asked to clear.
  const icRaw = cell('ic_number');
  if (icRaw !== undefined) {
    if (!subject.pack.statutory.validateIC(icRaw)) {
      errors.push(`Invalid IC "${icRaw}"`);
    } else {
      const icNorm = subject.pack.statutory.normalizeIC(icRaw);
      const owner = x.icOwners.get(icNorm);
      const alreadyInFile = x.seenIcs.get(icNorm);
      const unchanged = icNorm === String(subject.statutory?.icNumber ?? '').replace(/\D/g, '');
      if (!x.allowDuplicatedNric && !unchanged && alreadyInFile !== undefined && alreadyInFile.personId !== subject.personId) {
        errors.push(NRIC_FILE_DUPLICATE_MESSAGE);
      } else if (!x.allowDuplicatedNric && !unchanged && owner && [...owner].some(id => id !== subject.personId)) {
        errors.push(NRIC_DUPLICATE_MESSAGE);
      } else {
        x.seenIcs.set(icNorm, {rowNum:x.rowNum,personId:subject.personId});
        row.ic = { icNumber: icNorm };
        if (!unchanged) changes.push('ic_number');
      }
    }
  }

  const oldIc=cell('old_ic_number');
  if(oldIc!==undefined) {
    row.ic={...row.ic,oldIcNumber:oldIc};if(oldIc!==(subject.statutory?.oldIcNumber??''))changes.push('old_ic_number');
  }

  // PASSPORT — a whole-block setter, so the file's cells are overlaid on the stored block. That is what
  // makes "correct 400 expiry dates" a legal file: the numbers and issue dates stay as they are.
  const pCode=cell('passport_issuing_country_code');
  const pRemark=cell('passport_remark');
  const pNumber = cell('passport_number');
  const pIssue = cell('passport_issue_date');
  const pExpiry = cell('passport_expiry_date');
  const pCountry = catalogValue(cell('passport_issuing_country'), 'passport_issuing_country', catalog, errors);
  for (const [v, label] of [
    [pIssue, 'passport_issue_date'],
    [pExpiry, 'passport_expiry_date'],
  ] as const) {
    if (v !== undefined && !isCalendarDate(v)) errors.push(`${label} must be YYYY-MM-DD (got "${v}")`);
  }
  if (pNumber !== undefined || pIssue !== undefined || pExpiry !== undefined || pCountry !== undefined || pCode!==undefined || pRemark!==undefined) {
    const stored = subject.statutory;
    const merged = {
      passportNumber: pNumber ?? ((stored?.passportNumber as string | null) ?? null),
      passportIssueDate: pIssue ?? ((stored?.passportIssueDate as string | null) ?? null),
      passportExpiryDate: pExpiry ?? ((stored?.passportExpiryDate as string | null) ?? null),
      passportRemark: pRemark ?? (stored?.passportRemark as string | null) ?? null,
      passportIssuingCountry: pCountry ?? ((stored?.passportIssuingCountry as string | null) ?? null),
      passportIssuingCountryCode: pCode ?? (stored?.passportIssuingCountryCode as string | null) ?? null,
    };
    if (!merged.passportNumber || !merged.passportIssueDate || !merged.passportExpiryDate) {
      errors.push(
        'passport_number, passport_issue_date and passport_expiry_date must all be on file together — this employee has none stored, so all three are needed',
      );
    } else if (merged.passportExpiryDate < merged.passportIssueDate) {
      errors.push('passport_expiry_date must be on or after passport_issue_date');
    } else {
      row.passport = merged;
      row.passportSupplied=(Object.entries({passportNumber:pNumber,passportIssueDate:pIssue,passportExpiryDate:pExpiry,passportIssuingCountry:pCountry,passportIssuingCountryCode:pCode,passportRemark:pRemark}).filter(([,value])=>value!==undefined).map(([key])=>key)) as (keyof PassportPatch)[];
      for (const [v, label, was] of [
        [pNumber, 'passport_number', stored?.passportNumber],
        [pIssue, 'passport_issue_date', stored?.passportIssueDate],
        [pExpiry, 'passport_expiry_date', stored?.passportExpiryDate],
        [pCountry, 'passport_issuing_country', stored?.passportIssuingCountry],
        [pCode,'passport_issuing_country_code',stored?.passportIssuingCountryCode],
        [pRemark,'passport_remark',stored?.passportRemark],
      ] as const) {
        // Reported as changed only when it actually MOVES. A file that repeats what is already on
        // record is the normal shape of a corrected re-upload, and a preview that calls every repeated
        // cell a change is a preview nobody can read.
        if (v !== undefined && v !== ((was as string | null) ?? '')) changes.push(label);
      }
    }
  }
  void rec;
}

function buildBankStatutory(
  cell: (c: string) => string | undefined,
  subject: Subject,
  row: ResolvedSectionRow,
  x: BuildCtx,
) {
  const { errors, changes } = x;
  const stored = subject.statutory;
  const registrations={epfNumber:cell('epf_number'),socsoNumber:cell('socso_number')};
  const touchesRegistrations=registrations.epfNumber!==undefined||registrations.socsoNumber!==undefined;
  if(touchesRegistrations) {
    if(!stored)errors.push('This employee has no statutory record; complete the Personnel statutory setup first.');
    else if(!subject.pack.statutory.setRegistrationNumbers)errors.push('Registration-number updates are unavailable for this country pack.');
    else { row.registrations=registrations;for(const [key,value] of Object.entries(registrations))if(value!==undefined && value!==(stored[key]??''))changes.push(key==='epfNumber'?'epf_number':'socso_number'); }
  }
  const bank=personnelBankValues(Object.fromEntries(PERSONNEL_BANK_COLUMNS.map(column=>[column,cell(column)??''])),stored?{bankName:stored.bankName as string|null,bankAccountNo:stored.bankAccountNo as string|null,enableCustomHolderName:Boolean(stored.enableCustomHolderName),customHolderName:stored.customHolderName as string|null,enableCustomHolderId:Boolean(stored.enableCustomHolderId),customHolderId:stored.customHolderId as string|null}:{});
  const touchesBank = bank.supplied.length>0;
  const touchesStatutory = [...MERGED_STATUTORY_COLUMNS,...BANK_STATUTORY_LEGACY_COLUMNS].some(c=>cell(c)!==undefined);
  if (!touchesBank && !touchesStatutory) return;

  // Every writer below requires an existing statutory row (the row is seeded by the employee's IC).
  // Caught here so it is a preview error with a name attached rather than a service exception half-way
  // through a 400-row file.
  if (!stored) {
    errors.push(
      'This employee has no statutory record yet — save their identity number on their Personnel record first, then re-run this file',
    );
    return;
  }

  if(touchesBank) {
    errors.push(...bank.errors);row.bank=bank.values;row.bankSupplied=bank.supplied;
    for(const field of PERSONNEL_BANK_FIELDS)if(bank.supplied.includes(field.import.writerField! as keyof PersonnelBankValues) && bank.values[field.import.writerField! as keyof PersonnelBankValues]!==stored[field.import.writerField!])changes.push(field.import.column!);
  }

  if (touchesStatutory) {
    // 0db97f14 — EPF/SOCSO/EIS, HRDF and every tax setting: canonical cells validated on the MERGED row
    // with the tab's rules; written later by the merged writer over the locked row.
    const built=buildBankStatutoryPatch(cell,subject,subject.bankState??bankStatutoryStateFrom(stored,{taxResidency:'',paymentMethod:subject.operations.paymentMethod}));
    errors.push(...built.errors);changes.push(...built.changes);
    if(Object.keys(built.patch).length)row.statutoryPatch=built.patch;
  }
}

function buildFamily(
  rec: ImportRecord,
  cell: (c: string) => string | undefined,
  subject: Subject,
  row: ResolvedSectionRow,
  x: BuildCtx & { catalog: Map<string, Set<string>>; warnings: string[] },
) {
  const { errors, warnings, changes, catalog } = x;
  const fullName = cell('full_name');
  const relationship = cell('relationship');
  if (fullName === undefined) errors.push('Missing full_name');
  if (relationship === undefined) errors.push('Missing relationship');
  else {
    const custom = catalog.get('dependentRelationship') ?? new Set<string>();
    if (!(DEPENDENT_RELATIONSHIPS as readonly string[]).includes(relationship) && !custom.has(relationship)) {
      errors.push(
        `Unknown relationship "${relationship}" (use ${DEPENDENT_RELATIONSHIPS.join(' / ')}, or an active option from your Family relationship list)`,
      );
    }
  }
  const dob = cell('date_of_birth');
  if (dob !== undefined && !isCalendarDate(dob)) errors.push(`date_of_birth must be YYYY-MM-DD (got "${dob}")`);
  const gender = cell('gender') === undefined ? undefined : enumCell(rec.gender);
  if (gender !== undefined && !(DEPENDENT_GENDERS as readonly string[]).includes(gender)) {
    errors.push(`Unknown gender "${rec.gender}" (use ${DEPENDENT_GENDERS.join(' / ')})`);
  }
  // Blank means NO: somebody is an insurance beneficiary only when a person says so.
  let isBeneficiary = false;
  const ben = cell('is_beneficiary');
  if (ben !== undefined) {
    const v = ben.toLowerCase();
    if (TRUTHY.has(v)) isBeneficiary = true;
    else if (FALSY.has(v)) isBeneficiary = false;
    else errors.push(`Invalid is_beneficiary "${ben}" (use yes/no)`);
  }
  const extra=personnelFamilyValues(rec);errors.push(...extra.errors,...personnelFamilyCatalogErrors(rec,catalog));
  if (errors.length > 0 || fullName === undefined || relationship === undefined) return;

  const identity:DependentIdentity={fullName,relationship,dateOfBirth:dob,icOrPassport:cell('ic_or_passport'),passportNumber:cell('passport_number')};
  const match=dependentImportMatch(subject.familyMembers,identity);
  if(match==='ambiguous') {errors.push('Family identity is ambiguous — review the existing record and provide matching identification before importing this member.');return;}
  if(match==='existing') {warnings.push('Already on file — this family member will be skipped');return;}
  subject.familyMembers.push(identity);
  row.dependent = {
    fullName,
    relationship,
    dateOfBirth: dob,
    gender,
    icOrPassport: cell('ic_or_passport'),
    passportNumber: cell('passport_number'),
    phone: cell('phone'),
    isBeneficiary,
    remarks: cell('remarks'),
    ...extra.values,
  };
  changes.push('family_member');
}

/**
 * WHICH WRITE WAS IN FLIGHT WHEN A ROW THREW, and the columns to name in the message.
 *
 * The dry run catches everything it can see; what is left is a database refusal (a unique index, a
 * check constraint, a race with somebody editing the same person). The admin still has to be told
 * WHICH part of the row did not go in — and told it without the value that caused it.
 */
export type WriteStep = 'person' | 'ic' | 'passport' | 'bank' | 'registrations' | 'tax' | 'statutory' | 'operations' | 'dependent';

const WRITE_STEP_COLUMNS: Record<WriteStep, string> = {
  person: 'full_name / email / phone / address / emergency contact',
  ic: 'ic_number',
  passport: 'passport_number / passport_issue_date / passport_expiry_date / passport_issuing_country',
  bank: 'bank_name / bank_account_no',
  registrations:'epf_number / socso_number',
  tax: 'tax_number / tax_category / num_children',
  statutory: 'the EPF, SOCSO, EIS, HRDF and income tax settings',
  operations:'Card ID, Attendance Photo or Payment Method',
  dependent: 'the family member on this row',
};

/** A Postgres unique violation, however the driver wrapped it. Detected WITHOUT reading the message
 *  into the output — knowing the class of failure is useful; quoting the statement is not. */
function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return /duplicate key value|unique constraint/i.test(String((e as Error)?.message ?? ''));
}

export function writeFailureMessage(step: WriteStep, e: unknown): string {
  if (pgSqlState(e) === 'PN001') return publicErrorMessage(e);
  // 0db97f14 — the statutory owners' own refusals (EPF election, tax selection) name the column and
  // the reason and carry no stored value, so they are shown as they are.
  const refusal = bankStatutoryRefusal(e);
  if (refusal) return `${refusal}. No changes from this row were saved.`;
  const cols = WRITE_STEP_COLUMNS[step];
  // All row writers share one explicit transaction; a refused writer rolls the row back.
  return isUniqueViolation(e)
    ? `Could not save ${cols} — another employee already has one of these values. No changes from this row were saved.`
    : `Could not save ${cols} — the database refused the change. No changes from this row were saved.`;
}

/** Dry run — validate and produce the per-row verdict. Writes nothing. */
export async function validateSectionImport(
  ctx: SessionContext,
  p: { section: string; records: ImportRecord[] },
): Promise<SectionImportPreview> {
  if(!isImportSection(p.section))throw new Error('Unknown import section. Employment updates use dated Movement import.');
  if(isPersonnelRegisterKind(p.section))return validateRegisterSection(ctx,p.section,p.records);
  const { preview } = await analyze(ctx, p.section, p.records);
  return preview;
}

/**
 * Apply the rows that passed. Re-validates from the records, so a tampered client preview cannot widen
 * what gets written, and refuses the whole file when the fence (or a missing key column) says so.
 *
 * Each valid row is one atomic transaction across its owners. A refused row rolls back while other
 * independently valid rows can apply. Blank cells are carried from locked current records, not preview data.
 */
export async function commitSectionImport(
  ctx: SessionContext,
  p: { section: string; records: ImportRecord[]; fileName?: string;
    /** 0db97f14 — record each employee's field-level change in this import attempt (ADR-0155), in the
     *  SAME transaction as the change, then the attempt's confirmed event. Bank & Statutory only. */
    history?: { attemptId: string } },
): Promise<SectionImportResult> {
  p=structuredClone(p);
  if(p.history && p.section!=='bank_statutory')throw new Error('Import history is recorded for Bank & Statutory section files only.'); ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  if(!isImportSection(p.section))throw new Error('Unknown import section. Employment updates use dated Movement import.');
  if(isPersonnelRegisterKind(p.section)) {
    const result=await commitRegisterSection(ctx,p.section,p.records);
    if(result.updated>0)result.runId=await recordSectionRun(ctx,{companyId:null,fileName:p.fileName??'',totalRows:p.records.length,updated:result.updated,rejected:[],failed:[]});
    return result;
  }
  const { preview, resolved } = await analyze(ctx, p.section, p.records);
  if (preview.fileErrors.length > 0) {
    return {
      section: p.section,
      updated: 0,
      skipped: resolved.length,
      failed: [],
      fileErrors: preview.fileErrors,
      runId: null,
    };
  }

  const failed: SectionImportResult['failed'] = [];
  let updated = 0;
  const warnings:string[]=[];
  const appliedPeople=new Set<string>();
  for (const row of resolved) {
    if (!row.result.ok || !row.subject) continue;
    const s = row.subject;
    const nominatedRow=row;
    let step: WriteStep = 'person';
    try {
      const wrote=await withTenant(ctx,async tx=>{
      await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
      // Writer locks first, then the attempt row: the same order as a revert, so the two cannot deadlock.
      if(p.history)await lockImportAttemptHeaderTx(tx,ctx,p.history.attemptId,'bank_statutory');
      const current=await analyze(ctx,p.section as ImportSection,p.records,tx,nominatedRow.result.rowNum);
      const fresh=current.resolved[nominatedRow.result.rowNum-1];
      if(current.preview.fileErrors.length||!fresh?.subject||fresh.subject.employmentId!==nominatedRow.subject!.employmentId||fresh.subject.personId!==nominatedRow.subject!.personId||fresh.subject.companyId!==nominatedRow.subject!.companyId||fresh.subject.employeeCode!==nominatedRow.subject!.employeeCode||fresh.subject.pack!==nominatedRow.subject!.pack)throw new Error('Section import inputs changed; preview the original file again.');
      if(fresh.result.errors.length)throw new Error('Section import inputs changed; preview the original file again.');
      // A later row naming a Person that an EARLIER row of this same commit already wrote re-analyses as
      // 'skip' only because of that write. The preview counted it as an update and the native owner applies
      // it exactly as previewed (each row its own write); an independent no-op still stays a skip.
      const afterOwnEarlierRow=fresh.result.verdict==='skip'&&appliedPeople.has(fresh.subject.personId);
      if(fresh.result.verdict==='skip'&&!afterOwnEarlierRow)return false;
      const binding=(value:ResolvedSectionRow)=>JSON.stringify({...value,result:undefined,subject:undefined});
      if(!(fresh.result.ok||afterOwnEarlierRow)||binding(fresh)!==binding(nominatedRow))throw new Error('Section import inputs changed; preview the original file again.');
      const row=fresh,s=fresh.subject;
      await assertWorkforceEmploymentTx(tx,ctx,s.employmentId,'maintain');
      await assertWorkforcePersonTx(tx,ctx,s.personId,'maintain');
      step = 'person';
      // Lock shared records before carrying forward absent cells. Preview snapshots never supply
      // values for blank columns at apply time; a concurrent unrelated edit must survive.
      const [freshPerson]=await tx.select().from(person).where(eq(person.id,s.personId)).for('update');
      if(!freshPerson)throw new Error('Personnel record is no longer available.');
      const [freshStat]=await tx.select().from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,s.personId)).for('update');
      const historySubject={employmentId:s.employmentId,personId:s.personId,pack:s.pack,country:s.country};
      const historyBefore=p.history?(await readBankStatutoryStateTx(tx,ctx,historySubject)).state:null;
      if (row.personPatch) {
        await updatePerson(ctx, {
          personId: s.personId,
          fullName: row.personPatch.fullName ?? freshPerson.fullName,
          primaryEmail: row.personPatch.primaryEmail ?? freshPerson.primaryEmail,
          phone: row.personPatch.phone ?? freshPerson.phone,
          via: 'section-import',
          ...row.personPatch.fields,
        }, tx);
      }
      if(row.compliance)await setPersonComplianceFields(ctx,{employmentId:s.employmentId,...row.compliance}, tx);
      step = 'ic';
      if (row.ic) await s.pack.statutory.setIc(ctx, { personId: s.personId, icNumber:row.ic.icNumber??freshStat?.icNumber??'',oldIcNumber:row.ic.oldIcNumber??freshStat?.oldIcNumber??null }, tx);
      step = 'passport';
      if (row.passport) {
        const passport={...row.passport};
        for(const key of Object.keys(passport) as (keyof PassportPatch)[])if(!row.passportSupplied?.includes(key))passport[key]=freshStat?.[key]??null;
        await s.pack.statutory.setPassport(ctx,{personId:s.personId,...passport},tx);
      }
      step = 'bank';
      if(row.bank) {
        const latest=freshStat;if(!latest)throw new Error('Statutory setup is unavailable.');
        const bank={...row.bank};
        for(const field of PERSONNEL_BANK_FIELDS) {const key=field.import.writerField! as keyof PersonnelBankValues;if(!row.bankSupplied?.includes(key))(bank as unknown as Record<string,unknown>)[key]=(latest as unknown as Record<string,unknown>)[key]??(field.type==='boolean'?false:null);}
        await s.pack.statutory.setBank(ctx,{personId:s.personId,...bank},tx);
      }
      step='registrations';
      if(row.registrations) {
        const setter=s.pack.statutory.setRegistrationNumbers;if(!setter)throw new Error('Registration-number updates are unavailable for this country pack.');
        await setter(ctx,{personId:s.personId,...row.registrations},tx);
      }
      step = 'statutory';
      if(row.statutoryPatch) {
        if(!freshStat)throw new Error('Statutory setup is unavailable.');
        await applyBankStatutoryPatchTx(tx,ctx,historySubject,row.statutoryPatch);
      }
      step='operations';
      if(row.operations)await applyPersonnelOperationalValuesTx(tx,ctx,s.employmentId,row.operations);
      step = 'dependent';
      if (row.dependent) await addDependentTx(tx,ctx,s.personId,row.dependent);
      if(p.history && historyBefore) {
        const diff=bankStatutoryDiff(historyBefore,(await readBankStatutoryStateTx(tx,ctx,historySubject)).state);
        if(diff.changed.length)await recordImportItemTx(tx,ctx,{attemptId:p.history.attemptId,companyId:s.companyId,employmentId:s.employmentId,itemKey:`row-${row.result.rowNum}`,label:historyLabel(row.result),ordinal:row.result.rowNum,status:'applied',
          before:{employeeCode:s.employeeCode,fields:diff.before} satisfies BankStatutoryItemState,after:{employeeCode:s.employeeCode,fields:diff.after} satisfies BankStatutoryItemState});
      }
      return true;
      });
      if(!wrote)continue;
      appliedPeople.add(s.personId);
      updated++;
      if(row.dependent) {try {await syncChildReliefFromFamily(ctx,s.personId);}catch{warnings.push(`Row ${row.result.rowNum} was saved; review the child-relief refresh on Personnel.`);}}
    } catch (e) {
      // NEVER THE DRIVER'S OWN WORDS. A failed write throws a Drizzle error whose message carries the
      // whole statement AND its bound parameters — an NRIC, a bank account, a tax reference. That text
      // was being rendered to the admin and PERSISTED into `employee_import_run.errors`, in a product
      // holding Malaysian personal data. The stored + displayed message now names the COLUMNS and the
      // row and nothing else; the detail stays in the server log where an engineer can still find it.
      console.error(
        `[section-import] row ${row.result.rowNum} (${row.result.employeeCode}) failed at step "${step}":`,
        pgSqlState(e)==='PN001'?'NRIC duplicate policy refusal':e,
      );
      failed.push({
        rowNum: row.result.rowNum,
        employeeCode: row.result.employeeCode,
        message: writeFailureMessage(step, e),
      });
      if(p.history) {
        const message=failed.at(-1)!.message;
        try{await withTenant(ctx,tx=>recordImportItemTx(tx,ctx,{attemptId:p.history!.attemptId,companyId:s.companyId,employmentId:s.employmentId,itemKey:`row-${row.result.rowNum}`,label:historyLabel(row.result),ordinal:row.result.rowNum,status:'failed',errors:[message]}));}
        catch(recordError){console.error('[section-import] failed item history',recordError);}
      }
    }
  }

  // 0db97f14 — rows refused by the dry run are recorded as failed items (for the companies in the attempt),
  // then the confirmed event carries the counts the history list shows.
  let attemptId:string|null=null;
  if(p.history) {
    const rejected=resolved.filter(r=>!r.result.ok&&r.result.errors.length);
    await withTenant(ctx,async tx=>{
      const attempt=await lockImportAttemptTx(tx,ctx,p.history!.attemptId,'bank_statutory');
      for(const r of rejected)if(r.subject&&attempt.companyIds.includes(r.subject.companyId))await recordImportItemTx(tx,ctx,{attemptId:attempt.id,companyId:r.subject.companyId,employmentId:r.subject.employmentId,itemKey:`row-${r.result.rowNum}`,label:historyLabel(r.result),ordinal:r.result.rowNum,status:'failed',errors:r.result.errors});
      await recordImportEventTx(tx,ctx,{attemptId:attempt.id,kind:'confirmed',importKind:'bank_statutory',detail:{succeeded:updated,failed:failed.length+rejected.length}});
    });
    attemptId=p.history.attemptId;
  }

  const runId = await recordSectionRun(ctx, {
    companyId: resolved.find((r) => r.subject)?.subject?.companyId ?? null,
    fileName: p.fileName ?? '',
    totalRows: resolved.length,
    updated,
    rejected: resolved.filter((r) => !r.result.ok).map((r) => r.result),
    failed,
  });

  return {
    section: p.section,
    updated,
    skipped: resolved.length - updated - failed.length,
    failed,
    fileErrors: [],
    warnings,
    runId,
    ...(attemptId?{attemptId}:{}),
  };
}

const historyLabel=(r:SectionRowResult)=>[r.employeeCode,r.employeeName].filter(Boolean).join(' · ')||`Row ${r.rowNum}`;

/**
 * 0db97f14 — the dry run with each row's employee and company, for the Bank & Statutory upload: which
 * companies the attempt names and which rows are refused before anything is written.
 */
export async function analyzeSectionRows(ctx:SessionContext,section:ImportSection,records:ImportRecord[]){
  const {preview,resolved}=await analyze(ctx,section,records);
  return {fileErrors:preview.fileErrors,rows:resolved.map(r=>({rowNum:r.result.rowNum,employeeCode:r.result.employeeCode,employeeName:r.result.employeeName,verdict:r.result.verdict,ok:r.result.ok,errors:r.result.errors,changes:r.result.changes,companyId:r.subject?.companyId??null,employmentId:r.subject?.employmentId??null}))};
}

/** Bounded background preview: same canonical analyzer, with an opaque concurrency binding. */
const sectionBinding=(row:ResolvedSectionRow)=>createHash('sha256').update(JSON.stringify({...row,result:undefined,subject:undefined})).digest('hex');
export async function analyzeBankImportBatch(ctx:SessionContext,records:ImportRecord[]){
 const {preview,resolved}=await analyze(ctx,'bank_statutory',records);
 return{fileErrors:preview.fileErrors,rows:resolved.map(row=>({preview:row.result,companyId:row.subject?.companyId??null,employmentId:row.subject?.employmentId??null,binding:sectionBinding(row)}))};
}
/** Caller commits the HR mutation, history item and queue checkpoint in ONE transaction. */
export async function applyBankImportRowTx(tx:Tx,ctx:SessionContext,input:{record:ImportRecord;binding:string;employmentId:string;companyId:string;attemptId:string;ordinal:number}){
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
 await lockImportAttemptHeaderTx(tx,ctx,input.attemptId,'bank_statutory');
 const current=await analyze(ctx,'bank_statutory',[input.record],tx);
 const row=current.resolved[0],subject=row?.subject;
 if(current.preview.fileErrors.length||!subject||subject.employmentId!==input.employmentId||subject.companyId!==input.companyId||row.result.errors.length)throw new Error('Personnel changed or access was removed. Validate this row again.');
 if(row.result.verdict==='skip')return false;
 if(!row.result.ok||sectionBinding(row)!==input.binding)throw new Error('Personnel changed after validation. Validate this row again.');
 await assertWorkforceEmploymentTx(tx,ctx,subject.employmentId,'maintain');
 await assertWorkforcePersonTx(tx,ctx,subject.personId,'maintain');
 const [stored]=await tx.select().from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,subject.personId)).for('update');
 if(!stored)throw new Error('Statutory setup is unavailable.');
 const historySubject={employmentId:subject.employmentId,personId:subject.personId,pack:subject.pack,country:subject.country};
 const before=(await readBankStatutoryStateTx(tx,ctx,historySubject)).state;
 if(row.bank){
  const bank={...row.bank};
  for(const field of PERSONNEL_BANK_FIELDS){const key=field.import.writerField! as keyof PersonnelBankValues;if(!row.bankSupplied?.includes(key))(bank as unknown as Record<string,unknown>)[key]=(stored as unknown as Record<string,unknown>)[key]??(field.type==='boolean'?false:null);}
  await subject.pack.statutory.setBank(ctx,{personId:subject.personId,...bank},tx);
 }
 if(row.registrations){const setter=subject.pack.statutory.setRegistrationNumbers;if(!setter)throw new Error('Registration updates are unavailable.');await setter(ctx,{personId:subject.personId,...row.registrations},tx);}
 if(row.statutoryPatch)await applyBankStatutoryPatchTx(tx,ctx,historySubject,row.statutoryPatch);
 if(row.operations)await applyPersonnelOperationalValuesTx(tx,ctx,subject.employmentId,row.operations);
 const diff=bankStatutoryDiff(before,(await readBankStatutoryStateTx(tx,ctx,historySubject)).state);
 if(diff.changed.length)await recordImportItemTx(tx,ctx,{attemptId:input.attemptId,companyId:subject.companyId,employmentId:subject.employmentId,itemKey:`row-${input.ordinal}`,label:historyLabel(row.result),ordinal:input.ordinal,status:'applied',before:{employeeCode:subject.employeeCode,fields:diff.before},after:{employeeCode:subject.employeeCode,fields:diff.after}});
 return diff.changed.length>0;
}

/**
 * cf43c909's history row, for a section run.
 *
 * BEST-EFFORT, for the same reason the wide importer's is: the records are already changed by the time
 * this runs, so losing a history row is a lesser fault than reporting a failure that did not happen.
 * A section run is stored in the SAME table as a wide one — an admin asking "what has been loaded into
 * this system, and what did not go in?" is asking one question, and two histories would be two answers.
 */
async function recordSectionRun(
  ctx: SessionContext,
  p: {
    companyId: string | null;
    fileName: string;
    totalRows: number;
    updated: number;
    rejected: SectionRowResult[];
    failed: SectionImportResult['failed'];
  },
): Promise<string | null> {
  // Identity + reason only — never a cell's value. Skipped rows are NOT failures: nothing was wrong
  // with them, there was simply nothing to do, so they are excluded rather than reported as errors.
  const errors: ImportRunError[] = [
    ...p.rejected
      .filter((r) => r.errors.length > 0)
      .map((r) => ({ rowNum: r.rowNum, fullName: r.employeeName || r.employeeCode, email: '', errors: r.errors })),
    ...p.failed.map((f) => ({ rowNum: f.rowNum, fullName: f.employeeCode, email: '', errors: [f.message] })),
  ].sort((a, b) => a.rowNum - b.rowNum);
  try {
    return await withTenant(ctx, async (tx) => {
      let personId = ctx.personId ?? null;
      if (!personId && ctx.userId) {
        const [u] = await tx
          .select({ personId: appUser.personId })
          .from(appUser)
          .where(and(eq(appUser.tenantId, ctx.tenantId), eq(appUser.workosUserId, ctx.userId)))
          .limit(1);
        personId = u?.personId ?? null;
      }
      const [rowOut] = await tx
        .insert(employeeImportRun)
        .values({
          tenantId: ctx.tenantId,
          companyId: p.companyId,
          createdByPersonId: personId,
          createdByUserId: ctx.userId ?? null,
          fileName: p.fileName.slice(0, 255),
          totalRows: p.totalRows,
          importedRows: p.updated,
          failedRows: errors.length,
          errors: errors.slice(0, IMPORT_RUN_ERROR_CAP),
          errorsTruncated: errors.length > IMPORT_RUN_ERROR_CAP,
        })
        .returning({ id: employeeImportRun.id });
      return rowOut?.id ?? null;
    });
  } catch {
    return null;
  }
}
