'use server';

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
const fail = (e: unknown) => redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
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
