/**
 * Day-one employee importer (ADR-0008 localization stays in the pack; this is the generic
 * bulk-load path). Parses a validated set of CSV records and reuses the same services the
 * single-hire form uses — hireEmployee → the pack's statutory.set → setCompensation — so an
 * imported employee is indistinguishable from a hand-entered one, events included.
 *
 * Two phases:
 *  - analyze(): pure validation against the company catalog + existing records (dry run).
 *  - commitEmployeeImport(): imports the rows that pass, row-by-row, continuing past a row
 *    that fails so one bad record can't strand the rest, then appends a batch event.
 *
 * Not atomic across rows by design: the per-row services each own their transaction, and a
 * day-one migration wants maximum rows in, not all-or-nothing. The dry run is the gate.
 */
import { withTenant, type SessionContext } from '../db/client';
import {
  company,
  person,
  employeeStatutoryMy,
  employeeDraft,
  employment,
  employeeImportRun,
  appUser,
  profileOption,
} from '../db/schema';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { hireEmployee, setEmploymentInfo, setReportingLine, updatePerson } from './org';
import { setCompensation } from './comp';
import { setPersonComplianceFields } from './profile';
// Item 2983802f — the family sheet writes through the SAME service the Family card uses, so an imported
// dependant is indistinguishable from a hand-entered one (events, child-relief resync, catalog rules).
import { addDependent, DEPENDENT_GENDERS, DEPENDENT_RELATIONSHIPS } from './dependents';
// Rung 5a (ADR-0080 D1/D6): the statutory writer + IC helpers come from the COMPANY'S country pack
// (resolved in analyze() from company.country), never from a direct localization/my import. A company
// whose country resolves no pack fails the import loudly (D3) instead of validating under MY rules.
import { requirePackFor, type CountryPack } from '../localization/registry';
import { normalizeEmployeeCode, isValidEmployeeCode, EMPLOYEE_CODE_MAX_LEN } from '../lib/employee-code';
import { listCompanies, listDepartments, listLeaveTypes } from './read';
import { listPositions, listCostCenters } from './admin';
import { appendEvent, actorOf } from '../db/events';
import {
  DEPENDENT_IMPORT_COLUMNS,
  IMPORT_COLUMNS,
  type DependentPreview,
  type DependentRowResult,
  type ImportRecord,
  type RowResult,
  type ImportPreview,
  type ImportResult,
  type ImportRunError,
  type ImportRunRow,
} from '../lib/import-schema';

// Re-exported so server-side callers (actions, tests) can keep importing from core/import.
export { IMPORT_COLUMNS, DEPENDENT_IMPORT_COLUMNS };
export type {
  ImportRecord,
  RowResult,
  ImportPreview,
  ImportResult,
  ImportRunError,
  ImportRunRow,
  DependentPreview,
  DependentRowResult,
};

/**
 * cf43c909 — how many rejected rows an import run stores.
 *
 * The error detail exists so HR can correct the rows and re-upload; past a few hundred the file itself is
 * the wrong file and the answer is to fix the source, not to scroll. Capping bounds the jsonb document a
 * single bad 5,000-row upload can write, and `errorsTruncated` tells the screen to say the list is a
 * sample rather than letting anyone believe a truncated report is the whole story.
 */
export const IMPORT_RUN_ERROR_CAP = 200;

/** How many past runs the history screen reads. */
export const IMPORT_RUN_HISTORY_LIMIT = 50;

