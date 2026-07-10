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

const BASE = '/admin/settings/profile-options';
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
