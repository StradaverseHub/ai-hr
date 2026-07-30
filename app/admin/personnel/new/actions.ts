'use server';

/**
 * Create New Employee wizard — server actions (item 6d671f44).
 *
 * These take TYPED ARGUMENTS, not FormData, because the wizard is one long-lived client form whose
 * state spans several steps: serialising it to FormData and back on every save would be a second
 * representation of the draft to keep in step with `EmployeeDraftData`. The services re-validate
 * everything (`missingForCreation`, then each writer's own gates), so nothing here is trusted.
 */
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import {
  completeEmployeeDraft,
  discardEmployeeDraft,
  saveEmployeeDraft,
} from '@/core/employee-draft';
import type { EmployeeDraftData } from '@/lib/employee-draft-schema';

export async function saveDraftAction(
  id: string | undefined,
  data: EmployeeDraftData,
  currentStep: number,
): Promise<{ id: string }> {
  const s = await requireAdmin();
  const out = await saveEmployeeDraft(s, { id: id || undefined, data, currentStep });
  revalidatePath('/admin/personnel/new');
  return out;
}

export async function discardDraftAction(id: string): Promise<void> {
  const s = await requireAdmin();
  await discardEmployeeDraft(s, id);
  revalidatePath('/admin/personnel/new');
}

/**
 * Final step. Saves whatever is on screen FIRST (so the draft on the server is what gets created —
 * never a stale copy from an earlier step), then completes it.
 */
export async function createEmployeeAction(
  id: string | undefined,
  data: EmployeeDraftData,
): Promise<{ employmentId: string }> {
  const s = await requireAdmin();
  const saved = await saveEmployeeDraft(s, { id: id || undefined, data, currentStep: 5 });
  const out = await completeEmployeeDraft(s, saved.id);
  revalidatePath('/admin/personnel');
  revalidatePath('/admin/personnel/new');
  return out;
}
