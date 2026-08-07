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
  createEmployeeDraftWithReservedCode,
  discardEmployeeDraft,
  isEmployeeCodeTaken,
  saveEmployeeDraft,
} from '@/core/employee-draft';
import { normalizeEmployeeCode } from '@/lib/employee-code';
import type { EmployeeDraftData } from '@/lib/employee-draft-schema';

/**
 * The short Create screen (item 06f0cb8f). Four fields in, a Draft with a HELD Employee ID out.
 *
 * The service does the validating, the rule resolution and the reservation in ONE transaction — this
 * action only carries the four values across and revalidates the two screens the new row appears on
 * (the employee list, where Drafts are now rows, and this route, which the caller is about to reopen
 * with `?draft=`).
 */
export async function createDraftAction(p: {
  companyId: string;
  fullName: string;
  primaryEmail: string;
  employeeIdMode?: string;
  employeeCode?: string;
}): Promise<{ id: string; employeeCode: string }> {
  const s = await requireAdmin();
  const out = await createEmployeeDraftWithReservedCode(s, p);
  revalidatePath('/admin/personnel');
  revalidatePath('/admin/personnel/new');
  return out;
}

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

/**
 * Item bd271009 — is this hand-keyed Employee ID already taken? Called on blur so the clash is named
 * while HR is still looking at the field, instead of surfacing as a refusal at the very last button.
 *
 * ADVISORY. `hireEmployee` re-checks and the tenant-wide unique index is the real net; a "free" answer
 * here can be overtaken by a concurrent hire and that is accepted, because the cost is the old behaviour
 * (a clear refusal at create) rather than a bad ID.
 */
export async function checkEmployeeCodeAction(code: string): Promise<{ code: string; taken: boolean }> {
  const s = await requireAdmin();
  const normalized = normalizeEmployeeCode(code);
  return { code: normalized, taken: normalized === '' ? false : await isEmployeeCodeTaken(s, normalized) };
}

export async function discardDraftAction(id: string): Promise<void> {
  const s = await requireAdmin();
  await discardEmployeeDraft(s, id);
  // The employee list too (item 06f0cb8f): a Draft is a ROW there now, not a card above the table.
  revalidatePath('/admin/personnel');
  revalidatePath('/admin/personnel/new');
}

/**
 * ACTIVATE (item 06f0cb8f — this was "Create Employee" on the old Review step). Saves whatever is on
 * screen FIRST (so the draft on the server is what gets activated — never a stale copy from an earlier
 * step), then completes it, which turns the held Employee ID into a real employment carrying that ID.
 */
export async function createEmployeeAction(
  id: string | undefined,
  data: EmployeeDraftData,
  currentStep: number,
): Promise<{ employmentId: string }> {
  const s = await requireAdmin();
  const saved = await saveEmployeeDraft(s, { id: id || undefined, data, currentStep });
  const out = await completeEmployeeDraft(s, saved.id);
  revalidatePath('/admin/personnel');
  revalidatePath('/admin/personnel/new');
  return out;
}
