import { canonicalColumnKey, LEAVE_HISTORY_REQUIRED_KEYS } from './leave-history-import-schema';
import { canonicalBfColumnKey, LEAVE_BF_REQUIRED_KEYS } from './leave-bf-import-schema';
export type LeaveDataImportType = 'history' | 'bf';
export function leaveDataImportType(value: unknown): LeaveDataImportType | null {
  return value === 'history' || value === 'bf' ? value : null;
}
export function requireLeaveImportHeaders(type: unknown, headers: readonly string[]): void {
  const selected = leaveDataImportType(type);
  if (!selected) throw new Error('Choose an Import Type in Step 1.');
  const history = new Set(headers.map(canonicalColumnKey));
  const bf = new Set(headers.map(canonicalBfColumnKey));
  const wrongType = selected === 'history' ? bf.has('bf_days') : history.has('leave_reference') || history.has('leave_start_date') || history.has('leave_end_date');
  const required = selected === 'history' ? LEAVE_HISTORY_REQUIRED_KEYS : LEAVE_BF_REQUIRED_KEYS;
  const keys = selected === 'history' ? history : bf;
  if (wrongType || required.some(key => !keys.has(key))) throw new Error('This file does not match the selected Import Type. Change the selection in Step 1 or download its template.');
}
