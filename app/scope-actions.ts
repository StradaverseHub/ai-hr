'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { inquiryScopeReturnPath } from '@/lib/leave-inquiry-query';

/** Set the active company context (the checked companies in the top-bar switcher). */
export async function setCompanyScope(formData: FormData) {
  const cookieStore = await cookies();
  // Absence resolves to the caller's current authorized companies in getScopeIds.
  if (formData.get('scopeMode') === 'all') {
    cookieStore.delete('company_scope');
  } else {
    const ids = formData.getAll('companyId').map(String).filter(Boolean);
    cookieStore.set('company_scope', ids.join(','), { sameSite: 'lax', path: '/' });
  }
  revalidatePath('/', 'layout');
  const returnPath = inquiryScopeReturnPath(formData.get('returnPath'));
  if (returnPath) redirect(returnPath);
}
