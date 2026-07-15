'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { editDelegation, endReportingLine, hasDownline, setReportingLine } from '@/core/org';
import { delegationsScoped, employmentPickerList, myEmployments } from '@/core/read';
import { todayInKualaLumpur } from '@/core/leave';

/**
 * Global Delegation (Phase 1) — server actions for the /delegations screen.
 *
 * Two audiences share one page:
 *   • self-service — a manager (someone with a downline) hands their OWN approver duty to a stand-in. The
 *     delegator is FORCED to the caller's own employment server-side (never a form field), so an employee
 *     cannot set up cover on someone else's behalf.
 *   • HR / super_admin — can create / edit / revoke for ANY employment.
 *
 * reporting_line RLS is tenant-only, so every action re-derives authority in code (isAdmin, own-downline,
 * own-row ownership) rather than trusting RLS to scope the write. The engine (setReportingLine /
 * editDelegation / endReportingLine) owns the overlap + window guards and the DomainEvents.
 */

function fail(msg: string): never {
  redirect(`/delegations?error=${encodeURIComponent(msg)}`);
}

function ok(): never {
  revalidatePath('/delegations');
  redirect('/delegations?toast=Saved');
}

/** Active employment ids of the current principal (the set the caller may act as delegator/own). */
async function myEmploymentIds(): Promise<string[]> {
  const s = await getSession();
  const rows = await myEmployments(s);
  return rows.map((r) => r.employmentId);
}

// ── Self-service ─────────────────────────────────────────────────────────────────────────────────

/**
 * R44 delegation (Phase 1) — data loader for the global command-bar quick-delegation modal. Returns
 * whether the caller may self-delegate (has a downline on any of their own employments) plus the stand-in
 * picker (all active employments EXCLUDING the caller's own — no self-delegation). Read-only, no event.
 * Lazily invoked from the client command bar so the app shell doesn't pay this cost on every page render.
 */
export async function loadSelfDelegationContextAction(): Promise<{
  canSelfDelegate: boolean;
  options: { employmentId: string; name: string; employeeCode: string | null }[];
}> {
  const s = await getSession();
  const today = todayInKualaLumpur();
  const mine = await myEmployments(s);
  const myIds = new Set(mine.map((m) => m.employmentId));
  let canSelfDelegate = false;
  for (const m of mine) {
    if (await hasDownline(s, m.employmentId, today)) {
      canSelfDelegate = true;
      break;
    }
  }
  if (!canSelfDelegate) return { canSelfDelegate: false, options: [] };
  const picker = await employmentPickerList(s);
  const options = picker
    .filter((p) => !myIds.has(p.employmentId))
    .map((p) => ({ employmentId: p.employmentId, name: p.name, employeeCode: p.employeeCode }));
  return { canSelfDelegate: true, options };
}

export async function createSelfDelegationAction(formData: FormData) {
  const s = await getSession();
  const today = todayInKualaLumpur();
  const validFrom = String(formData.get('validFrom') ?? '').trim() || today;
  const validTo = String(formData.get('validTo') ?? '').trim() || null;
  const delegateEmploymentId = String(formData.get('delegateEmploymentId') ?? '').trim();
  try {
    if (!delegateEmploymentId) throw new Error('Choose who will stand in for you.');
    const mine = await myEmploymentIds();
    if (mine.length === 0) throw new Error('You have no active employment to delegate from.');
    // The delegator is the caller's OWN employment that actually has a downline (an approver duty to hand
    // over). Pick the first such — self-service is only offered to managers (the create form is gated on it).
    let delegator: string | null = null;
    for (const id of mine) {
      if (await hasDownline(s, id, validFrom)) {
        delegator = id;
        break;
      }
    }
    if (!delegator) throw new Error('Only a manager with direct reports can delegate approvals.');
    // Reject self-delegation, including to another of the caller's own concurrent employments.
    if (mine.includes(delegateEmploymentId)) throw new Error('You cannot delegate approvals to yourself.');
    await setReportingLine(s, {
      subordinateEmploymentId: delegator, // forced to the caller's own employment
      managerEmploymentId: delegateEmploymentId,
      lineType: 'delegate',
      validFrom,
      validTo,
    });
  } catch (e) {
    fail((e as Error).message);
  }
  ok();
}

