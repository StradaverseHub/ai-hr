'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { approverLevelOf, editDelegation, endReportingLine, hasDownline, setReportingLine, type DelegationOrgScope } from '@/core/org';
import {
  delegationsScoped,
  eligibleDelegates,
  employmentPickerList,
  listCompanies,
  listDepartments,
  myEmployments,
  type DelegationScopedRow,
  type EligibleDelegateRow,
} from '@/core/read';
import { listBusinessUnits } from '@/core/admin';
import { todayInKualaLumpur } from '@/core/leave';
import type { OrgScopeMasters } from '@/components/delegation-org-scope-picker';
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
 * Global Delegation (Phase 1) — server actions for the /delegations screen AND the command-bar quick popup
 * (popup parity, feedback 29fe2d45). Two audiences share one surface component:
 *   • self-service — a manager (someone with a downline) hands their OWN approver duty to a stand-in. The
 *     delegator is FORCED to the caller's own employment server-side (never a form field), so an employee
 *     cannot set up cover on someone else's behalf.
 *   • HR / super_admin — can create / edit / revoke for ANY employment.
 *
 * reporting_line RLS is tenant-only, so every action re-derives authority in code (isAdmin, own-downline,
 * own-row ownership) rather than trusting RLS to scope the write. The engine (setReportingLine /
 * editDelegation / endReportingLine) owns the overlap + window guards and the DomainEvents.
 *
 * Popup parity (29fe2d45): every mutating action returns a UNIFORM result — { ok: true } after a
 * revalidatePath('/delegations'), or { ok: false, error } — instead of the old fail()/ok() redirect pair
 * (precedent: app/roster/actions.ts CellResult). Both surfaces render the outcome inline via
 * useActionState, so saving inside the popup never hard-navigates the user away.
 */

export type DelegationActionResult = { ok: true } | { ok: false; error: string };

/** Active employment ids of the current principal (the set the caller may act as delegator/own). */
async function myEmploymentIdList(): Promise<string[]> {
  const s = await getSession();
  const rows = await myEmployments(s);
  return rows.map((r) => r.employmentId);
}

// ── Shared context loader (popup parity, feedback 29fe2d45) ────────────────────────────────────────

/**
 * One loader for BOTH surfaces (the /delegations page hydration + the command-bar popup, plus every
 * refetch after a save or a history toggle). Everything role-dependent is derived from the SESSION —
 * `admin` comes ONLY from isAdmin(session), never a client flag, because the admin branch exposes
 * tenant-wide rows + the employment picker. `history` is honored only for admins (matching the page).
 * `today` is todayInKualaLumpur() on both surfaces — the popup previously used the browser's UTC date,
 * which drifted a day for some timezones. Read-only, no DomainEvent.
 */
export async function loadDelegationContextAction(history: boolean): Promise<DelegationContext> {
  const s = await getSession();
  const adminCaller = isAdmin(s);
  const today = todayInKualaLumpur();
  const showHistory = adminCaller && history === true;
  const [rows, companiesRaw, businessUnitsRaw, departmentsRaw] = await Promise.all([
    delegationsScoped(s, { isAdmin: adminCaller, history: showHistory, asOf: today }),
    // R51 (baf56348): coverage cascade masters (tenant-readable under RLS, so self-service works too).
    listCompanies(s),
    listBusinessUnits(s),
    listDepartments(s),
  ]);
  const masters: OrgScopeMasters = {
    // f1bbc572 — the Criteria fields travel with the masters so the picker can apply the resolver's own
    // origin ∪ global rule (flag-gated, exactly as labelUsableByCompany does at save time).
    companies: companiesRaw.map((c) => ({ id: c.id, name: c.name, sharedSystemLabels: c.sharedSystemLabels })),
    businessUnits: businessUnitsRaw.map((b) => ({ id: b.id, name: b.name, companyId: b.companyId, isGlobal: b.isGlobal })),
    departments: departmentsRaw.map((d) => ({
      id: d.id,
      name: d.name,
      companyId: d.companyId,
      businessUnitId: d.businessUnitId,
      isGlobal: d.isGlobal,
    })),
  };
  if (adminCaller) {
    const delegatorOptions = await employmentPickerList(s);
    return {
      admin: true,
      canSelfDelegate: false,
      initialCandidates: [],
      delegatorOptions,
      masters,
      rows,
      myEmploymentIds: [],
      today,
    };
  }
  // Self branch — the R51 gate: hasDownline OR an approver level (a pure department/BU head with no
  // administrative reports clearly holds approval duties, so they can set up cover too).
  const mine = await myEmployments(s);
  const myIds = mine.map((m) => m.employmentId);
  let selfDelegator: string | null = null;
  for (const m of mine) {
    if (
      (await hasDownline(s, m.employmentId, today)) ||
      (await approverLevelOf(s, m.employmentId, today)) !== 'none'
    ) {
      selfDelegator = m.employmentId;
      break;
    }
  }
  // R51: candidates come from the SECURITY-DEFINER eligible list (same-rank approvers across the org), in
  // full EligibleDelegateRow shape so the coverage cascade can narrow them client-side. The caller's own
  // employments are filtered out exactly as the page does (no self-delegation).
  const myIdSet = new Set(myIds);
  const initialCandidates = selfDelegator
    ? (await eligibleDelegates(s, selfDelegator)).filter((c) => !myIdSet.has(c.employmentId))
    : [];
  return {
    admin: false,
    canSelfDelegate: selfDelegator != null,
    initialCandidates,
    delegatorOptions: [],
    masters,
    rows,
    myEmploymentIds: myIds,
    today,
  };
}

