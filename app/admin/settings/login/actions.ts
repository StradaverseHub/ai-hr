'use server';
import { getSession } from '@/lib/session';
import { saveLoginPresentation } from '@/core/login-presentation';
import { saveSessionPolicy } from '@/core/session-policy';
import { forgetIdleTimeout } from '@/lib/session-policy-server';
import { revalidatePath } from 'next/cache';
export type LoginPresentationResult = { status: 'idle' | 'saved' | 'invalid' | 'conflict' | 'forbidden' | 'unavailable'; revision?: number };
export async function saveLoginPresentationAction(_previous: LoginPresentationResult, form: FormData): Promise<LoginPresentationResult> {
  const ctx = await getSession();
  try {
    const saved = await saveLoginPresentation(ctx, { mediaType: form.get('mediaType'), mediaUrl: form.get('mediaUrl'), alt: form.get('alt'), iconUrl: form.get('iconUrl') }, Number(form.get('revision')));
    revalidatePath('/admin/settings/login'); revalidatePath('/login');
    return { status: 'saved', revision: saved.revision };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { status: ['invalid', 'conflict', 'forbidden'].includes(code) ? code as 'invalid' | 'conflict' | 'forbidden' : 'unavailable' };
  }
}

export type SessionPolicyResult = { status: 'idle' | 'saved' | 'invalid' | 'conflict' | 'forbidden' | 'unavailable'; revision?: number };
/** ADR-0171: the organization's idle sign-out limit; the owner validates bounds and authority again. */
export async function saveSessionPolicyAction(_previous: SessionPolicyResult, form: FormData): Promise<SessionPolicyResult> {
  const ctx = await getSession();
  try {
    const saved = await saveSessionPolicy(ctx, form.get('idleTimeoutMinutes'), Number(form.get('revision')));
    forgetIdleTimeout(ctx.tenantId);
    revalidatePath('/admin/settings/login');
    return { status: 'saved', revision: saved.revision };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { status: ['invalid', 'conflict', 'forbidden'].includes(code) ? code as 'invalid' | 'conflict' | 'forbidden' : 'unavailable' };
  }
}
