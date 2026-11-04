'use server';
import { getSession } from '@/lib/session';
import { saveRememberedMfaPolicy } from '@/core/remembered-mfa-policy';
import { revalidatePath } from 'next/cache';
export type RememberedMfaResult = { status: 'idle' | 'saved' | 'invalid' | 'conflict' | 'forbidden' | 'unavailable'; revision?: number };
export async function saveRememberedMfaAction(_previous: RememberedMfaResult, form: FormData): Promise<RememberedMfaResult> {
  const ctx = await getSession();
  try {
    const raw = form.get('rememberDays'), revision = form.get('revision');
    if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw) || typeof revision !== 'string' || !/^\d+$/.test(revision)) throw new Error('invalid');
    const saved = await saveRememberedMfaPolicy(ctx, { rememberDays: Number(raw) }, Number(revision));
    revalidatePath('/admin/security-center/password-policy');
    return { status: 'saved', revision: saved.revision };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { status: ['invalid', 'conflict', 'forbidden'].includes(code) ? code as 'invalid' | 'conflict' | 'forbidden' : 'unavailable' };
  }
}
