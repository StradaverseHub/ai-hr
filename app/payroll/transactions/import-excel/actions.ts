'use server';

import { revalidatePath } from 'next/cache';

import { scopedAdmin } from '@/lib/scope';
import { parseCsvRecords } from '@/lib/csv';
import { commitTxnImport, validateTxnImport } from '@/core/payroll-txn-import';
import type { TxnImportKind, TxnImportPreview, TxnImportResult } from '@/lib/payroll-txn-import-schema';

/**
 * 5c65367d — the two actions behind the Fixed / Individual Transaction Excel import.
 *
 * TWO ACTIONS, VALIDATE THEN COMMIT, which is r185's shape kept deliberately: the operator finds out
 * what is wrong with their file before anything reaches an employee's pay, and nothing is written until
 * they press Confirm.
 *
 * THE SERVER SEES PLAIN CSV TEXT, NEVER A WORKBOOK. The client parses the .xlsx in the BROWSER
 * (lib/spreadsheet.ts, SheetJS lazily imported so it stays out of the bundle and off the server
 * entirely). That is why there is no server-side spreadsheet attack surface, and it is why the ONLY
 * thing crossing this boundary is a string.
 *
 * `scopedAdmin` FIRST on both. RLS isolates tenants; COMPANY scope is an application concern, so the
 * scoped id list is what the resolver matches employee codes against — an employee outside this admin's
 * companies is not "denied", they are simply not in the catalogue, and the row reads as an unknown
 * employee. Same fence, same wording, as every other screen in this hub.
 */

/** Dry run. Returns a verdict per row; writes nothing and appends no event — a preview is a read. */
export async function validateTxnImportAction(csv: string, kind: TxnImportKind): Promise<TxnImportPreview> {
  const { s, scopeIds } = await scopedAdmin();
  const { records } = parseCsvRecords(csv);
  return validateTxnImport(s, { kind, scopeIds, records });
}

/**
 * Commit. RE-VALIDATES server-side and writes from ITS OWN answer, not from the preview the client is
 * holding — a commit that trusted the client's verdicts would be a commit the client could widen.
 *
 * Every row goes through the live service (`setEmploymentPayComponent` / `createIndividualTxnsBulk`), so
 * the overlap refusal, the closed-run refusal, the amount and date guards and — on Individual —
 * `markBatchNeedsRecalc` all fire exactly as they do for a row typed into the form.
 */
export async function commitTxnImportAction(csv: string, kind: TxnImportKind): Promise<TxnImportResult> {
  const { s, scopeIds } = await scopedAdmin();
  const { records } = parseCsvRecords(csv);
  const result = await commitTxnImport(s, { kind, scopeIds, records });
  revalidatePath(kind === 'fixed' ? '/payroll/transactions/fixed' : '/payroll/transactions/individual');
  return result;
}
