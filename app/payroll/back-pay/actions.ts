'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { requireAdmin } from '@/lib/authz';
import {
  BackPayNothingToCalculateError,
  BackPayRunNotFoundError,
  BackPayStatusError,
  BackPayTargetRunNotDraftError,
  approveAndPostBackPay,
  calculateBackPay,
  cancelBackPayRun,
  verifyBackPayRun,
} from '@/core/back-pay';

/**
 * Back Pay write surface (2ef69d1e).
 *
 * Every action re-asserts admin server-side rather than trusting the page's `scopedAdmin()` — a server
 * action is a POST endpoint, reachable without ever rendering the page that offers the button.
 *
 * Errors come back as a stable CODE in the query string, never a message: the page localises them. That
 * is the same discipline core/pay-rule.ts's PayRuleErrorCode follows, and it is what stops raw English
 * from this layer reaching a screen someone is reading in Tamil.
 */

const back = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const qs = q.toString();
  redirect(`/payroll/back-pay${qs ? `?${qs}` : ''}`);
};

/** Map a service error onto the stable code the page localises. */
function codeOf(e: unknown): string {
  if (e instanceof BackPayNothingToCalculateError) return 'nothingToCalculate';
  if (e instanceof BackPayTargetRunNotDraftError) return 'targetRunNotDraft';
  if (e instanceof BackPayStatusError) return 'wrongStatus';
  if (e instanceof BackPayRunNotFoundError) return 'notFound';
  console.error('back pay action failed', e);
  return 'unknown';
}

export async function calculateBackPayAction(formData: FormData) {
  await requireAdmin();
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const targetPayPeriod = String(formData.get('targetPayPeriod') ?? '');
  // The operator ticks which revisions to include; no tick at all means "everything detected", which is
  // the common case and saves twenty-two checkboxes on the first run.
  const compensationIds = formData.getAll('compensationId').map(String).filter(Boolean);
  if (!companyId || !targetPayPeriod) back({ err: 'unknown' });
  let runId: string | undefined;
  try {
    const res = await calculateBackPay(s, { companyId, targetPayPeriod, compensationIds });
    runId = res.runId;
  } catch (e) {
    back({ company: companyId, err: codeOf(e) });
  }
  revalidatePath('/payroll/back-pay');
  back({ company: companyId, run: runId });
}

export async function verifyBackPayAction(formData: FormData) {
  await requireAdmin();
  const s = await getSession();
  const runId = String(formData.get('runId') ?? '');
  try {
    await verifyBackPayRun(s, { runId });
  } catch (e) {
    back({ run: runId, err: codeOf(e) });
  }
  revalidatePath('/payroll/back-pay');
  back({ run: runId, ok: 'verified' });
}

/** THE ONLY ACTION THAT MOVES MONEY. Everything before it is arithmetic on a screen. */
export async function approveAndPostBackPayAction(formData: FormData) {
  await requireAdmin();
  const s = await getSession();
  const runId = String(formData.get('runId') ?? '');
  try {
    await approveAndPostBackPay(s, { runId });
  } catch (e) {
    back({ run: runId, err: codeOf(e) });
  }
  revalidatePath('/payroll/back-pay');
  revalidatePath('/payroll');
  back({ run: runId, ok: 'posted' });
}

export async function cancelBackPayAction(formData: FormData) {
  await requireAdmin();
  const s = await getSession();
  const runId = String(formData.get('runId') ?? '');
  try {
    await cancelBackPayRun(s, { runId });
  } catch (e) {
    back({ run: runId, err: codeOf(e) });
  }
  revalidatePath('/payroll/back-pay');
  revalidatePath('/payroll');
  back({ run: runId, ok: 'cancelled' });
}
