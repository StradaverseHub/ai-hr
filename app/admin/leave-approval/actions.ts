'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
// e4238594 — the _redirects imports (ENTITLEMENTS / fail / okEntitlements) and getTranslations went with
// the 4e9a4d59 wrappers below; this file redirects to its own PAGE only. Those helpers are still used
// widely elsewhere under app/admin — nothing was removed from _redirects itself.
// 706d34e8 — the rule create/update/archive imports went with the per-rule actions (see the block below).
// The core functions still exist and are still exercised; this FILE simply no longer reaches for them.
import { setLeaveEscalationPolicy } from '@/core/leave-approval-policy';
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

// ─── 706d34e8 (r155): THE PER-RULE WRITE PATH IS GONE FROM THIS FILE. Third and last removal here. ───
//
// What stood here, in the order it was retired:
//   1. e4238594 retired the two 4e9a4d59 wrappers (…FromEntitlementsAction) when the leave-type
//      workspace's embedded Approval Workflow sub-step was deleted as a duplicate of the Approval tab.
//   2. 241817ef step 2 (r94) retired the company base-chain action when its section left the page.
//   3. 706d34e8 now retires the two STANDALONE rule actions and the persist helpers behind them, because
//      the Approval Workflows matrix — their only remaining caller — left the page in the same commit.
//
// Each time the rule has been identical and it is worth stating once more: A SERVER ACTION WITH NO SCREEN
// IS STILL AN ADDRESSABLE ENDPOINT. Leaving these would keep a write path into leave_approval_policy that
// nothing on any screen shows — which is the silent-configuration problem 241817ef exists to end.
//
// The other two actions' identifiers are deliberately NOT spelled here: test/leave-approval-page-restructure
// .test.ts asserts this file does not contain them ANYWHERE, comments included.
//
// THE SERVICES SURVIVE. core/leave-approval-policy.ts keeps createLeaveApprovalRule /
// updateLeaveApprovalRule / archiveLeaveApprovalRule and every reader — resolveApprovalChain routes on
// these rows, core/leave-approval-consolidation.ts rewrites them, and test/leave-approval-rule-matrix.test.ts
// drives them directly. Removing a screen is not removing a service. What is gone is the HTTP-reachable
// wrapper, not the domain operation, so a future editor (or a conversion script) still has one.
//
// ASSIGNMENT IS NOW THE ONLY WRITE PATH into these rows from a screen: assignApprovalTemplateAction /
// unassignApprovalTemplateAction below, via core/leave-approval-template.ts, which inserts and archives the
// same leave_approval_policy rows with a template_id stamped on them.

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
// 706d34e8 — employmentTypeOrNull() and its EmploymentType alias went with the per-rule save that was
// their only caller. The Assign Template path never parsed an employment type from the form: it derives
// one from the chosen benefit scheme inside core/leave-approval-template.ts (22de47c4).
