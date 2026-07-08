'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveLeaveApprovalRule,
  createLeaveApprovalRule,
  setLeaveApprovalPolicy,
  setLeaveMultiApproval,
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

/** Save a company's DEFAULT approval chain + on/off toggle (ADR-0039 2B-2). The company default is the
 *  fully-wildcard rule under ADR-0071's matrix. */
export async function saveLeaveApprovalPolicyAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const enabled = String(formData.get('enabled') ?? '0') === '1';
  const levels = parseLevels(formData);
  const reason = str(formData.get('reason')); // 4ec5a940 — optional "why" for the audit trail
  try {
    await setLeaveApprovalPolicy(s, { companyId, enabled, levels, reason });
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent('Approval chain saved')}`);
}

/** Create or update a scoped approval rule (ADR-0071). A ruleId in the form switches to update. */
export async function saveLeaveApprovalRuleAction(formData: FormData) {
  const s = await getSession();
  const ruleId = str(formData.get('ruleId'));
  const input: LeaveApprovalRuleInput = {
    companyId: String(formData.get('companyId') ?? ''),
    ruleName: str(formData.get('ruleName')),
    leaveTypeId: str(formData.get('leaveTypeId')),
    businessUnitId: str(formData.get('businessUnitId')),
    departmentId: str(formData.get('departmentId')),
    positionId: str(formData.get('positionId')),
    gradeId: str(formData.get('gradeId')),
    employmentType: employmentTypeOrNull(formData.get('employmentType')),
    minDays: numOrNull(formData.get('minDays')),
    maxDays: numOrNull(formData.get('maxDays')),
    levels: parseLevels(formData),
  };
  const reason = str(formData.get('reason')); // 4ec5a940 — optional "why" for the audit trail
  try {
    if (ruleId) await updateLeaveApprovalRule(s, ruleId, input, { reason });
    else await createLeaveApprovalRule(s, input);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent(ruleId ? 'Rule updated' : 'Rule created')}`);
}

/** Archive (soft-delete) a scoped approval rule (ADR-0071). */
export async function archiveLeaveApprovalRuleAction(formData: FormData) {
  const s = await getSession();
  const ruleId = String(formData.get('ruleId') ?? '');
  const companyId = String(formData.get('companyId') ?? '');
  try {
    await archiveLeaveApprovalRule(s, ruleId, companyId);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent('Rule deleted')}`);
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

/** Bulk-assign a template to many companies × many leave types in one action (multi-select). */
export async function assignApprovalTemplateAction(formData: FormData) {
  const s = await getSession();
  const templateId = String(formData.get('templateId') ?? '');
  const companyIds = formData.getAll('companyIds').map(String).filter(Boolean);
  const leaveTypeIds = formData.getAll('leaveTypeIds').map(String).filter(Boolean);
  try {
    await assignApprovalTemplate(s, { templateId, companyIds, leaveTypeIds });
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

/** Flip a company's multi-step-approval opt-in (so a template assignment can actually fire). */
export async function setLeaveMultiApprovalAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const enabled = String(formData.get('enabled') ?? '0') === '1';
  try {
    await setLeaveMultiApproval(s, companyId, enabled);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent(enabled ? 'Multi-step approval enabled' : 'Multi-step approval disabled')}`);
}

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