const EMPLOYMENT_TYPES = new Set(['full_time', 'part_time', 'contract', 'intern']);
const STANDING_GRANTS = new Set(['ANNUAL', 'SICK', 'HOSPITALIZATION']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TRUTHY = new Set(['', 'true', 'yes', 'y', '1']); // default-true fields: blank = true
const FALSY = new Set(['false', 'no', 'n', '0']);

/** Everything the per-row validation needs for ONE company: its catalogs and its country pack.
 *  d8471481 made this per-company because a file may now span several. */
type CompanyContext = {
  id: string;
  name: string;
  deptByName: Map<string, string>;
  posByName: Map<string, string>;
  ccByName: Map<string, string>;
  pack: CountryPack;
};

type ResolvedRow = {
  result: RowResult;
  /** The company's pack — resolved from the ROW's company, not the screen's, so a Singapore company
   *  in a mostly-Malaysian file is validated under its own statutory rules (ADR-0080 D1/D6). */
  pack: CountryPack;
  hire: {
    person: { fullName: string; primaryEmail: string; phone?: string };
    companyId: string;
    departmentId: string;
    positionId?: string;
    costCenterId?: string;
    employmentType: 'full_time' | 'part_time' | 'contract' | 'intern';
    hiredOn: string;
    employeeCode?: string; // optional — blank/absent falls through to hireEmployee's auto counter
    grantLeaveTypes: { id: string; code: string }[];
    /** Item 2983802f — the probation end date, set AT HIRE (this is the column hireEmployee accepts).
     *  Undefined unless the row supplied one, so an existing file's behaviour is byte-identical. */
    provisionalEndOn?: string;
  };
  /**
   * Item 2983802f — home address + emergency contact, written through `updatePerson` (the same writer the
   * Personnel Contact & Address card uses, which routes the emergency block into the register in the same
   * transaction). Undefined when the row supplied none of these columns, so no extra write happens and an
   * existing file's import is unchanged.
   */
  profile?: Record<string, string | null>;
  /** Item 2983802f — the passport block, written through the company pack's `setPassport`. Undefined
   *  unless the row supplied at least one passport cell (an all-blank block must not clear anything). */
  passport?: {
    passportNumber: string;
    passportIssueDate: string;
    passportExpiryDate: string;
    passportIssuingCountry?: string;
  };
  /** Item 2983802f — probation + notice-period periods and the confirmation date, written through
   *  `setEmploymentInfo`. Undefined unless the row supplied at least one of them. */
  employmentInfo?: Record<string, string>;
  /**
   * Item 2983802f — the Direct Superior, RESOLVED AFTER EVERY ROW IS READ.
   *
   * `existing` names an employment already in the tenant; `row` names another line of THIS file, which is
   * the whole point: A0002's manager may be A0005 further down, and a valid file must not fail because of
   * the order its rows happen to be in.
   */
  superior?: { kind: 'existing'; employmentId: string } | { kind: 'row'; index: number };
  statutory: {
    icNumber: string;
    epfNumber?: string;
    socsoNumber?: string;
    taxNumber?: string;
    taxCategory?: number;
    numChildren?: number;
    eisEligible?: boolean;
    isResident?: boolean;
    epfCitizenship?: 'citizen' | 'pr' | 'non_citizen';
    bankName?: string;
    bankAccountNo?: string;
  };
  basicSalary: number;
  monthlyAllowance: number;
  // ADR-0078 — optional employee-specific salary structure (undefined ⇒ the setCompensation defaults:
  // monthly / monthly / no rate). A mixed-workforce customer onboards by CSV, so this path is in scope.
  payMode?: 'monthly' | 'daily' | 'hourly' | 'custom_period';
  paymentTerm?: 'monthly' | 'weekly' | 'biweekly';
  rateAmount?: number;
  effectiveFrom: string;
};

/** Item 2983802f — one validated row of the FAMILY sheet, with the employee row it belongs to. */
type ResolvedDependent = {
  result: DependentRowResult;
  /** Index into the employee `resolved` array; -1 when the Employee ID matched nothing on that sheet. */
  employeeIndex: number;
  add: {
    fullName: string;
    relationship: string;
    dateOfBirth?: string;
    gender?: string;
    icOrPassport?: string;
    passportNumber?: string;
    phone?: string;
    isBeneficiary: boolean;
    remarks?: string;
  };
};

const norm = (s: string | undefined) => (s ?? '').trim();
const lc = (s: string | undefined) => norm(s).toLowerCase();
/** Enum-ish cell: lowercased with spaces and dashes folded to underscores, the way every other coded
 *  column on this sheet is already read (`employment_type`, `pay_mode`, `epf_citizenship`). */
const enumCell = (s: string | undefined) => lc(s).replace(/[\s-]+/g, '_');

/**
 * Item 2983802f — the verdict on ONE catalog-governed import cell, in THREE distinct states.
 *
 * The three are kept apart on purpose. An earlier shape returned `undefined` for both "the cell was
 * blank" and "the catalog refused this value", and the payload builder below then fell back to the RAW
 * cell — so a value the dry run had just rejected was still assembled into the `updatePerson` payload.
 * Nothing wrote it, because the row also carried the error and was skipped at commit; but "a rejected
 * value survives in the payload and only an unrelated guard stops it from being written" is the exact
 * silently-wrong-field this whole item exists to prevent. So the verdict says which of the three it is.
 */
export type CatalogCell =
  | { kind: 'blank' }
  | { kind: 'ok'; value: string }
  | { kind: 'refused'; value: string };

/** Pure: classify one cell against a catalog predicate. Exported so the three-way contract is pinned by
 *  a test rather than inferred from the call sites. */
export function classifyCatalogCell(
  raw: string | undefined,
  allows: (value: string) => boolean,
): CatalogCell {
  const v = norm(raw);
  if (!v) return { kind: 'blank' };
  return allows(v) ? { kind: 'ok', value: v } : { kind: 'refused', value: v };
}

/**
 * Pure: what one cell contributes to an `updatePerson` payload. `checked` is the validator's verdict for
 * a catalog-governed column and `undefined` for a plain-text one; `raw` is the trimmed cell.
 *
 * A REFUSED verdict contributes NOTHING. It must not fall through to `raw`: the reason is already on the
 * row, and writing the text anyway would put a value in the record that the catalog does not allow.
 */
export function carriedProfileValue(checked: CatalogCell | undefined, raw: string): string | undefined {
  if (checked?.kind === 'refused') return undefined;
  const v = checked?.kind === 'ok' ? checked.value : raw;
  return v === '' ? undefined : v;
}

/** Build the catalog + pack context for ONE company. Called once per DISTINCT company named in the
 *  file, so a single-company import does exactly the work it always did. */
async function loadCompanyContext(
  ctx: SessionContext,
  co: { id: string; name: string; country: string | null },
): Promise<CompanyContext> {
  const [departments, positions, costCenters] = await Promise.all([
    listDepartments(ctx, { companyIds: [co.id] }),
    listPositions(ctx, { companyIds: [co.id] }),
    listCostCenters(ctx, { companyIds: [co.id] }),
  ]);
  const ccByName = new Map<string, string>();
  for (const c of costCenters) {
    if (c.name) ccByName.set(c.name.toLowerCase(), c.id);
    if (c.code) ccByName.set(c.code.toLowerCase(), c.id);
  }
  return {
    id: co.id,
    name: co.name,
    deptByName: new Map(departments.map((d) => [d.name.toLowerCase(), d.id])),
    posByName: new Map(positions.map((p) => [p.title.toLowerCase(), p.id])),
    ccByName,
    // Rung 5a (ADR-0080 D1/D6): IC rules come from the COMPANY'S country pack, fail-loud when the
    // country resolves nothing — so a per-row company change also changes the statutory rules applied.
    pack: requirePackFor(co.country),
  };
}

/** Read the company catalogs + existing identifiers once, then validate every record in memory. */
async function analyze(
  ctx: SessionContext,
  companyId: string,
  records: ImportRecord[],
  /** Item 2983802f — the FAMILY sheet's records. Empty for every file that has no such sheet, which is
   *  every file that imports today. */
  dependentRecords: ImportRecord[] = [],
): Promise<{ preview: ImportPreview; resolved: ResolvedRow[]; dependents: ResolvedDependent[] }> {
  const [allCompanies, leaveTypes] = await Promise.all([listCompanies(ctx), listLeaveTypes(ctx)]);
  // d8471481 — company lookup keys. Legal name is what the reporter's template shows; company label
  // and registration number are accepted because those are what an HR spreadsheet usually carries.
  // The id is accepted too so a machine-generated file can be exact. All matched case-insensitively.
  const companyByKey = new Map<string, (typeof allCompanies)[number]>();
  const key = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
  for (const c of allCompanies) {
    for (const k of [c.id, c.name, c.companyLabel, c.registrationNo]) {
      const kk = key(k);
      // First writer wins: a duplicate label must never silently retarget an unrelated company.
      if (kk && !companyByKey.has(kk)) companyByKey.set(kk, c);
    }
  }
  const defaultCompany = allCompanies.find((c) => c.id === companyId);

  const grants = leaveTypes
    .filter((t) => STANDING_GRANTS.has(t.code))
    .map((t) => ({ id: t.id, code: t.code }));

  // PASS 1 — resolve each row's company from the file, so we know which catalogs to load. Pure and
  // synchronous; the unresolved ones are recorded and surface as a per-row error in pass 2.
  const rowCompanies = records.map((rec) => {
    const raw = norm(rec.company);
    if (!raw) return { raw, co: defaultCompany, unknown: false };
    const co = companyByKey.get(raw.toLowerCase());
    return { raw, co, unknown: !co };
  });
  const needed = new Map<string, (typeof allCompanies)[number]>();
  for (const rc of rowCompanies) if (rc.co) needed.set(rc.co.id, rc.co);
  if (defaultCompany) needed.set(defaultCompany.id, defaultCompany);
  const contexts = new Map<string, CompanyContext>();
  for (const [id, co] of needed) contexts.set(id, await loadCompanyContext(ctx, co));

  // Existing identifiers (tenant-scoped via RLS) so the import can't create dup ICs (DB-unique)
  // or silently re-add someone by email. IC normalisation is pack-specific, so the collision set is
  // built with the DEFAULT company's pack — the same pack that produced every stored IC in a
  // single-jurisdiction tenant. `normalizeIC` is digit-stripping in every pack today, so this stays
  // correct across a mixed file; if a pack ever normalises differently, this is where to revisit.
  let normPack = contexts.get(companyId)?.pack ?? [...contexts.values()][0]?.pack;
  const {
    existingEmails,
    existingIcs,
    existingCodes,
    reservedCodes,
    catalog,
    superiorByCode,
    superiorByEmail,
  } = await withTenant(ctx, async (tx) => {
    if (!normPack) {
      // No company resolved from `listCompanies` — which EXCLUDES archived companies, so this is
      // reachable when the screen's selected company has since been archived. Read its country
      // directly and let the pack registry decide: it either resolves (and we keep going, so the IC
      // collision set is still built with the right rules) or it throws with its own message.
      const [co] = await tx
        .select({ country: company.country })
        .from(company)
        .where(eq(company.id, companyId))
        .limit(1);
      normPack = requirePackFor(co?.country);
    }
    const ppl = await tx.select({ email: person.primaryEmail }).from(person);
    const ics = await tx.select({ ic: employeeStatutoryMy.icNumber }).from(employeeStatutoryMy);
    // Employee IDs already in use in this tenant (feedback 38668d9b) — an import must not collide with an
    // existing staff ID. Compared on the normalized (uppercased) value, matching the uniqueness rule.
    const codes = await tx.select({ code: employment.employeeCode }).from(employment);
    // Item 2983802f — the tenant's existing employments, keyed by Employee ID and by work email, so a
    // `direct_superior` cell may name somebody who is ALREADY employed (the usual case: a new intake
    // reporting to a manager who has been here for years) as well as somebody further down the file.
    const superiorCandidates = await tx
      .select({ id: employment.id, code: employment.employeeCode, email: person.primaryEmail })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId));
    // Item 2983802f — the catalog-governed vocabularies the new columns write into. Read ONCE here so a
    // typo in `state` / `country` / an emergency-contact or family relationship is a per-row error in the
    // DRY RUN, where a spreadsheet can still be fixed, instead of a failure at write with an employee
    // already created. Same rule as `assertProfileValueAllowed`: an EMPTY catalog means the tenant never
    // configured that list and free text is accepted, exactly as it is on the Personnel screens.
    const options = await tx
      .select({ category: profileOption.category, value: profileOption.value })
      .from(profileOption)
      .where(eq(profileOption.isActive, true));
    // Item 06f0cb8f — an unfinished DRAFT holds an Employee ID too, so an import can collide with a
    // record that has no employment row yet. `hireEmployee` refuses it either way (that is the
    // authority, and it is what makes the rule true for every path at once); reading it here as well
    // moves the refusal from row 400 of a commit into the preview, where a spreadsheet can still be fixed.
    const reserved = await tx
      .select({ code: employeeDraft.reservedEmployeeCode })
      .from(employeeDraft)
      .where(isNotNull(employeeDraft.reservedEmployeeCode));
    const catalog = new Map<string, Set<string>>();
    for (const o of options) {
      const set = catalog.get(o.category) ?? new Set<string>();
      set.add(o.value);
      catalog.set(o.category, set);
    }
    const superiorByCode = new Map<string, string>();
    const superiorByEmail = new Map<string, string>();
    for (const e of superiorCandidates) {
      if (e.code) superiorByCode.set(normalizeEmployeeCode(e.code), e.id);
      superiorByEmail.set(e.email.toLowerCase(), e.id);
    }
    return {
      catalog,
      superiorByCode,
      superiorByEmail,
      reservedCodes: new Set(reserved.map((r) => normalizeEmployeeCode(r.code as string))),
      existingEmails: new Set(ppl.map((r) => r.email.toLowerCase())),
      // Item e3ce0d4d — icNumber is now nullable (non-Malaysian passport rows); skip null ICs so a blank never
      // enters the collision set (mirrors the employeeCode filter below).
      existingIcs: new Set(
        ics.filter((r) => r.ic).map((r) => normPack!.statutory.normalizeIC(r.ic as string)),
      ),
      existingCodes: new Set(codes.filter((r) => r.code).map((r) => normalizeEmployeeCode(r.code))),
    };
  });

  const presentColumns = new Set(records.length ? Object.keys(records[0]) : []);
  const missingColumns = IMPORT_COLUMNS.required.filter((c) => !presentColumns.has(c));

  const seenEmails = new Set<string>();
  const seenIcs = new Set<string>();
  const seenCodes = new Set<string>();
  const resolved: ResolvedRow[] = [];
  // Item 2983802f — the Direct Superior cell of each row, kept as typed. Resolution happens AFTER the
  // loop below, because a superior may be a row this loop has not reached yet.
  const superiorRaw: string[] = [];
  // Item 2983802f — Employee ID → row index, for both the superior pass and the family sheet's link.
  const codeToRow = new Map<string, number>();

  /**
   * Item 2983802f — is this value acceptable for a catalog-governed column?
   *
   * The SAME rule `assertProfileValueAllowed` applies at write time, checked here so it fails in the dry
   * run instead: blank is always fine, an EMPTY catalog means the tenant never configured that list and
   * free text is accepted (today's behaviour on the Personnel screens), otherwise the value must be one
   * of the active options. Deliberately NOT case-folded — the catalog value is what gets stored, and the
   * Reference sheet lists the exact spellings.
   */
  const catalogAllows = (category: string, value: string): boolean => {
    const active = catalog.get(category);
    if (!active || active.size === 0) return true;
    return active.has(value);
  };

  records.forEach((rec, idx) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const fullName = norm(rec.full_name);
    const email = norm(rec.email);

    // PASS 2 begins with the company: every catalog lookup below is against THIS row's company, which
    // is what makes the reporter's "Department does not belong to selected company" a real check.
    const rc = rowCompanies[idx];
    if (rc.unknown) errors.push(`Unknown company "${rc.raw}"`);
    else if (!rc.co) errors.push('Missing company');
    const cctx = rc.co ? contexts.get(rc.co.id) : undefined;
    const { deptByName, posByName, ccByName } = cctx ?? {
      deptByName: new Map<string, string>(),
      posByName: new Map<string, string>(),
      ccByName: new Map<string, string>(),
    };
    const pack = cctx?.pack ?? normPack!;

    // Employee ID (feedback 38668d9b): HR MAY supply one — the feature is manual-entry ABILITY, not an
    // obligation. Blank or absent → hireEmployee auto-generates via nextEmployeeCode, exactly like a
    // hand hire without an ID. When supplied: alphanumeric + dash max 30 (de2823cc), unique in the file and across
    // the tenant; the normalized (uppercased) value is what gets stored + hired with.
    const codeRaw = norm(rec.employee_code);
    const codeNorm = normalizeEmployeeCode(codeRaw);
    if (codeRaw && !isValidEmployeeCode(codeRaw))
      errors.push(`Invalid employee_code "${codeRaw}" (letters/numbers/dash, max ${EMPLOYEE_CODE_MAX_LEN})`);
    else if (codeRaw && seenCodes.has(codeNorm)) errors.push('Duplicate employee_code in this file');
    else if (codeRaw && existingCodes.has(codeNorm)) errors.push(`Employee ID "${codeNorm}" is already in use`);
    // Named differently from "already in use" (item 06f0cb8f): nobody is employed under this ID — an
    // unfinished draft is holding it, and the way out is to finish or discard that draft.
    else if (codeRaw && reservedCodes.has(codeNorm))
      errors.push(`Employee ID "${codeNorm}" is reserved by a draft employee record`);
    if (codeRaw && isValidEmployeeCode(codeRaw)) seenCodes.add(codeNorm);

    if (!fullName) errors.push('Missing full_name');
    if (!email) errors.push('Missing email');
    else if (!EMAIL_RE.test(email)) errors.push(`Invalid email "${email}"`);
    else if (seenEmails.has(email.toLowerCase())) errors.push('Duplicate email in this file');
    else if (existingEmails.has(email.toLowerCase())) warnings.push('A person with this email already exists');
    if (email) seenEmails.add(email.toLowerCase());

    // Department (required, resolved by name)
    const deptName = norm(rec.department);
    const departmentId = deptByName.get(deptName.toLowerCase());
    if (!deptName) errors.push('Missing department');
    else if (!departmentId) errors.push(`Unknown department "${deptName}"`);

    // Position / cost-center (optional, resolved by name; unknown = error so it's never dropped silently)
    const posName = norm(rec.position);
    let positionId: string | undefined;
    if (posName) {
      positionId = posByName.get(posName.toLowerCase());
      if (!positionId) errors.push(`Unknown position "${posName}"`);
    }
    const ccName = norm(rec.cost_center);
    let costCenterId: string | undefined;
    if (ccName) {
      costCenterId = ccByName.get(ccName.toLowerCase());
      if (!costCenterId) errors.push(`Unknown cost_center "${ccName}"`);
    }

    // Hire date
    const hiredOn = norm(rec.hired_on);
    if (!hiredOn) errors.push('Missing hired_on');
    else if (!DATE_RE.test(hiredOn)) errors.push(`hired_on must be YYYY-MM-DD (got "${hiredOn}")`);

    // Employment type
    let employmentType: 'full_time' | 'part_time' | 'contract' | 'intern' = 'full_time';
    const etRaw = lc(rec.employment_type).replace(/[\s-]+/g, '_');
    if (etRaw) {
      if (EMPLOYMENT_TYPES.has(etRaw)) employmentType = etRaw as typeof employmentType;
      else errors.push(`Unknown employment_type "${rec.employment_type}"`);
    }

    // IC (required, format + uniqueness — DB enforces tenant-unique IC; rules from the company's pack)
    const icRaw = norm(rec.ic_number);
    const icNorm = pack.statutory.normalizeIC(icRaw);
    if (!icRaw) errors.push('Missing ic_number');
    else if (!pack.statutory.validateIC(icRaw)) errors.push(`Invalid IC "${icRaw}" (expected 12 digits)`);
    else if (seenIcs.has(icNorm)) errors.push('Duplicate ic_number in this file');
    else if (existingIcs.has(icNorm)) errors.push('An employee with this IC already exists');
    if (icRaw && pack.statutory.validateIC(icRaw)) seenIcs.add(icNorm);

    // Salary
    const salaryRaw = norm(rec.basic_salary).replace(/[,_]/g, '');
    const basicSalary = Number(salaryRaw);
    if (!salaryRaw) errors.push('Missing basic_salary');
    else if (!Number.isFinite(basicSalary) || basicSalary < 0) errors.push(`Invalid basic_salary "${rec.basic_salary}"`);
    const allowanceRaw = norm(rec.monthly_allowance).replace(/[,_]/g, '');
    let monthlyAllowance = 0;
    if (allowanceRaw) {
      monthlyAllowance = Number(allowanceRaw);
      if (!Number.isFinite(monthlyAllowance) || monthlyAllowance < 0) {
        errors.push(`Invalid monthly_allowance "${rec.monthly_allowance}"`);
        monthlyAllowance = 0;
      }
    }

    // Tax category / children
    let taxCategory: number | undefined;
    const tcRaw = norm(rec.tax_category);
    if (tcRaw) {
      taxCategory = Number(tcRaw);
      if (![1, 2, 3].includes(taxCategory)) errors.push('tax_category must be 1, 2 or 3');
    }
    let numChildren: number | undefined;
    const ncRaw = norm(rec.num_children);
    if (ncRaw) {
      numChildren = Number(ncRaw);
      if (!Number.isInteger(numChildren) || numChildren < 0) errors.push(`Invalid num_children "${ncRaw}"`);
    }

    // Boolean flags (default true)
    const boolField = (raw: string, label: string): boolean | undefined => {
      const v = lc(raw);
      if (v === '') return undefined;
      if (TRUTHY.has(v)) return true;
      if (FALSY.has(v)) return false;
      errors.push(`Invalid ${label} "${raw}" (use yes/no)`);
      return undefined;
    };
    const eisEligible = boolField(rec.eis_eligible, 'eis_eligible');
    const isResident = boolField(rec.is_resident, 'is_resident');
    // EPF citizenship (#157) — drives the Third Schedule rule. Default citizen; accepts common synonyms.
    const epfCitizenship = ((): 'citizen' | 'pr' | 'non_citizen' | undefined => {
      const c = norm(rec.epf_citizenship).toLowerCase().replace(/[\s-]+/g, '_');
      if (!c) return undefined;
      if (c === 'citizen' || c === 'malaysian') return 'citizen';
      if (c === 'pr' || c === 'permanent_resident') return 'pr';
      if (['non_citizen', 'noncitizen', 'foreign', 'foreigner', 'foreign_worker'].includes(c)) return 'non_citizen';
      errors.push(`Invalid epf_citizenship "${rec.epf_citizenship}" (use citizen / pr / non_citizen)`);
      return undefined;
    })();

    // Bank: both or neither (mirrors the ESS validation)
    const bankName = norm(rec.bank_name) || undefined;
    const bankAccountNo = norm(rec.bank_account_no) || undefined;
    if (!!bankName !== !!bankAccountNo) errors.push('bank_name and bank_account_no must be provided together');

    // ADR-0078 — employee-specific salary structure (all optional; blank = monthly / monthly / no rate,
    // the setCompensation defaults). Mirrors the service validation so a bad row fails the DRY RUN, not
    // the commit: daily/hourly require a positive rate_amount.
    const payMode = ((): 'monthly' | 'daily' | 'hourly' | 'custom_period' | undefined => {
      const m = lc(rec.pay_mode).replace(/[\s-]+/g, '_');
      if (!m) return undefined;
      if (['monthly', 'daily', 'hourly', 'custom_period'].includes(m)) return m as 'monthly';
      errors.push(`Invalid pay_mode "${rec.pay_mode}" (use monthly / daily / hourly / custom_period)`);
      return undefined;
    })();
    const paymentTerm = ((): 'monthly' | 'weekly' | 'biweekly' | undefined => {
      const f = lc(rec.payment_term).replace(/[\s-]+/g, '_');
      if (!f) return undefined;
      if (f === 'bi_weekly' || f === 'biweekly') return 'biweekly';
      if (f === 'monthly' || f === 'weekly') return f;
      errors.push(`Invalid payment_term "${rec.payment_term}" (use monthly / weekly / biweekly)`);
      return undefined;
    })();
    let rateAmount: number | undefined;
    const rateRaw = norm(rec.rate_amount).replace(/[,_]/g, '');
    if (rateRaw) {
      rateAmount = Number(rateRaw);
      if (!Number.isFinite(rateAmount) || rateAmount < 0) {
        errors.push(`Invalid rate_amount "${rec.rate_amount}"`);
        rateAmount = undefined;
      }
    }
    if ((payMode === 'daily' || payMode === 'hourly') && !(rateAmount !== undefined && rateAmount > 0)) {
      errors.push(`pay_mode "${payMode}" requires a positive rate_amount`);
    }

    // ─────────────────────────── Item 2983802f — the seven new blocks ───────────────────────────
    // Every one of them is OPTIONAL and every one of them fails HERE, in the dry run, rather than
    // half-way through a commit: the whole reason the preview exists is that a spreadsheet can still be
    // corrected while nothing has been written.

    /** An optional YYYY-MM-DD cell. Blank → undefined; malformed → a named per-row error. */
    const dateField = (raw: string | undefined, label: string): string | undefined => {
      const v = norm(raw);
      if (!v) return undefined;
      if (!DATE_RE.test(v)) {
        errors.push(`${label} must be YYYY-MM-DD (got "${v}")`);
        return undefined;
      }
      return v;
    };
    /** An optional non-negative whole number (a period length in months or days). */
    const countField = (raw: string | undefined, label: string): string | undefined => {
      const v = norm(raw).replace(/[,_]/g, '');
      if (!v) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        errors.push(`Invalid ${label} "${raw}" (whole number, 0 or more)`);
        return undefined;
      }
      return String(n);
    };
    /** An optional value governed by a profile_option catalog, as a three-way verdict (see `CatalogCell`
     *  — blank, accepted and refused are never collapsed into one another). */
    const catalogField = (raw: string | undefined, category: string, label: string): CatalogCell => {
      const cell = classifyCatalogCell(raw, (v) => catalogAllows(category, v));
      if (cell.kind === 'refused') {
        errors.push(
          `"${cell.value}" is not an active ${category} option (see the Reference sheet) — column ${label}`,
        );
      }
      return cell;
    };

    // PASSPORT — all-or-nothing on the trio, matching the Personnel card (a partial passport block is
    // refused there too).
    //
    // THE ISSUING COUNTRY IS GOVERNED BY THE `nationality` CATALOG, NOT `country`. That is not a typo: the
    // Passport card's Issuing Country picker is fed from the tenant's nationality list
    // (app/admin/personnel/[employmentId]/page.tsx → IdentityFields `countryOptions`), so the value the
    // product itself stores in this column is a DEMONYM — "Malaysian", not "Malaysia"; the separate
    // `passportIssuingCountryCode` field carries the ISO code precisely because one cannot be derived from
    // the other (e4b541c6, components/personnel-identity.tsx). Checking it against `country` rejected every
    // value the card can produce and accepted values its dropdown never offers, which the Reference sheet
    // (which now lists this column, from the same live nationality catalog) would have made obvious.
    const passportNumber = norm(rec.passport_number);
    const passportIssue = dateField(rec.passport_issue_date, 'passport_issue_date');
    const passportExpiry = dateField(rec.passport_expiry_date, 'passport_expiry_date');
    const passportCountry = catalogField(
      rec.passport_issuing_country,
      'nationality',
      'passport_issuing_country',
    );
    const passportTouched =
      Boolean(passportNumber) ||
      norm(rec.passport_issue_date) !== '' ||
      norm(rec.passport_expiry_date) !== '' ||
      norm(rec.passport_issuing_country) !== '';
    let passport: ResolvedRow['passport'];
    if (passportTouched) {
      if (!passportNumber || !passportIssue || !passportExpiry) {
        errors.push('passport_number, passport_issue_date and passport_expiry_date must be provided together');
      } else if (passportExpiry < passportIssue) {
        errors.push('passport_expiry_date must be on or after passport_issue_date');
      } else {
        passport = {
          passportNumber,
          passportIssueDate: passportIssue,
          passportExpiryDate: passportExpiry,
          passportIssuingCountry: passportCountry.kind === 'ok' ? passportCountry.value : undefined,
        };
      }
    }

    // ADDRESS + EMERGENCY CONTACT — one `updatePerson` payload, because that writer saves the address and
    // routes the emergency block into the register inside ONE transaction. Only the cells the file
    // actually carries are put in the payload: `updatePerson` leaves an omitted field alone, so a
    // template missing these columns entirely can never blank an existing person's address.
    const profile: Record<string, string | null> = {};
    const carry = (column: string, field: string, checked?: CatalogCell) => {
      if (!(column in rec)) return; // column absent from the file → say nothing about it
      const v = carriedProfileValue(checked, norm(rec[column]));
      if (v !== undefined) profile[field] = v;
    };
    carry('address_line_1', 'permanentAddressLine1');
    carry('address_line_2', 'permanentAddressLine2');
    carry('address_line_3', 'permanentAddressLine3');
    carry('postcode', 'permanentPostcode');
    carry('city', 'permanentCity');
    carry('state', 'permanentState', catalogField(rec.state, 'state', 'state'));
    carry('country', 'permanentCountry', catalogField(rec.country, 'country', 'country'));
    carry('emergency_contact_name', 'emergencyContactName');
    carry(
      'emergency_contact_relationship',
      'emergencyContactRelationship',
      catalogField(rec.emergency_contact_relationship, 'relationship', 'emergency_contact_relationship'),
    );
    carry('emergency_contact_phone', 'emergencyContactPhone');
    carry('emergency_contact_home_phone', 'emergencyContactPhone2');
    carry('emergency_contact_address', 'emergencyContactAddress');

    // PROBATION + NOTICE PERIOD. `probation_end_date` writes the employment's provisional end date, which
    // IS the probation end for a full-time hire — and means the END OF THE CONTRACT for a contract or an
    // internship. Accepting it there would quietly record a contract end nobody typed, so it is refused
    // with the reason instead.
    const probationEnd = dateField(rec.probation_end_date, 'probation_end_date');
    if (probationEnd && employmentType !== 'full_time') {
      errors.push(
        `probation_end_date applies to full_time employees only (this row is ${employmentType}; for a fixed term use the contract dates on the employee's record)`,
      );
    }
    if (probationEnd && hiredOn && DATE_RE.test(hiredOn) && probationEnd < hiredOn) {
      errors.push('probation_end_date must be on or after hired_on');
    }
    const confirmationDate = dateField(rec.confirmation_date, 'confirmation_date');
    if (confirmationDate && hiredOn && DATE_RE.test(hiredOn) && confirmationDate < hiredOn) {
      errors.push('confirmation_date must be on or after hired_on');
    }
    const employmentInfo: Record<string, string> = {};
    const period = (column: string, field: string) => {
      const v = countField(rec[column], column);
      if (v !== undefined) employmentInfo[field] = v;
    };
    period('probation_months', 'probationMonths');
    period('probation_days', 'probationDays');
    period('resignation_notice_months', 'resignationNoticeMonths');
    period('resignation_notice_days', 'resignationNoticeDays');
    if (confirmationDate) employmentInfo.confirmationDate = confirmationDate;

    // DIRECT SUPERIOR — recorded now, RESOLVED LATER (see the pass after this loop). Resolving here would
    // fail a perfectly valid file purely because the manager's row happens to come after the subordinate's.
    superiorRaw.push(norm(rec.direct_superior));
    if (codeRaw && isValidEmployeeCode(codeRaw) && !codeToRow.has(codeNorm)) codeToRow.set(codeNorm, idx);

    const ok = errors.length === 0;
    const result: RowResult = {
      rowNum: idx + 1,
      fullName,
      email,
      ok,
      errors,
      warnings,
      company: rc.co?.name ?? '',
    };
    resolved.push({
      result,
      pack,
      hire: {
        person: { fullName, primaryEmail: email, phone: norm(rec.phone) || undefined },
        companyId: rc.co?.id ?? companyId,
        departmentId: departmentId ?? '',
        positionId,
        costCenterId,
        employmentType,
        hiredOn,
        // Blank → undefined so hireEmployee falls through to the nextEmployeeCode auto-counter.
        employeeCode: codeNorm || undefined,
        grantLeaveTypes: grants,
        provisionalEndOn: probationEnd,
      },
      profile: Object.keys(profile).length > 0 ? profile : undefined,
      passport,
      employmentInfo: Object.keys(employmentInfo).length > 0 ? employmentInfo : undefined,
      statutory: {
        icNumber: icRaw,
        epfNumber: norm(rec.epf_number) || undefined,
        socsoNumber: norm(rec.socso_number) || undefined,
        taxNumber: norm(rec.tax_number) || undefined,
        taxCategory,
        numChildren,
        eisEligible,
        isResident,
        epfCitizenship,
        bankName,
        bankAccountNo,
      },
      basicSalary,
      monthlyAllowance,
      payMode,
      paymentTerm,
      rateAmount,
      effectiveFrom: hiredOn,
    });
  });

  // ─────────────── PASS 3 (2983802f) — DIRECT SUPERIOR, once every row is staged ───────────────
  //
  // This pass exists for exactly one reason: A0002's manager may be A0005, further down the same file.
  // Resolving inside the row loop would fail a perfectly valid file on the order of its lines, which is
  // the kind of defect that makes people stop trusting an importer. So the whole sheet is read first and
  // the edges are resolved against BOTH the tenant's existing employments and the file's own rows.
  const emailToRow = new Map<string, number>();
  resolved.forEach((r, i) => {
    const e = r.result.email.toLowerCase();
    if (e && !emailToRow.has(e)) emailToRow.set(e, i);
  });
  /** Which row (or existing employment) does this cell name? */
  const findSuperior = (raw: string): NonNullable<ResolvedRow['superior']> | 'unknown' => {
    const asCode = normalizeEmployeeCode(raw);
    const existingById = superiorByCode.get(asCode) ?? superiorByEmail.get(raw.toLowerCase());
    if (existingById) return { kind: 'existing', employmentId: existingById };
    const rowIndex = codeToRow.get(asCode) ?? emailToRow.get(raw.toLowerCase());
    if (rowIndex !== undefined) return { kind: 'row', index: rowIndex };
    return 'unknown';
  };
  superiorRaw.forEach((raw, idx) => {
    if (!raw) return;
    const row = resolved[idx];
    const found = findSuperior(raw);
    if (found === 'unknown') {
      row.result.errors.push(`Unknown direct_superior "${raw}" (no employee with that Employee ID or email)`);
    } else if (found.kind === 'row' && found.index === idx) {
      row.result.errors.push('direct_superior cannot be the employee themselves');
    } else {
      // "The manager is on this file but is not going to be created" is decided AFTER this loop, not
      // inside it — see the propagation below.
      row.superior = found;
    }
  });
  // A CYCLE INSIDE THE FILE (A reports to B, B reports to A) would be refused by `setReportingLine` at
  // write time — with half the pair already created. Walking the file's own edges here turns that into a
  // dry-run error on the row that closes the loop, which is where it can still be fixed.
  resolved.forEach((row, idx) => {
    if (row.superior?.kind !== 'row') return;
    const seen = new Set<number>([idx]);
    let at: number | undefined = row.superior.index;
    while (at !== undefined) {
      if (seen.has(at)) {
        row.result.errors.push('direct_superior forms a reporting cycle within this file');
        break;
      }
      seen.add(at);
      const next: ResolvedRow['superior'] = resolved[at].superior;
      at = next?.kind === 'row' ? next.index : undefined;
    }
  });
  // Re-derive `ok` for every row: pass 3 can only ADD errors, never remove them.
  for (const r of resolved) r.result.ok = r.result.errors.length === 0;

  // "YOUR MANAGER IS NOT BEING IMPORTED" — decided HERE, once every superior error above has been
  // pushed and `ok` re-derived, and iterated to a fixpoint.
  //
  // Reading `ok` from inside the resolve loop was wrong in two ways at once. A manager whose ONLY fault
  // was its own direct_superior cell still read as `ok` at the moment the subordinate looked at it (the
  // flag is not re-derived until the loop ends), so the subordinate was previewed as Ready to Import and
  // created with no manager — the miss surfacing only in `superiorFailed` after the write, which is the
  // opposite of what a check-before-create preview is for. And the rule is TRANSITIVE: if C is refused,
  // B (who reports to C) is refused, so A (who reports to B) has nothing to point at either. One pass in
  // file order could not see either case; the loop below runs until nothing more changes.
  for (let settling = true; settling; ) {
    settling = false;
    resolved.forEach((row, idx) => {
      if (!row.result.ok || row.superior?.kind !== 'row') return;
      if (resolved[row.superior.index].result.ok) return;
      row.result.errors.push(
        `direct_superior "${superiorRaw[idx]}" is on row ${row.superior.index + 1} of this file, which has errors and will not be imported`,
      );
      row.result.ok = false;
      settling = true;
    });
  }

  // ─────────────────────── PASS 4 (2983802f) — the FAMILY sheet ───────────────────────
  const { dependents, dependentPreview, fileErrors } = analyzeDependents(dependentRecords, {
    resolved,
    codeToRow,
    catalog,
  });

  const preview: ImportPreview = {
    companyId,
    total: records.length,
    validCount: resolved.filter((r) => r.result.ok).length,
    rows: resolved.map((r) => r.result),
    missingColumns,
    fileErrors,
    dependents: dependentPreview,
  };
  return { preview, resolved, dependents };
}

