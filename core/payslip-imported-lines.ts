import { payslipAbsenceLines, type PayslipAbsenceLines } from './payslip-absence-lines';
/**
 * b240c0ff — THE PAY ITEM LINES AN IMPORTED PAYROLL-HISTORY MONTH KEEPS, and how a payslip surface reads them.
 *
 * The history import (core/payroll-history-import.ts `importedComponentLines`) stamps the file's own pay
 * item lines on the payslip and its revision snapshot as `statutory.importedLines`, in exactly the kernel's
 * `componentLines` shape ({code, name, amount, buckets}).
 *
 * WHY A KEY OF ITS OWN, NOT `componentLines`. `componentLines` is EVIDENCE as well as display: the EA
 * pay-item → box routing and its completeness test (localization/my/ea-routing.ts), the payroll comparison
 * report and the "is this pay item in use" check all read it. Imported history has never been EA routing
 * evidence and the approved plan forbids moving a single EA or statutory figure, so the imported lines are
 * kept where only the DISPLAY readers below look. Kernel runs never carry the key, so nothing about how an
 * ordinary payroll run renders can change through this file.
 *
 * Pure and DB-free (client-safe), like core/payslip-earning-lines.ts beside it.
 */
import {
  groupNamedPayItemLines,
  payItemLinesForBuckets,
  payItemLinesReconcile,
  storedComponentLines,
  restorePayItemQuantities,
  type PayslipQuantitySource,
  type NamedPayItemLine,
  type StoredComponentLine,
} from './payslip-earning-lines';

/** The imported pay item lines on a payslip, or [] (every kernel run, and every month imported before this). */
export function importedPayItemLines(statutory: unknown): StoredComponentLine[] {
  const st = (statutory ?? {}) as { importedLines?: unknown };
  return Array.isArray(st.importedLines) ? (st.importedLines as StoredComponentLine[]) : [];
}

