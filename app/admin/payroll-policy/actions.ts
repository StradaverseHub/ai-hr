'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  assignPolicy,
  copyPolicy,
  createPolicy,
  deletePolicy,
  DuplicatePolicyNameError,
  PolicyCompanyMismatchError,
  PolicyInUseError,
  setStatus,
  updatePolicy,
} from '@/core/payroll-policy';
import type { PayRule } from '@/core/pay-rule';
import type { PayrollPolicyConfig } from '@/db/schema';

const PAGE = '/admin/payroll-policy';

const str = (fd: FormData, k: string): string | undefined => {
  const v = String(fd.get(k) ?? '').trim();
  return v || undefined;
};

/** Build the pay-rule from the submitted form for the given type. Daily ⇒ a per_day rule from `dailyRate`;
 *  Hourly (2.1.3) ⇒ a per_hour rule from `hourlyRate` plus the `onlyPullHoursWithinShiftSchedule` checkbox.
 *  (NaN/blank rate ⇒ 0, which the service's resolveRule validation then rejects as out of range.) Monthly ⇒ null. */
function payRuleFromForm(fd: FormData, policyType: string): PayRule | null {
  if (policyType === 'daily') return { kind: 'per_day', rate: Number(fd.get('dailyRate') ?? '') };
  if (policyType === 'hourly') {
    return {
      kind: 'per_hour',
      rate: Number(fd.get('hourlyRate') ?? ''),
      onlyPullHoursWithinShiftSchedule: fd.get('onlyPullHoursWithinShift') === 'on',
    };
  }
  return null;
}

/** 2.1.4 (Custom period) — build the policy `config` carrying the cut-off WINDOW for a custom_period policy.
 *  When the cut-off toggle is "custom", emits `{ cutOff: { mode:'custom', anchorDay } }`; the service's
 *  cleanPayrollPolicyConfig validates anchorDay ∈ 1..28 and drops an invalid/calendar value back to null
 *  (byte-identical). Any other type ⇒ null (no config). This records the window only — it is NOT yet applied
 *  to payroll calculation (deferred follow-up); statutory months stay calendar-bound by law. */
function configFromForm(fd: FormData, policyType: string): PayrollPolicyConfig | null {
  if (policyType !== 'custom_period') return null;
  if (String(fd.get('cutOffMode') ?? 'calendar') !== 'custom') return null;
  const raw = String(fd.get('anchorDay') ?? '').trim();
  if (!raw) return null;
  return { cutOff: { mode: 'custom', anchorDay: Number(raw) } };
}

/** Map a known service error to its localized message; fall back to the raw message otherwise. */
async function errorMessage(e: unknown): Promise<string> {
  const t = await getTranslations('payrollPolicy.errors');
  if (e instanceof DuplicatePolicyNameError) return t('duplicateName');
  if (e instanceof PolicyInUseError) return t('inUse');
  if (e instanceof PolicyCompanyMismatchError) return t('companyMismatch');
  return (e as Error).message;
}

/**
 * Run a write, then redirect — the success/error redirect always happens OUTSIDE the try/catch so Next's
 * NEXT_REDIRECT control-flow error is never swallowed by the catch. Returns the localized toast key resolved
 * to a real string (global ToastFromQuery fires `?toast=`).
 */
async function run(write: () => Promise<void>, toastKey: string, page = PAGE) {
  let errMsg: string | null = null;
  try {
    await write();
    revalidatePath(page);
  } catch (e) {
    errMsg = await errorMessage(e);
  }
  if (errMsg) redirect(`${page}?error=${encodeURIComponent(errMsg)}`);
  const t = await getTranslations('payrollPolicy.toasts');
  redirect(`${page}?toast=${encodeURIComponent(t(toastKey))}`);
}

export async function createPolicyAction(formData: FormData) {
  const s = await getSession();
  // 2.1.2/2.1.3/2.1.4 — Monthly, Daily, Hourly and Custom-period are selectable. Read the submitted type and,
  // for daily/hourly, build the pay-rule from the rate field; for custom_period, build the cut-off-window config.
  // The service's resolveRule + cleanPayrollPolicyConfig validate both.
  const policyType = str(formData, 'policyType') ?? 'monthly';
  await run(
    () =>
      createPolicy(s, {
        companyId: String(formData.get('companyId') ?? ''),
        name: String(formData.get('name') ?? ''),
        description: str(formData, 'description') ?? null,
        policyType,
        payRule: payRuleFromForm(formData, policyType),
        config: configFromForm(formData, policyType),
      }).then(() => undefined),
    'saved',
  );
}

export async function updatePolicyAction(formData: FormData) {
  const s = await getSession();
  // 2.1.2/2.1.3/2.1.4 — the type is read-only on edit (the hidden field carries the existing type); for a daily
  // or hourly policy pass the edited rate (and, for hourly, the shift toggle) through; for a custom_period policy
  // pass the edited cut-off-window config (null when the toggle is back on "calendar", clearing the window).
  const policyType = str(formData, 'policyType') ?? 'monthly';
  await run(
    () =>
      updatePolicy(s, {
        id: String(formData.get('id') ?? ''),
        name: String(formData.get('name') ?? ''),
        description: str(formData, 'description') ?? null,
        ...(policyType === 'daily' || policyType === 'hourly'
          ? { payRule: payRuleFromForm(formData, policyType) }
          : {}),
        ...(policyType === 'custom_period' ? { config: configFromForm(formData, policyType) } : {}),
      }).then(() => undefined),
    'saved',
  );
}

/** 2.1.2 — Copy an existing policy into a new one under a new name (type + rate + config preserved). */
export async function copyPolicyAction(formData: FormData) {
  const s = await getSession();
  await run(
    () =>
      copyPolicy(s, {
        sourceId: String(formData.get('id') ?? ''),
        name: String(formData.get('name') ?? ''),
      }).then(() => undefined),
    'copied',
  );
}

export async function setStatusAction(formData: FormData) {
  const s = await getSession();
  await run(
    () =>
      setStatus(s, { id: String(formData.get('id') ?? ''), status: String(formData.get('status') ?? '') }).then(
        () => undefined,
      ),
    'statusChanged',
  );
}

export async function deletePolicyAction(formData: FormData) {
  const s = await getSession();
  await run(() => deletePolicy(s, { id: String(formData.get('id') ?? '') }).then(() => undefined), 'deleted');
}

/** Assign (or clear, when policyId is empty) a payroll policy to an employment. Used from the employee detail
 *  page; returns to the same employee with a localized toast/error. */
export async function assignPolicyAction(formData: FormData) {
  const s = await getSession();
  const employmentId = String(formData.get('employmentId') ?? '');
  const rawPolicy = String(formData.get('policyId') ?? '').trim();
  const dest = `/people/${employmentId}`;
  let errMsg: string | null = null;
  try {
    await assignPolicy(s, { employmentId, policyId: rawPolicy || null });
    revalidatePath(dest);
  } catch (e) {
    errMsg = await errorMessage(e);
  }
  if (errMsg) redirect(`${dest}?error=${encodeURIComponent(errMsg)}`);
  const t = await getTranslations('payrollPolicy.toasts');
  redirect(`${dest}?toast=${encodeURIComponent(t('assigned'))}`);
}