/**
 * Item 2983802f — validate the FAMILY sheet as its own row set, and decide whether the file survives.
 *
 * THE DECISION, written down once: **any problem on the family sheet rejects the WHOLE file.** Not the
 * offending row — the file. Nothing is imported: not the employees, not the family.
 *
 * That is deliberately stricter than the employee sheet, where a bad row is skipped and the rest load,
 * and the asymmetry is the point. A skipped employee row is VISIBLE — that person is simply not in the
 * system, and the first thing anybody does is look for them. A skipped FAMILY row is invisible: the
 * employee is there, their record looks complete, and the missing spouse is discovered by an insurance
 * claim months later. The plan asked for this case to be decided rather than left to chance, and this is
 * the decision: a file that carries family is imported whole or not at all.
 *
 * The specific case the plan named — a family row whose Employee ID is not on the employee sheet — is one
 * instance of it, and it gets its own message naming the ID so the fix is one cell.
 */
function analyzeDependents(
  records: ImportRecord[],
  ctx: {
    resolved: ResolvedRow[];
    codeToRow: Map<string, number>;
    catalog: Map<string, Set<string>>;
  },
): { dependents: ResolvedDependent[]; dependentPreview: DependentPreview; fileErrors: string[] } {
  const presentColumns = new Set(records.length ? Object.keys(records[0]) : []);
  const missingColumns = records.length
    ? DEPENDENT_IMPORT_COLUMNS.required.filter((c) => !presentColumns.has(c))
    : [];
  const builtinRelationships = new Set<string>(DEPENDENT_RELATIONSHIPS);
  const customRelationships = ctx.catalog.get('dependentRelationship') ?? new Set<string>();
  const genders = new Set<string>(DEPENDENT_GENDERS);
  const dependents: ResolvedDependent[] = [];
  const unmatchedCodes: string[] = [];

  records.forEach((rec, idx) => {
    const errors: string[] = [];
    const codeRaw = norm(rec.employee_code);
    const fullName = norm(rec.full_name);
    const relationship = norm(rec.relationship);

    if (!codeRaw) errors.push('Missing employee_code — this is the link to the employee row');
    if (!fullName) errors.push('Missing full_name');
    if (!relationship) errors.push('Missing relationship');
    else if (!builtinRelationships.has(relationship) && !customRelationships.has(relationship)) {
      errors.push(
        `Unknown relationship "${relationship}" (use ${[...DEPENDENT_RELATIONSHIPS].join(' / ')}, or an active option from your Family relationship list)`,
      );
    }

    const dob = norm(rec.date_of_birth);
    if (dob && !DATE_RE.test(dob)) errors.push(`date_of_birth must be YYYY-MM-DD (got "${dob}")`);
    const gender = enumCell(rec.gender);
    if (gender && !genders.has(gender)) {
      errors.push(`Unknown gender "${rec.gender}" (use ${[...DEPENDENT_GENDERS].join(' / ')})`);
    }
    // Blank means NO here, unlike the employee sheet's default-true statutory flags: a family member is
    // an insurance beneficiary only when somebody says so.
    const benRaw = lc(rec.is_beneficiary);
    let isBeneficiary = false;
    if (benRaw !== '') {
      if (TRUTHY.has(benRaw)) isBeneficiary = true;
      else if (FALSY.has(benRaw)) isBeneficiary = false;
      else errors.push(`Invalid is_beneficiary "${rec.is_beneficiary}" (use yes/no)`);
    }

    // The link. An Employee ID that is not on the employee sheet is the case the plan singled out.
    const codeNorm = normalizeEmployeeCode(codeRaw);
    let employeeIndex = -1;
    if (codeRaw) {
      const found = ctx.codeToRow.get(codeNorm);
      if (found === undefined) {
        errors.push(`Employee ID "${codeRaw}" is not on the employee sheet`);
        if (!unmatchedCodes.includes(codeRaw)) unmatchedCodes.push(codeRaw);
      } else {
        employeeIndex = found;
        if (!ctx.resolved[found].result.ok) {
          errors.push(
            `the employee on row ${found + 1} of the employee sheet has errors, so this family member has nobody to belong to`,
          );
        }
      }
    }

    dependents.push({
      result: {
        rowNum: idx + 1,
        employeeCode: codeRaw,
        fullName,
        relationship,
        ok: errors.length === 0,
        errors,
      },
      employeeIndex,
      add: {
        fullName,
        relationship,
        dateOfBirth: dob || undefined,
        gender: gender || undefined,
        icOrPassport: norm(rec.ic_or_passport) || undefined,
        passportNumber: norm(rec.passport_number) || undefined,
        phone: norm(rec.phone) || undefined,
        isBeneficiary,
        remarks: norm(rec.remarks) || undefined,
      },
    });
  });

  const fileErrors: string[] = [];
  if (missingColumns.length > 0) {
    fileErrors.push(
      `The Family sheet is missing required column(s): ${missingColumns.join(', ')}. Nothing was imported.`,
    );
  }
  for (const code of unmatchedCodes.slice(0, 5)) {
    fileErrors.push(
      `The Family sheet names Employee ID "${code}", which is not on the employee sheet. Nothing was imported — add the employee, or correct the ID, and upload again.`,
    );
  }
  const badRows = dependents.filter((d) => !d.result.ok).map((d) => d.result.rowNum);
  if (badRows.length > 0) {
    fileErrors.push(
      `${badRows.length} row(s) on the Family sheet could not be validated (row ${badRows.slice(0, 10).join(', row ')}${badRows.length > 10 ? ', …' : ''}). A file that carries family members is imported whole or not at all, so nothing was imported.`,
    );
  }

  return {
    dependents,
    dependentPreview: {
      total: records.length,
      validCount: dependents.filter((d) => d.result.ok).length,
      rows: dependents.map((d) => d.result),
      missingColumns,
    },
    fileErrors,
  };
}

