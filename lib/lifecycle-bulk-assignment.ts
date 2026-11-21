/**
 * d1e26f81 — one validation for "Set for all items", shared by onboarding Equipment and access (bulkEquipment)
 * and offboarding Return and revoke (bulkItems). Dependency-free so both models and server graphs can import it.
 * Returns the refusal message, or null when the change is valid; each model raises its own error type.
 */
export type BulkAssignmentChange = { ids: string[]; group?: string; method?: string; due?: number };
export type BulkAssignmentLabels = { change: string; due: string };
export const EQUIPMENT_BULK_LABELS: BulkAssignmentLabels = { change: 'Choose items and at least one equipment change.', due: 'Choose an equipment due day from -999 to 9999.' };
export const RETURN_BULK_LABELS: BulkAssignmentLabels = { change: 'Choose items and at least one return change.', due: 'Choose a return due day from -999 to 9999.' };
export function bulkAssignmentProblem(change: BulkAssignmentChange, groupIds: readonly string[], labels: BulkAssignmentLabels): string | null {
    if (!change.ids.length || new Set(change.ids).size !== change.ids.length || change.group === undefined && change.method === undefined && change.due === undefined) return labels.change;
    if (change.group !== undefined && !groupIds.includes(change.group)) return 'Choose an existing assignment group.';
    if (change.method !== undefined && !['rr', 'manual'].includes(change.method)) return 'Choose Round robin or Manual.';
    if (change.due !== undefined && (!Number.isInteger(change.due) || change.due < -999 || change.due > 9999)) return labels.due;
    return null;
}
