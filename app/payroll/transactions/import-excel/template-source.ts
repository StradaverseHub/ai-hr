import type { TxnTemplateReference } from '@/lib/import-template-xlsx';
import type { TxnImportKind } from '@/lib/payroll-txn-import-schema';

export async function loadTxnTemplateReference(kind: TxnImportKind, preferredCompanyId?: string) {
  const params = new URLSearchParams({ kind });
  if (preferredCompanyId) params.set('companyId', preferredCompanyId);
  const response = await fetch(`/payroll/transactions/import-excel/template?${params}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Payroll template unavailable');
  return await response.json() as TxnTemplateReference;
}
