'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  createConfig,
  deleteConfig,
  DuplicateActiveConfigError,
  EmployeeCodeTooLongError,
  PrefixCollisionError,
  setStatus,
  updateConfig,
} from '@/core/employee-id-config';

const PAGE = '/admin/settings/employee-id';

const numOrUndef = (fd: FormData, k: string): number | undefined => {
  const v = String(fd.get(k) ?? '').trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Map a known service error to its localized message; fall back to the raw message otherwise. */
async function errorMessage(e: unknown): Promise<string> {
  const t = await getTranslations('employeeIdConfig.errors');
  if (e instanceof DuplicateActiveConfigError) return t('duplicateActive');
  if (e instanceof PrefixCollisionError) return t('prefixCollision');
  if (e instanceof EmployeeCodeTooLongError) return t('tooLong');
  return (e as Error).message;
}

/** Run a write, then redirect (success/error redirect ALWAYS outside try/catch so NEXT_REDIRECT isn't caught). */
async function run(write: () => Promise<void>, toastKey: string) {
  let errMsg: string | null = null;
  try {
    await write();
    revalidatePath(PAGE);
  } catch (e) {
    errMsg = await errorMessage(e);
  }
  if (errMsg) redirect(`${PAGE}?error=${encodeURIComponent(errMsg)}`);
  const t = await getTranslations('employeeIdConfig.toasts');
  redirect(`${PAGE}?toast=${encodeURIComponent(t(toastKey))}`);
}

export async function createConfigAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '').trim() || null; // '' = GLOBAL scope
  await run(
    () =>
      createConfig(s, {
        companyId,
        prefix: String(formData.get('prefix') ?? ''),
        startNumber: numOrUndef(formData, 'startNumber'),
        numberLength: numOrUndef(formData, 'numberLength'),
        increment: numOrUndef(formData, 'increment'),
        status: String(formData.get('status') ?? 'active'),
      }).then(() => undefined),
    'saved',
  );
}

export async function updateConfigAction(formData: FormData) {
  const s = await getSession();
  await run(
    () =>
      updateConfig(s, {
        id: String(formData.get('id') ?? ''),
        prefix: String(formData.get('prefix') ?? ''),
        startNumber: numOrUndef(formData, 'startNumber'),
        numberLength: numOrUndef(formData, 'numberLength'),
        increment: numOrUndef(formData, 'increment'),
        currentRunningNumber: numOrUndef(formData, 'currentRunningNumber'),
        status: String(formData.get('status') ?? 'active'),
      }).then(() => undefined),
    'saved',
  );
}

export async function setStatusAction(formData: FormData) {
  const s = await getSession();
  await run(
    () => setStatus(s, { id: String(formData.get('id') ?? ''), status: String(formData.get('status') ?? '') }).then(() => undefined),
    'statusChanged',
  );
}

export async function deleteConfigAction(formData: FormData) {
  const s = await getSession();
  await run(() => deleteConfig(s, { id: String(formData.get('id') ?? '') }).then(() => undefined), 'deleted');
}
