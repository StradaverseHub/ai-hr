'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveLeaveApprovalRule,
  createLeaveApprovalRule,
  setLeaveApprovalPolicy,
  updateLeaveApprovalRule,
  type LeaveApprovalRuleInput,
} from '@/core/leave-approval-policy';

const PAGE = '/admin/leave-approval';

type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern';

/** Save a company's DEFAULT approval chain + on/off toggle (ADR-0039 2B-2). The company default is the
 *  fully-wildcard rule under ADR-0071's matrix. */
export async function saveLeaveApprovalPolicyAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const enabled = String(formData.get('enabled') ?? '0') === '1';
  const levels = parseLevels(formData);
  try {
    await setLeaveApprovalPolicy(s, { companyId, enabled, levels });
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
  try {
    if (ruleId) await updateLeaveApprovalRule(s, ruleId, input);
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
  redirect(`${PAGE}?toast=${encodeURIComponent('Rule archived')}`);
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
