/**
 * Lifecycle onboarding import from Excel (ADR-0095, handover brief 4.6).
 *
 * A business group's own tracker works as well as the downloadable template: columns are matched by their
 * HEADING, never their position. Nothing is created by `previewOnboardingImport`; each row is checked with
 * the rules the New Hire form uses and marked OK / Duplicate / Error with the reason. `commitOnboardingRows`
 * then creates the OK rows one transaction each, so one bad row cannot sink the rest, through
 * `createOnboardingCase` itself — the same validation, the same requisition hand-off, no second code path.
 *
 * Safeguards: only `.xlsx`, at most 8 MB and 500 rows; a column that looks like a password, identity number
 * or bank detail is NEVER READ (only its heading is reported); dates are read day-first (13/10/2026 is
 * 13 October); and the commit takes ROWS, not trusted flags — every row is re-validated server-side.
 */
import * as XLSX from 'xlsx';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { company } from '../db/schema';
import { createOnboardingCase, type OnboardingInput } from './lifecycle-cases';
import { LEVEL, LifecycleError, clean, requireLevel, withTenant } from './lifecycle-base';
import { normaliseCompanyCode } from './lifecycle-defaults';

export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 500;

const SYNONYMS: Record<string, string[]> = {
  fullName: ['name', 'fullname', 'employeename', 'newhirename', 'staffname', 'nameasperic', 'candidatename'],
  employeeNo: ['employeeno', 'employeenumber', 'empno', 'employeeid', 'staffno', 'staffid', 'empid', 'employeecode'],
  joinDate: ['joindate', 'startdate', 'datejoined', 'commencementdate', 'dateofjoining', 'reportingdate'],
  company: ['businessgroup', 'bg', 'company', 'entity', 'companycode', 'group'],
  jobTitle: ['jobtitle', 'position', 'designation', 'title'],
  department: ['department', 'dept', 'division'],
  supervisor: ['supervisor', 'reportingto', 'reportingmanager', 'manager', 'linemanager'],
  hireType: ['hiretype', 'typeofhiring', 'hiring'],
  replacedPerson: ['replacing', 'replacedperson', 'replacementfor', 'replacementof'],
  laptopRequired: ['laptoprequired', 'laptop', 'needlaptop'],
  carparkRequired: ['carparkrequired', 'carpark', 'parking', 'carparkbay'],
  newhireEmail: ['email', 'emailaddress', 'newhireemail', 'personalemail', 'workemail', 'username'],
  gbsTa: ['gbsta', 'ta', 'talentacquisition', 'recruiter'],
};
/** Headings that must never be read, whatever else they match. */
const SENSITIVE = /password|passwd|pwd|nric|passport|\bic\b|icno|icnumber|identity|bank|account\s*no|salary|epf|socso|tax/i;

const norm = (h: unknown): string => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const yes = (v: unknown): boolean | undefined => {
  const x = String(v ?? '').trim().toLowerCase();
  if (x === '') return undefined;
  if (['y', 'yes', 'true', '1', 'required', 'x'].includes(x)) return true;
  if (['n', 'no', 'false', '0', 'not required', '-'].includes(x)) return false;
  return undefined;
};