export type DelegationContext = {
  admin: boolean;
  canSelfDelegate: boolean;
  /** self mode: same-level candidates for the caller's own delegator employment (own employments excluded). */
  initialCandidates: EligibleDelegateRow[];
  /** hr mode: the "delegate from" picker (all active employments). Empty for self-service callers. */
  delegatorOptions: { employmentId: string; name: string; employeeCode: string | null }[];
  masters: OrgScopeMasters;
  rows: DelegationScopedRow[];
  myEmploymentIds: string[];
  today: string;
};

// ── Self-service ─────────────────────────────────────────────────────────────────────────────────

export async function createSelfDelegationAction(
  _prev: DelegationActionResult | null,
  formData: FormData,
): Promise<DelegationActionResult> {
  const s = await getSession();
  const today = todayInKualaLumpur();
  const validFrom = String(formData.get('validFrom') ?? '').trim() || today;
  const validTo = String(formData.get('validTo') ?? '').trim() || null;
  const delegateEmploymentId = String(formData.get('delegateEmploymentId') ?? '').trim();
  try {
    if (!delegateEmploymentId) throw new Error('Choose who will stand in for you.');
    const mine = await myEmploymentIdList();
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
    return { ok: false, error: publicErrorMessage(e) };
  }
  revalidatePath('/delegations');
  return { ok: true };
}

export async function revokeSelfDelegationAction(
  _prev: DelegationActionResult | null,
  formData: FormData,
): Promise<DelegationActionResult> {
  const s = await getSession();
  const reportingLineId = String(formData.get('reportingLineId') ?? '').trim();
  // No form-supplied endDate anymore (popup parity): the server's Kuala-Lumpur today is the single
  // source, so a form left open past midnight can never post yesterday's date.
  const endDate = String(formData.get('endDate') ?? '').trim() || todayInKualaLumpur();
  try {
    if (!reportingLineId) throw new Error('Missing delegation.');
    // Ownership guard: a self-service user may only revoke a delegation they DELEGATED (their own duty).
    const mine = new Set(await myEmploymentIdList());
    const rows = await delegationsScoped(s, { isAdmin: false, history: true, asOf: todayInKualaLumpur() });
    const row = rows.find((r) => r.id === reportingLineId);
    if (!row || !mine.has(row.delegatorEmploymentId)) throw new Error('You can only revoke your own delegations.');
    await endReportingLine(s, { reportingLineId, endDate });
  } catch (e) {
    return { ok: false, error: publicErrorMessage(e) };
  }
  revalidatePath('/delegations');
  return { ok: true };
}

// ── HR / super_admin management (any employment) ───────────────────────────────────────────────────

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

const NOT_HR_ERROR = 'Only HR can manage delegations on behalf of employees.';

export async function hrCreateDelegationAction(
  _prev: DelegationActionResult | null,
  formData: FormData,
): Promise<DelegationActionResult> {
  const s = await getSession();
  if (!isAdmin(s)) return { ok: false, error: NOT_HR_ERROR };
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
    return { ok: false, error: publicErrorMessage(e) };
  }
  revalidatePath('/delegations');
  return { ok: true };
}

export async function hrEditDelegationAction(
  _prev: DelegationActionResult | null,
  formData: FormData,
): Promise<DelegationActionResult> {
  const s = await getSession();
  if (!isAdmin(s)) return { ok: false, error: NOT_HR_ERROR };
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
    return { ok: false, error: publicErrorMessage(e) };
  }
  revalidatePath('/delegations');
  return { ok: true };
}

export async function hrRevokeDelegationAction(
  _prev: DelegationActionResult | null,
  formData: FormData,
): Promise<DelegationActionResult> {
  const s = await getSession();
  if (!isAdmin(s)) return { ok: false, error: NOT_HR_ERROR };
  const reportingLineId = String(formData.get('reportingLineId') ?? '').trim();
  const endDate = String(formData.get('endDate') ?? '').trim() || todayInKualaLumpur();
  try {
    if (!reportingLineId) throw new Error('Missing delegation.');
    await endReportingLine(s, { reportingLineId, endDate });
  } catch (e) {
    return { ok: false, error: publicErrorMessage(e) };
  }
  revalidatePath('/delegations');
  return { ok: true };
}
