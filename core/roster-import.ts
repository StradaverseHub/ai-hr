/**
 * Upload Shift Roster (item 23390097) — analyze-then-commit for a MONTH GRID file.
 *
 * The file is the month itself, not a list: a header row of ISO dates, one row per employee. That is
 * deliberate — it is the same shape as the screen and the same shape the Download Template hands out, so
 * "download, type the codes, send it back" is one artefact end to end.
 *
 * It follows app/(app)/attendance/import's contract exactly: `analyzeRosterImport({dryRun:true})` returns a
 * preview and writes nothing; the same call with `dryRun:false` re-derives everything server-side and
 * writes. The client preview is never trusted — a commit repeats the whole analysis.
 *
 * THE FOUR RULES THE REPORTER ASKED FOR, and where each is enforced:
 *   1. Nothing outside the chosen month is ever touched — a date column outside `month` is REJECTED with
 *      that reason and never reaches a write (`out_of_month`).
 *   2. An unknown or archived shift code is rejected with the reason, never quietly created — codes are
 *      matched case-insensitively against the tenant's shift library, archived ones separately so the
 *      message can say WHY (`unknown_code` / `archived_code`).
 *   3. An employee number that does not resolve to an active, in-scope employment is rejected — the row,
 *      once, not once per date (`unknown_employee`). Scope is whatever listEmployees returns, which is
 *      already RLS-fenced, so a supervisor cannot upload for somebody else's team.
 *   4. Every rejection is reported with its line number before anything is saved.
 *
 * CELL VOCABULARY (also printed on the screen and in the template's Notes sheet):
 *   blank      leave the date exactly as it is
 *   (CODE)     leave as-is — the bracket is how the EXPORT prints a date that is only covered by the
 *              person's usual shift, so an exported month can be re-uploaded without silently turning
 *              every ghosted day into a hard-rostered one
 *   RD         an explicit rostered rest day
 *   OFF | -    remove any roster entry for that date (it goes back to following the usual shift)
 *   any code   roster that shift on that date
 */
import { parseCsvRecords } from '../lib/csv';
import { isIsoDate, monthOf } from '../lib/roster-month';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockLeaveDependenciesTx,lockLeaveDependencyReadConfigurationTx,LeaveDependencyUnavailable} from '../packs/leave/service';
import { listEmployees } from './read';
import {
  assertRosterDatesWritable,
  assignShiftBulk,
  clearRoster,
  listShiftsForTenant,
  recordRosterUpload,
  rosterForRange,
  setRestDayBulk,
} from './roster';

/** Why a line (or one cell of it) could not be accepted. */
export type RosterImportRejectReason =
  | 'unknown_employee'
  | 'missing_employee_no'
  | 'out_of_month'
  | 'bad_date_column'
  | 'unknown_code'
  | 'archived_code'
  | 'duplicate';

export type RosterImportReject = {
  /** 1-based line number in the uploaded file, counting the header as line 1. */
  row: number;
  employeeCode: string;
  /** The date column the rejection belongs to, or null for a whole-row rejection. */
  date: string | null;
  /** What was in the cell (empty for a whole-row rejection). */
  value: string;
  reason: RosterImportRejectReason;
};

export type RosterImportResult = {
  month: string;
  fileName: string;
  /** Data rows read (header excluded). */
  rowsRead: number;
  /** Distinct employees the file resolved to. */
  employees: number;
  /** Date cells that carried an instruction (blank and (bracketed) cells are not instructions). */
  daysRead: number;
  /** Cells that passed every check. */
  valid: number;
  /** Cells discarded because the same (employee, date) appeared earlier in the file. */
  duplicates: number;
  /** Cells whose instruction differs from what is already stored — the number a commit actually writes. */
  changed: number;
  rejects: RosterImportReject[];
  /** False for a dry run. */
  committed: boolean;
};

