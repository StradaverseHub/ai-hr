import type { BulkJobState } from './bulk-job';

export const FIXED_TXN_IMPORT_LOG = '/payroll/transactions/fixed/imports';

export const fixedImportLogStatus = {
  queued: 'pending',
  preparing: 'validating',
  running: 'importing',
  finalizing: 'importing',
  discarding: 'importing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
} as const satisfies Record<BulkJobState, string>;
