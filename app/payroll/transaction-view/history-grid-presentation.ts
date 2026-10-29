import type { GridRowGroup, HistoryGridRow } from './history-pivot';

/** Display placement is independent of the accounting groups used to reconcile gross pay. */
export function historyGridDisplayGroup(row: HistoryGridRow): GridRowGroup {
  return row.kind === 'synthetic' && row.labelKey === 'overtime' ? 'summary' : row.group;
}

export function historyGridLabelKey(row: HistoryGridRow): string | undefined {
  return row.kind === 'synthetic' && row.labelKey === 'overtime' ? 'totalOvertime' : row.labelKey ?? undefined;
}

const order: Record<GridRowGroup, number> = {
  earning: 0, deduction: 1, employer: 2, item: 3, summary: 4, wagebase: 5,
};

/** Both screen and displayed-grid export retain the same stable ordering within each section. */
export function historyGridDisplayRows(rows: HistoryGridRow[]): HistoryGridRow[] {
  return [...rows].sort((a, b) => order[historyGridDisplayGroup(a)] - order[historyGridDisplayGroup(b)]);
}
