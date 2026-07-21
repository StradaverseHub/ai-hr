'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { approverLevelOf, editDelegation, endReportingLine, hasDownline, setReportingLine, type DelegationOrgScope } from '@/core/org';
import { delegationsScoped, eligibleDelegates, employmentPickerList, myEmployments, type EligibleDelegateRow } from '@/core/read';
import { todayInKualaLumpur } from '@/core/leave';
import {
  expandScopeTasks,
  isDelegationModule,
  isDelegationScopeGroup,
  isDelegationTaskType,
  moduleOfTask,
  type DelegationScopeGroupId,
  type DelegationTaskType,
} from '@/lib/delegation-scope';

/**
 * R44 delegation (Phase 2) — parse the scope picker's form fields into (reason, scope rows). A checked
 * module with no checked task = the WHOLE module (taskType null); with tasks = those tasks; ZERO modules =
 * whole-scope (empty list). Reason is required (the UI marks it *, this is the server-side guard).
 *
 * R51 (20f09fc3): `scopeGroup` values are TRANSIENT — each group expands to its LEAF task ids here
 * (expandScopeTasks: a bare group covers ALL its leaves; submitted leaves narrow it), then the existing
 * per-module branch runs unchanged over the expanded leaf list. Group ids are never stored: a forged/stale
 * `scopeTask` carrying a group id is dropped by isDelegationTaskType (group ids are not in the task set),
 * and a submitted group whose module checkbox is unticked is inert (the module loop keeps only tasks of
 * checked modules).
 */
function parseScopeAndReason(formData: FormData): {
  reason: string;
  scopes: { module: string; taskType: string | null }[];
} {
  const reason = String(formData.get('reason') ?? '').trim();
  const modules = formData.getAll('scopeModule').map(String).filter(isDelegationModule);
  const groups = formData.getAll('scopeGroup').map(String).filter(isDelegationScopeGroup) as DelegationScopeGroupId[];
  const rawTasks = formData.getAll('scopeTask').map(String).filter(isDelegationTaskType) as DelegationTaskType[];
  const tasks = expandScopeTasks(groups, rawTasks);
  const scopes: { module: string; taskType: string | null }[] = [];
  for (const m of modules) {
    const mtasks = tasks.filter((tk) => moduleOfTask[tk] === m);
    if (mtasks.length) scopes.push(...mtasks.map((tk) => ({ module: m, taskType: tk as string })));
    else scopes.push({ module: m, taskType: null });
  }
  return { reason, scopes };
}

/**
 * R51 (baf56348) — parse the Delegation Coverage cascade (company → business unit → department). Blank at a
 * level = everything under the level above; all blank = unrestricted. The ids are re-validated server-side
 * by the engine (parent-chain consistency in insertDelegateLineTx) — client filtering is not trusted.
 */
function parseOrgScope(formData: FormData): DelegationOrgScope {
  const pick = (name: string) => {
    const v = String(formData.get(name) ?? '').trim();
    return v ? v : null;
  };
  return {
    companyId: pick('scopeCompanyId'),
    businessUnitId: pick('scopeBusinessUnitId'),
    departmentId: pick('scopeDepartmentId'),
  };
}

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
  // R51 (baf56348): the gate is hasDownline OR an approver level (a pure department/BU head with no
  // administrative reports clearly holds approval duties, so they can now set up cover too).
  let delegator: string | null = null;
  for (const m of mine) {
    if (
      (await hasDownline(s, m.employmentId, today)) ||
      (await approverLevelOf(s, m.employmentId, today)) !== 'none'
    ) {
      delegator = m.employmentId;
      break;
    }
  }
  if (!delegator) return { canSelfDelegate: false, options: [] };
  // R51: the quick modal obeys the same-level rule — candidates come from the SECURITY-DEFINER eligible
  // list (same-rank approvers across the org), not the raw employee picker, so the shortcut is no side door.
  // (The engine-level guard in setReportingLine backstops it regardless.)
  const candidates = await eligibleDelegates(s, delegator);
  const options = candidates.map((p) => ({ employmentId: p.employmentId, name: p.name, employeeCode: null }));
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
    // The delegator is the caller's OWN employment that actually holds an approver duty to hand over: a
    // downline OR (R51) a department/BU headship — a pure head with no administrative reports can now
    // delegate. Picked server-side (never a form field), so an employee cannot delegate on someone's behalf.
    let delegator: string | null = null;
    for (const id of mine) {
      if (
        (await hasDownline(s, id, validFrom)) ||
        (await approverLevelOf(s, id, todayInKualaLumpur())) !== 'none'
      ) {
        delegator = id;
        break;
      }
    }
    if (!delegator) throw new Error('Only an approver (a manager or a department/business unit head) can delegate approvals.');
    // Reject self-delegation, including to another of the caller's own concurrent employments.
    if (mine.includes(delegateEmploymentId)) throw new Error('You cannot delegate approvals to yourself.');
    const { reason, scopes } = parseScopeAndReason(formData);
    if (!reason) throw new Error('Please give a reason for the delegation.');
    await setReportingLine(s, {
      subordinateEmploymentId: delegator, // forced to the caller's own employment
      managerEmploymentId: delegateEmploymentId,
      lineType: 'delegate',
      validFrom,
      validTo,
      reason,
      scopes,
      orgScope: parseOrgScope(formData),
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

/**
 * R51 (baf56348) — stand-in candidates for the HR create form, fired once when HR picks the delegator (NOT
 * on coverage changes — the cascade filters client-side). Re-checks the admin role; the SECURITY-DEFINER
 * eligible list additionally self-guards, so this cannot become a directory-enumeration side door.
 */
export async function loadEligibleDelegatesAction(delegatorEmploymentId: string): Promise<EligibleDelegateRow[]> {
  const s = await getSession();
  if (!isAdmin(s)) return [];
  const id = String(delegatorEmploymentId ?? '').trim();
  if (!id) return [];
  return eligibleDelegates(s, id);
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
    const { reason, scopes } = parseScopeAndReason(formData);
    if (!reason) throw new Error('Please give a reason for the delegation.');
    await setReportingLine(s, {
      subordinateEmploymentId: delegatorEmploymentId,
      managerEmploymentId: delegateEmploymentId,
      lineType: 'delegate',
      validFrom,
      validTo,
      reason,
      scopes,
      orgScope: parseOrgScope(formData),
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
    const { reason, scopes } = parseScopeAndReason(formData);
    if (!reason) throw new Error('Please give a reason for the delegation.');
    await editDelegation(s, {
      reportingLineId,
      managerEmploymentId: delegateEmploymentId,
      validFrom,
      validTo,
      reason,
      scopes,
      orgScope: parseOrgScope(formData),
    });
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
