/**
 * Import Payroll History — bulk-load PRE-COMPUTED historical payroll for data migration.
 *
 * Why this exists: a customer migrating onto the platform mid-life needs prior periods on file so the
 * EA form, Form E / CP8D and the monthly statutory returns are complete at year-end. Those readers
 * (localization/my/reports.ts) read `payslip ⋈ payroll_batch` directly — anything stored outside that
 * join is invisible to year-end — so imported rows MUST land as real payslip rows under a real batch.
 * No parallel table.
 *
 * DESIGN (load-bearing decisions; verified against the codebase):
 *
 *  1. Records live in payslip + payroll_batch — same source the year-end/monthly readers consume.
 *
 *  2. Import-only-into-EMPTY months. The importer refuses any (company, period) that already has ANY
 *     batch. Every employee-month for such a period comes back as "Existing record / Needs action" and
 *     NOTHING is written for it. Rationale: a migration imports PRIOR history for months the live system
 *     never ran; a month with an existing batch is exactly the double-count trap, since loadBatchRows
 *     (reports.ts) SUMS payslips across every batch for the month with no run_type and no status filter,
 *     loadYearRows / eaStatement filter only on `pay_period LIKE '<year>-%'`, and core/payroll.ts replays
 *     prior-period payslips into the PCB accumulators with the same absence of a filter. A second load
 *     into an occupied month would therefore submit someone paid 5,000 as 10,000 AND distort the rest of
 *     that year's PCB. THIS CHECK IS THE WHOLE OF THE SAFETY — see the Override? note below.
 *
 *  3. OVERRIDE? IS PARSED AND VALIDATED, NEVER HONOURED AS A REPLACE. The reporter asked for Override=1
 *     to update the existing record. It cannot: on top of the double-count above there is no undo — an
 *     imported batch is inserted closed, and db/migrations/0011_payroll_immutability.sql blocks UPDATE
 *     and DELETE on a closed batch and its payslips at trigger level, while core/payroll.ts refuses
 *     deleteBatch unless the batch is draft. So the value must be 1 or 0 (anything else is an error) and
 *     an occupied month yields the reporter's OWN second branch: keep the existing record, flag the row.
 *     "Updated/overridden" in the summary is therefore always 0. A genuine replace — reversing or
 *     superseding the earlier batch — is a separate and considerably larger piece of work.
 *
 *  4. The importer owns its batch insert — it does NOT call createBatch (which throws on any existing
 *     batch for the period and always creates run_type='regular', colliding with the partial unique
 *     index payroll_batch_one_regular_uq). It inserts run_type='adjustment', run_seq=1 directly,
 *     find-or-creating the pay_period parent inline. 'adjustment' sidesteps the regular-uniqueness
 *     index without a new enum; the additional-remuneration "increment" math lives ONLY in
 *     generatePayslips (which the importer never calls — it inserts payslips directly), so there is no
 *     EA distortion: the EA reader reads stored payslip scalars regardless of run_type.
 *
 *  5. Create batch status='draft', insert payslips, set counters, THEN flip to 'closed'. The 0011
 *     immutability triggers are BEFORE UPDATE/DELETE only, so creating 'closed' up front would make
 *     employee_count/totals un-backfillable. Order: insert draft → insert payslips → UPDATE counters →
 *     UPDATE status='closed' → UPDATE pay_period status='closed' (so the period isn't orphaned 'open').
 *
 *  6. FIGURES ARE THE FILE'S OWN, AND THE ONLY ARITHMETIC IS ADDITION. The Malaysian statutory tables are
 *     never applied to a loaded month — a migration's numbers are whatever the prior system paid. Gross
 *     is the sum of the file's earning lines; net is that minus the file's own cash deductions. If the
 *     file ALSO states a GROSS or NETPAY line, it is cross-checked and a disagreement is a hard error
 *     rather than a silent preference for one figure over the other. The statutory JSONB carries every
 *     key the readers consume plus a `version` stamp set to the company's pack's built-in ruleset
 *     version, so versionOf reports the import provenance.
 *
 *  7. RESOLUTION IS BY EMPLOYEE CODE within the company named by the file's Company Code, effective for
 *     the period — not by email, which is what the wide contract used. Company Code resolves against
 *     company.company_label (plus id / legal name / registration no, mirroring core/import.ts) but,
 *     unlike the leave importer's case-insensitive first-writer-wins, an unknown OR ambiguous code is a
 *     hard error here: a mis-targeted payroll month cannot be taken back.
 *
 * THE FILE FORMAT IS LONG, NOT WIDE (4157a498). Seven columns, one line per figure, folded back into one
 * employee-month. See lib/payroll-history-import-schema.ts for the contract and the code vocabulary.
 *
 * Shape mirrors core/import.ts: one PRIVATE analyze(), two public exports
 * (validatePayrollHistoryImport dry-run, commitPayrollHistoryImport). Not atomic across periods: each
 * period writes in its OWN withTenant transaction so one failing period can't strand the others (a
 * single shared tx aborts on first failed insert).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import {
  company,
  employeeStatutoryMy,
  employment,
  payComponent,
  payPeriod,
  payrollBatch,
  payrollCycle,
  payrollImportCode,
  payslip,
} from '../db/schema';
import { appendEvent, actorOf } from '../db/events';
// Rung 5a (ADR-0080 D1/D6): the provenance version stamp is the company's pack's built-in ruleset
// version (`statutoryConfig.default.version`), resolved fail-loud in analyze() from company.country.
import { requirePackFor } from '../localization/registry';
import {
  PAYROLL_HISTORY_COLUMNS,
  PAYROLL_IMPORT_DESTINATIONS,
  STATUTORY_DESTINATIONS,
  STATUTORY_IMPORT_CODES,
  missingHistoryColumns,
  payComponentDestination,
  readHistoryField,
  type HistoryErrorType,
  type HistoryImportPreview,
  type HistoryImportResult,
  type HistoryIssue,
  type HistoryMonth,
  type ImportCodeEntry,
  type PayrollHistoryRecord,
  type PayrollImportDestination,
} from '../lib/payroll-history-import-schema';

export { PAYROLL_HISTORY_COLUMNS };
export type { PayrollHistoryRecord, HistoryIssue, HistoryMonth, HistoryImportPreview, HistoryImportResult };

/** YYYYMM as the reporter's template specifies. Converted, never coerced. */
const PERIOD_YYYYMM_RE = /^\d{6}$/;
/** The stored form. Accepted on input too, because a customer's own export often already has it. */
const PERIOD_ISO_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** A money cell after thousands separators are stripped: digits with at most one decimal point. */
const MONEY_RE = /^\d+(\.\d+)?$/;
const MONEY_TOL = 0.02;

