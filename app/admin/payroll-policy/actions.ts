'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  assignPolicy,
  copyPolicy,
  createPolicy,
  DefaultPolicyInUseError,
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

const numOrUndef = (fd: FormData, k: string): number | undefined => {
  const v = String(fd.get(k) ?? '').trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const checked = (fd: FormData, k: string): boolean => fd.get(k) === 'on';

/**
 * f3148da1 (Steps 2–5) — build the full General-Settings `config` blob from the submitted form for ANY policy
 * type. The service's `cleanPayrollPolicyConfig` coerces + clamps every field and drops all-default groups
 * back to NULL, so a form left at its defaults persists as NULL (byte-identical to today). Passed on BOTH
 * create and edit (edit must rebuild the whole blob, else toggling a new field would wipe the others). The
 * cut-off WINDOW (2.1.4) is only meaningful for custom_period; the cleaner drops it for other types.
 *   • proration (Step 2/3): divisor + custom days + working-day basis flags + salary-increment split
 *   • negative net (Step 2)
 *   • overtime (Step 4): multiplier, max hours, max amount, eligible day types, exceed-handling → pay item
 *   • leave (Step 5): the three divisors + custom day/hour/minute values
 *   • rounding: earnings / deductions / net-pay modes
 */
function configFromForm(fd: FormData, policyType: string): PayrollPolicyConfig {
  const eligibleDayTypes = (['workday', 'rest_day', 'holiday'] as const).filter((d) => checked(fd, `otDay_${d}`));
  const exceedAction = String(fd.get('otExceedAction') ?? 'cap');
  const otComponentId = String(fd.get('otExceedComponentId') ?? '').trim();
  // Built as a plain blob and validated/clamped by cleanPayrollPolicyConfig in the service (a bad string falls
  // back to its default there), so we cast once rather than pre-typing every union field.
  // Working-day basis flags are OMITTED entirely unless at least one is checked — the cleaner keys off their
  // PRESENCE (`'includeSaturday' in raw`) to switch from calendar-day to working-day proration, so always
  // sending them (even as false) would silently flip every policy to working-day counting. Absent = calendar
  // days (byte-identical). Checking any box opts into working-day proration with the selected weekend roster.
  const sat = checked(fd, 'includeSaturday');
  const sun = checked(fd, 'includeSunday');
  const hol = checked(fd, 'includeHoliday');
  const anyBasis = sat || sun || hol;
  const raw: Record<string, unknown> = {
    proration: {
      divisor: String(fd.get('prorationDivisor') ?? 'calendar_month'),
      customDays: numOrUndef(fd, 'prorationCustomDays'),
      ...(anyBasis ? { includeSaturday: sat, includeSunday: sun, includeHoliday: hol } : {}),
    },
    salaryIncrementProration: checked(fd, 'salaryIncrementProration'),
    negativeNet: String(fd.get('negativeNet') ?? 'retain'),
    overtime: {
      multiplier: numOrUndef(fd, 'otMultiplier'),
      maxHoursPerMonth: numOrUndef(fd, 'otMaxHours'),
      maxAmount: numOrUndef(fd, 'otMaxAmount'),
      eligibleDayTypes,
      ...(exceedAction === 'convert' && otComponentId
        ? { exceedHandling: { action: 'convert', componentId: otComponentId } }
        : {}),
    },
    leave: {
      unpaidLeaveDivisor: String(fd.get('unpaidLeaveDivisor') ?? 'calendar_month'),
      unpaidTimeOffDivisor: String(fd.get('unpaidTimeOffDivisor') ?? 'calendar_month'),
      encashmentDivisor: String(fd.get('encashmentDivisor') ?? 'calendar_month'),
      customDays: numOrUndef(fd, 'leaveCustomDays'),
      customHours: numOrUndef(fd, 'leaveCustomHours'),
      customMinutes: numOrUndef(fd, 'leaveCustomMinutes'),
    },
    rounding: {
      earnings: String(fd.get('roundingEarnings') ?? 'none'),
      deductions: String(fd.get('roundingDeductions') ?? 'none'),
      netPay: String(fd.get('roundingNetPay') ?? 'none'),
    },
    // 2.1.4 cut-off window (custom_period only; cleaner drops it for other types).
    ...(policyType === 'custom_period' && String(fd.get('cutOffMode') ?? 'calendar') === 'custom'
      ? { cutOff: { mode: 'custom', anchorDay: numOrUndef(fd, 'anchorDay') } }
      : {}),
  };
  return raw as PayrollPolicyConfig;
}

/** Map a known service error to its localized message; fall back to the raw message otherwise. */
async function errorMessage(e: unknown): Promise<string> {
  const t = await getTranslations('payrollPolicy.errors');
  if (e instanceof DuplicatePolicyNameError) return t('duplicateName');
  if (e instanceof PolicyInUseError) return t('inUse');
  if (e instanceof DefaultPolicyInUseError) return t('defaultInUse');
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

// Note: on edit, the full General-Settings config is ALWAYS rebuilt and passed (see updatePolicyAction below) —
// omitting it would drop the fields not touched this submit.

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
        // f3148da1 — always rebuild + pass the full General-Settings config (all types), else a group left
        // untouched this submit would be wiped. cleanPayrollPolicyConfig collapses an all-default blob to NULL.
        config: configFromForm(formData, policyType),
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
  const dest = `/admin/personnel/${employmentId}`;
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
