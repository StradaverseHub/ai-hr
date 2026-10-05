'use server';

import { publicErrorMessage } from '@/lib/public-error';
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

/** The checked audience roles (9606c59f). The service normalises + falls back to employee when empty. */
const audienceOf = (fd: FormData): string[] => fd.getAll('audience').map((v) => String(v));

/** Map a known service error to its localized message; fall back to the raw message otherwise. */
async function errorMessage(e: unknown): Promise<string> {
  const t = await getTranslations('dashboardCardConfig.errors');
  if (e instanceof DuplicateCardKeyError) return t('duplicateKey');
  return publicErrorMessage(e);
}

/**
 * The view to come back to (9da61c86 — "keep your search, filter and page position when you add or edit a
 * record and come back").
 *
 * This screen is worse off than most without it: the redirect was a bare `${PAGE}?toast=`, and PAGE opens
 * on the Card Library only because `library` is the default section — so saving a card dropped the admin's
 * search, type and status filters AND their page, on a screen whose whole purpose is to find one card
 * among many. A server action reads the FORM, never the address it was posted from, so the page sends its
 * view as `returnTo` and this reads it back.
 *
 * Only the keys this screen owns are re-emitted, so nothing a hand-edited form could put in that field can
 * reach the redirect.
 */
const RETURN_KEYS = ['section', 'q', 'type', 'status', 'page', 'size'] as const;

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
  const t = await getTranslations('dashboardCardConfig.toasts');
  redirect(listAddress(formData, { toast: t(toastKey) }));
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
        audience: audienceOf(formData),
      }).then(() => undefined),
    'saved',
    formData,
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
        audience: audienceOf(formData),
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

export async function deleteCardAction(formData: FormData) {
  const s = await getSession();
  await run(() => deleteCard(s, { id: String(formData.get('id') ?? '') }).then(() => undefined), 'deleted', formData);
}
