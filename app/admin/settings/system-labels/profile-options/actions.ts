'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  createProfileOption,
  deleteProfileOption,
  seedProfileOptions,
  setProfileOptionActive,
  updateProfileOption,
} from '@/core/profile-options';

// fbdeee87: Profile Options relocated into the System Labels surface as a tab. These are the SAME five
// core functions the standalone page called (core/profile-options.ts UNCHANGED — this is a UI/navigation
// consolidation, not a data merge); only the redirect BASE moves onto the System Labels path so a
// create/edit/activate/delete/seed keeps the admin on the Profile Options tab.
const BASE = '/admin/settings/system-labels/profile-options';
// c9986927: the eight organisation categories are now edited from the Organisation Labels tab, which reads
// the SAME catalog through the SAME two grid actions below — so a save there must revalidate that page too,
// or the rail counts and rows would keep serving the pre-edit render.
const ORG_LABELS = '/admin/settings/system-labels';
const fail = (e: unknown) => redirect(`${BASE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
const numOrNull = (v: FormDataEntryValue | null): number | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : Number(s);
};

export async function createProfileOptionAction(formData: FormData) {
  const s = await getSession();
  try {
    await createProfileOption(s, {
      category: String(formData.get('category') ?? ''),
      value: String(formData.get('value') ?? ''),
      label: String(formData.get('label') ?? '') || null,
      description: String(formData.get('description') ?? '') || null,
      sortOrder: numOrNull(formData.get('sortOrder')),
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Option added')}`);
}

export async function updateProfileOptionAction(formData: FormData) {
  const s = await getSession();
  try {
    await updateProfileOption(s, {
      id: String(formData.get('id')),
      label: String(formData.get('label') ?? ''),
      description: String(formData.get('description') ?? ''),
      sortOrder: numOrNull(formData.get('sortOrder')),
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Option updated')}`);
}

export async function setProfileOptionActiveAction(formData: FormData) {
  const s = await getSession();
  try {
    await setProfileOptionActive(s, {
      id: String(formData.get('id')),
      isActive: formData.get('isActive') === 'true',
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Saved')}`);
}

export async function deleteProfileOptionAction(formData: FormData) {
  const s = await getSession();
  try {
    await deleteProfileOption(s, String(formData.get('id')));
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Option deleted')}`);
}

/** Seed the default catalog for this tenant (idempotent — safe to click repeatedly). */
export async function seedProfileOptionsAction() {
  const s = await getSession();
  try {
    await seedProfileOptions(s);
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Defaults added')}`);
}

// 15277676 — the Excel-style Profile Options grid batches all pending edits into ONE Save. This value-
// returning action fans the batch out across the SAME five core mutations the per-row forms used, so each
// create / update / (de)activate still appends its own DomainEvent (substrate coverage unchanged). Row-level
// failures are collected and returned so the grid can highlight the offending cell without losing the rest.
export type ProfileOptionSaveResult =
  | { ok: true; created: number; updated: number; createdIds: { key: string; id: string }[] }
  | { ok: false; rowErrors: { key: string; message: string }[]; message?: string };

export async function saveProfileOptionsAction(payload: {
  creates: { key: string; category: string; value: string; label: string; description: string; sortOrder: number }[];
  updates: { key: string; id: string; label: string; description: string; sortOrder: number; setActive: boolean | null }[];
}): Promise<ProfileOptionSaveResult> {
  const s = await getSession();
  const rowErrors: { key: string; message: string }[] = [];
  const createdIds: { key: string; id: string }[] = [];
  let created = 0;
  let updated = 0;

  for (const c of payload.creates) {
    try {
      const { id } = await createProfileOption(s, {
        category: c.category,
        value: c.value,
        label: c.label || null,
        description: c.description || null,
        sortOrder: c.sortOrder,
      });
      createdIds.push({ key: c.key, id });
      created += 1;
    } catch (e) {
      rowErrors.push({ key: c.key, message: publicErrorMessage(e) });
    }
  }

  for (const u of payload.updates) {
    try {
      await updateProfileOption(s, {
        id: u.id,
        label: u.label,
        description: u.description,
        sortOrder: u.sortOrder,
      });
      // Active state lives on a separate core mutation (its own activated/deactivated event); only fire it
      // when the row's status actually changed, so a plain label edit never emits a spurious status event.
      if (u.setActive !== null) {
        await setProfileOptionActive(s, { id: u.id, isActive: u.setActive });
      }
      updated += 1;
    } catch (e) {
      rowErrors.push({ key: u.key, message: publicErrorMessage(e) });
    }
  }

  if (rowErrors.length > 0) {
    return { ok: false, rowErrors, message: undefined };
  }
  revalidatePath(BASE);
  revalidatePath(ORG_LABELS);
  return { ok: true, created, updated, createdIds };
}

/** Delete a single option (immediate, from the grid's row action). Returns ok/message rather than redirecting. */
export async function removeProfileOptionAction(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const s = await getSession();
  try {
    await deleteProfileOption(s, id);
  } catch (e) {
    return { ok: false, message: publicErrorMessage(e) };
  }
  revalidatePath(BASE);
  revalidatePath(ORG_LABELS);
  return { ok: true };
}
