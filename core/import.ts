/**
 * Day-one employee importer (ADR-0008 localization stays in the pack; this is the generic
 * bulk-load path). Parses a validated set of CSV records and reuses the same services the
 * single-hire form uses — hireEmployee → setStatutoryProfileMY → setCompensation — so an
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
import { person, employeeStatutoryMy, employment } from '../db/schema';
import { eq } from 'drizzle-orm';
import { hireEmployee } from './org';
import { setCompensation } from './comp';
import { setStatutoryProfileMY, isValidIC, normalizeIC } from '../localization/my/statutory';
import { normalizeEmployeeCode, isValidEmployeeCode, EMPLOYEE_CODE_MAX_LEN } from '../lib/employee-code';
import { listDepartments, listLeaveTypes } from './read';
import { listPositions, listCostCenters } from './admin';
import { appendEvent, actorOf } from '../db/events';
import { IMPORT_COLUMNS, type ImportRecord, type RowResult, type ImportPreview, type ImportResult } from '../lib/import-schema';

// Re-exported so server-side callers (actions, tests) can keep importing from core/import.
export { IMPORT_COLUMNS };
export type { ImportRecord, RowResult, ImportPreview, ImportResult };

const EMPLOYMENT_TYPES = new Set(['full_time', 'part_time', 'contract', 'intern']);
const STANDING_GRANTS = new Set(['ANNUAL', 'SICK', 'HOSPITALIZATION']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TRUTHY = new Set(['', 'true', 'yes', 'y', '1']); // default-true fields: blank = true
const FALSY = new Set(['false', 'no', 'n', '0']);

type ResolvedRow = {
  result: RowResult;
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
  };
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
  effectiveFrom: string;
};

const norm = (s: string | undefined) => (s ?? '').trim();
const lc = (s: string | undefined) => norm(s).toLowerCase();

/** Read the company catalog + existing identifiers once, then validate every record in memory. */
async function analyze(
  ctx: SessionContext,
  companyId: string,
  records: ImportRecord[],
): Promise<{ preview: ImportPreview; resolved: ResolvedRow[] }> {
  const [departments, positions, costCenters, leaveTypes] = await Promise.all([
    listDepartments(ctx, { companyIds: [companyId] }),
    listPositions(ctx, { companyIds: [companyId] }),
    listCostCenters(ctx, { companyIds: [companyId] }),
    listLeaveTypes(ctx),
  ]);
  const deptByName = new Map(departments.map((d) => [d.name.toLowerCase(), d.id]));
  const posByName = new Map(positions.map((p) => [p.title.toLowerCase(), p.id]));
  const ccByName = new Map<string, string>();
  for (const c of costCenters) {
    if (c.name) ccByName.set(c.name.toLowerCase(), c.id);
    if (c.code) ccByName.set(c.code.toLowerCase(), c.id);
  }
  const grants = leaveTypes
    .filter((t) => STANDING_GRANTS.has(t.code))
    .map((t) => ({ id: t.id, code: t.code }));

  // Existing identifiers (tenant-scoped via RLS) so the import can't create dup ICs (DB-unique)
  // or silently re-add someone by email.
  const { existingEmails, existingIcs, existingCodes } = await withTenant(ctx, async (tx) => {
    const ppl = await tx.select({ email: person.primaryEmail }).from(person);
    const ics = await tx.select({ ic: employeeStatutoryMy.icNumber }).from(employeeStatutoryMy);
    // Employee IDs already in use in this tenant (feedback 38668d9b) — an import must not collide with an
    // existing staff ID. Compared on the normalized (uppercased) value, matching the uniqueness rule.
    const codes = await tx.select({ code: employment.employeeCode }).from(employment);
    return {
      existingEmails: new Set(ppl.map((r) => r.email.toLowerCase())),
      existingIcs: new Set(ics.map((r) => normalizeIC(r.ic))),
      existingCodes: new Set(codes.filter((r) => r.code).map((r) => normalizeEmployeeCode(r.code))),
    };
  });

  const presentColumns = new Set(records.length ? Object.keys(records[0]) : []);
  const missingColumns = IMPORT_COLUMNS.required.filter((c) => !presentColumns.has(c));

  const seenEmails = new Set<string>();
  const seenIcs = new Set<string>();
  const seenCodes = new Set<string>();
  const resolved: ResolvedRow[] = [];

  records.forEach((rec, idx) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const fullName = norm(rec.full_name);
    const email = norm(rec.email);

    // Employee ID (feedback 38668d9b): HR MAY supply one — the feature is manual-entry ABILITY, not an
    // obligation. Blank or absent → hireEmployee auto-generates via nextEmployeeCode, exactly like a
    // hand hire without an ID. When supplied: alphanumeric + dash max 9, unique in the file and across
    // the tenant; the normalized (uppercased) value is what gets stored + hired with.
    const codeRaw = norm(rec.employee_code);
    const codeNorm = normalizeEmployeeCode(codeRaw);
    if (codeRaw && !isValidEmployeeCode(codeRaw))
      errors.push(`Invalid employee_code "${codeRaw}" (letters/numbers/dash, max ${EMPLOYEE_CODE_MAX_LEN})`);
    else if (codeRaw && seenCodes.has(codeNorm)) errors.push('Duplicate employee_code in this file');
    else if (codeRaw && existingCodes.has(codeNorm)) errors.push(`Employee ID "${codeNorm}" is already in use`);
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

    // IC (required, format + uniqueness — DB enforces tenant-unique IC)
    const icRaw = norm(rec.ic_number);
    const icNorm = normalizeIC(icRaw);
    if (!icRaw) errors.push('Missing ic_number');
    else if (!isValidIC(icRaw)) errors.push(`Invalid IC "${icRaw}" (expected 12 digits)`);
    else if (seenIcs.has(icNorm)) errors.push('Duplicate ic_number in this file');
    else if (existingIcs.has(icNorm)) errors.push('An employee with this IC already exists');
    if (icRaw && isValidIC(icRaw)) seenIcs.add(icNorm);

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

    const ok = errors.length === 0;
    const result: RowResult = { rowNum: idx + 1, fullName, email, ok, errors, warnings };
    resolved.push({
      result,
      hire: {
        person: { fullName, primaryEmail: email, phone: norm(rec.phone) || undefined },
        companyId,
        departmentId: departmentId ?? '',
        positionId,
        costCenterId,
        employmentType,
        hiredOn,
        // Blank → undefined so hireEmployee falls through to the nextEmployeeCode auto-counter.
        employeeCode: codeNorm || undefined,
        grantLeaveTypes: grants,
      },
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
      effectiveFrom: hiredOn,
    });
  });

  const preview: ImportPreview = {
    companyId,
    total: records.length,
    validCount: resolved.filter((r) => r.result.ok).length,
    rows: resolved.map((r) => r.result),
    missingColumns,
  };
  return { preview, resolved };
}