/** Dry run: validate the records against the company catalog without writing anything. */
export async function validateEmployeeImport(
  ctx: SessionContext,
  p: { companyId: string; records: ImportRecord[]; dependentRecords?: ImportRecord[] },
): Promise<ImportPreview> {
  const { preview } = await analyze(ctx, p.companyId, p.records, p.dependentRecords ?? []);
  return preview;
}

/** Commit the valid rows. Re-validates server-side (never trusts a client-supplied preview),
 *  imports row-by-row reusing the hire / statutory / compensation services, and records a
 *  batch event so the import itself shows up in the audit trail. */
export async function commitEmployeeImport(
  ctx: SessionContext,
  p: { companyId: string; records: ImportRecord[]; dependentRecords?: ImportRecord[]; fileName?: string },
): Promise<ImportResult> {
  const { preview, resolved, dependents } = await analyze(
    ctx,
    p.companyId,
    p.records,
    p.dependentRecords ?? [],
  );
  const valid = resolved.filter((r) => r.result.ok);
  const failed: ImportResult['failed'] = [];
  const superiorFailed: ImportResult['superiorFailed'] = [];
  let imported = 0;
  let dependentsImported = 0;

  // Item 2983802f — A FILE-LEVEL REFUSAL WRITES NOTHING. Re-derived here from the records, never taken
  // from a client-supplied preview, so a tampered payload cannot talk the server into a half-import.
  if (preview.fileErrors.length > 0) {
    return {
      companyId: p.companyId,
      imported: 0,
      failed: [],
      skipped: resolved.length,
      dependentsImported: 0,
      superiorFailed: [],
      fileErrors: preview.fileErrors,
      runId: null,
    };
  }

  // Item 2983802f — family members grouped by the employee row they belong to, so each employee's family
  // is written immediately after that employee exists.
  const familyByRow = new Map<number, ResolvedDependent[]>();
  for (const d of dependents) {
    if (d.employeeIndex < 0) continue;
    const list = familyByRow.get(d.employeeIndex) ?? [];
    list.push(d);
    familyByRow.set(d.employeeIndex, list);
  }
  // Item 2983802f — row index → the employment it created, so the Direct Superior pass below can link a
  // subordinate to a manager who was created by the SAME run.
  const employmentByRow = new Map<number, string>();

  for (const [index, row] of resolved.entries()) {
    if (!row.result.ok) continue;
    // Per-ROW pack (d8471481): a file may span companies, and a company's statutory writer is its
    // own country's. Reading it off the row rather than the batch is what keeps that honest.
    const pack = row.pack;
    try {
      const { employmentId, personId } = await hireEmployee(ctx, row.hire);
      employmentByRow.set(index, employmentId);
      await pack.statutory.set(ctx, { personId, ...row.statutory });
      // Feedback b9fd8fd5 — imports behave like manual entry (setIcAction, item 354a500d): a valid IC also
      // persists the derived Date of Birth so the Profile tab's Age never reads "Not Available" for an
      // imported employee. `dobOnlyIfEmpty` guarantees an existing DOB is never overwritten; an IC whose
      // first six digits form no real calendar date derives nothing (null) and is skipped, not failed.
      // Best-effort: the employee is already hired + statutory-saved, so a failure here must not fail the row.
      const derivedDob = pack.statutory.dobFromIC(row.statutory.icNumber);
      if (derivedDob) {
        try {
          await setPersonComplianceFields(ctx, { employmentId, dateOfBirth: derivedDob, dobOnlyIfEmpty: true });
        } catch {
          // non-fatal — the DOB autofill is a convenience (mirrors setIcAction's safety net).
        }
      }
      await setCompensation(ctx, {
        employmentId,
        basicSalary: row.basicSalary,
        monthlyAllowance: row.monthlyAllowance,
        // ADR-0078 — undefined falls through to the service defaults (monthly / monthly / no rate).
        payMode: row.payMode,
        paymentTerm: row.paymentTerm,
        rateAmount: row.rateAmount,
        effectiveFrom: row.effectiveFrom,
      });
      // ── Item 2983802f — the new blocks, each through the SAME service its Personnel card uses, and
      //    each skipped entirely when the file carried none of its columns. That is what keeps an
      //    existing file's import byte-identical to what it was before this change.
      if (row.passport) {
        await pack.statutory.setPassport(ctx, { personId, ...row.passport });
      }
      if (row.profile) {
        // `updatePerson` re-writes the core trio, so the row's own values are passed through — omitting
        // `phone` would blank a phone number the file had just supplied.
        await updatePerson(ctx, {
          personId,
          fullName: row.hire.person.fullName,
          primaryEmail: row.hire.person.primaryEmail,
          phone: row.hire.person.phone ?? null,
          via: 'employee-import',
          ...row.profile,
        });
      }
      if (row.employmentInfo) {
        await setEmploymentInfo(ctx, { employmentId, ...row.employmentInfo });
      }
      for (const d of familyByRow.get(index) ?? []) {
        await addDependent(ctx, { personId, ...d.add });
        dependentsImported++;
      }
      imported++;
    } catch (e) {
      failed.push({ rowNum: row.result.rowNum, email: row.result.email, message: (e as Error).message });
    }
  }

  // ── Item 2983802f — DIRECT SUPERIOR, after every row has been created.
  //
  // This is the write-side half of the forward-reference rule: a manager who is on this file only exists
  // once the loop above has finished, so the edges cannot be drawn inside it. The line type is
  // `administrative` and the window opens on the subordinate's hire date — the same edge the Personnel
  // screen's Direct Superior field writes (dce55aff), through the same service, so an imported hierarchy
  // is indistinguishable from a hand-built one and carries the same audit events.
  for (const [index, row] of resolved.entries()) {
    if (!row.superior) continue;
    const subordinate = employmentByRow.get(index);
    if (!subordinate) continue; // the employee itself failed to import; nothing to attach a manager to
    const manager =
      row.superior.kind === 'existing' ? row.superior.employmentId : employmentByRow.get(row.superior.index);
    if (!manager) {
      superiorFailed.push({
        rowNum: row.result.rowNum,
        email: row.result.email,
        message: 'the direct superior named on this row was not imported',
      });
      continue;
    }
    try {
      await setReportingLine(ctx, {
        subordinateEmploymentId: subordinate,
        managerEmploymentId: manager,
        lineType: 'administrative',
        validFrom: row.hire.hiredOn,
      });
    } catch (e) {
      // The employee EXISTS — only the link failed. Reported apart from `failed` for exactly that reason.
      superiorFailed.push({
        rowNum: row.result.rowNum,
        email: row.result.email,
        message: (e as Error).message,
      });
    }
  }

  await withTenant(ctx, (tx) =>
    appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-import',
      aggregateId: p.companyId,
      eventType: 'employee-import.completed',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId,
        imported,
        failed: failed.length,
        skipped: resolved.length - valid.length,
        // d8471481 — one file may now create employees at several companies. The aggregate stays the
        // SELECTED company (a stable aggregate id the audit trail already keys on); the distinct
        // companies actually written are recorded here so the event still describes what happened.
        companyIds: [...new Set(valid.map((r) => r.hire.companyId))],
        // Item 2983802f — the family sheet's contribution, so the audit trail describes the whole run.
        dependents: dependentsImported,
      },
    }),
  );

  const runId = await recordImportRun(ctx, {
    companyId: p.companyId,
    fileName: p.fileName ?? '',
    totalRows: resolved.length,
    imported,
    rejected: resolved.filter((r) => !r.result.ok).map((r) => r.result),
    failed,
  });

  return {
    companyId: p.companyId,
    imported,
    failed,
    skipped: resolved.length - valid.length,
    dependentsImported,
    superiorFailed,
    fileErrors: [],
    runId,
  };
}

