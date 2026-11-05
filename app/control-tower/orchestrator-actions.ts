'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { reconcileReadinessCases } from '@/core/hr-orchestrator';

/** Refreshes coordination evidence only. Never sends reminders or runs a model on a page request. The queue is part of
 * Operations › Record readiness (AI Centre restructure, 4 Nov 2026), so every refresh returns there. */
export async function refreshOrchestrationAction() {
  const target = '/control-tower/readiness?';
  const session = await requireAdmin();
  try { await reconcileReadinessCases(session); }
  catch { redirect(`${target}refresh=failed`); }
  revalidatePath('/control-tower/readiness');
  redirect(`${target}refresh=complete`);
}