/** Dry run: validate the records against the company catalog without writing anything. */
export async function validateEmployeeImport(
  ctx: SessionContext,
  p: { companyId: string; records: ImportRecord[] },
): Promise<ImportPreview> {
  const { preview } = await analyze(ctx, p.companyId, p.records);
  return preview;
}

/** Commit the valid rows. Re-validates server-side (never trusts a client-supplied preview),
 *  imports row-by-row reusing the hire / statutory / compensation services, and records a
 *  batch event so the import itself shows up in the audit trail. */
export async function commitEmployeeImport(
  ctx: SessionContext,
  p: { companyId: string; records: ImportRecord[] },
): Promise<ImportResult> {
  const { resolved } = await analyze(ctx, p.companyId, p.records);
  const valid = resolved.filter((r) => r.result.ok);
  const failed: ImportResult['failed'] = [];
  let imported = 0;

  for (const row of valid) {
    try {
      const { employmentId, personId } = await hireEmployee(ctx, row.hire);
      await setStatutoryProfileMY(ctx, { personId, ...row.statutory });
      await setCompensation(ctx, {
        employmentId,
        basicSalary: row.basicSalary,
        monthlyAllowance: row.monthlyAllowance,
        effectiveFrom: row.effectiveFrom,
      });
      imported++;
    } catch (e) {
      failed.push({ rowNum: row.result.rowNum, email: row.result.email, message: (e as Error).message });
    }
  }

  await withTenant(ctx, (tx) =>
    appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-import',
      aggregateId: p.companyId,
      eventType: 'employee-import.completed',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, imported, failed: failed.length, skipped: resolved.length - valid.length },
    }),
  );

  return { companyId: p.companyId, imported, failed, skipped: resolved.length - valid.length };
}
