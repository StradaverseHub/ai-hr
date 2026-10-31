'use server';
import { redirect } from 'next/navigation';
import { internalSelected } from '@/lib/internal-auth/config';
import { validOpaque } from '@/lib/internal-auth/crypto';
import { endInternalSession } from '@/lib/internal-auth/web-session';
/** Explicit cookie/family revocation before opening an invitation for another account. */
export async function switchInvitationAccount(form: FormData) {
  const token = form.get('token');
  if (!internalSelected() || !validOpaque(token)) redirect('/login');
  return endInternalSession(`/invite/${token}/activate`);
}