/** 289634a6 — one imported Non-Payable pay item (a BIK, a VOLA) as an imported month saved it. */
export type ImportedNonPayableLine = {
  code: string;
  name: string;
  amount: number;
  /** Always true: the import only routes a pay item marked Non-Payable here, so the shared filter
   *  (`isNonPayableRecordLine`) and the name rule (`recordLineIdentity`) read it as the run's own stamp. */
  nonPayable: true;
  /** The pay item's "Subject to PCB" setting AS THE IMPORT STAMPED IT (`importedTaxBasis.settings`), never
   *  today's catalogue. `null` when the month saved no stamped setting for the item. */
  countsForPcb: boolean | null;
  imported: true;
};

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const codeKey = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : '');
const cents = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * 289634a6 — THE NON-PAYABLE PAY ITEMS AN IMPORTED PAYROLL-HISTORY MONTH SAVED, for display only.
 *
 * The history import routes a Non-Payable pay item (BKCAR benefit-in-kind car, BKDRV driver) to its own
 * `noncash` destination: it is never in gross, net or any cash figure, and it is never written to
 * `recordLines` (the kernel's run-time record). It is saved in two places on the imported month, both owned
 * by the import: `statutory.historyMaintenance.items` (the effective item totals after every listed update)
 * and `statutory.importedTaxBasis.lines` (the tax input the import stamped, with the pay item settings it
 * used). Every Transaction View reader only looked at `recordLines`, so these items were saved and counted
 * for PCB but shown nowhere.
 *
 * Read order: the effective maintenance items first (they reflect every later update), then the stamped tax
 * lines for a month imported before maintenance existed. Repeated rows of one code are added in cents. The
 * PCB marker comes from the setting the import stamped. A code the run's own `recordLines` already lists as
 * non-payable is left out, so a line can never be shown twice. Nothing here changes a figure.
 */
export function importedNonPayableLines(statutory: unknown): ImportedNonPayableLine[] {
  const st = objectOf(statutory);
  if (!st) return [];
  const stamp = objectOf(st.importedTaxBasis);
  const rawSettings: unknown = stamp ? stamp.settings : undefined;
  const settings = (Array.isArray(rawSettings) ? rawSettings : []).map(objectOf).filter((s): s is Record<string, unknown> => s !== null);
  const settingById = (id: unknown) => (typeof id === 'string' ? settings.find((s) => s.id === id) : undefined);
  const settingByCode = (code: string) => settings.find((s) => codeKey(s.code) === code);
  const pcbOf = (setting: Record<string, unknown> | undefined) => {
    const included: unknown = setting ? setting.includedInPcb : undefined;
    return typeof included === 'boolean' ? included : null;
  };
  const nameOf = (setting: Record<string, unknown> | undefined) => {
    const name: unknown = setting ? setting.name : undefined;
    return typeof name === 'string' ? name : '';
  };

  const out = new Map<string, { code: string; name: string; cents: number; countsForPcb: boolean | null }>();
  const add = (code: string, name: string, amount: number, countsForPcb: boolean | null) => {
    const key = codeKey(code);
    if (!key) return;
    const prior = out.get(key);
    if (prior) {
      prior.cents += amount;
      if (!prior.name && name) prior.name = name;
      if (prior.countsForPcb === null) prior.countsForPcb = countsForPcb;
    } else out.set(key, { code: code.trim(), name, cents: amount, countsForPcb });
  };

  const maintained = objectOf(st.historyMaintenance);
  if (maintained && maintained.version === 1 && Array.isArray(maintained.items)) {
    for (const raw of maintained.items) {
      const item = objectOf(raw);
      if (!item || (item.direction !== 'noncash' && item.destination !== 'noncash')) continue;
      const code: unknown = item.code, key: unknown = item.key, label: unknown = item.label;
      const amount = cents(item.amount);
      if (typeof code !== 'string' || amount === null) continue;
      const owner = typeof key === 'string' && key.startsWith('component:') ? settingById(key.slice('component:'.length)) : undefined;
      const setting = owner ?? settingByCode(codeKey(code));
      add(code, typeof label === 'string' && label.trim() ? label.trim() : nameOf(setting), amount, pcbOf(setting));
    }
  } else if (stamp && Array.isArray(stamp.lines)) {
    for (const raw of stamp.lines) {
      const line = objectOf(raw);
      if (!line || line.direction !== 'noncash') continue;
      const code: unknown = line.code;
      const amount = cents(line.amount);
      if (typeof code !== 'string' || amount === null) continue;
      const setting = settingById(line.settingId) ?? settingByCode(codeKey(code));
      add(code, nameOf(setting), amount, pcbOf(setting));
    }
  }
  if (!out.size) return [];

  // Shown once: a code the run itself recorded as non-payable stays with that record line.
  const recorded = new Set(
    (Array.isArray(st.recordLines) ? st.recordLines : [])
      .map(objectOf)
      .filter((l): l is Record<string, unknown> => l !== null && l.nonPayable === true)
      .map((l) => codeKey(l.code)),
  );
  return [...out.entries()]
    .filter(([key]) => !recorded.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, l]) => ({ code: l.code, name: l.name, amount: l.cents / 100, nonPayable: true as const, countsForPcb: l.countsForPcb, imported: true as const }));
}

/**
 * 289634a6 — the earlier imported months whose saved Income Tax Correction a payroll calculation found SUPERSEDED by
 * a newer payroll history import, as that calculation stamped them on its own payslip
 * (`statutory.taxBasisSupersededCorrections`, core/payroll.ts). The calculation used the newer imported amounts; the
 * correction itself stays in its own history. One entry per month, oldest first; `replacedAt` is when the superseding
 * import revision was accepted (ISO instant), or null when it was not recorded. [] on every other payslip.
 */
