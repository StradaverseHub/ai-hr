'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getBrowserCommandSession } from '@/lib/session';
import { setAssistantLauncher } from '@/core/assistant-launcher';
import { aiManagementHref } from './sections';

/** Floating Assistant button settings. Group administrators only (the owner re-proves it); the form posts
 * only closed values, and a refusal shows a fixed sentence, never the underlying error. */
export async function setAssistantLauncherAction(formData: FormData) {
  try {
    const session = await getBrowserCommandSession();
    await setAssistantLauncher(session, {
      enabled: formData.get('enabled') === 'yes',
      position: String(formData.get('position') ?? ''),
      hiddenAreas: formData.getAll('hidden').map(value => String(value)),
    });
  } catch { redirect(aiManagementHref('assistant', { error: 'launcher', anchor: '#ai-launcher' })); }
  revalidatePath('/', 'layout');
  redirect(aiManagementHref('assistant', { toast: 'saved', anchor: '#ai-launcher' }));
}
