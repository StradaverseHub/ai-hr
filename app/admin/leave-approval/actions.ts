'use server';

import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
// 4e9a4d59 — the shared post-action redirect contract (see app/admin/_redirects.ts). Imported rather than
// re-implemented so the workspace wrappers below inherit okEntitlements' exact URL shape.
import { ENTITLEMENTS, fail, okEntitlements } from '@/app/admin/_redirects';
import {
  archiveLeaveApprovalRule,
  createLeaveApprovalRule,
  setLeaveApprovalPolicy,
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

/** Save a company's DEFAULT approval chain (ADR-0039 2B-2). The company default is the fully-wildcard rule
 *  under ADR-0071's matrix. r79 0322 — the on/off toggle is gone; the chain's own length decides whether a
 *  request is single- or multi-step. */
export async function saveLeaveApprovalPolicyAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const levels = parseLevels(formData);
  const reason = str(formData.get('reason')); // 4ec5a940 — optional "why" for the audit trail
  try {
    await setLeaveApprovalPolicy(s, { companyId, levels, reason });
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent('Approval chain saved')}`);
}

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

// ── 4e9a4d59: the SAME two saves, posted from INSIDE a leave type's setup flow ─────────────────────────
// The Approval Workflow sub-step of the Leave Type workspace embeds the very same WorkflowMatrix the
// standalone Approvals screen renders. Origin is known STATICALLY at the call site (WorkflowMatrix takes
// its actions as an injected prop), so no runtime origin flag is needed: the workspace simply injects
// these two wrappers instead. They run the identical persist core, then return via okEntitlements — HR
// stays on the leave type + step they were configuring, on success AND on failure (the Entitlements page
// already renders its ErrorBanner from ?error=). The standalone actions above are untouched, so that
// screen cannot regress.
//
// Toast wording deliberately uses admin.leave.savedToast rather than the standalone actions' raw English
// literals ('Rule created' / 'Rule deleted') — the workspace is fully localised, so reusing those would
// show English to ms/ta/th/vi/zh users.

/** Save a rule from the leave-type workspace's Approval Workflow sub-step — stay on that type. */
export async function saveLeaveApprovalRuleFromEntitlementsAction(formData: FormData) {
  const s = await getSession();
  try {
    await persistApprovalRule(s, formData);
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  const t = await getTranslations('admin.leave');
  // The rule's own Scope select owns leaveTypeId: retargeting a rule to another type (or to "all types",
  // which posts nothing) lands HR where the rule now lives — the latter degrading to the bare route.
  okEntitlements(t('savedToast'), str(formData.get('leaveTypeId')) ?? '');
}

/** Delete a rule from the leave-type workspace's Approval Workflow sub-step — stay on that type. */
export async function archiveLeaveApprovalRuleFromEntitlementsAction(formData: FormData) {
  const s = await getSession();
  try {
    await persistArchiveApprovalRule(s, formData);
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  const t = await getTranslations('admin.leave');
  okEntitlements(t('savedToast'), str(formData.get('leaveTypeId')) ?? '');
}

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
