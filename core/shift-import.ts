import { createHash, randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import type { BreakPeriod } from '../db/schema';
import { publicErrorMessage } from '../lib/public-error';
import { readShiftImportWorkbook, type ShiftImportIssue } from '../lib/shift-import-workbook';
import { createShift, listShiftsForTenant, updateShift, validateShiftImportInput, type ShiftInput } from './roster';

const identity = (code: string) => code.trim().toLowerCase();
const numeric = (value: string | undefined, field: string) => {
  if (value === undefined) return undefined;
  if (!/^\d{1,4}$/.test(value)) throw new Error(`${field} must be a whole number.`);
  return Number(value);
};

export async function previewShiftImport(ctx: SessionContext, bytes: Buffer) {
  const workbook = readShiftImportWorkbook(bytes);
  const existing = await listShiftsForTenant(ctx, { includeArchived: true });
  const byCode = new Map<string, (typeof existing)[number]>();
  for (const row of existing) {
    if (row.code && (!byCode.has(identity(row.code)) || !row.archivedAt)) byCode.set(identity(row.code), row);
  }
  const declared = new Set(workbook.shifts.map(row => identity(row.values['Shift Code'] ?? '')));
  const counts = new Map<string, number>();
  for (const row of workbook.shifts) {
    const code = identity(row.values['Shift Code'] ?? '');
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const issues: ShiftImportIssue[] = [];
  const broken = new Set<string>();
  const breakRows = new Map<string, BreakPeriod[]>();
  for (const row of workbook.breaks) {
    const values = row.values, code = identity(values['Shift Code'] ?? '');
    try {
      if (!code || !declared.has(code)) throw new Error('Choose a shift code listed on the Shifts sheet.');
      const breakType = values['Break Type'] ?? 'in_shift';
      if (breakType !== 'in_shift' && breakType !== 'before_shift' && breakType !== 'after_shift') throw new Error('Choose in_shift, before_shift or after_shift.');
      const start = values['Break Start'], end = values['Break End'];
      if (!start || !end || ![start, end].every(time => /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time))) throw new Error('Enter break start and end as HH:MM.');
      const paid = (values.Paid ?? 'no').toLowerCase();
      if (paid !== 'yes' && paid !== 'no') throw new Error('Paid must be yes or no.');
      const flexibleMinutes = numeric(values['Flexible Minutes'], 'Flexible Minutes');
      const periods = breakRows.get(code) ?? [];
      if (periods.length >= 24) throw new Error('A shift may have at most 24 breaks in this import.');
      periods.push({ start, end, breakType, ...(paid === 'yes' && { paid: true }),
        ...(flexibleMinutes !== undefined && { flexible: true, flexibleMinutes }) });
      breakRows.set(code, periods);
    } catch (error) {
      broken.add(code);
      issues.push({ sheet: 'Breaks', row: row.row, field: 'Break', message: publicErrorMessage(error) });
    }
  }
  const operations: { code: string; row: number; input: ShiftInput; id?: string; snapshot?: string }[] = [];
  for (const row of workbook.shifts) {
    const v = row.values, code = v['Shift Code'] ?? '', key = identity(code), stored = byCode.get(key);
    try {
      if (!code) throw new Error('Shift Code is required.');
      if (counts.get(key) !== 1) throw new Error('Shift Code is repeated in this workbook.');
      if (stored?.archivedAt) throw new Error('This shift is archived. Restore it before importing updates.');
      if (broken.has(key)) throw new Error('Correct the invalid rows for this shift on the Breaks sheet.');
      if (stored?.flexibleBreakEnabled && breakRows.has(key)) throw new Error('Stop using the legacy whole-shift break allowance before importing break rows.');
      const type = v['Shift Type'] ?? stored?.type ?? 'normal';
      if (type !== 'normal' && type !== 'semi_flexi' && type !== 'full_flexi') throw new Error('Choose normal, semi_flexi or full_flexi.');
      const input: ShiftInput = {
        code: stored?.code ?? code,
        name: v['Shift Name'] ?? stored?.name ?? '',
        type,
        startTime: v['Time In'] ?? stored?.startTime,
        endTime: v['Time Out'] ?? stored?.endTime,
        normalMinutesOverride: numeric(v['Normal Working Minutes'], 'Normal Working Minutes') ?? stored?.normalMinutesOverride,
        normalHoursRoundingMinutes: numeric(v['Rounding Minutes'], 'Rounding Minutes') ?? stored?.normalHoursRoundingMinutes,
        breakPeriods: breakRows.get(key) ?? stored?.breakPeriods,
        breakMinutes: stored?.breakMinutes,
        description: v.Description ?? stored?.description,
        category: v.Category ?? stored?.category,
        color: v.Colour ?? stored?.color,
        dailyCutoffEnabled: stored?.dailyCutoffEnabled,
        dailyCutoffTime: stored?.dailyCutoffTime,
        earlyIn: stored?.earlyIn,
        lateOut: stored?.lateOut,
        lateOutNextDay: stored?.lateOutNextDay,
        halfDayFirstOut: stored?.halfDayFirstOut,
        halfDaySecondIn: stored?.halfDaySecondIn,
        flexibleBreakEnabled: stored?.flexibleBreakEnabled,
        flexibleBreakMinutes: stored?.flexibleBreakMinutes,
      };
      validateShiftImportInput(input);
      const { allowedRuleIds: _, ...snapshot } = stored ?? { allowedRuleIds: [] };
      operations.push({ row: row.row, code, input, ...(stored && { id: stored.id, snapshot: JSON.stringify(snapshot) }) });
    } catch (error) {
      issues.push({ sheet: 'Shifts', row: row.row, field: 'Shift', message: publicErrorMessage(error) });
    }
  }
  if (!workbook.shifts.length) throw new Error('Enter at least one shift on the Shifts sheet.');
  const fingerprint = createHash('sha256').update(bytes).update(JSON.stringify(operations)).digest('hex');
  return { fingerprint, issues, operations, total: workbook.shifts.length };
}

export async function confirmShiftImport(ctx: SessionContext, bytes: Buffer, fingerprint: string) {
  const preview = await previewShiftImport(ctx, bytes);
  if (preview.fingerprint !== fingerprint) throw new Error('The workbook or shift settings changed. Preview the workbook again.');
  const importId = randomUUID();
  const audit = (eventType: string, payload: Record<string, number>) => withTenant(ctx, tx => appendEvent(tx, {
    tenantId: ctx.tenantId, aggregateType: 'shift-import', aggregateId: importId, eventType, actor: actorOf(ctx), payload,
  }));
  await audit('shift-import.started', { total: preview.total, valid: preview.operations.length });
  let created = 0, updated = 0;
  const issues = [...preview.issues];
  for (const operation of preview.operations) {
    try {
      if (operation.id) {
        await updateShift(ctx, { ...operation.input, shiftId: operation.id, expectedImportSnapshot: operation.snapshot });
        updated++;
      } else {
        await createShift(ctx, operation.input);
        created++;
      }
    } catch (error) {
      issues.push({ sheet: 'Shifts', row: operation.row, field: 'Shift', message: publicErrorMessage(error) });
    }
  }
  const counts = { created, updated, skipped: preview.total - preview.operations.length, failed: preview.operations.length - created - updated };
  await audit('shift-import.completed', counts);
  return { ...counts, issues };
}