const norm = (s: string | undefined | null) => (s ?? '').trim();
const up = (s: string) => s.trim().toUpperCase();
const round2 = (n: number) => Math.round(n * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Period conversion
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * YYYYMM → YYYY-MM, or null when the cell is not a period.
 *
 * HARD FAILURE, NEVER COERCION. `Date` would happily read "202513" as something; a coerced period would
 * write a month's payroll into the wrong month, and an imported batch cannot be deleted. So the only
 * accepted shapes are exactly six digits with a month of 01–12, or the ISO form already.
 */
export function toIsoPeriod(raw: string): string | null {
  const s = norm(raw);
  if (PERIOD_ISO_RE.test(s)) return s;
  if (!PERIOD_YYYYMM_RE.test(s)) return null;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  if (month < 1 || month > 12) return null;
  if (year < 1900 || year > 2999) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
}

/** First and last calendar day of a YYYY-MM, for the "was this person employed that month" test. */
function periodBounds(period: string): { first: string; last: string } {
  const [y, m] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${period}-01`, last: `${period}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * Parse a money cell. Thousands separators are stripped (the reporter asked that they not be REQUIRED,
 * not that they be rejected); anything else non-numeric returns null so the caller can say which cell.
 */
function money(raw: string): number | null {
  const s = norm(raw).replace(/[,_\s]/g, '');
  if (s === '') return null;
  if (!MONEY_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Internal shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A single accepted line, already resolved. */
type ParsedLine = {
  rowNum: number;
  employeeNo: string;
  period: string; // YYYY-MM
  rawPeriod: string;
  cycle: string;
  doeCode: string;
  companyCode: string;
  amount: number;
  override: boolean;
  destination: PayrollImportDestination;
};

/** A folded employee-month ready for the writer. */
type ResolvedMonth = {
  month: HistoryMonth;
  employmentId: string;
  period: string;
  basicSalary: number;
  allowance: number;
  overtimePay: number;
  bonus: number;
  grossPay: number;
  otherDeductions: number;
  totalDeductions: number;
  netPay: number;
  employerCost: number;
  statutory: ImportedStat;
};

/** Statutory blob stored on each imported payslip (file figures, verbatim) + provenance version. */
type ImportedStat = {
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  socsoSkbbk: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  lp: number;
  zakat: number;
  hrdf: number;
  version: string;
  /** CP38 — the LHDN/court instalment, DISTINCT from MTD. Stamped only when > 0 (mirrors the kernel), so
   *  cp39FileForBatch sums the instalment into the e-Data file's CP38 column. */
  cp38?: number;
};

const issue = (
  line: { rowNum: number; employeeNo: string; rawPeriod: string; doeCode: string },
  type: HistoryErrorType,
  description: string,
  status: HistoryIssue['status'] = 'Failed',
): HistoryIssue => ({
  rowNum: line.rowNum,
  employeeNo: line.employeeNo,
  period: line.rawPeriod,
  doeCode: line.doeCode,
  type,
  description,
  status,
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The DOE code catalog
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the codes this tenant's import may use, in three layers:
 *
 *   1. STATUTORY_IMPORT_CODES — built in, so a tenant provisioned after migration 0427 (which has no
 *      payroll_import_code rows at all) can still import. This is the floor, not a seed dependency.
 *   2. the live pay_component catalog — the earning/deduction codes an admin already maintains, mapped
 *      by kind and display category. A non-payable component (a BIK/perquisite: taxable but never paid
 *      in cash) is deliberately NOT accepted — it has no cash destination and guessing one would inflate
 *      the employee's gross.
 *   3. payroll_import_code — the override layer: adds a code, aliases one onto another, or (active
 *      false) removes one.
 *
 * Later layers win. An alias resolves ONE hop; an alias whose target is itself an alias, or unknown, is
 * dropped rather than chased, so a bad catalog row can never loop or silently retarget.
 */
export async function resolveImportCodes(ctx: SessionContext): Promise<Map<string, ImportCodeEntry>> {
  const { components, catalog } = await withTenant(ctx, async (tx) => {
    const components = await tx
      .select({
        code: payComponent.code,
        name: payComponent.name,
        kind: payComponent.kind,
        displayCategory: payComponent.displayCategory,
        isNonPayable: payComponent.isNonPayable,
        archivedAt: payComponent.archivedAt,
      })
      .from(payComponent);
    const catalog = await tx.select().from(payrollImportCode);
    return { components, catalog };
  });

  const byCode = new Map<string, ImportCodeEntry>();
  for (const s of STATUTORY_IMPORT_CODES) byCode.set(up(s.code), { ...s });
  for (const c of components) {
    if (c.archivedAt != null || c.isNonPayable) continue;
    const { destination, direction } = payComponentDestination({
      code: c.code,
      kind: c.kind,
      displayCategory: c.displayCategory,
    });
    byCode.set(up(c.code), { code: c.code, label: c.name, destination, direction, source: 'component' });
  }
  // Pass 1: direct catalog rows (and removals). Pass 2: aliases, so an alias may point at a row added in
  // pass 1 regardless of the order they came back from the database.
  const aliases: typeof catalog = [];
  for (const row of catalog) {
    if (row.aliasFor != null && norm(row.aliasFor) !== '') {
      aliases.push(row);
      continue;
    }
    if (!row.active) {
      byCode.delete(up(row.code));
      continue;
    }
    if (!(PAYROLL_IMPORT_DESTINATIONS as readonly string[]).includes(row.destination)) continue;
    byCode.set(up(row.code), {
      code: row.code,
      label: row.label,
      destination: row.destination as PayrollImportDestination,
      direction: row.direction as ImportCodeEntry['direction'],
      source: 'catalog',
    });
  }
  for (const row of aliases) {
    if (!row.active) {
      byCode.delete(up(row.code));
      continue;
    }
    const target = byCode.get(up(row.aliasFor!));
    if (!target) continue; // unknown target — dropped, never guessed
    byCode.set(up(row.code), {
      code: row.code,
      label: row.label,
      destination: target.destination,
      direction: target.direction,
      source: 'alias',
    });
  }
  return byCode;
}

/** The code list as the template's Codes sheet and the screen's reference panel show it. */
export async function listImportCodes(ctx: SessionContext): Promise<ImportCodeEntry[]> {
  const map = await resolveImportCodes(ctx);
  return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// analyze
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Read the master data once, then validate every LINE and fold the lines into employee-months in memory
 * (RLS-scoped reads only; writes nothing). Returns the preview plus the resolved months the commit path
 * replays. PRIVATE — the two public exports are the only surface.
 */
async function analyze(
  ctx: SessionContext,
  companyId: string,
  records: PayrollHistoryRecord[],
): Promise<{ preview: HistoryImportPreview; months: ResolvedMonth[]; statutoryVersion: string }> {
  const codes = await resolveImportCodes(ctx);

  const { companyKeys, targetCompany, employees, cycles, statutoryVersion } = await withTenant(
    ctx,
    async (tx) => {
      const companies = await tx
        .select({
          id: company.id,
          legalName: company.legalName,
          companyLabel: company.companyLabel,
          registrationNo: company.registrationNo,
          country: company.country,
          archivedAt: company.archivedAt,
        })
        .from(company);
      const targetCompany = companies.find((c) => c.id === companyId);
      const statutoryVersion = requirePackFor(targetCompany?.country).statutoryConfig.default.version;

      // Company Code lookup, mirroring core/import.ts's key set (id / legal name / label / registration
      // no) — but recording EVERY company a key hits rather than keeping the first. Two companies sharing
      // a label must fail loudly here; the leave importer's first-writer-wins would silently target one.
      const companyKeys = new Map<string, string[]>();
      for (const c of companies) {
        if (c.archivedAt != null) continue;
        for (const k of [c.id, c.legalName, c.companyLabel, c.registrationNo]) {
          const kk = up(k ?? '');
          if (!kk) continue;
          const hits = companyKeys.get(kk) ?? [];
          if (!hits.includes(c.id)) hits.push(c.id);
          companyKeys.set(kk, hits);
        }
      }

      const employees = await tx
        .select({
          employmentId: employment.id,
          code: employment.employeeCode,
          hiredOn: employment.hiredOn,
          terminatedOn: employment.terminatedOn,
          // leftJoin: the MY statutory profile may be absent, which is exactly the CP39 warning below.
          taxNumber: employeeStatutoryMy.taxNumber,
        })
        .from(employment)
        .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
        .where(eq(employment.companyId, companyId));

      const cycles = await tx
        .select({
          name: payrollCycle.name,
          code: payrollCycle.code,
          archivedAt: payrollCycle.archivedAt,
        })
        .from(payrollCycle)
        .where(eq(payrollCycle.companyId, companyId));

      return { companyKeys, targetCompany, employees, cycles, statutoryVersion };
    },
  );

  // ── Employee lookup by code, within THIS company. `employment_employee_code_uq` (tenant, code) already
  // makes a code unique tenant-wide, so a within-company collision is impossible today — the guard stays
  // because the code is now load-bearing for money and a future relaxation of that index must not turn
  // into a silent mis-posting.
  const employeesByCode = new Map<string, typeof employees>();
  for (const e of employees) {
    const key = up(e.code ?? '');
    if (!key) continue;
    const list = employeesByCode.get(key) ?? [];
    list.push(e);
    employeesByCode.set(key, list);
  }

  // ── Cycle lookup: the short code the reporter's file carries, OR the friendly name (a customer who has
  // not filled in the codes yet can still write "Monthly"). Archived cycles are not accepted.
  const cycleKeys = new Map<string, number>();
  for (const c of cycles) {
    if (c.archivedAt != null) continue;
    for (const k of [c.code, c.name]) {
      const kk = up(k ?? '');
      if (kk) cycleKeys.set(kk, (cycleKeys.get(kk) ?? 0) + 1);
    }
  }

  const headerKeys = records.length ? Object.keys(records[0]) : [];
  const missingColumns = missingHistoryColumns(headerKeys);

  const issues: HistoryIssue[] = [];
  const lines: ParsedLine[] = [];
  /** Lines that failed on their own, keyed by month, so the month can be held whole. */
  const failedByMonth = new Map<string, number>();
  const seenKeys = new Set<string>();
  let duplicates = 0;
  let blankLines = 0;

  records.forEach((rec, idx) => {
    // Excel Row No.: the header occupies row 1, so the first data record is row 2.
    const rowNum = idx + 2;
    const employeeNo = readHistoryField(rec, 'employee_no');
    const rawPeriod = readHistoryField(rec, 'payroll_period');
    const cycle = readHistoryField(rec, 'payroll_cycle');
    const doeCode = readHistoryField(rec, 'doe_code');
    const companyCode = readHistoryField(rec, 'company_code');
    const rawAmount = readHistoryField(rec, 'amount');
    const rawOverride = readHistoryField(rec, 'override?');
    const ref = { rowNum, employeeNo, rawPeriod, doeCode };

    // "No completely blank data rows should be imported" — skipped in silence, not reported as an error.
    if (!employeeNo && !rawPeriod && !cycle && !doeCode && !companyCode && !rawAmount && !rawOverride) {
      blankLines += 1;
      return;
    }

    const before = issues.length;
    const missing = ([
      ['employee_no', employeeNo, 'Employee No'],
      ['payroll_period', rawPeriod, 'Payroll Period'],
      ['payroll_cycle', cycle, 'Payroll Cycle'],
      ['doe_code', doeCode, 'DOE Code'],
      ['company_code', companyCode, 'Company Code'],
      ['amount', rawAmount, 'Amount'],
    ] as const).filter(([, v]) => v === '');
    for (const [, , label] of missing) {
      issues.push(issue(ref, 'Missing mandatory field', `${label} is required and was left blank`));
    }

    // Period — converted, never coerced.
    const period = rawPeriod ? toIsoPeriod(rawPeriod) : null;
    if (rawPeriod && !period) {
      issues.push(
        issue(ref, 'Invalid Payroll Period', `Payroll Period must be YYYYMM with a month of 01–12 (got “${rawPeriod}”)`),
      );
    }

    // Company Code — unknown or ambiguous is a hard error, and it must be the company being imported into.
    if (companyCode) {
      const hits = companyKeys.get(up(companyCode)) ?? [];
      if (hits.length === 0) {
        issues.push(issue(ref, 'Invalid Company Code', `No company matches Company Code “${companyCode}”`));
      } else if (hits.length > 1) {
        issues.push(
          issue(ref, 'Invalid Company Code', `Company Code “${companyCode}” matches ${hits.length} companies — make it unique before importing`),
        );
      } else if (hits[0] !== companyId) {
        issues.push(
          issue(ref, 'Invalid Company Code', `Company Code “${companyCode}” is not the company selected for this import (${targetCompany?.legalName ?? companyId})`),
        );
      }
    }

    // Employee No — by employee code within the resolved company, effective for the period.
    let employmentId = '';
    if (employeeNo) {
      const hits = employeesByCode.get(up(employeeNo)) ?? [];
      if (hits.length === 0) {
        issues.push(issue(ref, 'Invalid Employee No', `Employee does not exist in Employee Master for this company`));
      } else if (hits.length > 1) {
        issues.push(issue(ref, 'Invalid Employee No', `Employee No “${employeeNo}” matches ${hits.length} employments`));
      } else if (period) {
        const { first, last } = periodBounds(period);
        const emp = hits[0];
        if (emp.hiredOn > last || (emp.terminatedOn != null && emp.terminatedOn < first)) {
          issues.push(
            issue(ref, 'Invalid Employee No', `Employee was not employed during ${period} (joined ${emp.hiredOn}${emp.terminatedOn ? `, left ${emp.terminatedOn}` : ''})`),
          );
        } else {
          employmentId = emp.employmentId;
        }
      } else {
        employmentId = hits[0].employmentId;
      }
    }

    // Payroll Cycle.
    if (cycle) {
      const hits = cycleKeys.get(up(cycle)) ?? 0;
      if (hits === 0) {
        issues.push(
          issue(ref, 'Invalid Payroll Cycle', `No active payroll cycle has the code or name “${cycle}” — add it under Admin → Payroll Cycle`),
        );
      } else if (hits > 1) {
        issues.push(issue(ref, 'Invalid Payroll Cycle', `“${cycle}” matches more than one active payroll cycle`));
      }
    }

    // DOE Code.
    const entry = doeCode ? codes.get(up(doeCode)) : undefined;
    if (doeCode && !entry) {
      issues.push(issue(ref, 'Invalid DOE Code', `“${doeCode}” is not a known earning, deduction or statutory code`));
    }

    // Amount.
    const amount = rawAmount ? money(rawAmount) : null;
    if (rawAmount && amount == null) {
      issues.push(issue(ref, 'Invalid Amount', `Amount “${rawAmount}” is not a number (digits and one decimal point only)`));
    }

    // Override? — validated, never honoured as a replace (see the file header).
    let override = true;
    if (rawOverride !== '') {
      if (rawOverride === '1') override = true;
      else if (rawOverride === '0') override = false;
      else issues.push(issue(ref, 'Invalid Override', `Override? must be 1 or 0 (got “${rawOverride}”)`));
    }

    // Duplicate on the reporter's five-part key.
    const dupKey = [up(employeeNo), rawPeriod, up(cycle), up(doeCode), up(companyCode)].join('|');
    if (employeeNo && rawPeriod && cycle && doeCode && companyCode) {
      if (seenKeys.has(dupKey)) {
        duplicates += 1;
        issues.push(
          issue(ref, 'Duplicate record', `The same Employee No, Payroll Period, Payroll Cycle, DOE Code and Company Code already appears earlier in this file`),
        );
      } else {
        seenKeys.add(dupKey);
      }
    }

    const monthKey = `${up(employeeNo)}|${period ?? rawPeriod}`;
    if (issues.length > before || !entry || amount == null || !employmentId || !period) {
      failedByMonth.set(monthKey, (failedByMonth.get(monthKey) ?? 0) + 1);
      return;
    }

    lines.push({
      rowNum,
      employeeNo,
      period,
      rawPeriod,
      cycle,
      doeCode,
      companyCode,
      amount,
      override,
      destination: entry.destination,
    });
  });

  // ── Fold to employee-months. The unit is (Employee No, Payroll Period): payslip_batch_employment_uq
  // allows exactly one payslip per employment per batch, and a month's statutory figures are the MONTH's
  // figures regardless of which cycle each line came in under. Cycle stays a validated, recorded column
  // and part of the duplicate key, which is what the reporter specified it for.
  type Bucket = {
    key: string;
    employeeNo: string;
    period: string;
    rawPeriod: string;
    cycles: string[];
    companyCodes: string[];
    rowNums: number[];
    lines: ParsedLine[];
    totals: Record<PayrollImportDestination, number>;
  };
  const zeroTotals = () =>
    Object.fromEntries(PAYROLL_IMPORT_DESTINATIONS.map((d) => [d, 0])) as Record<PayrollImportDestination, number>;
  const buckets = new Map<string, Bucket>();
  for (const l of lines) {
    const key = `${up(l.employeeNo)}|${l.period}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        key,
        employeeNo: l.employeeNo,
        period: l.period,
        rawPeriod: l.rawPeriod,
        cycles: [],
        companyCodes: [],
        rowNums: [],
        lines: [],
        totals: zeroTotals(),
      };
      buckets.set(key, b);
    }
    if (!b.cycles.includes(l.cycle)) b.cycles.push(l.cycle);
    if (!b.companyCodes.includes(l.companyCode)) b.companyCodes.push(l.companyCode);
    b.rowNums.push(l.rowNum);
    b.lines.push(l);
    b.totals[l.destination] = round2(b.totals[l.destination] + l.amount);
  }

  // ── Which periods are already occupied. Read once for every period the file mentions.
  const periods = [...new Set([...buckets.values()].map((b) => b.period))];
  const occupiedPeriods = await withTenant(ctx, async (tx) => {
    if (periods.length === 0) return new Set<string>();
    const rows = await tx
      .select({ period: payrollBatch.payPeriod })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, companyId), inArray(payrollBatch.payPeriod, periods)));
    return new Set(rows.map((r) => r.period));
  });

  // Tax numbers, for the CP39 readiness warning.
  const taxByCode = new Map<string, string | null>();
  for (const e of employees) if (e.code) taxByCode.set(up(e.code), e.taxNumber ?? null);
  const employmentByCode = new Map<string, string>();
  for (const e of employees) if (e.code) employmentByCode.set(up(e.code), e.employmentId);

  const months: ResolvedMonth[] = [];
  const monthSummaries: HistoryMonth[] = [];
  let existingMonths = 0;

  for (const b of [...buckets.values()].sort((x, y) => x.rowNums[0] - y.rowNums[0])) {
    const first = b.lines[0];
    const ref = { rowNum: first.rowNum, employeeNo: b.employeeNo, rawPeriod: b.rawPeriod, doeCode: '' };
    const monthIssues: HistoryIssue[] = [];

    const t = b.totals;
    const gross = round2(t.basic + t.allowance + t.overtime + t.bonus);
    // Cash deductions: everything that actually leaves the employee's pay. `lp` is deliberately NOT here
    // — it is the TP1 / approved-deduction RELIEF that reduces the tax computation, not a cash deduction.
    const cashDeductions = round2(
      t.other_deduction + t.epf_employee + t.socso_employee + t.socso_skbbk + t.eis_employee + t.pcb + t.cp38 + t.zakat,
    );
    // ZAKAT HAS TWO ENCODINGS IN THE WILD (audit H#5; ITA 1967 s.6A(3), EA Form C.P.8A Part D):
    //   (a) separate-cash — the dominant MY encoding: zakat really is deducted and the remitted `pcb` is
    //       already net of it, so net = gross − (… + pcb + zakat). This is what we compute by default.
    //   (b) reduce-pcb — zakat folded into the pcb figure and NOT separately deducted from net.
    // Nothing in the file says which one it is. When the file states a NETPAY line we can find out: if it
    // matches (b) rather than (a), the file's own arithmetic is (b) and its stated net is what we store.
    // With no NETPAY line there is nothing to disambiguate and (a) — the dominant encoding — is used.
    const netCash = round2(gross - cashDeductions);
    const netZakatInPcb = round2(netCash + t.zakat);
    const employerCost = round2(gross + t.epf_employer + t.socso_employer + t.eis_employer + t.hrdf);

    // Completeness — an earning-bearing month with no statutory line at all is stopped rather than
    // guessed at. An explicit 0.00 line satisfies it: the point is that somebody stated the figure.
    const hasEarnings = b.lines.some((l) => ['basic', 'allowance', 'overtime', 'bonus'].includes(l.destination));
    const hasStatutory = b.lines.some((l) => STATUTORY_DESTINATIONS.has(l.destination));
    if (hasEarnings && !hasStatutory) {
      monthIssues.push(
        issue(
          ref,
          'Incomplete month',
          `${b.employeeNo} ${b.period} has earnings but no EPF / SOCSO / EIS / tax lines — add them (a figure that really was zero can be entered as 0.00)`,
        ),
      );
    }

    // Cross-check any stated GROSS / NETPAY against the file's own lines. A disagreement is an error:
    // preferring one of the two figures would be exactly the invented arithmetic this importer refuses.
    const statedGross = b.lines.filter((l) => l.destination === 'gross');
    const statedNet = b.lines.filter((l) => l.destination === 'net');
    if (statedGross.length > 0 && Math.abs(t.gross - gross) > MONEY_TOL) {
      monthIssues.push(
        issue(
          { ...ref, rowNum: statedGross[0].rowNum, doeCode: statedGross[0].doeCode },
          'Inconsistent totals',
          `The GROSS line says ${t.gross.toFixed(2)} but the earning lines add up to ${gross.toFixed(2)}`,
        ),
      );
    }
    let net = netCash;
    if (statedNet.length > 0) {
      if (Math.abs(t.net - netCash) <= MONEY_TOL) {
        net = t.net;
      } else if (t.zakat > MONEY_TOL && Math.abs(t.net - netZakatInPcb) <= MONEY_TOL) {
        // The file uses the reduce-pcb zakat convention. Its own arithmetic wins.
        net = t.net;
      } else {
        monthIssues.push(
          issue(
            { ...ref, rowNum: statedNet[0].rowNum, doeCode: statedNet[0].doeCode },
            'Inconsistent totals',
            `The NETPAY line says ${t.net.toFixed(2)} but gross ${gross.toFixed(2)} less deductions ${cashDeductions.toFixed(2)} is ${netCash.toFixed(2)}`,
          ),
        );
      }
    }
    const totalDeductions = round2(gross - net);

    // THE EA PART-B SPLIT CHECK, RESHAPED FOR THE LONG FORMAT.
    //
    // The wide contract warned when `gross > basic` with no allowance/overtime/bonus split, because gross
    // and basic were two independent columns and could disagree. Folding makes that check structurally
    // impossible: gross IS basic + allowance + overtime + bonus, so `gross > basic` with nothing in the
    // other three cannot happen. Carrying it over verbatim would have left a dead branch and no warning.
    //
    // The equivalent risk under the long format is a file that codes everything as BASIC. That lands the
    // whole month in the payslip's basic scalar, and the EA Part B itemisation reads exactly that scalar,
    // so the breakdown collapses just as before — but from inside the file the case is INDISTINGUISHABLE
    // from an employee who genuinely was paid basic pay and nothing else. There is no test that separates
    // them, and inventing one would be exactly the guessing this importer refuses to do.
    //
    // So the check is stated as what it can honestly say: every earning line in this month landed in
    // basic. It fires on the correctly-stated basic-only month too, and that is accepted, because it is a
    // WARNING on a migration screen rather than a block, and the sentence it prints is the one a migrator
    // needs to read once per file. Correctable after import via EA-overwrite of grossSalary / allowances /
    // bonus (core/ea-override.ts).
    const earningLines = b.lines.filter((l) => ['basic', 'allowance', 'overtime', 'bonus'].includes(l.destination));
    const basicLines = earningLines.filter((l) => l.destination === 'basic');
    if (earningLines.length > 0 && basicLines.length === earningLines.length && t.basic > MONEY_TOL) {
      monthIssues.push(
        issue(
          { ...ref, doeCode: basicLines.map((l) => l.doeCode).join(', ') },
          'EA breakdown',
          `${b.employeeNo} ${b.period}: every earning line is coded to basic pay, with no allowance, overtime or bonus line — the EA Part B itemisation will land entirely in “basic”. If any of it was an allowance, code it as one; otherwise nothing to do. Correctable after import via EA-overwrite.`,
          'Warning',
        ),
      );
    }

    // CP39 readiness — a warning, never a block: 21 of the 33 live statutory records have no tax number,
    // so hard-erroring this would block most of a migration.
    if (t.pcb > MONEY_TOL && !taxByCode.get(up(b.employeeNo))) {
      monthIssues.push(
        issue(
          ref,
          'CP39 readiness',
          `${b.employeeNo} has tax deducted but no tax number on file — the month loads, but its CP39 e-Data file cannot be produced until the tax number is filled in`,
          'Warning',
        ),
      );
    }

    // The double-count guard. NOTHING is written for an occupied period, whatever Override? said.
    const existing = occupiedPeriods.has(b.period);
    if (existing) {
      existingMonths += 1;
      for (const l of b.lines) {
        monthIssues.push(
          issue(
            { rowNum: l.rowNum, employeeNo: l.employeeNo, rawPeriod: l.rawPeriod, doeCode: l.doeCode },
            'Existing record',
            `${b.period} already has payroll for this company — the existing record is kept and nothing is written. Override cannot replace it: a second load would be added to the first and submitted as double, and a loaded month cannot be deleted.`,
            'Needs action',
          ),
        );
      }
    }

    const lineFailures = failedByMonth.get(b.key) ?? 0;
    const hardErrors = monthIssues.filter((i) => i.status === 'Failed').length;
    const ok = hardErrors === 0 && lineFailures === 0 && !existing;

    // A month with a failing line is held WHOLE — half a month would understate the year-end statement.
    if (lineFailures > 0 && hardErrors === 0 && !existing) {
      monthIssues.push(
        issue(
          ref,
          'Incomplete month',
          `${b.employeeNo} ${b.period} is held back: ${lineFailures} of its ${lineFailures + b.lines.length} lines could not be read. Correct them and upload the month again.`,
        ),
      );
    }

    issues.push(...monthIssues);

    const summary: HistoryMonth = {
      key: b.key,
      employeeNo: b.employeeNo,
      period: b.period,
      cycle: b.cycles.join(', '),
      companyCode: b.companyCodes.join(', '),
      rowNums: b.rowNums,
      lineCount: b.lines.length,
      ok,
      existing,
      gross,
      net,
      errorCount: monthIssues.filter((i) => i.status !== 'Warning').length,
      warningCount: monthIssues.filter((i) => i.status === 'Warning').length,
    };
    monthSummaries.push(summary);

    if (!ok) continue;
    months.push({
      month: summary,
      employmentId: employmentByCode.get(up(b.employeeNo))!,
      period: b.period,
      basicSalary: t.basic,
      allowance: t.allowance,
      overtimePay: t.overtime,
      bonus: t.bonus,
      grossPay: gross,
      otherDeductions: t.other_deduction,
      totalDeductions,
      netPay: net,
      employerCost,
      statutory: {
        epfEmployee: t.epf_employee,
        epfEmployer: t.epf_employer,
        socsoEmployee: t.socso_employee,
        socsoEmployer: t.socso_employer,
        socsoSkbbk: t.socso_skbbk,
        eisEmployee: t.eis_employee,
        eisEmployer: t.eis_employer,
        pcb: t.pcb,
        lp: t.lp,
        zakat: t.zakat,
        hrdf: t.hrdf,
        version: statutoryVersion,
        ...(t.cp38 > 0 ? { cp38: t.cp38 } : {}),
      },
    });
  }

  const total = records.length - blankLines;
  const valid = months.reduce((n, m) => n + m.month.lineCount, 0);
  const preview: HistoryImportPreview = {
    companyId,
    total,
    valid,
    invalid: total - valid,
    duplicates,
    existingMonths,
    months: monthSummaries,
    issues: issues.sort((a, b2) => a.rowNum - b2.rowNum),
    missingColumns,
  };
  return { preview, months, statutoryVersion };
}

/** Dry run: validate the file against the company's master data; writes nothing. */
export async function validatePayrollHistoryImport(
  ctx: SessionContext,
  p: { companyId: string; records: PayrollHistoryRecord[] },
): Promise<HistoryImportPreview> {
  const { preview } = await analyze(ctx, p.companyId, p.records);
  return preview;
}

/**
 * Commit the importable employee-months. Re-analyzes server-side (never trusts a client preview), groups
 * them by period, and writes EACH period in its OWN transaction (a shared tx aborts on first failed
 * insert). Each period: find-or-create pay_period → insert draft batch (run_type='adjustment') → insert
 * one payslip per employee-month → UPDATE batch counters → UPDATE batch status='closed' → UPDATE
 * pay_period status='closed'. A failing period collects into the issue list without stranding the rest.
 */
export async function commitPayrollHistoryImport(
  ctx: SessionContext,
  p: { companyId: string; records: PayrollHistoryRecord[] },
): Promise<HistoryImportResult> {
  const { preview, months, statutoryVersion } = await analyze(ctx, p.companyId, p.records);
  const issues = [...preview.issues];
  let imported = 0;
  let importedMonths = 0;

  const byPeriod = new Map<string, ResolvedMonth[]>();
  for (const m of months) {
    const arr = byPeriod.get(m.period) ?? [];
    arr.push(m);
    byPeriod.set(m.period, arr);
  }

  for (const [period, rows] of byPeriod) {
    try {
      await withTenant(ctx, async (tx) => {
        // Find-or-create the pay_period parent (mirror createBatch). Status starts 'open' here; it is
        // flipped to 'closed' below within the same tx.
        const [existingPeriod] = await tx
          .select({ id: payPeriod.id })
          .from(payPeriod)
          .where(and(eq(payPeriod.companyId, p.companyId), eq(payPeriod.period, period)))
          .limit(1);
        let periodId = existingPeriod?.id;
        if (!periodId) {
          const [created] = await tx
            .insert(payPeriod)
            .values({ tenantId: ctx.tenantId, companyId: p.companyId, period, status: 'open', statutoryVersion })
            .returning({ id: payPeriod.id });
          periodId = created.id;
        }

        // Insert the historical batch as a DRAFT adjustment run (so counters are backfillable, and it
        // never collides with payroll_batch_one_regular_uq).
        const [batch] = await tx
          .insert(payrollBatch)
          .values({
            tenantId: ctx.tenantId,
            companyId: p.companyId,
            payPeriodId: periodId,
            runSeq: 1,
            runType: 'adjustment',
            payPeriod: period,
            batchDate: `${period}-28`,
            status: 'draft',
            remarks: 'Imported payroll history',
          })
          .returning({ id: payrollBatch.id });

        const totals = { gross: 0, net: 0, epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0, socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0 };
        for (const r of rows) {
          await tx.insert(payslip).values({
            tenantId: ctx.tenantId,
            batchId: batch.id,
            employmentId: r.employmentId,
            basicSalary: r.basicSalary.toFixed(2),
            allowance: r.allowance.toFixed(2),
            overtimePay: r.overtimePay.toFixed(2),
            bonus: r.bonus.toFixed(2),
            grossPay: r.grossPay.toFixed(2),
            statutory: r.statutory,
            otherDeductions: r.otherDeductions.toFixed(2),
            totalDeductions: r.totalDeductions.toFixed(2),
            netPay: r.netPay.toFixed(2),
            employerCost: r.employerCost.toFixed(2),
          });
          totals.gross = round2(totals.gross + r.grossPay);
          totals.net = round2(totals.net + r.netPay);
          totals.epfEmployee = round2(totals.epfEmployee + r.statutory.epfEmployee);
          totals.epfEmployer = round2(totals.epfEmployer + r.statutory.epfEmployer);
          totals.socsoEmployee = round2(totals.socsoEmployee + r.statutory.socsoEmployee);
          totals.socsoEmployer = round2(totals.socsoEmployer + r.statutory.socsoEmployer);
          totals.eisEmployee = round2(totals.eisEmployee + r.statutory.eisEmployee);
          totals.eisEmployer = round2(totals.eisEmployer + r.statutory.eisEmployer);
          totals.pcb = round2(totals.pcb + r.statutory.pcb);
        }

        // Backfill counters while still draft-and-mutable (the 0011 trigger only fires once closed).
        await tx
          .update(payrollBatch)
          .set({ employeeCount: rows.length, totals })
          .where(eq(payrollBatch.id, batch.id));
        // Then flip batch + period to closed (immutability + out of the live draft→process→close UI).
        await tx.update(payrollBatch).set({ status: 'closed' }).where(eq(payrollBatch.id, batch.id));
        await tx.update(payPeriod).set({ status: 'closed' }).where(eq(payPeriod.id, periodId));
      });
      for (const r of rows) imported += r.month.lineCount;
      importedMonths += rows.length;
    } catch (e) {
      // The whole period failed — none of its months were written.
      for (const r of rows) {
        issues.push({
          rowNum: r.month.rowNums[0],
          employeeNo: r.month.employeeNo,
          period: r.month.period,
          doeCode: '',
          type: 'Incomplete month',
          description: `${period} could not be written: ${(e as Error).message}`,
          status: 'Failed',
        });
      }
    }
  }

  // Substrate: one completion event summarizes the import (mirrors commitEmployeeImport). Per-payslip /
  // per-batch inserts are intentionally NOT individually evented — they're the body of this one
  // import flow, summarized here (documented skip, consistent with the employee importer).
  await withTenant(ctx, (tx) =>
    appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-history-import',
      aggregateId: p.companyId,
      eventType: 'payroll-history-import.completed',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId,
        total: preview.total,
        imported,
        importedMonths,
        existing: preview.existingMonths,
        duplicates: preview.duplicates,
        periods: [...byPeriod.keys()],
      },
    }),
  );

  return {
    companyId: p.companyId,
    total: preview.total,
    valid: preview.valid,
    invalid: preview.invalid,
    imported,
    importedMonths,
    // Always 0 — an occupied month is never overwritten. See the type comment and the file header.
    updated: 0,
    duplicates: preview.duplicates,
    existing: preview.existingMonths,
    failed: preview.total - imported,
    issues: issues.sort((a, b) => a.rowNum - b.rowNum),
  };
}
