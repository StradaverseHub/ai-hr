'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
// e4238594 — the _redirects imports (ENTITLEMENTS / fail / okEntitlements) and getTranslations went with
// the 4e9a4d59 wrappers below; this file redirects to its own PAGE only. Those helpers are still used
// widely elsewhere under app/admin — nothing was removed from _redirects itself.
import {
  archiveLeaveApprovalRule,
  createLeaveApprovalRule,
  setLeaveEscalationPolicy,
  updateLeaveApprovalRule,
  type LeaveApprovalRuleInput,
} from '@/core/leave-approval-policy';
import {
  assignApprovalTemplate,
  createApprovalTemplate,
  deleteApprovalTemplate,
  duplicateApprovalTemplate,
  setApprovalTemplateActive,
  setTenantDefaultTemplate,
  unassignApprovalTemplate,
  updateApprovalTemplate,
} from '@/core/leave-approval-template';

// 0d147b78: the approval editor now lives on the Approval Workflow tab of Leave Settings; post-action
// redirects land there (the old /admin/leave-approval route 308-redirects here too).
const PAGE = '/admin/leave/approval';

type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern';

/** R51 722904dc — save a company's Approval Escalation Settings (enable + working-day threshold +
 *  recipient rule). Auth guard stays the page's scopedSession/getSession posture like every other action
 *  here — deliberately NOT requireAdmin(). */
export async function saveLeaveEscalationPolicyAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const enabled = String(formData.get('enabled') ?? '0') === '1';
  const escalateAfterDays = numOrNull(formData.get('escalateAfterDays'));
  const target = String(formData.get('target') ?? 'next_level');
  const targetRole = str(formData.get('targetRole'));
  const reason = str(formData.get('reason')); // 4ec5a940 — optional "why" for the audit trail
  try {
    await setLeaveEscalationPolicy(s, { companyId, enabled, escalateAfterDays, target, targetRole, reason });
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent('Escalation settings saved')}`);
}

/** 4e9a4d59 — the parse+persist CORE of the rule save, shared verbatim by the standalone Approvals-screen
 *  action and the leave-type-workspace wrapper. It throws on failure; each caller owns its own redirect
 *  contract (that is the ONLY difference between the two entry points). Returns whether it was an update,
 *  which the standalone action needs for its created/updated wording. */
async function persistApprovalRule(s: Awaited<ReturnType<typeof getSession>>, formData: FormData): Promise<boolean> {
  const ruleId = str(formData.get('ruleId'));
  const input: LeaveApprovalRuleInput = {
    companyId: String(formData.get('companyId') ?? ''),
    ruleName: str(formData.get('ruleName')),
    leaveTypeId: str(formData.get('leaveTypeId')),
    businessUnitId: str(formData.get('businessUnitId')),
    departmentId: str(formData.get('departmentId')),
    positionId: str(formData.get('positionId')),
    gradeId: str(formData.get('gradeId')),
    // R41 72800eda — grade-GROUP scoping + Default(template)/Custom(levels) workflow type.
    gradeGroupId: str(formData.get('gradeGroupId')),
    templateId: str(formData.get('templateId')),
    employmentType: employmentTypeOrNull(formData.get('employmentType')),
    minDays: numOrNull(formData.get('minDays')),
    maxDays: numOrNull(formData.get('maxDays')),
    levels: parseLevels(formData),
  };
  const reason = str(formData.get('reason')); // 4ec5a940 — optional "why" for the audit trail
  if (ruleId) await updateLeaveApprovalRule(s, ruleId, input, { reason });
  else await createLeaveApprovalRule(s, input);
  return ruleId != null;
}

/** 4e9a4d59 — the persist core of the rule archive, shared by both entry points (throws on failure). */
async function persistArchiveApprovalRule(
  s: Awaited<ReturnType<typeof getSession>>,
  formData: FormData,
): Promise<void> {
  await archiveLeaveApprovalRule(
    s,
    String(formData.get('ruleId') ?? ''),
    String(formData.get('companyId') ?? ''),
  );
}

/** Create or update a scoped approval rule (ADR-0071). A ruleId in the form switches to update. */
export async function saveLeaveApprovalRuleAction(formData: FormData) {
  const s = await getSession();
  let wasUpdate = false;
  try {
    wasUpdate = await persistApprovalRule(s, formData);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent(wasUpdate ? 'Rule updated' : 'Rule created')}`);
}