export async function revokeSelfDelegationAction(formData: FormData) {
  const s = await getSession();
  const reportingLineId = String(formData.get('reportingLineId') ?? '').trim();
  const endDate = String(formData.get('endDate') ?? '').trim() || todayInKualaLumpur();
  try {
    if (!reportingLineId) throw new Error('Missing delegation.');
    // Ownership guard: a self-service user may only revoke a delegation they DELEGATED (their own duty).
    const mine = new Set(await myEmploymentIds());
    const rows = await delegationsScoped(s, { isAdmin: false, history: true, asOf: todayInKualaLumpur() });
    const row = rows.find((r) => r.id === reportingLineId);
    if (!row || !mine.has(row.delegatorEmploymentId)) throw new Error('You can only revoke your own delegations.');
    await endReportingLine(s, { reportingLineId, endDate });
  } catch (e) {
    fail((e as Error).message);
  }
  ok();
}

// ── HR / super_admin management (any employment) ───────────────────────────────────────────────────

async function requireAdminSession() {
  const s = await getSession();
  if (!isAdmin(s)) fail('Only HR can manage delegations on behalf of employees.');
  return s;
}

export async function hrCreateDelegationAction(formData: FormData) {
  const s = await requireAdminSession();
  const today = todayInKualaLumpur();
  const delegatorEmploymentId = String(formData.get('delegatorEmploymentId') ?? '').trim();
  const delegateEmploymentId = String(formData.get('delegateEmploymentId') ?? '').trim();
  const validFrom = String(formData.get('validFrom') ?? '').trim() || today;
  const validTo = String(formData.get('validTo') ?? '').trim() || null;
  try {
    if (!delegatorEmploymentId) throw new Error('Choose the employee handing over their approvals.');
    if (!delegateEmploymentId) throw new Error('Choose the stand-in approver.');
    if (delegatorEmploymentId === delegateEmploymentId) throw new Error('The stand-in must be a different person.');
    await setReportingLine(s, {
      subordinateEmploymentId: delegatorEmploymentId,
      managerEmploymentId: delegateEmploymentId,
      lineType: 'delegate',
      validFrom,
      validTo,
    });
  } catch (e) {
    fail((e as Error).message);
  }
  ok();
}

export async function hrEditDelegationAction(formData: FormData) {
  const s = await requireAdminSession();
  const reportingLineId = String(formData.get('reportingLineId') ?? '').trim();
  const delegateEmploymentId = String(formData.get('delegateEmploymentId') ?? '').trim();
  const validFrom = String(formData.get('validFrom') ?? '').trim() || todayInKualaLumpur();
  const validTo = String(formData.get('validTo') ?? '').trim() || null;
  try {
    if (!reportingLineId) throw new Error('Missing delegation.');
    if (!delegateEmploymentId) throw new Error('Choose the stand-in approver.');
    await editDelegation(s, { reportingLineId, managerEmploymentId: delegateEmploymentId, validFrom, validTo });
  } catch (e) {
    fail((e as Error).message);
  }
  ok();
}

export async function hrRevokeDelegationAction(formData: FormData) {
  const s = await requireAdminSession();
  const reportingLineId = String(formData.get('reportingLineId') ?? '').trim();
  const endDate = String(formData.get('endDate') ?? '').trim() || todayInKualaLumpur();
  try {
    if (!reportingLineId) throw new Error('Missing delegation.');
    await endReportingLine(s, { reportingLineId, endDate });
  } catch (e) {
    fail((e as Error).message);
  }
  ok();
}
