'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  archiveAllowancePolicy,
  createAllowancePolicy,
  DuplicateAllowancePolicyCodeError,
  setAllowancePolicyStatus,
  updateAllowancePolicy,
} from '@/core/attendance-allowance';
import type { AttendanceAllowanceCriteria, AttendanceAllowanceScope } from '@/db/schema';

const PAGE = '/admin/attendance-allowance';

const str = (fd: FormData, k: string): string | undefined => {
  const v = String(fd.get(k) ?? '').trim();
  return v || undefined;
};

/** Build the criteria bag from the submitted form. A blank input ⇒ the criterion is not set. */
function criteriaFromForm(fd: FormData): AttendanceAllowanceCriteria {
  const num = (k: string): number | undefined => {
    const v = String(fd.get(k) ?? '').trim();
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const c: AttendanceAllowanceCriteria = {};
  const min = num('minAttendanceDays');
  if (min !== undefined) c.minAttendanceDays = min;
  const abs = num('maxAbsentDays');
  if (abs !== undefined) c.maxAbsentDays = abs;
  const late = num('maxLateCount');
  if (late !== undefined) c.maxLateCount = late;
  const leave = num('maxTotalLeaveDays');
  if (leave !== undefined) c.maxTotalLeaveDays = leave;
  if (fd.get('requirePerfectAttendance') === 'on') c.requirePerfectAttendance = true;
  return c;
}

/** Build the scope bag: multi-select checkbox lists for department / business unit / company. */
function scopeFromForm(fd: FormData): AttendanceAllowanceScope {
  const list = (k: string): string[] => fd.getAll(k).map((x) => String(x).trim()).filter(Boolean);
  const s: AttendanceAllowanceScope = {};
  const dep = list('departmentIds');
  if (dep.length) s.departmentIds = dep;
  const bu = list('businessUnitIds');
  if (bu.length) s.businessUnitIds = bu;
  const co = list('companyIds');
  if (co.length) s.companyIds = co;
  return s;
}

async function errorMessage(e: unknown): Promise<string> {
  const t = await getTranslations('attendanceAllowance.errors');
  if (e instanceof DuplicateAllowancePolicyCodeError) return t('duplicateCode');
  return publicErrorMessage(e);
}

async function run(write: () => Promise<void>, toastKey: string) {
  let errMsg: string | null = null;
  try {
    await write();
    revalidatePath(PAGE);
  } catch (e) {
    errMsg = await errorMessage(e);
  }
  if (errMsg) redirect(`${PAGE}?error=${encodeURIComponent(errMsg)}`);
  const t = await getTranslations('attendanceAllowance.toasts');
  redirect(`${PAGE}?toast=${encodeURIComponent(t(toastKey))}`);
}

export async function createAllowancePolicyAction(formData: FormData) {
  const s = await getSession();
  await run(
    () =>
      createAllowancePolicy(s, {
        companyId: String(formData.get('companyId') ?? ''),
        code: String(formData.get('code') ?? ''),
        name: String(formData.get('name') ?? ''),
        method: 'monthly',
        amount: String(formData.get('amount') ?? ''),
        payComponentId: String(formData.get('payComponentId') ?? ''),
        effectiveFrom: String(formData.get('effectiveFrom') ?? ''),
        criteria: criteriaFromForm(formData),
        scope: scopeFromForm(formData),
      }).then(() => undefined),
    'saved',
  );
}

export async function updateAllowancePolicyAction(formData: FormData) {
  const s = await getSession();
  await run(
    () =>
      updateAllowancePolicy(s, {
        id: String(formData.get('id') ?? ''),
        code: str(formData, 'code'),
        name: String(formData.get('name') ?? ''),
        amount: String(formData.get('amount') ?? ''),
        payComponentId: String(formData.get('payComponentId') ?? ''),
        effectiveFrom: String(formData.get('effectiveFrom') ?? ''),
        criteria: criteriaFromForm(formData),
        scope: scopeFromForm(formData),
      }).then(() => undefined),
    'saved',
  );
}

export async function setAllowanceStatusAction(formData: FormData) {
  const s = await getSession();
  await run(
    () =>
      setAllowancePolicyStatus(s, {
        id: String(formData.get('id') ?? ''),
        status: String(formData.get('status') ?? ''),
      }).then(() => undefined),
    'statusChanged',
  );
}

export async function archiveAllowancePolicyAction(formData: FormData) {
  const s = await getSession();
  await run(() => archiveAllowancePolicy(s, { id: String(formData.get('id') ?? '') }).then(() => undefined), 'archived');
}