/** Day-first. Accepts a real Date (xlsx cellDates), an Excel serial, `13/10/2026`, `13-10-26`, or ISO. */
export function parseSheetDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())).toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isFinite(v) && v > 20000 && v < 80000) {
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const x = String(v ?? '').trim();
  if (!x) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(x);
  const dmy = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(x);
  let y: number; let m: number; let d: number;
  if (iso) { y = +iso[1]!; m = +iso[2]!; d = +iso[3]!; }
  else if (dmy) { d = +dmy[1]!; m = +dmy[2]!; y = +dmy[3]!; if (dmy[3]!.length === 2) y += 2000; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export type ImportRow = {
  sheet: string;
  row: number;
  status: 'ok' | 'duplicate' | 'error';
  reason: string | null;
  input: Omit<OnboardingInput, 'companyId'> & { companyId: string | null; companyText: string | null };
};
export type ImportPreview = { rows: ImportRow[]; skippedColumns: string[]; ok: number; duplicate: number; error: number };

export function onboardingTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Full name', 'Employee no.', 'Join date', 'Business group', 'Job title', 'Department', 'Supervisor', 'Hire type', 'Replacing', 'Laptop required', 'Car park', 'Email'],
    ['Aisha Binti Karim', 'E1001', '13/10/2026', '', 'Analyst', 'Finance', 'Lee Wei', 'New Hire', '', 'Yes', 'No', 'aisha@example.com'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'New hires');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}

export async function previewOnboardingImport(
  ctx: SessionContext, file: Buffer, opts: { fileName?: string; defaultCompanyId?: string | null } = {},
): Promise<ImportPreview> {
  if (file.length === 0) throw new LifecycleError('The file is empty.');
  if (file.length > IMPORT_MAX_BYTES) throw new LifecycleError('The file is larger than 8 MB.');
  if (file.length < 4 || file.toString('latin1', 0, 2) !== 'PK') throw new LifecycleError('Only .xlsx workbooks can be imported.');
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(file, { type: 'buffer', cellDates: true, dense: false }); } catch { throw new LifecycleError('That file could not be read as an Excel workbook.'); }

  const companies = await withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.agent, 'only staff import new hires');
    return tx.select({ id: company.id, label: company.companyLabel, name: company.legalName }).from(company);
  });
  const byKey = new Map<string, string>();
  for (const c of companies) {
    if (normaliseCompanyCode(c.label)) byKey.set(normaliseCompanyCode(c.label), c.id);
    byKey.set(normaliseCompanyCode(c.name), c.id);
  }
  const resolveCompany = (text: string | null, sheetName: string): string | null => {
    for (const t of [text, sheetName]) { const k = normaliseCompanyCode(t); if (k && byKey.has(k)) return byKey.get(k)!; }
    return opts.defaultCompanyId ?? null;
  };

  const skipped = new Set<string>();
  const rows: ImportRow[] = [];
  const seenNos = new Set<string>(); const seenEmails = new Set<string>();
  let total = 0;
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]!;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '', blankrows: false });
    if (matrix.length < 2) continue;
    const headerIdx = matrix.findIndex((r) => (r as unknown[]).some((c) => String(c ?? '').trim() !== ''));
    const head = (matrix[headerIdx] as unknown[]).map((h) => String(h ?? '').trim());
    const col: Record<string, number> = {};
    head.forEach((h, i) => {
      if (!h) return;
      if (SENSITIVE.test(h)) { skipped.add(h); return; }
      const n = norm(h);
      for (const [field, syns] of Object.entries(SYNONYMS)) if (col[field] === undefined && syns.includes(n)) col[field] = i;
    });
    if (col.fullName === undefined && col.employeeNo === undefined) continue; // not a hires sheet
    for (let r = headerIdx + 1; r < matrix.length; r++) {
      const line = matrix[r] as unknown[];
      if (line.every((c) => String(c ?? '').trim() === '')) continue;
      total++;
      if (total > IMPORT_MAX_ROWS) throw new LifecycleError(`The file has more than ${IMPORT_MAX_ROWS} rows. Split it and import in parts.`);
      const get = (f: string): unknown => (col[f] === undefined ? undefined : line[col[f]!]);
      const txt = (f: string) => clean(get(f), 300);
      const companyText = txt('company');
      const hireText = (txt('hireType') ?? '').toLowerCase();
      const joinRaw = get('joinDate');
      const joinDate = parseSheetDate(joinRaw);
      const input: ImportRow['input'] = {
        companyId: resolveCompany(companyText, sheetName), companyText,
        fullName: txt('fullName') ?? '', employeeNo: txt('employeeNo') ?? '', joinDate: joinDate ?? '',
        jobTitle: txt('jobTitle'), department: txt('department'), supervisor: txt('supervisor'), gbsTa: txt('gbsTa'),
        hireType: hireText.includes('replace') ? 'replacement' : 'new_hire', replacedPerson: txt('replacedPerson'),
        laptopRequired: yes(get('laptopRequired')) ?? true, carparkRequired: yes(get('carparkRequired')) ?? false,
        newhireEmail: txt('newhireEmail')?.toLowerCase() ?? null,
        importedFrom: `${opts.fileName ?? 'file'}, ${sheetName}, row ${r + 1}`,
      };
      let reason: string | null = null;
      if (!input.fullName) reason = 'Full name is missing.';
      else if (!input.employeeNo) reason = 'Employee number is missing.';
      else if (joinRaw === undefined || String(joinRaw).trim() === '') reason = 'Join date is missing.';
      else if (!joinDate) reason = 'Join date is not a readable date (use day/month/year).';
      else if (!input.companyId) reason = 'Business group is missing and no default was chosen.';
      else if (input.hireType === 'replacement' && !input.replacedPerson) reason = 'A replacement hire needs the person being replaced.';
      else if (input.newhireEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.newhireEmail)) reason = 'Email address is not valid.';
      let status: ImportRow['status'] = reason ? 'error' : 'ok';
      const key = input.employeeNo.toLowerCase();
      if (status === 'ok') {
        if (seenNos.has(key)) { status = 'duplicate'; reason = 'Employee number appears twice in this file.'; }
        else if (input.newhireEmail && seenEmails.has(input.newhireEmail)) { status = 'duplicate'; reason = 'Email appears twice in this file.'; }
      }
      if (input.employeeNo) seenNos.add(key);
      if (input.newhireEmail) seenEmails.add(input.newhireEmail);
      rows.push({ sheet: sheetName, row: r + 1, status, reason, input });
    }
  }
  // Employee numbers / emails already in an active case.
  const nos = [...new Set(rows.filter((x) => x.status === 'ok').map((x) => x.input.employeeNo.toLowerCase()))];
  if (nos.length) {
    const hits = await withTenant(ctx, async (tx) => {
      const r = (await tx.execute(sql`select lower(employee_no) as no, lower(newhire_email) as em from lc_case where kind = 'onboarding' and status = 'in_progress'`)) as unknown as { no: string; em: string | null }[];
      return r;
    });
    const activeNos = new Set(hits.map((h) => h.no)); const activeMails = new Set(hits.map((h) => h.em).filter(Boolean) as string[]);
    for (const x of rows) {
      if (x.status !== 'ok') continue;
      if (activeNos.has(x.input.employeeNo.toLowerCase())) { x.status = 'duplicate'; x.reason = 'Employee number already has an active onboarding case.'; }
      else if (x.input.newhireEmail && activeMails.has(x.input.newhireEmail)) { x.status = 'duplicate'; x.reason = 'Email already has an active onboarding case.'; }
    }
  }
  return { rows, skippedColumns: [...skipped], ok: rows.filter((x) => x.status === 'ok').length, duplicate: rows.filter((x) => x.status === 'duplicate').length, error: rows.filter((x) => x.status === 'error').length };
}

export type CommitResult = { created: { row: number; number: string; requisition: string }[]; failed: { row: number; reason: string }[] };

/** Create the OK rows, one transaction each. Every row is re-validated by createOnboardingCase itself. */
export async function commitOnboardingRows(ctx: SessionContext, rows: ImportRow[]): Promise<CommitResult> {
  if (rows.length > IMPORT_MAX_ROWS) throw new LifecycleError(`At most ${IMPORT_MAX_ROWS} rows per import.`);
  const out: CommitResult = { created: [], failed: [] };
  for (const r of rows) {
    if (r.status !== 'ok' || !r.input.companyId) continue;
    try {
      const { companyText: _t, ...rest } = r.input;
      const res = await createOnboardingCase(ctx, { ...rest, companyId: r.input.companyId });
      out.created.push({ row: r.row, number: res.number, requisition: res.requisitionNumber });
    } catch (e) {
      out.failed.push({ row: r.row, reason: e instanceof Error ? e.message : 'Could not create the case.' });
    }
  }
  return out;
}
