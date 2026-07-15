'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { createCard, deleteCard, DuplicateCardKeyError, setStatus, updateCard } from '@/core/dashboard-card-config';

const PAGE = '/admin/settings/dashboard';

const numOrUndef = (fd: FormData, k: string): number | undefined => {
  const v = String(fd.get(k) ?? '').trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** An unchecked HTML checkbox submits NOTHING; a checked one submits 'on'. Treat presence as true. */
const boolOf = (fd: FormData, k: string): boolean => {
  const v = fd.get(k);
  return v === 'on' || v === 'true' || v === '1';
};

/** Map a known service error to its localized message; fall back to the raw message otherwise. */
async function errorMessage(e: unknown): Promise<string> {
  const t = await getTranslations('dashboardCardConfig.errors');
  if (e instanceof DuplicateCardKeyError) return t('duplicateKey');
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
  const t = await getTranslations('dashboardCardConfig.toasts');
  redirect(`${PAGE}?toast=${encodeURIComponent(t(toastKey))}`);
}

export async function createCardAction(formData: FormData) {
  const s = await getSession();
  await run(
    () =>
      createCard(s, {
        cardKey: String(formData.get('cardKey') ?? ''),
        name: String(formData.get('name') ?? ''),
        description: String(formData.get('description') ?? ''),
        cardType: String(formData.get('cardType') ?? 'information'),
        status: String(formData.get('status') ?? 'active'),
        employeeSelectable: boolOf(formData, 'employeeSelectable'),
        defaultDisplay: boolOf(formData, 'defaultDisplay'),
        mandatory: boolOf(formData, 'mandatory'),
        displayOrder: numOrUndef(formData, 'displayOrder'),
        href: String(formData.get('href') ?? ''),
      }).then(() => undefined),
    'saved',
  );
}

export async function updateCardAction(formData: FormData) {
  const s = await getSession();
  await run(
    () =>
      updateCard(s, {
        id: String(formData.get('id') ?? ''),
        // cardKey is immutable on edit (it binds the row to a renderer) — not sent from the form.
        name: String(formData.get('name') ?? ''),
        description: String(formData.get('description') ?? ''),
        cardType: String(formData.get('cardType') ?? 'information'),
        status: String(formData.get('status') ?? 'active'),
        employeeSelectable: boolOf(formData, 'employeeSelectable'),
        defaultDisplay: boolOf(formData, 'defaultDisplay'),
        mandatory: boolOf(formData, 'mandatory'),
        displayOrder: numOrUndef(formData, 'displayOrder'),
        href: String(formData.get('href') ?? ''),
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

export async function deleteCardAction(formData: FormData) {
  const s = await getSession();
  await run(() => deleteCard(s, { id: String(formData.get('id') ?? '') }).then(() => undefined), 'deleted');
}
