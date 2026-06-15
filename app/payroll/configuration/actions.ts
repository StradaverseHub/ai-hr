'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { packFor } from '@/localization/registry';
import { StatutoryRulesetInvalidError } from '@/localization/my/statutory-config';
import type { StatutoryRuleset } from '@/localization/my/statutory-tables';

const BASE = '/payroll/configuration';

/** Publish a new effective-dated statutory version (admin; RLS enforces the write). */
export async function saveStatutoryAction(formData: FormData) {
  const s = await getSession();
  const pack = packFor('MY');
  if (!pack) redirect(`${BASE}?error=${encodeURIComponent('No localization pack for MY.')}`);

  const version = String(formData.get('version') ?? '').trim();
  const effectiveFrom = String(formData.get('effectiveFrom') ?? '');
  const notes = String(formData.get('notes') ?? '').trim() || null;

  let data: StatutoryRuleset;
  try {
    data = JSON.parse(String(formData.get('data') ?? '')) as StatutoryRuleset;
  } catch {
    redirect(`${BASE}?edit=1&error=${encodeURIComponent('Malformed configuration payload.')}`);
  }

  try {
    await pack!.statutoryConfig.save(s, { version, effectiveFrom, data, notes });
  } catch (e) {
    const msg = e instanceof StatutoryRulesetInvalidError ? e.problems.join('; ') : (e as Error).message;
    redirect(`${BASE}?edit=1&error=${encodeURIComponent(msg)}`);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Statutory version published')}`);
}

/** Archive a stored version so the active resolution skips it (admin). */
export async function archiveStatutoryAction(formData: FormData) {
  const s = await getSession();
  const pack = packFor('MY');
  if (!pack) redirect(`${BASE}?error=${encodeURIComponent('No localization pack for MY.')}`);
  const id = String(formData.get('id') ?? '');
  try {
    await pack!.statutoryConfig.archive(s, id);
  } catch (e) {
    redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Version archived')}`);
}