export function payslipSupersededTaxCorrections(statutory: unknown): { period: string; replacedAt: string | null }[] {
  const st = objectOf(statutory);
  const raw: unknown = st ? st.taxBasisSupersededCorrections : undefined;
  if (!Array.isArray(raw)) return [];
  const out: { period: string; replacedAt: string | null }[] = [];
  for (const value of raw) {
    const entry = objectOf(value);
    const period: unknown = entry ? entry.period : undefined, replacedAt: unknown = entry ? entry.replacedAt : undefined;
    if (typeof period !== 'string' || !/^\d{4}-\d{2}$/.test(period) || out.some((seen) => seen.period === period)) continue;
    out.push({ period, replacedAt: typeof replacedAt === 'string' && Number.isFinite(Date.parse(replacedAt)) ? replacedAt : null });
  }
  return out.sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * The lines a payslip SCREEN or DOCUMENT itemises its figures from: the kernel's stamp plus, for imported
 * history, the file's own lines. Display only — never hand this to an EA, statutory or comparison reader.
 */
export function displayComponentLines(statutory: unknown): StoredComponentLine[] {
  const imported = importedPayItemLines(statutory);
  const stored = storedComponentLines(statutory);
  return imported.length ? [...stored, ...imported] : stored;
}

/** Named saved deduction items shared by History, Review and the PDF. Replace a grouped residual only
 * when their stored contributions reconcile; the named absence carve is applied once on every surface. */
export function deductionLinesFor(statutory: unknown, residual: unknown, absence?: PayslipAbsenceLines, sources: readonly PayslipQuantitySource[] = []): NamedPayItemLine[] {
  const lines = payItemLinesForBuckets(displayComponentLines(statutory), ['deduct']);
  // Repeated lines of ONE deduction code print as one row, the way overtime is grouped (2026-11-13: three
  // one-day UNPAID LEAVE transactions were three rows). Grouping is per code and keeps first-seen order, the
  // amounts add exactly (in cents), and a day count is shown only when every grouped line carries days — so
  // the rows reconcile to the residual below exactly as the ungrouped ones did. Unrelated codes stay apart.
  const recorded = restorePayItemQuantities(lines, sources, 'deduction').map(line => {
    if (line.code !== 'ABSENT' || line.detail || line.inputQuantity?.unit !== null) return line;
    return { ...line, inputQuantity: { qty: line.inputQuantity.qty, unit: 'days' as const } };
  });
  const items = groupNamedPayItemLines(recorded);
  if (payItemLinesReconcile(items, residual)) return items;
  // A named stamp can already account for a saved component. Confirm the
  // remaining total before suppressing that component.
  const remaining = [...items];
  for (const [code, named] of [['UPL', absence?.unpaidLeave], ['ABSENT', absence?.absent]] as const) {
    if (!named) continue;
    const at = remaining.findIndex(line => line.code === code && Math.round(line.amount * 100) === Math.round(named.amount * 100));
    if (at >= 0) remaining.splice(at, 1);
  }
  return remaining.length < items.length && payItemLinesReconcile(remaining, residual) ? remaining : [];
}

/** Present a single Absent row when both the stamp and a separate paid
 * ABSENT component contribute to the same slip. The residual was reconciled
 * independently before the stamp is moved into the itemized rows. */
export function payslipDeductionBreakdown(statutory: unknown, otherDeductions: unknown, sources: readonly PayslipQuantitySource[] = []) {
  const absence = payslipAbsenceLines(statutory, otherDeductions);
  const deductionLines = deductionLinesFor(statutory, absence.residual, absence, sources);
  if (!absence.absent || !deductionLines.some(line => line.code === 'ABSENT')) return { absence, deductionLines };

  const { days, amount } = absence.absent;
  return {
    absence: { ...absence, absent: null, residual: Math.round((absence.residual + amount) * 100) / 100 },
    deductionLines: groupNamedPayItemLines([
      ...deductionLines,
      { code: 'ABSENT', name: '', amount, ...(days > 0 ? { inputQuantity: { qty: days, unit: 'days' as const } } : {}) },
    ], 'ABSENT'),
  };
}
