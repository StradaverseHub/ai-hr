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
import {randomBytes} from 'node:crypto';
import type {DraftActivateActionResult,DraftDeleteActionResult} from '@/lib/draft-action-result';
import { requireAdmin } from '@/lib/authz';
import {
  saveAndCompleteEmployeeDraft,
  draftActivationValidation,
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

/** Unknown failures are private server diagnostics; the browser receives only a reportable reference. */
function draftFailure(operation: 'activate' | 'delete', error: unknown): {ok:false;kind:'system';reference:string} {
  const reference = `DRAFT-${randomBytes(4).toString('hex').toUpperCase()}`;
  console.error(`[Draft ${operation} failure ${reference}]`, error);
  return {ok:false,kind:'system',reference};
}
function refreshDraftRoutes(): void {
  // Persistence already committed. A cache-refresh fault must not turn a completed action into a
  // reported rollback; the client navigates and refreshes its destination after ok:true.
  try { revalidatePath('/admin/personnel'); revalidatePath('/admin/personnel/new'); }
  catch (error) { console.error('[Draft committed; route refresh failed]',error); }
}
export async function discardDraftAction(id: string): Promise<DraftDeleteActionResult> {
  const session = await requireAdmin();
  try {
    await discardEmployeeDraft(session, id);
    refreshDraftRoutes();
    return {ok:true};
  } catch(error) { return draftFailure('delete',error); }
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
): Promise<DraftActivateActionResult> {
  const session = await requireAdmin();
  try {
    const result = await saveAndCompleteEmployeeDraft(session,{id:id || undefined,data,currentStep});
    refreshDraftRoutes();
    return {ok:true,...result};
  } catch(error) {
    const validation = draftActivationValidation(error);
    return validation ? {ok:false,kind:'validation',...validation} : draftFailure('activate',error);
  }
}
