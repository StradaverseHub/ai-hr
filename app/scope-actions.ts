'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

/** Set the active company context (the checked companies in the top-bar switcher). */
export async function setCompanyScope(formData: FormData) {
  const ids = formData.getAll('companyId').map(String).filter(Boolean);
  const cookieStore = await cookies();
  cookieStore.set('company_scope', ids.join(','), { sameSite: 'lax', path: '/' });
  revalidatePath('/', 'layout');
}
