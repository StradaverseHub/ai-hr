'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { BulkExpectInterrupted, BulkExpectRefused } from '@/lib/payroll-exceptions';
import { markGroupExpected } from './bulk';

/** Closed result codes the page knows how to say; nothing from an error's text reaches the address bar. */
const CODES = ['not_administrator', 'invalid', 'blocking', 'too_many', 'nothing'] as const;

/** Bulk "Mark as expected" for the exceptions of one set-up group that were on screen. */
export async function markGroupExpectedAction(formData: FormData) {
  const s = await requireAdmin();
  const group = formData.get('group');
  const params = new URLSearchParams();
  if (typeof group === 'string' && group.length <= 160) params.set('group', group);
  try {
    const result = await markGroupExpected(s, { group, verdictIds: formData.getAll('verdictId'), note: formData.get('note') });
    params.set('expected', String(result.resolved));
    params.set('expectedSkipped', String(result.skipped));
  } catch (e) {
    if (e instanceof BulkExpectInterrupted) {
      // The batch failed as a whole (nothing written): ask for another try. Nothing is reported as skipped.
      params.set('expected', String(e.resolved));
      params.set('bulkError', 'retry');
    } else {
      params.set('bulkError', e instanceof BulkExpectRefused && (CODES as readonly string[]).includes(e.reason) ? e.reason : 'failed');
    }
  }
  revalidatePath('/control-tower/exceptions');
  revalidatePath('/control-tower');
  redirect(`/control-tower/exceptions?${params}`);
}
