/**
 * Client-safe contract for the leave-data importer (Leave Data Import & Migration Tool).
 *
 * No DB imports — the column list + per-row result shape live here so BOTH the server service
 * (core/leave-import) and the client UI (app/admin/leave/import) can share them, exactly like
 * lib/import-schema.ts does for the employee importer.
 *
 * The result type deliberately does NOT reuse lib/import-schema's RowResult (that type is hardwired
 * to employee-importer fields fullName/email). The shape is modelled on core/attendance's
 * PunchImportResult / PunchImportPreviewRow instead — ref-matching-shaped, no person-name fields
 * baked in — keeping the same {ok, errors, warnings} convention as a new sibling type.
 */

export type LeaveImportRecord = Record<string, string>;

/** Columns the importer recognises. Required ones must be present and non-empty per row.
 *  'Transaction Type' maps onto the leave_ledger.entryType enum. */
export const LEAVE_IMPORT_COLUMNS = {
  required: ['employee_id', 'leave_type', 'transaction_type', 'days', 'effective_date'],
  optional: [] as string[],
} as const;

/** Accepted transaction_type values, mapping the file column onto the leave_ledger entryType enum.
 *  in_lieu_accrual (TOIL) is DELIBERATELY excluded from v1 — see core/leave-import.ts for the
 *  data-integrity rationale (a bare in_lieu_accrual ledger row has no companion toil_accrual row and
 *  would be invisible to the TOIL expiry sweep). */
export const LEAVE_IMPORT_ENTRY_TYPES = ['accrual', 'debit', 'adjustment'] as const;
export type LeaveImportEntryType = (typeof LEAVE_IMPORT_ENTRY_TYPES)[number];

/** Per-row dry-run result. `status` mirrors the ticket's Function 4 Row/Status/Message example.
 *  `warnings` carries non-blocking flags (terminated employee, already-imported duplicate,
 *  rolled-over year, oversized days) that don't demote a row to Error. */
export type LeaveRowResult = {
  rowNum: number; // 1-based data row (header excluded)
  employeeRef: string; // employee_id exactly as given (echoed into the error report)
  leaveType: string; // leave_type exactly as given
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export type LeaveImportPreview = {
  total: number;
  validCount: number;
  rows: LeaveRowResult[];
  missingColumns: string[];
};

export type LeaveImportResult = {
  imported: number;
  failed: { rowNum: number; employeeRef: string; message: string }[];
  skipped: number;
  totalRows: number;
};

/** How the imported rows reached the commit — recorded in the leave.import.completed event payload so
 *  a file-driven migration is distinguishable in the audit trail from a hand-pasted batch. Payload-only
 *  enrichment of the EXISTING event (no new write, no schema change — domain_event.payload is jsonb). */
export type LeaveImportSource = {
  kind: 'file' | 'paste';
  name?: string; // original filename when kind === 'file'
  format?: 'csv' | 'xls' | 'xlsx';
};
