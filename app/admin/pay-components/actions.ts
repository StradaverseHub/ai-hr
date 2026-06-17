'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { archivePayComponent, seedPayComponentCatalog, upsertPayComponent } from '@/core/pay-components';

const PAGE = '/admin/pay-components';
const back = (toast: string) => redirect(`${PAGE}?toast=${encodeURIComponent(toast)}`);
const fail = (e: unknown) => redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);

export async function seedCatalogAction() {
  const s = await getSession();
  try {
    const r = await seedPayComponentCatalog(s);
    revalidatePath(PAGE);
    back(`Seeded default catalog (${r.created} added)`);
  } catch (e) {
    fail(e);
  }
}

const bool = (fd: FormData, name: string) => fd.get(name) === 'on';

export async function upsertComponentAction(formData: FormData) {
  const s = await getSession();
  const rawKind = String(formData.get('kind') ?? 'allowance');
  const kind = (['allowance', 'deduction', 'contribution', 'non_payable'] as const).includes(rawKind as never)
    ? (rawKind as 'allowance' | 'deduction' | 'contribution' | 'non_payable')
    : 'allowance';
  try {
    await upsertPayComponent(s, {
      code: String(formData.get('code') ?? '').trim().toUpperCase(),
      name: String(formData.get('name') ?? '').trim(),
      kind,
      includedInEpf: bool(formData, 'includedInEpf'),
      includedInSocsoEis: bool(formData, 'includedInSocsoEis'),
      includedInPcb: bool(formData, 'includedInPcb'),
      includedInHrdfBase: bool(formData, 'includedInHrdfBase'),
      isNonPayable: kind === 'non_payable',
      prorates: bool(formData, 'prorates'),
    });
    revalidatePath(PAGE);
    back('Component saved');
  } catch (e) {
    fail(e);
  }
}

export async function archiveComponentAction(formData: FormData) {
  const s = await getSession();
  try {
    await archivePayComponent(s, String(formData.get('id')));
    revalidatePath(PAGE);
    back('Component archived');
  } catch (e) {
    fail(e);
  }
}