/** One accepted instruction. `brush` matches the grid's vocabulary: a shift id, 'rest', or 'clear'. */
type Cell = { sourceRow:number; employmentId: string; employeeCode: string; date: string; brush: string };
type RosterImportInput={csvText:string;month:string;companyId:string;fileName?:string;dryRun:boolean};
type RosterImportPlan={result:RosterImportResult;changes:Cell[];accepted:Cell[]};

const CLEAR_TOKENS = new Set(['off', '-', '—', 'clear']);
const REST_TOKENS = new Set(['rd', 'rest']);
/** `(MB28)` — how the export prints a day covered only by the usual shift. Means "leave as-is". */
const isGhostCell = (v: string) => v.startsWith('(') && v.endsWith(')');
const norm = (v: string) => v.trim().toLowerCase();
/** Shape AND validity: `2026-02-31` has the right shape and is not a day. */
const isRealIsoDate = (v: string): boolean =>
  isIsoDate(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export const ROSTER_IMPORT_EMPLOYEE_COLUMNS = ['employee_no', 'employee_number', 'employee_code', 'staff_id'] as const;

/**
 * Read the month grid, check every cell, and (unless `dryRun`) write the accepted ones.
 *
 * `month` is the month the ADMIN chose on screen, not something the file can override — that is what
 * makes rule 1 enforceable rather than advisory.
 */
export async function analyzeRosterImport(ctx:SessionContext,p:RosterImportInput):Promise<RosterImportResult>{
  p={...p};ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  // Read-only nomination/preview under configuration ownership. Each actual group below replays
  // this SAME original raw file after its complete subject ownership; no client preview is trusted.
  const plan=await withTenant(ctx,async tx=>{
    await lockAccessConfigurationTx(tx,ctx.tenantId);await lockLeaveDependencyReadConfigurationTx(tx,ctx.tenantId);
    return planRosterImport(ctx,p,tx);
  });
  if(p.dryRun)return plan.result;
  assertRosterDatesWritable(ctx,[...new Set(plan.changes.map(cell=>cell.date))]);
  await commitRosterCells(ctx,plan.changes,p.companyId,plan,p);
  await recordRosterUpload(ctx,{companyId:p.companyId,month:p.month,fileName:p.fileName??'',employees:plan.result.employees,
    rowsRead:plan.result.rowsRead,changed:plan.changes.length,rejected:plan.result.rejects.length});
  return{...plan.result,committed:true};
}

/** One canonical planner for initial nomination and same-Tx actual group revalidation. */
async function planRosterImport(ctx:SessionContext,p:RosterImportInput,existingTx:Tx):Promise<RosterImportPlan>{
  const fileName = p.fileName ?? '';
  const { headers, records } = parseCsvRecords(p.csvText);

  const [employees, allShifts] = await Promise.all([
    listEmployees(ctx, [p.companyId],undefined,existingTx),
    listShiftsForTenant(ctx, { includeArchived: true },existingTx),
  ]);

  // Employee number → active employment. Case-insensitive: HR types "a0001" as often as "A0001".
  const byCode = new Map<string, { employmentId: string; code: string }>();
  for (const e of employees) {
    if (e.terminatedOn || !e.employeeCode) continue;
    const k = norm(e.employeeCode);
    if (!byCode.has(k)) byCode.set(k, { employmentId: e.employmentId, code: e.employeeCode });
  }

  const liveShift = new Map<string, string>(); // lower(code) → shift id
  const archivedCodes = new Set<string>();
  for (const s of allShifts) {
    if (!s.code) continue; // a null-coded shift has nothing for a cell to match; the grid prints its name
    const k = norm(s.code);
    if (s.archivedAt) archivedCodes.add(k);
    else liveShift.set(k, s.id);
  }

  // Which headers are date columns. A header that LOOKS like a date but is not a real one (2026-02-31,
  // 2026-13-01 — both shapes a hand-edited header row produces) is kept separately and reported once per
  // row that carries a value under it, because the admin needs the line number to find it.
  const dateColByHeader = new Map<string, string>();
  const badDateHeaders: string[] = [];
  for (const h of headers) {
    if (!/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(h)) continue;
    const iso = h.replace(/\//g, '-');
    if (isRealIsoDate(iso)) dateColByHeader.set(h, iso);
    else badDateHeaders.push(h);
  }

  const rejects: RosterImportReject[] = [];
  const accepted: Cell[] = [];
  const seen = new Set<string>();
  const resolvedEmployments = new Set<string>();
  let daysRead = 0;
  let duplicates = 0;

  records.forEach((rec, i) => {
    const line = i + 2; // header is line 1
    const rawCode = (ROSTER_IMPORT_EMPLOYEE_COLUMNS.map((c) => rec[c]).find((v) => v && v.trim() !== '') ?? '').trim();
    // A wholly blank row is padding from a spreadsheet, not a mistake — skip it silently.
    const hasAnyValue = Object.values(rec).some((v) => v && v.trim() !== '');
    if (!hasAnyValue) return;
    if (rawCode === '') {
      rejects.push({ row: line, employeeCode: '', date: null, value: '', reason: 'missing_employee_no' });
      return;
    }
    const emp = byCode.get(norm(rawCode));
    if (!emp) {
      rejects.push({ row: line, employeeCode: rawCode, date: null, value: '', reason: 'unknown_employee' });
      return;
    }
    resolvedEmployments.add(emp.employmentId);

    for (const header of badDateHeaders) {
      const raw = (rec[header] ?? '').trim();
      if (raw === '' || isGhostCell(raw)) continue;
      daysRead += 1;
      rejects.push({ row: line, employeeCode: rawCode, date: header, value: raw, reason: 'bad_date_column' });
    }
    for (const [header, iso] of dateColByHeader) {
      const raw = (rec[header] ?? '').trim();
      if (raw === '' || isGhostCell(raw)) continue; // "leave as-is" — not an instruction, not a read day
      daysRead += 1;
      if (monthOf(iso) !== p.month) {
        // Rule 1. Reported, never written — this is the "must not overwrite outside the month" promise.
        rejects.push({ row: line, employeeCode: rawCode, date: iso, value: raw, reason: 'out_of_month' });
        continue;
      }
      const key = `${emp.employmentId}|${iso}`;
      if (seen.has(key)) {
        duplicates += 1;
        rejects.push({ row: line, employeeCode: rawCode, date: iso, value: raw, reason: 'duplicate' });
        continue;
      }
      const token = norm(raw);
      let brush: string;
      if (REST_TOKENS.has(token)) brush = 'rest';
      else if (CLEAR_TOKENS.has(token)) brush = 'clear';
      else {
        const shiftId = liveShift.get(token);
        if (!shiftId) {
          rejects.push({
            row: line,
            employeeCode: rawCode,
            date: iso,
            value: raw,
            reason: archivedCodes.has(token) ? 'archived_code' : 'unknown_code',
          });
          continue;
        }
        brush = shiftId;
      }
      seen.add(key);
      accepted.push({ sourceRow:line, employmentId: emp.employmentId, employeeCode: emp.code, date: iso, brush });
    }
  });

  // What would actually CHANGE. Compared against the stored rows for the month so the preview can say
  // "3 of 620 cells differ" rather than implying 620 writes.
  const empIds = [...resolvedEmployments];
  const existing = new Map<string, string>(); // key → brush-equivalent of the stored row
  if (empIds.length > 0 && accepted.length > 0) {
    const dates = accepted.map((c) => c.date).sort();
    for (const r of await rosterForRange(ctx, { employmentIds: empIds, from: dates[0], to: dates[dates.length - 1] },existingTx)) {
      existing.set(`${r.employmentId}|${r.shiftDate}`, r.isRestDay ? 'rest' : (r.shiftId ?? 'clear'));
    }
  }
  const changes = accepted.filter((c) => {
    const cur = existing.get(`${c.employmentId}|${c.date}`) ?? 'clear';
    return cur !== c.brush;
  });

  const result: RosterImportResult = {
    month: p.month,
    fileName,
    rowsRead: records.filter((rec) => Object.values(rec).some((v) => v && v.trim() !== '')).length,
    employees: resolvedEmployments.size,
    daysRead,
    valid: accepted.length,
    duplicates,
    changed: changes.length,
    rejects,
    committed: false,
  };
  return{result,changes,accepted};
}

/**
 * Write the accepted cells, grouped by target.
 *
 * Shifts and rest days go through the existing idempotent bulk upserts. They take a CROSS PRODUCT of
 * employees × dates, so employees are grouped by the exact set of dates they share — a template filled
 * in the ordinary way collapses to a handful of calls, and the worst case (everyone different) is one
 * call each, never one per cell. Clears have no bulk primitive and are looped; each emits its own
 * event carrying the row it removed, which is what an audit reader wants from a deletion anyway.
 */
async function commitRosterCells(ctx: SessionContext, cells: Cell[], companyId: string, nomination:RosterImportPlan,input:RosterImportInput): Promise<void> {
  const sourceKey=(cell:Cell)=>`${cell.sourceRow}|${cell.date}`;
  const image=(rows:Cell[])=>JSON.stringify(rows.slice().sort((a,b)=>a.sourceRow-b.sourceRow||a.date.localeCompare(b.date)));
  const writeGroup=async(group:Cell[],write:(tx:Tx)=>Promise<unknown>)=>withTenant(ctx,async tx=>{
    const ids=[...new Set(group.map(cell=>cell.employmentId))].sort();
    await lockAccessConfigurationTx(tx,ctx.tenantId);await lockLeaveDependencyReadConfigurationTx(tx,ctx.tenantId);
    await lockLeaveDependenciesTx(tx,ctx.tenantId,ids);
    const fresh=await planRosterImport(ctx,input,tx),keys=new Set(group.map(sourceKey));
    const expected=nomination.accepted.filter(cell=>keys.has(sourceKey(cell)));
    // Immutable source-row identity prevents a fresh code lookup from silently targeting another
    // employment or shift. A newly discovered subject refuses; never acquire a late reverse-order key.
    if(image(expected)!==image(fresh.accepted.filter(cell=>keys.has(sourceKey(cell))))
      ||image(group)!==image(fresh.changes.filter(cell=>keys.has(sourceKey(cell)))))throw new LeaveDependencyUnavailable();
    return write(tx);
  });
  const byTarget = new Map<string, Map<string, string[]>>(); // brush → employmentId → dates
  for (const c of cells) {
    if (c.brush === 'clear') continue;
    let perEmp = byTarget.get(c.brush);
    if (!perEmp) byTarget.set(c.brush, (perEmp = new Map()));
    const list = perEmp.get(c.employmentId);
    if (list) list.push(c.date);
    else perEmp.set(c.employmentId, [c.date]);
  }
  for (const [brush, perEmp] of byTarget) {
    // employees sharing an identical date-set are written in one call
    const bySignature = new Map<string, { employmentIds: string[]; dates: string[] }>();
    for (const [employmentId, dates] of perEmp) {
      const sorted = [...dates].sort();
      const sig = sorted.join(',');
      const g = bySignature.get(sig);
      if (g) g.employmentIds.push(employmentId);
      else bySignature.set(sig, { employmentIds: [employmentId], dates: sorted });
    }
    for (const { employmentIds, dates } of bySignature.values()) {
      const group=cells.filter(cell=>cell.brush===brush&&employmentIds.includes(cell.employmentId)&&dates.includes(cell.date));
      await writeGroup(group,tx=>brush==='rest'
        ?setRestDayBulk(ctx,{employmentIds,shiftDates:dates,anchorId:companyId},tx)
        :assignShiftBulk(ctx,{employmentIds,shiftDates:dates,shiftId:brush},tx));
    }
  }
  for (const c of cells) {
    if (c.brush === 'clear') await writeGroup([c],tx=>clearRoster(ctx, { employmentId: c.employmentId, shiftDate: c.date },tx));
  }
}