/**
 * cf43c909 — write the history row for a finished run.
 *
 * BEST-EFFORT BY DESIGN. The employees are already created by the time this runs; if recording the run
 * throws (an unapplied migration on a stale deploy, a transient failure), the import must still be
 * reported as what it was. Losing a history row is a lesser fault than telling an admin their import
 * failed when 300 employees now exist — so the failure is swallowed and `runId` comes back null.
 *
 * WHAT A "FAILED ROW" IS. Both kinds are one list to HR, because both mean "this person is not in the
 * system and here is why": rows REJECTED by validation (they never reached the write) and rows that
 * FAILED at write (a service threw). Storing them apart would make the screen ask HR to understand an
 * internal boundary in order to fix a spreadsheet.
 */
async function recordImportRun(
  ctx: SessionContext,
  p: {
    companyId: string;
    fileName: string;
    totalRows: number;
    imported: number;
    rejected: RowResult[];
    failed: ImportResult['failed'];
  },
): Promise<string | null> {
  // Identity + reason only — never the row's IC, bank account, statutory numbers or salary. The uploaded
  // file is not stored at all (see migration 0341's header); this is what a correction actually needs.
  const errors: ImportRunError[] = [
    ...p.rejected.map((r) => ({ rowNum: r.rowNum, fullName: r.fullName, email: r.email, errors: r.errors })),
    ...p.failed.map((f) => ({ rowNum: f.rowNum, fullName: '', email: f.email, errors: [f.message] })),
  ].sort((a, b) => a.rowNum - b.rowNum);
  const failedRows = errors.length;
  try {
    return await withTenant(ctx, async (tx) => {
      // Resolve the actor's person ONCE, at the moment of the run. A session only carries `personId` when
      // the login is tied to an employee; an HR admin's usually is, but the link lives on app_user, so
      // fall back to it rather than showing "Unknown" for the person who is most likely to run an import.
      // Pinned at write time, not resolved on read, so the history keeps naming whoever ran it even after
      // that login is later re-pointed or archived.
      let personId = ctx.personId ?? null;
      if (!personId && ctx.userId) {
        const [u] = await tx
          .select({ personId: appUser.personId })
          .from(appUser)
          .where(and(eq(appUser.tenantId, ctx.tenantId), eq(appUser.workosUserId, ctx.userId)))
          .limit(1);
        personId = u?.personId ?? null;
      }
      const [row] = await tx
        .insert(employeeImportRun)
        .values({
          tenantId: ctx.tenantId,
          companyId: p.companyId,
          createdByPersonId: personId,
          createdByUserId: ctx.userId ?? null,
          fileName: p.fileName.slice(0, 255),
          totalRows: p.totalRows,
          importedRows: p.imported,
          failedRows,
          errors: errors.slice(0, IMPORT_RUN_ERROR_CAP),
          errorsTruncated: failedRows > IMPORT_RUN_ERROR_CAP,
        })
        .returning({ id: employeeImportRun.id });
      return row?.id ?? null;
    });
  } catch {
    return null;
  }
}

