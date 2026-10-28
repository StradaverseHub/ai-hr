'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { reconcileReadinessCases } from '@/core/hr-orchestrator';

/** Refreshes coordination evidence only. Never sends reminders or runs a model on a page request. */
export async function refreshOrchestrationAction(formData?: FormData) {
  // AI management shows the queue on its own sub-menu page, so return there rather than to Needs attention.
  const target = formData?.get('returnTo') === '/control-tower/agents' ? '/control-tower/agents/orchestrator?' : '/control-tower?';
  const session = await requireAdmin();
  try { await reconcileReadinessCases(session); }
  catch { redirect(`${target}refresh=failed`); }
  revalidatePath('/control-tower');
  revalidatePath('/control-tower/agents');
  redirect(`${target}refresh=complete`);
}
