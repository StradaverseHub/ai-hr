'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { reconcileReadinessCases } from '@/core/hr-orchestrator';

/** Refreshes coordination evidence only. Never sends reminders or runs a model on a page request. */
export async function refreshOrchestrationAction() {
  const session = await requireAdmin();
  try { await reconcileReadinessCases(session); }
  catch { redirect('/control-tower?refresh=failed'); }
  revalidatePath('/control-tower');
  redirect('/control-tower?refresh=complete');
}