/** cf43c909 — past import runs, most recent first. RLS (0341) is the authority: admin-only, tenant-scoped. */
export function listEmployeeImportRuns(
  ctx: SessionContext,
  opts?: { limit?: number },
): Promise<ImportRunRow[]> {
  const limit = Math.max(1, Math.min(IMPORT_RUN_HISTORY_LIMIT, opts?.limit ?? IMPORT_RUN_HISTORY_LIMIT));
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: employeeImportRun.id,
        companyId: employeeImportRun.companyId,
        companyName: company.legalName,
        actorName: person.fullName,
        fileName: employeeImportRun.fileName,
        totalRows: employeeImportRun.totalRows,
        importedRows: employeeImportRun.importedRows,
        failedRows: employeeImportRun.failedRows,
        errors: employeeImportRun.errors,
        errorsTruncated: employeeImportRun.errorsTruncated,
        createdAt: employeeImportRun.createdAt,
      })
      .from(employeeImportRun)
      .leftJoin(company, eq(company.id, employeeImportRun.companyId))
      .leftJoin(person, eq(person.id, employeeImportRun.createdByPersonId))
      .orderBy(desc(employeeImportRun.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      ...r,
      // jsonb comes back as `unknown`; a row written by an older or newer shape must render as "no detail"
      // rather than crashing the history screen for every other run on it.
      errors: Array.isArray(r.errors) ? (r.errors as ImportRunError[]) : [],
      createdAt: r.createdAt.toISOString(),
    }));
  });
}
