'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getBrowserCommandSession } from '@/lib/session';
import { AuditFindingRefused, disposeFinding, runControlChecks } from '@/core/payroll-audit/controls';
import { AuditCorrectionRefused, recordCorrectionCause } from '@/core/payroll-audit/corrections';
import { AuditCaptureRefused, capturePayrollPeriod } from '@/core/payroll-audit/capture';
import { isPayPeriod } from '@/core/payroll-audit/types';

/** AI v2 P2-2b — the Audit loop page's three commands, each re-checked by its service and by the database (migration 0965):
 *  - a payroll administrator of the finding's company disposes of a control finding, with a note (disposeFinding);
 *  - a payroll administrator of the run's company states the root cause of a post-run correction (recordCorrectionCause);
 *  - a group or HR administrator captures one company and month now and runs its checks, under their own login.
 * None of them changes pay, a run, a file or a filing. Each returns to the page with a closed result code the page translates;
 * no other text crosses. The loop's switch and per-company pause use the Operations › Loops actions. */
const PAGE = '/control-tower/loops/loop_payroll_audit';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Code = 'invalid' | 'refused' | 'failed';
function back(formData: FormData, result: { saved: string } | { error: Code }): never {
  const period = formData.get('period'), company = formData.get('company');
  const query = new URLSearchParams();
  if (isPayPeriod(period)) query.set('period', period);
  if (typeof company === 'string' && UUID.test(company)) query.set('company', company);
  for (const [key, value] of Object.entries(result)) query.set(key, value);
  revalidatePath(PAGE);
  redirect(`${PAGE}?${query}`);
}
const code = (e: unknown): Code => {
  if (e instanceof AuditFindingRefused || e instanceof AuditCorrectionRefused || e instanceof AuditCaptureRefused)
    return e.reason === 'invalid' || e.reason === 'not_found' ? 'invalid' : 'refused';
  return 'failed';
};

export async function disposeAuditFindingAction(formData: FormData) {
  let error: Code | null = null;
  try {
    const s = await getBrowserCommandSession();
    await disposeFinding(s, { findingId: formData.get('finding'), disposition: formData.get('disposition'), note: formData.get('note') });
  } catch (e) { error = code(e); }
  back(formData, error ? { error } : { saved: 'disposed' });
}

export async function recordCorrectionCauseAction(formData: FormData) {
  let error: Code | null = null;
  try {
    const s = await getBrowserCommandSession();
    await recordCorrectionCause(s, { correctionKey: formData.get('correction'), rootCause: formData.get('rootCause'), note: formData.get('note') });
  } catch (e) { error = code(e); }
  back(formData, error ? { error } : { saved: 'cause' });
}

export async function captureAuditNowAction(formData: FormData) {
  let error: Code | null = null;
  try {
    const s = await getBrowserCommandSession();
    const input = { companyId: formData.get('company'), payPeriod: formData.get('period') };
    await runControlChecks(s, input);
    await capturePayrollPeriod(s, input);
  } catch (e) { error = code(e); }
  back(formData, error ? { error } : { saved: 'captured' });
}
