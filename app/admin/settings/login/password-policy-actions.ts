'use server';
import { getSession } from '@/lib/session';
import { savePasswordPolicy,readPasswordPolicy } from '@/core/password-policy';
import { revalidatePath } from 'next/cache';
export type PasswordPolicyResult = { status: 'idle' | 'saved' | 'invalid' | 'conflict' | 'forbidden' | 'unavailable'; revision?: number };
export async function savePasswordPolicyAction(_previous: PasswordPolicyResult, form: FormData): Promise<PasswordPolicyResult> {
  const ctx = await getSession();
  try {
    const current=await readPasswordPolicy(ctx);
    const saved = await savePasswordPolicy(ctx, { ...(current.policy.requirements?{requirements:current.policy.requirements}:{}), enabled: form.get('enabled') === 'on', interval: Number(form.get('interval')), unit: form.get('unit') }, Number(form.get('revision')));
    revalidatePath('/admin/settings/login');
    return { status: 'saved', revision: saved.revision };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { status: ['invalid', 'conflict', 'forbidden'].includes(code) ? code as 'invalid' | 'conflict' | 'forbidden' : 'unavailable' };
  }
}
