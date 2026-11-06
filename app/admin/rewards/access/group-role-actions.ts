'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { publicErrorMessage } from '@/lib/public-error';
import { getSession } from '@/lib/session';
import { saveRewardGroupRole } from '@/packs/rewards/group-roles';

export async function saveRewardGroupRoleAction(form: FormData) {
  let error: string | undefined;
  try {
    const operation = form.get('operation');
    if (operation !== 'grant' && operation !== 'revoke') throw Error('Choose Grant or Revoke.');
    await saveRewardGroupRole(await getSession(), {
      userId: form.get('userId'),
      role: form.get('role'),
      active: operation === 'grant',
      revision: Number(form.get('revision')),
      reason: form.get('reason'),
    });
    revalidatePath('/admin/rewards', 'layout');
    revalidatePath('/rewards', 'layout');
  } catch (cause) {
    error = publicErrorMessage(cause);
  }

  const params = new URLSearchParams({ tab: 'users' });
  if (error) params.set('groupRoleError', error);
  redirect('/admin/rewards/access?' + params.toString() + '#whole-group-roles');
}
