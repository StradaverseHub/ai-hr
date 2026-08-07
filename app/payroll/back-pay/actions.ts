'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { requireAdmin } from '@/lib/authz';
import { scopedAdmin } from '@/lib/scope';
import {
  BackPayNothingToCalculateError,
  BackPayRunNotFoundError,
  BackPayStatusError,
  BackPayTargetRunNotDraftError,
  approveAndPostBackPay,
  backPayRunDetail,
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

// `: never` is load-bearing, not decoration. redirect() throws, so control never returns — but without
// the annotation TypeScript keeps narrowing `scopedRun(...)` to `{...} | null` AFTER a `back()` guard,
// and the null branch reads as live. Declaring it never lets the compiler prove the guard, which is how
// a scope check earns its keep rather than merely appearing above the code it protects.
const back = (params: Record<string, string | undefined>): never => {
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

/**
 * SCOPE — every action below resolves the run and re-checks its COMPANY against the caller's grants.
 *
 * `requireAdmin()` alone was not enough and this is the defect it hid: `app.is_admin()` is true for an
 * hr_admin grant on ANY company in the tenant, and `loadRunTx` fetches by run id with no company term.
 * So a Company A admin posting `runId=<Company B's run>` could verify, cancel or approve it. The money
 * POST was stopped downstream by payroll_individual_txn's own company-scoped RLS — but the state
 * transitions were not, and a cancelled run is a real loss to whoever was waiting on it.
 *
 * Returns null when the run does not exist, belongs to another tenant, or belongs to a company outside
 * the caller's scope — ONE answer for all three, so a caller cannot use the error to probe run ids.
 */
async function scopedRun(runId: string) {
  const { s, scopeIds } = await scopedAdmin();
  if (!runId) return null;
  const detail = await backPayRunDetail(s, runId);
  if (!detail || !scopeIds.includes(detail.run.companyId)) return null;
  return { s, scopeIds, detail };
}

export async function calculateBackPayAction(formData: FormData) {
  // companyId arrives FROM THE FORM, so it is attacker-controlled and must be checked, not trusted.
  // app/payroll/transactions/individual/actions.ts does exactly this: `!scopeIds.includes(companyId)`.
  const { s, scopeIds } = await scopedAdmin();
  const companyId = String(formData.get('companyId') ?? '');
  if (!companyId || !scopeIds.includes(companyId)) back({ err: 'unknown' });
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
  const runId = String(formData.get('runId') ?? '');
  const scoped = await scopedRun(runId);
  // `return back(...)` rather than a bare call: TypeScript only narrows through a never-returning
  // ARROW when the variable itself is annotated, and a guard the compiler cannot prove is a guard
  // that reads as protection without being it.
  if (!scoped) return back({ run: runId, err: 'notFound' });
  const { s } = scoped;
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
  const runId = String(formData.get('runId') ?? '');
  const scoped = await scopedRun(runId);
  // `return back(...)` rather than a bare call: TypeScript only narrows through a never-returning
  // ARROW when the variable itself is annotated, and a guard the compiler cannot prove is a guard
  // that reads as protection without being it.
  if (!scoped) return back({ run: runId, err: 'notFound' });
  const { s } = scoped;
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
  const runId = String(formData.get('runId') ?? '');
  const scoped = await scopedRun(runId);
  // `return back(...)` rather than a bare call: TypeScript only narrows through a never-returning
  // ARROW when the variable itself is annotated, and a guard the compiler cannot prove is a guard
  // that reads as protection without being it.
  if (!scoped) return back({ run: runId, err: 'notFound' });
  const { s } = scoped;
  try {
    await cancelBackPayRun(s, { runId });
  } catch (e) {
    back({ run: runId, err: codeOf(e) });
  }
  revalidatePath('/payroll/back-pay');
  revalidatePath('/payroll');
  back({ run: runId, ok: 'cancelled' });
}
