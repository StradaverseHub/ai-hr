'use server';

import { scopedAdmin } from '@/lib/scope';
import { queueFixedTransactionImport } from '@/core/fixed-transaction-import-job';

export async function queueFixedTransactionImportAction(input: { csv: string; fileName: string; operationKey: string }) {
  const { s, scopeIds } = await scopedAdmin();
  return queueFixedTransactionImport(s, { ...input, companyIds: scopeIds });
}
