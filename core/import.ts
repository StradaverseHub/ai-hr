import {readEmployeeImportEvaluationTx,claimEmployeeImportEvaluationTx,completeEmployeeImportEvaluationTx} from './personnel-import-evaluation';
import type {EmployeeImportEvaluationBinding,EmployeeImportEvaluationReceipt} from '../lib/personnel-import-evaluation';
import { getPeopleGeneral, readPeopleGeneralTx, occupiedNricsTx } from './people-general';
import { NRIC_DUPLICATE_MESSAGE, NRIC_FILE_DUPLICATE_MESSAGE } from '../lib/nric-policy-message';
import {previewCostAllocationImportTx,writeNewEmployeeCostAllocationsTx} from './cost-allocation-import';
import type {AllocationImportRecords,AllocationImportPreview} from '../lib/cost-allocation-import';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {workforceCompanies,workforceEmploymentPredicate,assertWorkforceCompanyTx,WorkforceAccessError} from './workforce-access';
import {PERSONNEL_PAY_MODES,PERSONNEL_PAYMENT_TERMS,PERSONNEL_EPF_CITIZENSHIPS} from '../lib/personnel-choice-vocabulary';
import { personnelOperationalValues,type PersonnelOperationalPatch } from '../lib/personnel-operational-import';
import { applyPersonnelOperationalValuesTx } from './personnel-import-operations';
import { assertCardIdFreeForCompany } from './attendance-card';
import { bankTransferLacksBank } from '../lib/payment-methods';
import {PERSONNEL_REGISTER_KINDS,type PersonnelRegisterRecords} from '../lib/personnel-register-import';
import {analyzeRegisterImportTx,validateRegisterImport,writeRegisterRowsTx} from './personnel-register-import';
import { PersonnelImportCatalog, normalizePersonnelCatalogRecord } from '../lib/personnel-import-catalog';
import { PersonnelImportLookup, addUniqueImportAlias } from '../lib/personnel-import-lookup';
import { personnelBankValues, type PersonnelBankValues } from '../lib/personnel-bank-import';
import { personnelFamilyValues, personnelFamilyCatalogErrors } from '../lib/personnel-family-import';
import { personnelImportProposedValues, PERSONNEL_EMPLOYMENT_IMPORT_FIELDS, PERSONNEL_PROFILE_IMPORT_FIELDS, PERSONNEL_COMPLIANCE_IMPORT_FIELDS, personnelScalarIssue } from '../lib/personnel-import-contract';
import { isCalendarDate } from '../lib/calendar-date';
// 524303d9 — the "Everything — new employees" template adopts every Bank & Statutory setting through the SAME
// parser, cross-field rules and merged writer as the Bank & Statutory import, inside the hire transaction.
import {buildBankStatutoryPatch,applyBankStatutoryPatchTx,bankStatutoryRefusal} from './bank-statutory-import';
import {bankStatutoryStateFrom,MERGED_STATUTORY_COLUMNS} from '../lib/bank-statutory-import';
import {copyPermanentToCorrespondence} from '../lib/address-blocks';
import {createImportAttemptTx,recordImportEventTx,recordImportFailure,recordImportItemTx,sealImportPlan,ImportHistoryError} from './import-history';
import type {EmployeeFullImportPlan,EmployeeFullItemState} from './employee-import-history';
import {assignPolicy} from '../packs/payroll/service';
import {setEmploymentScheduleGroupTx} from './roster';
import {isModuleEnabled} from './entitlements';
import {toCsv} from '../lib/csv';
/**
 * Day-one employee importer (ADR-0008 localization stays in the pack; this is the generic
 * bulk-load path). Parses a validated set of CSV records and reuses the same services the
 * single-hire form uses — hireEmployee → the pack's statutory.set → setCompensation — so an
 * imported employee is indistinguishable from a hand-entered one, events included.
 *
 * Two phases:
 *  - analyze(): pure validation against the company catalog + existing records (dry run).
 *  - commitEmployeeImport(): writes the validated subset and its forward reporting links in one
 *    explicit transaction shared by canonical owners. A write refusal rolls that subset back.
 *
 * Invalid preview rows remain excluded. Repeated-record orphan errors reject the complete file;
 * post-commit derived Family refresh failures are warnings and never misreported as rollback.
 */
import { publicErrorMessage } from '@/lib/public-error';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import {
  company,
  person,
  employeeStatutoryMy,
  employeeDraft,
  employment,
  employeeImportRun,
  appUser,
  profileOption,
  payrollPolicy,
  attendanceRule,
} from '../db/schema';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import {updatePerson} from './org';
import {hireEmployee,setEmploymentInfo,setReportingLine} from './workforce-commands';
// r369 — `unpayableSalaryLeg` is the SAME predicate `setCompensation` refuses on, imported rather than
// re-stated, so the dry run and the write can never disagree about which rows need a reason.
import { setCompensation, unpayableSalaryLeg } from './comp';
import { setPersonComplianceFields } from './workforce-commands';
// Item 2983802f — the family sheet writes through the SAME service the Family card uses, so an imported
// dependant is indistinguishable from a hand-entered one (events, child-relief resync, catalog rules).
import { addDependentTx, syncChildReliefFromFamily, assertDependentsValid, type DependentInput, DEPENDENT_GENDERS, DEPENDENT_RELATIONSHIPS } from './dependents';
// Rung 5a (ADR-0080 D1/D6): the statutory writer + IC helpers come from the COMPANY'S country pack
// (resolved in analyze() from company.country), never from a direct localization/my import. A company
// whose country resolves no pack fails the import loudly (D3) instead of validating under MY rules.
import { requirePackFor, type CountryPack } from '../localization/registry';
import { normalizeEmployeeCode, isValidEmployeeCode, EMPLOYEE_CODE_MAX_LEN } from '../lib/employee-code';
import { listCompanies, listDepartments, listLeaveTypes, listJobGrades } from './read';
import { listPositions, listCostCenters, listBusinessUnits } from './admin';
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
  deptByName: PersonnelImportLookup<string>;
  posByName: PersonnelImportLookup<string>;
  ccByName: PersonnelImportLookup<string>;
  buByName: PersonnelImportLookup<string>;
  gradeByName: PersonnelImportLookup<string>;
  organisationDisplay: Map<string,string>;
  departmentBusinessUnits:Map<string,string|null>;
  pack: CountryPack;
  /** 524303d9 — the company's country, for the client pack's tax-circumstance categories. */
  country: string;
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
    businessUnitId?: string;
    gradeId?: string;
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
  operations?:PersonnelOperationalPatch;
  bankExtra?:PersonnelBankValues;
  oldIcNumber?:string;
  compliance?: {dateOfBirth?:string;gender?:string;maritalStatus?:string};
  /** Item 2983802f — the passport block, written through the company pack's `setPassport`. Undefined
   *  unless the row supplied at least one passport cell (an all-blank block must not clear anything). */
  passport?: {
    passportNumber: string;
    passportIssueDate: string;
    passportExpiryDate: string;
    passportIssuingCountry?: string;
    passportIssuingCountryCode?:string;passportRemark?:string;
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
  /**
   * r369 (item eb949191) — the reason this row has no basic amount, handed straight to
   * `setCompensation`'s `remarks`. Undefined when the cell was blank or the column absent, which is
   * byte-identical to the call this importer made before the column existed.
   *
   * NEVER DEFAULTED. A remark the system wrote confirms nothing, so a zero-basic row with no reason is
   * refused in the dry run instead (see the salary block in `analyze`).
   */
  salaryRemarks?: string;
  effectiveFrom: string;
  /** 524303d9 — the hire's employer-scoped income tax selection: Non-Resident when the row says so through
   *  `is_resident` or `tax_residency`, otherwise Resident (an incentive scheme moves onto its scheme below). */
  initialTaxScheme: 'resident' | 'non_resident';
  /** 524303d9 — Bank & Statutory settings beyond the original create columns, as canonical values, written by
   *  the merged statutory writer in the hire transaction. Undefined when the row supplied none. */
  statutoryPatch?: Record<string, string>;
  country: string;
  /** 524303d9 — single-value hire-time settings, each through its own owner in the hire transaction. */
  payrollPolicyId?: string;
  scheduleGroupId?: string;
};