/** Archive (soft-delete) a scoped approval rule (ADR-0071). */
export async function archiveLeaveApprovalRuleAction(formData: FormData) {
  const s = await getSession();
  try {
    await persistArchiveApprovalRule(s, formData);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent('Rule deleted')}`);
}

// e4238594 RETIRED the two 4e9a4d59 wrappers that stood here
// (saveLeaveApprovalRuleFromEntitlementsAction / archiveLeaveApprovalRuleFromEntitlementsAction).
//
// They existed only so a save posted from the leave type workspace's Approval Workflow sub-step returned
// to that type instead of the Approvals screen. That sub-step is gone — it duplicated the Approval
// Workflow tab — so the wrappers had no caller left, and a server action with no caller retires WITH its
// screen (the r100 base-chain precedent — 241817ef step 2 retired that action the same way) rather than
// lingering as a second, unreachable write path into the same rules.
//
// The precedent's action is deliberately NOT named here: test/leave-approval-page-restructure.test.ts
// asserts this file does not contain that identifier ANYWHERE, comments included, because a caller-less
// server action is still an addressable endpoint. Naming it even in prose would redden that guard.
//
// THE SHARED CORE IS UNTOUCHED: persistApprovalRule / persistArchiveApprovalRule above still back the
// standalone saveLeaveApprovalRuleAction / archiveLeaveApprovalRuleAction, which are what the Approval tab
// posts. Only the two redirect wrappers went.

// ──────────────── 6fadb036 (R17): reusable templates + tenant default + bulk assignment ────────────────

/** Create or update a reusable approval TEMPLATE. A templateId in the form switches to update. */
export async function saveApprovalTemplateAction(formData: FormData) {
  const s = await getSession();
  const templateId = str(formData.get('templateId'));
  const input = {
    name: String(formData.get('name') ?? ''),
    description: str(formData.get('description')),
    levels: parseLevels(formData),
  };
  try {
    if (templateId) await updateApprovalTemplate(s, templateId, input);
    else await createApprovalTemplate(s, input);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent(templateId ? 'Template updated' : 'Template created')}`);
}

/** Duplicate a template (copies name + " (copy)", description, steps; never the org-default flag). */
export async function duplicateApprovalTemplateAction(formData: FormData) {
  const s = await getSession();
  const templateId = String(formData.get('templateId') ?? '');
  try {
    await duplicateApprovalTemplate(s, templateId);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent('Template duplicated')}`);
}

/** Activate / deactivate a template. Deactivation is blocked while an active rule references it. */
export async function setApprovalTemplateActiveAction(formData: FormData) {
  const s = await getSession();
  const templateId = String(formData.get('templateId') ?? '');
  const active = String(formData.get('active') ?? '0') === '1';
  try {
    await setApprovalTemplateActive(s, templateId, active);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent(active ? 'Template activated' : 'Template deactivated')}`);
}

/** Delete a template (only when nothing references it). */
export async function deleteApprovalTemplateAction(formData: FormData) {
  const s = await getSession();
  const templateId = String(formData.get('templateId') ?? '');
  try {
    await deleteApprovalTemplate(s, templateId);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent('Template deleted')}`);
}

/** Set (or clear) the tenant's single org-wide default template. */
export async function setTenantDefaultTemplateAction(formData: FormData) {
  const s = await getSession();
  const templateId = str(formData.get('templateId')); // absent = clear
  try {
    await setTenantDefaultTemplate(s, templateId);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent(templateId ? 'Default flow set' : 'Default flow cleared')}`);
}

/** Bulk-assign a template to many companies × many leave types × many grades in one action (multi-select).
 *  bb3938b9 — grades and the leave-duration condition are optional: posting none of them keeps the
 *  pre-existing "applies to every grade, any duration" assignment shape. */
export async function assignApprovalTemplateAction(formData: FormData) {
  const s = await getSession();
  const templateId = String(formData.get('templateId') ?? '');
  const companyIds = formData.getAll('companyIds').map(String).filter(Boolean);
  const leaveTypeIds = formData.getAll('leaveTypeIds').map(String).filter(Boolean);
  // 22de47c4 — the employee scope is chosen as BENEFIT SCHEMES now, not job grades (the service maps each
  // to the grade group + employment type it stands for).
  const benefitSchemeIds = formData.getAll('benefitSchemeIds').map(String).filter(Boolean);
  const minDays = numOrNull(formData.get('minDays'));
  const maxDays = numOrNull(formData.get('maxDays'));
  try {
    await assignApprovalTemplate(s, { templateId, companyIds, leaveTypeIds, benefitSchemeIds, minDays, maxDays });
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent('Template assigned')}`);
}

/** Unassign a template from one (company, leave-type) — archives the assignment row. */
export async function unassignApprovalTemplateAction(formData: FormData) {
  const s = await getSession();
  const ruleId = String(formData.get('ruleId') ?? '');
  const companyId = String(formData.get('companyId') ?? '');
  try {
    await unassignApprovalTemplate(s, ruleId, companyId);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent('Assignment removed')}`);
}

// r79 0322 — setLeaveMultiApprovalAction is GONE. It posted a hard-coded value="1" from the Assign Template
// screen, so it could only ever turn the flag ON; the flag itself no longer gates anything.

function parseLevels(formData: FormData): string[] {
  return String(formData.get('levels') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}
function str(v: FormDataEntryValue | null): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}
function numOrNull(v: FormDataEntryValue | null): number | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function employmentTypeOrNull(v: FormDataEntryValue | null): EmploymentType | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return (['full_time', 'part_time', 'contract', 'intern'] as const).includes(s as EmploymentType)
    ? (s as EmploymentType)
    : null;
}
