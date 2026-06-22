'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { setLeaveApprovalPolicy } from '@/core/leave-approval-policy';

const PAGE = '/admin/leave-approval';

/** Save a company's approval chain + on/off toggle (ADR-0039 2B-2). */
export async function saveLeaveApprovalPolicyAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const enabled = String(formData.get('enabled') ?? '0') === '1';
  const levels = String(formData.get('levels') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  try {
    await setLeaveApprovalPolicy(s, { companyId, enabled, levels });
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`${PAGE}?toast=${encodeURIComponent('Approval chain saved')}`);
}