/** Item 2983802f — one validated row of the FAMILY sheet, with the employee row it belongs to. */
type ResolvedDependent = {
  result: DependentRowResult;
  /** Index into the employee `resolved` array; -1 when the Employee ID matched nothing on that sheet. */
  employeeIndex: number;
  add: DependentInput;
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
  outerTx?:Tx,
): Promise<CompanyContext> {
  const [departments, positions, costCenters, businessUnits, grades] = await Promise.all([
    listDepartments(ctx, { companyIds: [co.id] },outerTx),
    listPositions(ctx, { companyIds: [co.id] },outerTx),
    listCostCenters(ctx, { companyIds: [co.id] },outerTx),
    listBusinessUnits(ctx, { companyIds: [co.id] },outerTx),
    listJobGrades(ctx,{},outerTx),
  ]);
  const deptByName=new PersonnelImportLookup<string>();
  const posByName=new PersonnelImportLookup<string>();
  const ccByName=new PersonnelImportLookup<string>();
  const buByName=new PersonnelImportLookup<string>();
  const gradeByName=new PersonnelImportLookup<string>();
  for(const d of departments)deptByName.add(d.id,d.id,{codes:[d.code],names:[d.label]});
  for(const p of positions)posByName.add(p.id,p.id,{codes:[p.code],names:[p.label]});
  for(const c of costCenters)ccByName.add(c.id,c.id,{codes:[c.code],names:[c.label]});
  for(const b of businessUnits)buByName.add(b.id,b.id,{codes:[b.code],names:[b.label]});
  for(const g of grades)gradeByName.add(g.id,g.id,{codes:[g.code],names:[g.name]});
  const display=(label:string|null,code:string|null)=>label?.trim()?`${label.trim()}${code?` (${code})`:''}`:code??'';
  return {
    id: co.id,
    name: co.name,
    deptByName,posByName,ccByName,buByName,gradeByName,
    departmentBusinessUnits:new Map(departments.map(department=>[department.id,department.businessUnitId])),
    organisationDisplay:new Map([
      ...departments.map(d=>[d.id,display(d.label,d.code)] as const),
      ...positions.map(p=>[p.id,display(p.label,p.code)] as const),
      ...costCenters.map(c=>[c.id,display(c.label,c.code)] as const),
      ...businessUnits.map(b=>[b.id,display(b.label,b.code)] as const),
      ...grades.map(g=>[g.id,display(g.name,g.code)] as const),
    ]),
    // Rung 5a (ADR-0080 D1/D6): IC rules come from the COMPANY'S country pack, fail-loud when the
    // country resolves nothing — so a per-row company change also changes the statutory rules applied.
    pack: requirePackFor(co.country),
    country: co.country ?? '',
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
  registerRecords:PersonnelRegisterRecords={},
  outerTx?:Tx,
): Promise<{ preview: ImportPreview; resolved: ResolvedRow[]; dependents: ResolvedDependent[]; registers:Awaited<ReturnType<typeof validateRegisterImport>>[] }> {
  const read=<T,>(fn:(tx:Tx)=>Promise<T>)=>outerTx?fn(outerTx):withTenant(ctx,fn);
  if(Object.keys(registerRecords).some(key=>!(PERSONNEL_REGISTER_KINDS as readonly string[]).includes(key)))throw new Error('Unknown register sheet.');
  const [catalogCompanies, leaveTypes, maintainIds, viewIds] = await Promise.all([
    listCompanies(ctx,{adminOnly:true},outerTx), listLeaveTypes(ctx,{},outerTx), workforceCompanies(ctx,'maintain',outerTx), workforceCompanies(ctx,'view',outerTx),
  ]);
  const writable=new Set(maintainIds),readable=new Set(viewIds);
  if(!writable.has(companyId)||!readable.has(companyId))throw new WorkforceAccessError();
  const allCompanies=catalogCompanies.filter(company=>writable.has(company.id)&&readable.has(company.id));
  // d8471481 — company lookup keys. Legal name is what the reporter's template shows; company label
  // and registration number are accepted because those are what an HR spreadsheet usually carries.
  // The id is accepted too so a machine-generated file can be exact. All matched case-insensitively.
  const companyByKey=new PersonnelImportLookup<(typeof allCompanies)[number]>();
  for(const c of allCompanies)companyByKey.add(c.id,c,{codes:[c.registrationNo],names:[c.name,c.companyLabel]});
  const defaultCompany = allCompanies.find((c) => c.id === companyId);

  const grants = leaveTypes
    .filter((t) => STANDING_GRANTS.has(t.code))
    .map((t) => ({ id: t.id, code: t.code }));

  // PASS 1 — resolve each row's company from the file, so we know which catalogs to load. Pure and
  // synchronous; the unresolved ones are recorded and surface as a per-row error in pass 2.
  const rowCompanies = records.map((rec) => {
    const raw = norm(rec.company);
    if (!raw) return { raw, co: defaultCompany, unknown: false,ambiguous:false };
    const co = companyByKey.get(raw.toLowerCase());
    return { raw, co, unknown: !co,ambiguous:companyByKey.isAmbiguous(raw) };
  });
  const needed = new Map<string, (typeof allCompanies)[number]>();
  for (const rc of rowCompanies) if (rc.co) needed.set(rc.co.id, rc.co);
  if (defaultCompany) needed.set(defaultCompany.id, defaultCompany);
  const contexts = new Map<string, CompanyContext>();
  for (const [id, co] of needed) contexts.set(id, await loadCompanyContext(ctx, co,outerTx));

  // Existing identifiers (tenant-scoped via RLS) so the import can't create dup ICs (DB-unique)
  // or silently re-add someone by email. IC normalisation is pack-specific, so the collision set is
  // built with the DEFAULT company's pack — the same pack that produced every stored IC in a
  // single-jurisdiction tenant. `normalizeIC` is digit-stripping in every pack today, so this stays
  // correct across a mixed file; if a pack ever normalises differently, this is where to revisit.
  const { allowDuplicatedNric, allowDuplicatedEmail } = await (outerTx?readPeopleGeneralTx(outerTx):getPeopleGeneral(ctx));
  let normPack = contexts.get(companyId)?.pack ?? [...contexts.values()][0]?.pack;
  const {
    existingEmails,
    existingIcs,
    existingCodes,
    reservedCodes,
    catalog,
    superiorByCode,
    superiorByEmail,
    policies,
    scheduleGroups,
  } = await read(async (tx) => {
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
    // 524303d9 — RLS (`person_rls`, migration 0676) leaves out the person of a voided import employment, so a
    // reverted file's emails are free again.
    const ppl = await tx.select({ email: person.primaryEmail }).from(person);
    // 524303d9 — hire-time settings resolved by name/code in the dry run, so a typo fails before any write.
    const policies = await tx.select({ id: payrollPolicy.id, companyId: payrollPolicy.companyId, name: payrollPolicy.name, code: payrollPolicy.code, status: payrollPolicy.status }).from(payrollPolicy);
    const scheduleGroups = await tx.select({ id: attendanceRule.id, name: attendanceRule.name, label: attendanceRule.label, status: attendanceRule.status }).from(attendanceRule);
    const hiddenConflicts = allowDuplicatedNric ? [] : await occupiedNricsTx(tx,{companyId,keys:records.map(record=>normPack!.statutory.normalizeIC(norm(record.ic_number)))});
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
      .innerJoin(person, eq(person.id, employment.personId))
      .where(workforceEmploymentPredicate(sql`${employment.id}`,'view'));
    // Item 2983802f — the catalog-governed vocabularies the new columns write into. Read ONCE here so a
    // typo in `state` / `country` / an emergency-contact or family relationship is a per-row error in the
    // DRY RUN, where a spreadsheet can still be fixed, instead of a failure at write with an employee
    // already created. Same rule as `assertProfileValueAllowed`: an EMPTY catalog means the tenant never
    // configured that list and free text is accepted, exactly as it is on the Personnel screens.
    const options = await tx
      .select({ category: profileOption.category, value: profileOption.value,label:profileOption.label,isActive:profileOption.isActive })
      .from(profileOption);
    // Item 06f0cb8f — an unfinished DRAFT holds an Employee ID too, so an import can collide with a
    // record that has no employment row yet. `hireEmployee` refuses it either way (that is the
    // authority, and it is what makes the rule true for every path at once); reading it here as well
    // moves the refusal from row 400 of a commit into the preview, where a spreadsheet can still be fixed.
    const reserved = await tx
      .select({ code: employeeDraft.reservedEmployeeCode })
      .from(employeeDraft)
      .where(isNotNull(employeeDraft.reservedEmployeeCode));
    const catalog = new PersonnelImportCatalog();
    for(const option of options)catalog.addOption(option);
    const superiorByCode = new Map<string, string>();
    const superiorByEmail = new Map<string, string|null>();
    for (const e of superiorCandidates) {
      if (e.code) superiorByCode.set(normalizeEmployeeCode(e.code), e.id);
      addUniqueImportAlias(superiorByEmail,e.email.toLowerCase(),e.id);
    }
    return {
      catalog,
      superiorByCode,
      superiorByEmail,
      policies,
      scheduleGroups,
      reservedCodes: new Set(reserved.map((r) => normalizeEmployeeCode(r.code as string))),
      existingEmails: new Set(ppl.map((r) => r.email.toLowerCase())),
      // Item e3ce0d4d — icNumber is now nullable (non-Malaysian passport rows); skip null ICs so a blank never
      // enters the collision set (mirrors the employeeCode filter below).
      existingIcs: new Set(
        [...hiddenConflicts,...ics.filter((r) => r.ic).map((r) => normPack!.statutory.normalizeIC(r.ic as string))],
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
    if (!active) return true;
    return active.has(value);
  };

  records.forEach((rawRecord, idx) => {
    const {record:rec,errors}=normalizePersonnelCatalogRecord(rawRecord,'employee',catalog);
    const warnings: string[] = [];
    const operations=personnelOperationalValues(rec);errors.push(...operations.errors);
    if(operations.values.paymentMethod==='bank_transfer' && bankTransferLacksBank({bankName:rec.bank_name,bankAccountNo:rec.bank_account_no}))errors.push('Bank Transfer requires bank_name and bank_account_no.');
    const fullName = norm(rec.full_name);
    const email = norm(rec.email);

    // PASS 2 begins with the company: every catalog lookup below is against THIS row's company, which
    // is what makes the reporter's "Department does not belong to selected company" a real check.
    const rc = rowCompanies[idx];
    if(rc.ambiguous)errors.push(`Ambiguous company "${rc.raw}" — use its exact company ID or registration number`);
    else if (rc.unknown) errors.push(`Unknown company "${rc.raw}"`);
    else if (!rc.co) errors.push('Missing company');
    const cctx = rc.co ? contexts.get(rc.co.id) : undefined;
    const { deptByName, posByName, ccByName, buByName, gradeByName } = cctx ?? {
      deptByName: new PersonnelImportLookup<string>(),
      posByName: new PersonnelImportLookup<string>(),
      ccByName: new PersonnelImportLookup<string>(),
      buByName: new PersonnelImportLookup<string>(),
      gradeByName: new PersonnelImportLookup<string>(),
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
    // 5e0b2154 — with Allow Duplicated Work Email or Personal Email ON, a shared email is reported, not refused.
    else if (seenEmails.has(email.toLowerCase())) (allowDuplicatedEmail ? warnings : errors).push(allowDuplicatedEmail ? 'This email is also used by another row in this file' : 'Duplicate email in this file');
    // 524303d9 — the duplicate policy applies in full, exactly like NRIC: with "Allow Duplicated Work Email or
    // Personal Email" OFF an email another person already holds is refused; ON it is reported.
    else if (existingEmails.has(email.toLowerCase())) (allowDuplicatedEmail ? warnings : errors).push(allowDuplicatedEmail ? 'A person with this email already exists' : `Email "${email}" is already used by another employee (Allow Duplicated Work Email is off)`);
    if (email) seenEmails.add(email.toLowerCase());

    // Department (required, canonical code before an unambiguous legacy label)
    const deptName = norm(rec.department);
    const departmentId = deptByName.get(deptName.toLowerCase());
    if (!deptName) errors.push('Missing department');
    else if (deptByName.isAmbiguous(deptName))errors.push(`Ambiguous department "${deptName}" — choose a distinct label or code`);
    else if (!departmentId) errors.push(`Unknown department "${deptName}"`);

    // Position / cost-center (optional; code first, unknown = error so it is never dropped silently)
    const posName = norm(rec.position);
    let positionId: string | undefined;
    if (posName) {
      positionId = posByName.get(posName.toLowerCase());
      if(posByName.isAmbiguous(posName))errors.push(`Ambiguous position "${posName}" — choose a distinct label or code`);
      else if (!positionId) errors.push(`Unknown position "${posName}"`);
    }
    const ccName = norm(rec.cost_center);
    let costCenterId: string | undefined;
    if (ccName) {
      costCenterId = ccByName.get(ccName.toLowerCase());
      if(ccByName.isAmbiguous(ccName))errors.push(`Ambiguous cost_center "${ccName}" — choose a distinct label or code`);
      else if (!costCenterId) errors.push(`Unknown cost_center "${ccName}"`);
    }

    const organisationChoice=(column:string,lookup:PersonnelImportLookup<string>)=>{
      const raw=norm(rec[column]);if(!raw)return undefined;
      const id=lookup.get(raw);
      if(lookup.isAmbiguous(raw))errors.push(`Ambiguous ${column} "${raw}" for ${cctx?.name??'the selected company'} — choose a distinct label or code`);
      else if(!id)errors.push(`Unavailable ${column} "${raw}" for ${cctx?.name??'the selected company'}`);
      return id;
    };
    const businessUnitId=organisationChoice('business_unit',buByName);
    const gradeId=organisationChoice('job_grade',gradeByName);
    const departmentUnit=departmentId?cctx?.departmentBusinessUnits.get(departmentId):undefined;
    if(businessUnitId && departmentUnit && businessUnitId!==departmentUnit)errors.push('department: unavailable under the selected business_unit');

    // Hire date
    const hiredOn = norm(rec.hired_on);
    if (!hiredOn) errors.push('Missing hired_on');
    else if (!isCalendarDate(hiredOn)) errors.push(`hired_on must be YYYY-MM-DD (got "${hiredOn}")`);

    // Employment type
    let employmentType: 'full_time' | 'part_time' | 'contract' | 'intern' = 'full_time';
    const etRaw = lc(rec.employment_type).replace(/[\s-]+/g, '_');
    if (etRaw) {
      if (EMPLOYMENT_TYPES.has(etRaw)) employmentType = etRaw as typeof employmentType;
      else errors.push(`Unknown employment_type "${rec.employment_type}"`);
    }

    // Optional NRIC: format is unconditional; duplication follows the current tenant policy.
    const icRaw = norm(rec.ic_number);
    const icNorm = pack.statutory.normalizeIC(icRaw);
    if (icRaw && !pack.statutory.validateIC(icRaw)) errors.push(`Invalid IC "${icRaw}" (expected 12 digits)`);
    else if (!allowDuplicatedNric && icRaw && seenIcs.has(icNorm)) errors.push(NRIC_FILE_DUPLICATE_MESSAGE);
    else if (!allowDuplicatedNric && icRaw && existingIcs.has(icNorm)) errors.push(NRIC_DUPLICATE_MESSAGE);
    if (icRaw && pack.statutory.validateIC(icRaw)) seenIcs.add(icNorm);

    // Salary
    const salaryRaw = norm(rec.basic_salary).replace(/[,_]/g, '');
    const basicSalary = Number(salaryRaw);
    if (!Number.isFinite(basicSalary) || basicSalary < 0) errors.push(`Invalid basic_salary "${rec.basic_salary}"`);
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
      if ((PERSONNEL_EPF_CITIZENSHIPS as readonly string[]).includes(c)) return c as (typeof PERSONNEL_EPF_CITIZENSHIPS)[number];
      if (c === 'malaysian') return 'citizen';
      if (c === 'permanent_resident') return 'pr';
      if (['noncitizen', 'foreign', 'foreigner', 'foreign_worker'].includes(c)) return 'non_citizen';
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
      if ((PERSONNEL_PAY_MODES as readonly string[]).includes(m)) return m as (typeof PERSONNEL_PAY_MODES)[number];
      errors.push(`Invalid pay_mode "${rec.pay_mode}" (use monthly / daily / hourly / custom_period)`);
      return undefined;
    })();
    const paymentTerm = ((): 'monthly' | 'weekly' | 'biweekly' | undefined => {
      const f = lc(rec.payment_term).replace(/[\s-]+/g, '_');
      if (!f) return undefined;
      if ((PERSONNEL_PAYMENT_TERMS as readonly string[]).includes(f)) return f as (typeof PERSONNEL_PAYMENT_TERMS)[number];
      if (f === 'bi_weekly') return 'biweekly';
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

    // r369 (item eb949191) — A BASIC SALARY OF 0 IMPORTS, ONCE THE ROW SAYS WHY.
    //
    // `setCompensation` accepts a zero monthly basic only with a remark on the record, because that
    // sentence is what tells a Director paid quarterly fees from a mistyped figure. Before this column
    // existed the importer had nothing to put there, so the service threw at COMMIT and the row failed on
    // a refusal no file could answer. Two things are fixed together and neither weakens the other:
    //
    //   · the reason travels with the row, straight through to the service's `remarks`; and
    //   · a zero-basic row with NO reason fails HERE, in the dry run, naming the column to fill — which
    //     is strictly better than failing at commit, because the file can still be corrected.
    //
    // NO DEFAULT IS SUPPLIED. A remark this code invented would confirm nothing, which is the entire
    // point of the gesture. The predicate is the service's own, so the two cannot drift; the pay mode
    // falls back to `monthly` because that is what `setCompensation` defaults a brand-new record to, and
    // every row here is a brand-new record (`hireEmployee` runs first, so there is no prior revision to
    // carry a mode forward from). Only asked when the amount itself parsed: a blank or unparseable
    // basic_salary already carries its own error above, and saying two things about one cell is noise.
    const salaryRemarks = norm(rec.salary_remarks) || undefined;
    if (
      Number.isFinite(basicSalary) &&
      basicSalary >= 0 &&
      unpayableSalaryLeg(payMode ?? 'monthly', basicSalary, rateAmount ?? null) === 'no_monthly_basic' &&
      !salaryRemarks
    ) {
      errors.push(
        'basic_salary is 0, so salary_remarks must say why (for example: paid by quarterly ' +
          "director's fees). Payroll will leave this employee out of any month with nothing payable.",
      );
    }

    // ─────────────────────────── Item 2983802f — the seven new blocks ───────────────────────────
    // Every one of them is OPTIONAL and every one of them fails HERE, in the dry run, rather than
    // half-way through a commit: the whole reason the preview exists is that a spreadsheet can still be
    // corrected while nothing has been written.

    /** An optional YYYY-MM-DD cell. Blank → undefined; malformed → a named per-row error. */
    const dateField = (raw: string | undefined, label: string): string | undefined => {
      const v = norm(raw);
      if (!v) return undefined;
      if (!isCalendarDate(v)) {
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
    // (app/(app)/admin/personnel/[employmentId]/page.tsx → IdentityFields `countryOptions`), so the value the
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
      norm(rec.passport_issuing_country) !== '' || norm(rec.passport_issuing_country_code)!=='' || norm(rec.passport_remark)!=='';
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
          passportIssuingCountryCode:norm(rec.passport_issuing_country_code)||undefined,passportRemark:norm(rec.passport_remark)||undefined,
        };
      }
    }

    const bankExtra=personnelBankValues(rec);errors.push(...bankExtra.errors);
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
    for(const field of PERSONNEL_PROFILE_IMPORT_FIELDS) {
      const {column,writerField,catalog:category}=field.import;
      if(column && writerField)carry(column,writerField,category?catalogField(rec[column],category,column):undefined);
    }
    const compliance: NonNullable<ResolvedRow['compliance']> = {};
    for(const field of PERSONNEL_COMPLIANCE_IMPORT_FIELDS) {
      const column=field.import.column!; const value=norm(rec[column]);if(!value)continue;
      const issue=personnelScalarIssue(field,value);
      if(issue)errors.push(`${column}: invalid ${issue} value`);
      else (compliance as Record<string,string>)[field.ownerField]=value;
    }
    if(profile.personalEmail && !EMAIL_RE.test(profile.personalEmail))errors.push('Invalid personal_email');
    // 524303d9 — "Same as permanent address": Yes copies the permanent block into the correspondence block
    // through the same writer, exactly as draft completion does (`copyPermanentToCorrespondence`).
    const sameAsPermanent = boolField(rec.correspondence_same_as_permanent ?? '', 'correspondence_same_as_permanent');
    if (sameAsPermanent === true) {
      if (Object.keys(rec).some((column) => /^correspondence_(address_line_[123]|postcode|city|state|country)$/.test(column) && norm(rec[column]) !== ''))
        errors.push('correspondence_same_as_permanent: leave the correspondence address columns blank when this is Yes');
      else for (const [key, value] of Object.entries(copyPermanentToCorrespondence(profile))) if (value !== undefined && value !== null) profile[key] = value as string;
    }

    // 524303d9 — PAYROLL POLICY and SCHEDULE GROUP at hire, judged here as draft completion judges them: the
    // policy must be an ACTIVE policy of the row's company and Payroll must be switched on for it.
    let payrollPolicyId: string | undefined;
    const policyRaw = norm(rec.payroll_policy);
    if (policyRaw && cctx) {
      const wanted = policyRaw.toLowerCase();
      const hits = policies.filter((policy) => policy.companyId === cctx.id && (policy.name.toLowerCase() === wanted || (policy.code ?? '').toLowerCase() === wanted));
      if (!isModuleEnabled(ctx, 'payroll', cctx.id)) errors.push(`payroll_policy: Payroll is not switched on for ${cctx.name}`);
      else if (hits.length > 1) errors.push(`Ambiguous payroll_policy "${policyRaw}" — use its policy code`);
      else if (!hits.length) errors.push(`Unknown payroll_policy "${policyRaw}" for ${cctx.name}`);
      else if (hits[0].status !== 'active') errors.push(`payroll_policy "${policyRaw}" is inactive`);
      else payrollPolicyId = hits[0].id;
    }
    let scheduleGroupId: string | undefined;
    const groupRaw = norm(rec.schedule_group);
    if (groupRaw) {
      const wanted = groupRaw.toLowerCase();
      const hits = scheduleGroups.filter((group) => group.name.toLowerCase() === wanted || (group.label ?? '').toLowerCase() === wanted);
      if (hits.length > 1) errors.push(`Ambiguous schedule_group "${groupRaw}"`);
      else if (!hits.length) errors.push(`Unknown schedule_group "${groupRaw}"`);
      else if (hits[0].status !== 'active') errors.push(`schedule_group "${groupRaw}" is inactive`);
      else scheduleGroupId = hits[0].id;
    }

    // 524303d9 — EVERY BANK & STATUTORY SETTING, validated in full before anything is written. The cells go
    // through the Bank & Statutory import's own parser and the tab's cross-field rules (EPF election via the
    // pack's `validateEpfElection`, tax circumstance ↔ category, residency ↔ EPF citizenship) against the
    // values this hire will hold. Columns the original create path already writes (tax number, tax category,
    // children, EPF citizenship, the legacy yes/no adapters) keep their parsers; tax category is passed only
    // when valid so the circumstance rule can see it.
    const legacyStatutory = new Set(['tax_number', 'num_children', 'epf_citizenship', 'eis_eligible', 'is_resident', 'tax_category']);
    const statutoryCell = (column: string) => {
      if (column === 'tax_category') return taxCategory !== undefined && [1, 2, 3].includes(taxCategory) ? String(taxCategory) : undefined;
      if (legacyStatutory.has(column)) return undefined;
      const v = norm(rec[column]);
      return v === '' ? undefined : v;
    };
    const residencyCell = statutoryCell('tax_residency')?.toLowerCase().replace(/[\s-]+/g, '_');
    const initialTaxScheme: 'resident' | 'non_resident' = isResident === false || residencyCell === 'non_resident' ? 'non_resident' : 'resident';
    const expected = bankStatutoryStateFrom({
      epfCitizenship: epfCitizenship ?? 'citizen', socsoCategory: 'auto', eisCategory: eisEligible === false ? 'none' : 'auto',
      taxCategory: taxCategory ?? 1, numChildren: numChildren ?? 0, childReliefMode: 'manual', taxNumber: norm(rec.tax_number) || null,
    }, { taxResidency: initialTaxScheme, paymentMethod: operations.values.paymentMethod ?? null });
    const built = buildBankStatutoryPatch(statutoryCell, { pack, country: cctx?.country ?? '' }, expected);
    errors.push(...built.errors);
    if (isResident !== undefined && built.patch.tax_residency && (isResident === false) !== (built.patch.tax_residency === 'non_resident'))
      errors.push('is_resident disagrees with tax_residency; keep one of the two columns');
    if (eisEligible !== undefined && built.patch.eis_category && (eisEligible === false) !== (built.patch.eis_category === 'none'))
      errors.push('eis_eligible disagrees with eis_category; keep one of the two columns');
    const statutoryPatch = Object.fromEntries(Object.entries(built.patch).filter(([column, value]) =>
      MERGED_STATUTORY_COLUMNS.includes(column) && column !== 'tax_category' && !(column === 'tax_residency' && value === initialTaxScheme)));

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
    if (probationEnd && hiredOn && isCalendarDate(hiredOn) && probationEnd < hiredOn) {
      errors.push('probation_end_date must be on or after hired_on');
    }
    const confirmationDate = dateField(rec.confirmation_date, 'confirmation_date');
    if (confirmationDate && hiredOn && isCalendarDate(hiredOn) && confirmationDate < hiredOn) {
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

    for(const field of PERSONNEL_EMPLOYMENT_IMPORT_FIELDS) {
      const {column,writerField,catalog:category}=field.import;const value=norm(rec[column!]);if(!value)continue;
      const issue=personnelScalarIssue(field,value);if(issue){errors.push(`${column}: invalid ${issue} value`);continue;}
      const checked=category?catalogField(value,category,column!):undefined;
      if(checked?.kind==='refused')continue;
      employmentInfo[writerField!]=checked?.kind==='ok'?checked.value:value;
    }
    for(const [legacyA,legacyB,valueColumn,unitColumn] of [
      ['probation_months','probation_days','probation_value','probation_unit'],
      ['resignation_notice_months','resignation_notice_days','notice_before_confirmation_value','notice_before_confirmation_unit'],
    ]) if((norm(rec[legacyA])||norm(rec[legacyB])) && (norm(rec[valueColumn])||norm(rec[unitColumn])))errors.push(`Use the current ${valueColumn}/${unitColumn} columns or the older month/day columns, not both`);

    // DIRECT SUPERIOR — recorded now, RESOLVED LATER (see the pass after this loop). Resolving here would
    // fail a perfectly valid file purely because the manager's row happens to come after the subordinate's.
    superiorRaw.push(norm(rec.direct_superior));
    if (codeRaw && isValidEmployeeCode(codeRaw) && !codeToRow.has(codeNorm)) codeToRow.set(codeNorm, idx);

    const ok = errors.length === 0;
    const result: RowResult = {
      proposed:personnelImportProposedValues(rec,'employee').map(value=>{
        const id=({department:departmentId,position:positionId,cost_center:costCenterId,business_unit:businessUnitId,job_grade:gradeId} as Record<string,string|undefined>)[value.column];
        const category=PERSONNEL_EMPLOYMENT_IMPORT_FIELDS.find(field=>field.import.column===value.column)?.import.catalog;
        const display=id?cctx?.organisationDisplay.get(id):category?catalog.display(category,rec[value.column]):undefined;
        return display?{...value,value:`${norm(rawRecord[value.column])} → ${display}`}:value;
      }),
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
        businessUnitId,gradeId,
        employmentType,
        hiredOn,
        // Blank → undefined so hireEmployee falls through to the nextEmployeeCode auto-counter.
        employeeCode: codeNorm || undefined,
        grantLeaveTypes: grants,
        provisionalEndOn: probationEnd,
      },
      operations:Object.keys(operations.values).length?operations.values:undefined,
      profile: Object.keys(profile).length > 0 ? profile : undefined,
      bankExtra:bankExtra.supplied.some(key=>!['bankName','bankAccountNo'].includes(key))?bankExtra.values:undefined,
      oldIcNumber:norm(rec.old_ic_number)||undefined,
      compliance: Object.keys(compliance).length > 0 ? compliance : undefined,
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
      salaryRemarks,
      effectiveFrom: hiredOn,
      initialTaxScheme,
      statutoryPatch: Object.keys(statutoryPatch).length ? statutoryPatch : undefined,
      country: cctx?.country ?? '',
      payrollPolicyId,
      scheduleGroupId,
    });
  });

  // Operational card assignments resolve against current canonical identities before any employee is written.
  for(const [index,row] of resolved.entries())if(row.result.ok && row.operations?.cardId) {
    try {await read(tx=>assertCardIdFreeForCompany(tx,row.hire.companyId,row.operations!.cardId!));}
    catch {row.result.errors.push('card_id already identifies another employee; choose an unused card ID.');row.result.ok=false;}
    const wanted=row.operations.cardId.toLowerCase(),digits=wanted.replace(/\D/g,'');
    if(resolved.some((other,otherIndex)=>otherIndex!==index && (other.operations?.cardId?.toLowerCase()===wanted || other.hire.employeeCode?.toLowerCase()===wanted || Boolean(digits && other.statutory.icNumber?.replace(/\D/g,'')===digits)))) {
      row.result.errors.push('card_id conflicts with another employee identity in this file.');row.result.ok=false;
    }
  }

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
  const findSuperior = (raw: string): NonNullable<ResolvedRow['superior']> | 'unknown' | 'ambiguous' => {
    const asCode = normalizeEmployeeCode(raw);
    if(!superiorByCode.has(asCode) && superiorByEmail.get(raw.toLowerCase())===null)return 'ambiguous';
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
    if(found==='ambiguous')row.result.errors.push('Ambiguous direct_superior email — use the exact Employee ID for the intended employment');
    else if (found === 'unknown') {
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

  if(['tender_resignation_date','resignation_date','last_working_date'].some(field=>presentColumns.has(field)))fileErrors.push('Resignation dates must be recorded through Movement import. Remove these columns from the employee file. Nothing was imported.');

  for(const dependent of dependents)if(dependent.result.ok) {
    try { await assertDependentsValid(ctx,[dependent.add],outerTx); }
    catch(error) { dependent.result.ok=false;dependent.result.errors.push(error instanceof Error?error.message:'Invalid Family values'); }
  }
  dependentPreview.validCount=dependents.filter(dependent=>dependent.result.ok).length;
  if(dependentPreview.validCount<dependents.length && !fileErrors.length)fileErrors.push('Some Family values were refused by the Personnel owner. Correct those rows before importing; nothing will be written.');

  const subjects=resolved.map(row=>({employeeCode:row.hire.employeeCode??'',employeeName:row.result.fullName,companyId:row.hire.companyId,employmentId:null,personId:null,valid:row.result.ok}));
  const registers=[] as Awaited<ReturnType<typeof validateRegisterImport>>[];
  for(const kind of PERSONNEL_REGISTER_KINDS) {
    if(!registerRecords[kind]?.length)continue;
    const checked=await (outerTx?analyzeRegisterImportTx(outerTx,kind,registerRecords[kind]??[],{subjects,newEmployees:true}):validateRegisterImport(ctx,kind,registerRecords[kind]??[],{subjects,newEmployees:true}));
    registers.push(checked);
    fileErrors.push(...checked.preview.fileErrors.map(error=>`${kind}: ${error}`));
  }

  const preview: ImportPreview = {
    companyId,
    total: records.length,
    validCount: resolved.filter((r) => r.result.ok).length,
    rows: resolved.map((r) => r.result),
    missingColumns,
    fileErrors,
    dependents: dependentPreview,
    registers:registers.map(register=>register.preview),
  };
  return { preview, resolved, dependents,registers };
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

  records.forEach((rawRecord, idx) => {
    const {record:rec,errors}=normalizePersonnelCatalogRecord(rawRecord,'family',ctx.catalog);
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
    if (dob && !isCalendarDate(dob)) errors.push(`date_of_birth must be YYYY-MM-DD (got "${dob}")`);
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

    const extra=personnelFamilyValues(rec);errors.push(...extra.errors,...personnelFamilyCatalogErrors(rec,ctx.catalog));
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
        ...extra.values,
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
  p: { companyId: string; records: ImportRecord[]; dependentRecords?: ImportRecord[]; registerRecords?:PersonnelRegisterRecords; allocationRecords?:AllocationImportRecords },
): Promise<ImportPreview> {
  const { preview, resolved } = await analyze(ctx, p.companyId, p.records, p.dependentRecords ?? [],p.registerRecords);
  await withTenant(ctx,async tx=>{
    await lockAccessConfigurationTx(tx,ctx.tenantId);
    await assertWorkforceCompanyTx(tx,ctx,p.companyId,'view');
    await assertWorkforceCompanyTx(tx,ctx,p.companyId,'maintain');
    for(const companyId of new Set(resolved.filter(row=>row.result.ok).map(row=>row.hire.companyId))){
      await assertWorkforceCompanyTx(tx,ctx,companyId,'view');await assertWorkforceCompanyTx(tx,ctx,companyId,'maintain');
    }
  });
  if(p.allocationRecords?.length){
    preview.allocations=await withTenant(ctx,tx=>previewCostAllocationImportTx(tx,ctx,p.allocationRecords!,resolved.flatMap((row,index)=>row.result.ok?[{companyId:row.hire.companyId,employeeCode:row.hire.employeeCode??'',hiredOn:row.hire.hiredOn,index}]:[])));
    for(const group of preview.allocations.groups)if(group.errors.length)preview.fileErrors.push(`Cost Center Allocations · ${group.employeeCode} · ${group.effectiveDate} · rows ${group.rowNums.join(', ')}: ${group.errors.join('; ')}`);
  }
  return preview;
}

/** Commit the valid rows. Re-validates server-side (never trusts a client-supplied preview),
 *  imports row-by-row reusing the hire / statutory / compensation services, and records a
 *  batch event so the import itself shows up in the audit trail. */
function measuredImportReplay(companyId:string,evaluationReceipt:EmployeeImportEvaluationReceipt):ImportResult&{evaluationReceipt:EmployeeImportEvaluationReceipt}{
 const c=evaluationReceipt.canonicalCounts;if(!c)throw Error('The import receipt could not be confirmed.');
 return{companyId,imported:c.imported,failed:[],skipped:c.skipped,dependentsImported:c.dependents,registersImported:{qualification:c.qualification,emergency:c.emergency},superiorFailed:[],fileErrors:[],runId:null,evaluationReceipt};
}
export async function commitEmployeeImport(
  ctx: SessionContext,
  p: { companyId: string; records: ImportRecord[]; dependentRecords?: ImportRecord[]; registerRecords?:PersonnelRegisterRecords; allocationRecords?:AllocationImportRecords; allocationToken?:string; fileName?: string; evaluationBinding?:EmployeeImportEvaluationBinding;
    /** 524303d9 — the ORIGINAL uploaded file for Import History (absent for a paste: the rows are recorded as CSV text). */
    source?:{name:string;content:Buffer;operationKey?:string} },
): Promise<ImportResult & {evaluationReceipt?:EmployeeImportEvaluationReceipt}> {
  const source=p.source?{...p.source,content:Buffer.from(p.source.content)}:undefined;
  p=structuredClone({...p,source:undefined});p.source=source;
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  if(p.evaluationBinding){const replay=await withTenant(ctx,tx=>readEmployeeImportEvaluationTx(tx,ctx,p.evaluationBinding!,p));if(replay)return measuredImportReplay(p.companyId,replay);}
  let { preview, resolved, dependents,registers } = await analyze(
    ctx,
    p.companyId,
    p.records,
    p.dependentRecords ?? [],
    p.registerRecords,
  );
  const nominationPack=resolved.map(row=>row.pack);
  const nominationBinding=JSON.stringify({preview,resolved:resolved.map(({pack,...row})=>row),dependents,registers});
  const allocationEmployees=resolved.flatMap((row,index)=>row.result.ok?[{companyId:row.hire.companyId,employeeCode:row.hire.employeeCode??'',hiredOn:row.hire.hiredOn,index}]:[]);
  let allocationPreview:AllocationImportPreview|undefined;
  if(p.allocationRecords?.length){
    allocationPreview=await withTenant(ctx,tx=>previewCostAllocationImportTx(tx,ctx,p.allocationRecords!,allocationEmployees));
    if(!p.allocationToken||p.allocationToken!==allocationPreview.token)preview.fileErrors.push('Cost Center Allocations changed. Preview the complete workbook again.');
    for(const group of allocationPreview.groups)if(group.errors.length)preview.fileErrors.push(`Cost Center Allocations · ${group.employeeCode} · ${group.effectiveDate} · rows ${group.rowNums.join(', ')}: ${group.errors.join('; ')}`);
  }
  const valid = resolved.filter((r) => r.result.ok);
  const failed: ImportResult['failed'] = [];
  const superiorFailed: ImportResult['superiorFailed'] = [];
  let imported = 0;
  let dependentsImported = 0;
  const registersImported={qualification:0,emergency:0};

  // Item 2983802f — A FILE-LEVEL REFUSAL WRITES NOTHING. Re-derived here from the records, never taken
  // from a client-supplied preview, so a tampered payload cannot talk the server into a half-import.
  // 524303d9 — Import History (ADR-0155 kind `employee_full`): the uploaded file (or, for a paste, the rows as
  // text), the per-row outcome and the companies, recorded before the write so a refused file is listed too.
  const attemptId=await recordEmployeeImportAttempt(ctx,p,preview,resolved);
  if (preview.fileErrors.length > 0) {
    if(attemptId)await recordImportFailure(ctx,attemptId,'employee_full','failed',new ImportHistoryError(preview.fileErrors.join(' ')));
    return {
      companyId: p.companyId,
      imported: 0,
      failed: [],
      skipped: resolved.length,
      dependentsImported: 0,
      superiorFailed: [],
      fileErrors: preview.fileErrors,
      runId: null,
      attemptId,
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
  const registerSubjects=new Map<string,{employmentId:string;personId:string}>();
  // Private measured-outcome erasure refs come from actual canonical owners, never model/browser IDs.
  const outcomeSubjects=new Map<string,{kind:'person'|'employment';id:string}>();
  const outcomeEmployment=(id:string)=>{if(p.evaluationBinding)outcomeSubjects.set('employment:'+id,{kind:'employment',id});};
  const outcomePerson=(id:string)=>{if(p.evaluationBinding)outcomeSubjects.set('person:'+id,{kind:'person',id});};

  // The validated subset and its forward reporting links form one import operation. Domain
  // writers share this explicit transaction; no failed file can leave a half-created employee.
  const familySyncPersonIds=new Set<string>();
  const writeFileErrors:string[]=[];
  const writeWarnings:string[]=[];
  let evaluationReceipt:EmployeeImportEvaluationReceipt|undefined,replayedEvaluation=false;
  try {
    await withTenant(ctx,async tx=>{
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  if(p.evaluationBinding){const claimed=await claimEmployeeImportEvaluationTx(tx,ctx,p.evaluationBinding,p);if(claimed.replayed){evaluationReceipt=claimed.replayed;replayedEvaluation=true;return;}}
  // The outside analysis nominated this exact raw file. Resolve ALL protected facts in this actual
  // transaction before any employee/assignment/reporting write; changing the binding requires preview.
  const fresh=await analyze(ctx,p.companyId,p.records,p.dependentRecords??[],p.registerRecords,tx);
  const freshBinding=JSON.stringify({preview:fresh.preview,resolved:fresh.resolved.map(({pack,...row})=>row),dependents:fresh.dependents,registers:fresh.registers});
  if(freshBinding!==nominationBinding||fresh.resolved.some((row,index)=>row.pack!==nominationPack[index]))
    throw new Error('Employee import inputs changed. Preview the complete file again.');
  ({preview,resolved,dependents,registers}=fresh);
  if(p.allocationRecords?.length){
    allocationPreview=await previewCostAllocationImportTx(tx,ctx,p.allocationRecords,allocationEmployees);
    if(allocationPreview.token!==p.allocationToken||allocationPreview.groups.some(g=>g.errors.length))throw new Error('Cost Center Allocations changed. Preview the complete workbook again.');
  }
  for (const [index, row] of resolved.entries()) {
    if (!row.result.ok) continue;
    // Per-ROW pack (d8471481): a file may span companies, and a company's statutory writer is its
    // own country's. Reading it off the row rather than the batch is what keeps that honest.
    const pack = row.pack;
    try {
      const saved = await (async()=>{
      const { employmentId, personId } = await hireEmployee(ctx, {...row.hire,initialTaxScheme:row.initialTaxScheme}, tx);
      if(allocationPreview)await writeNewEmployeeCostAllocationsTx(tx,ctx,allocationPreview.groups,index,employmentId);
      let familyCount=0;
      await pack.statutory.set(ctx, { personId, ...row.statutory }, tx);
      if(row.oldIcNumber)await pack.statutory.setIc(ctx,{personId,icNumber:row.statutory.icNumber??'',oldIcNumber:row.oldIcNumber},tx);
      if(row.bankExtra)await pack.statutory.setBank(ctx,{personId,...row.bankExtra},tx);
      if(row.operations)await applyPersonnelOperationalValuesTx(tx,ctx,employmentId,row.operations);
      // 524303d9 — the remaining Bank & Statutory settings, through the merged writer over the row just written
      // (it re-reads under lock and re-validates; a refusal rolls the whole import back).
      if(row.statutoryPatch){
        try{await applyBankStatutoryPatchTx(tx,ctx,{employmentId,personId,pack,country:row.country},row.statutoryPatch);}
        catch(error){const message=bankStatutoryRefusal(error);if(message)throw new Error(message);throw error;}
      }
      if(row.payrollPolicyId)await assignPolicy(ctx,{employmentId,policyId:row.payrollPolicyId},tx);
      if(row.scheduleGroupId)await setEmploymentScheduleGroupTx(tx,ctx,{employmentId,attendanceRuleId:row.scheduleGroupId});
      // Feedback b9fd8fd5 — imports behave like manual entry (setIcAction, item 354a500d): a valid IC also
      // persists the derived Date of Birth so the Profile tab's Age never reads "Not Available" for an
      // imported employee. `dobOnlyIfEmpty` guarantees an existing DOB is never overwritten; an IC whose
      // first six digits form no real calendar date derives nothing (null) and is skipped, not failed.
      // The complete employee row shares one transaction; a later owner refusal rolls back this autofill too.
      const derivedDob = pack.statutory.dobFromIC(row.statutory.icNumber);
      if (derivedDob) {
        await setPersonComplianceFields(ctx, { employmentId, dateOfBirth: derivedDob, dobOnlyIfEmpty: true }, tx);
      }
      await setCompensation(ctx, {
        employmentId,
        basicSalary: row.basicSalary,
        monthlyAllowance: row.monthlyAllowance,
        // ADR-0078 — undefined falls through to the service defaults (monthly / monthly / no rate).
        payMode: row.payMode,
        paymentTerm: row.paymentTerm,
        rateAmount: row.rateAmount,
        // r369 — the reason off the row, or undefined for a blank cell. The service stores undefined as
        // NULL and logs no `remarks` field change, so a file with no such column writes what it always did.
        remarks: row.salaryRemarks,
        effectiveFrom: row.effectiveFrom,
      }, tx);
      // ── Item 2983802f — the new blocks, each through the SAME service its Personnel card uses, and
      //    each skipped entirely when the file carried none of its columns. That is what keeps an
      //    existing file's import byte-identical to what it was before this change.
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
        }, tx);
      }
      if (row.passport) {
        await pack.statutory.setPassport(ctx, { personId, ...row.passport }, tx);
      }
      if (row.compliance) await setPersonComplianceFields(ctx,{employmentId,...row.compliance}, tx);
      if (row.employmentInfo) {
        await setEmploymentInfo(ctx, { employmentId, ...row.employmentInfo }, tx);
      }
      for (const d of familyByRow.get(index) ?? []) {
        await addDependentTx(tx,ctx,personId,d.add);
        familyCount++;
      }
      // 524303d9 — the attempt's item for this employment, in the SAME transaction as the hire (ADR-0155).
      if(attemptId){
        const [created]=await tx.select({code:employment.employeeCode}).from(employment).where(eq(employment.id,employmentId));
        const after:EmployeeFullItemState={employeeCode:created?.code??'',fullName:row.result.fullName,rowNum:row.result.rowNum};
        await recordImportItemTx(tx,ctx,{attemptId,companyId:row.hire.companyId,employmentId,itemKey:`row:${row.result.rowNum}`,label:`${after.employeeCode||'—'} · ${after.fullName}`,ordinal:index,status:'applied',after});
      }
      return {employmentId,personId,familyCount};
      })();
      employmentByRow.set(index,saved.employmentId);
      outcomeEmployment(saved.employmentId);outcomePerson(saved.personId);
      if(row.hire.employeeCode)registerSubjects.set(row.hire.employeeCode,{employmentId:saved.employmentId,personId:saved.personId});
      dependentsImported+=saved.familyCount;
      if(saved.familyCount)familySyncPersonIds.add(saved.personId);
      imported++;
    } catch (e) {
      failed.push({ rowNum: row.result.rowNum, email: row.result.email, message: publicErrorMessage(e) });
      throw e;
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
      throw new Error('The direct superior named on this row was not imported.');
    }
    try {
      await setReportingLine(ctx, {
        subordinateEmploymentId: subordinate,
        managerEmploymentId: manager,
        lineType: 'administrative',
        validFrom: row.hire.hiredOn,
      },tx);
      outcomeEmployment(subordinate);outcomeEmployment(manager);
    } catch (e) {
      // A reporting-link refusal aborts the enclosing import transaction as well.
      superiorFailed.push({
        rowNum: row.result.rowNum,
        email: row.result.email,
        message: publicErrorMessage(e),
      });
      throw e;
    }
  }

  for(const register of registers){
    registersImported[register.preview.kind]=await writeRegisterRowsTx(tx,ctx,register.preview.kind,register.resolved,registerSubjects);
    if(p.evaluationBinding)for(const row of register.resolved){
      const target=registerSubjects.get(row.preview.employeeCode)??row.subject;
      if(!target?.employmentId||!target.personId)throw Error('The import receipt could not be confirmed.');
      outcomeEmployment(target.employmentId);outcomePerson(target.personId);
    }
  }

  if(attemptId)await recordImportEventTx(tx,ctx,{attemptId,kind:'confirmed',importKind:'employee_full',detail:{succeeded:imported,failed:resolved.length-valid.length}});
  const evaluationEventId=await appendEvent(tx, {
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
        registers:registersImported,
      },
    },{returnId:Boolean(p.evaluationBinding)});
  if(p.evaluationBinding){if(typeof evaluationEventId!=='string')throw Error('The import receipt could not be confirmed.');evaluationReceipt=await completeEmployeeImportEvaluationTx(tx,ctx,p.evaluationBinding,p.companyId,evaluationEventId,{imported,failed:failed.length,skipped:resolved.length-valid.length,dependents:dependentsImported,qualification:registersImported.qualification,emergency:registersImported.emergency},[...outcomeSubjects.values()]);}

    });
  } catch(error) {
    evaluationReceipt=undefined;replayedEvaluation=false;
    const first=failed[0]??superiorFailed[0];
    const reason=first?.message??publicErrorMessage(error);
    writeFileErrors.push(`No employee rows were written. The import was rolled back${first?` after row ${first.rowNum} was refused`:''}. ${reason}`);
    failed.splice(0,failed.length,...valid.map(row=>({rowNum:row.result.rowNum,email:row.result.email,message:first?.rowNum===row.result.rowNum?reason:'Not written because the import was rolled back.'})));
    superiorFailed.splice(0);imported=0;dependentsImported=0;registersImported.qualification=0;registersImported.emergency=0;employmentByRow.clear();
  }

  if(writeFileErrors.length&&attemptId)await recordImportFailure(ctx,attemptId,'employee_full','failed',new ImportHistoryError(writeFileErrors.join(' ')));
  if(replayedEvaluation&&evaluationReceipt){
    if(attemptId)await recordImportFailure(ctx,attemptId,'employee_full','failed',new ImportHistoryError('This import was already completed; nothing new was written.'));
    return measuredImportReplay(p.companyId,evaluationReceipt);
  }

  // A post-commit refresh failure must never be described as a rolled-back employee import.
  if(!writeFileErrors.length) for(const personId of familySyncPersonIds) {
    try { const result=await syncChildReliefFromFamily(ctx,personId);if(result.skipped==='error')writeWarnings.push('Family records were saved; review the tax child-relief refresh on the Personnel record.'); }
    catch { writeWarnings.push('Family records were saved; review the tax child-relief refresh on the Personnel record.'); }
  }
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
    registersImported,
    superiorFailed,
    fileErrors: writeFileErrors,
    warnings: [...new Set(writeWarnings)],
    runId,
    attemptId,
    ...(evaluationReceipt?{evaluationReceipt}:{}),
  };
}

/** Rows as CSV text, for an import that arrived without its file (a paste, or a direct service call). */
function recordsAsCsv(records:ImportRecord[]){
  const columns=[...new Set(records.flatMap(record=>Object.keys(record)))];
  return toCsv([columns,...records.map(record=>columns.map(column=>record[column]??''))]);
}
/**
 * 524303d9 — the import attempt (ADR-0155). Only for a signed-in actor: a system context has no history owner.
 * Every listed company is one this actor maintains (analyze() already refused any other), so the attempt's
 * insert policy holds. A repeated upload operation is refused, never re-imported.
 */
async function recordEmployeeImportAttempt(ctx:SessionContext,p:{companyId:string;records:ImportRecord[];fileName?:string;source?:{name:string;content:Buffer;operationKey?:string}},preview:ImportPreview,resolved:ResolvedRow[]):Promise<string|null>{
  if(!ctx.userId)return null;
  const name=p.source?.name||p.fileName||'pasted-employees.csv';
  const content=p.source?.content??Buffer.from(recordsAsCsv(p.records),'utf8');
  const rows=resolved.map(row=>({rowNum:row.result.rowNum,fullName:row.result.fullName,employeeCode:row.hire.employeeCode??'',company:row.result.company,ok:row.result.ok,errors:row.result.errors}));
  const plan=sealImportPlan<EmployeeFullImportPlan>({version:1,kind:'employee_full',companyId:p.companyId,rows,counts:{total:rows.length,valid:preview.validCount,invalid:rows.length-preview.validCount},
    issues:[...preview.fileErrors.map(reason=>({rowNum:0,reason})),...rows.filter(row=>!row.ok).map(row=>({rowNum:row.rowNum,reason:`Row ${row.rowNum} (${row.fullName||row.employeeCode||'no name'}): ${row.errors.join('; ')}`}))],previewHash:''});
  const companyIds=[...new Set(resolved.filter(row=>row.result.ok).map(row=>row.hire.companyId))];
  const created=await withTenant(ctx,tx=>createImportAttemptTx(tx,ctx,{kind:'employee_full',sourceName:name,content,companyIds,plan,operationKey:p.source?.operationKey}));
  if(created.existing)throw new ImportHistoryError('This upload was already received. Open Import History to see its outcome.');
  return created.attemptId;
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
