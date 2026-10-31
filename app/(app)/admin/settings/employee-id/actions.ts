'use server';

import { publicErrorMessage } from '@/lib/public-error';
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

/** An unchecked checkbox is absent from FormData; a checked one posts "on" (or any truthy string). */
const boolOf = (fd: FormData, k: string): boolean => {
  const v = fd.get(k);
  return v != null && v !== '' && v !== 'false' && v !== 'off';
};

/** Map a known service error to its localized message; fall back to the raw message otherwise. */
async function errorMessage(e: unknown): Promise<string> {
  const t = await getTranslations('employeeIdConfig.errors');
  if (e instanceof DuplicateActiveConfigError) return t('duplicateActive');
  if (e instanceof PrefixCollisionError) return t('prefixCollision');
  if (e instanceof EmployeeCodeTooLongError) return t('tooLong');
  return publicErrorMessage(e);
}

/**
 * The list address to come back to (9da61c86 — "keep your search, filter and page position when you add or
 * edit a record and come back").
 *
 * The catalogue pages now, and every row action posted from it used to redirect to a bare `${PAGE}?toast=`:
 * deactivate the third template on page two and you were returned to page one, with a success message
 * about a row you could no longer see. A server action reads the FORM, never the address it was posted
 * from, so the page sends its position as `returnTo` (see the page's returnFields) and this reads it back.
 *
 * Only the keys this screen owns are re-emitted, so nothing a hand-edited form could put in that field can
 * reach the redirect.
 */
const RETURN_KEYS = ['page', 'size'] as const;

function listAddress(formData: FormData, extra: Record<string, string>): string {
  const from = new URLSearchParams(String(formData.get('returnTo') ?? ''));
  const sp = new URLSearchParams();
  for (const k of RETURN_KEYS) {
    const v = from.get(k);
    if (v) sp.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) sp.set(k, v);
  return `${PAGE}?${sp.toString()}`;
}

/** Run a write, then redirect (success/error redirect ALWAYS outside try/catch so NEXT_REDIRECT isn't caught). */
async function run(write: () => Promise<void>, toastKey: string, formData: FormData) {
  let errMsg: string | null = null;
  try {
    await write();
    revalidatePath(PAGE);
  } catch (e) {
    errMsg = await errorMessage(e);
  }
  if (errMsg) redirect(listAddress(formData, { error: errMsg }));
  const t = await getTranslations('employeeIdConfig.toasts');
  redirect(listAddress(formData, { toast: t(toastKey) }));
}

export async function createConfigAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '').trim() || null; // '' = GLOBAL scope
  await run(
    () =>
      createConfig(s, {
        companyId,
        templateName: String(formData.get('templateName') ?? ''),
        prefix: String(formData.get('prefix') ?? ''),
        suffix: String(formData.get('suffix') ?? ''),
        startNumber: numOrUndef(formData, 'startNumber'),
        numberLength: numOrUndef(formData, 'numberLength'),
        // increment is no longer a form field (R45 7bf025f0): new templates advance by +1 (service default).
        allowManualOverride: boolOf(formData, 'allowManualOverride'),
        status: String(formData.get('status') ?? 'active'),
      }).then(() => undefined),
    'saved',
    formData,
  );
}

export async function updateConfigAction(formData: FormData) {
  const s = await getSession();
  await run(
    () =>
      updateConfig(s, {
        id: String(formData.get('id') ?? ''),
        templateName: String(formData.get('templateName') ?? ''),
        prefix: String(formData.get('prefix') ?? ''),
        suffix: String(formData.get('suffix') ?? ''),
        startNumber: numOrUndef(formData, 'startNumber'),
        numberLength: numOrUndef(formData, 'numberLength'),
        // increment is no longer a form field (R45 7bf025f0) — the stored value is left untouched.
        allowManualOverride: boolOf(formData, 'allowManualOverride'),
        currentRunningNumber: numOrUndef(formData, 'currentRunningNumber'),
        status: String(formData.get('status') ?? 'active'),
      }).then(() => undefined),
    'saved',
    formData,
  );
}

export async function setStatusAction(formData: FormData) {
  const s = await getSession();
  await run(
    () => setStatus(s, { id: String(formData.get('id') ?? ''), status: String(formData.get('status') ?? '') }).then(() => undefined),
    'statusChanged',
    formData,
  );
}

export async function deleteConfigAction(formData: FormData) {
  const s = await getSession();
  await run(() => deleteConfig(s, { id: String(formData.get('id') ?? '') }).then(() => undefined), 'deleted', formData);
}
