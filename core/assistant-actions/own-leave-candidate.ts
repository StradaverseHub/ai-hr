/** Read-only candidate, not a prepared action or permission to submit. No action ID, persistence,
 * provider call, allowance admission or leave write is created here. The eventual lifecycle owner
 * must check fresh authority/AI controls, protect intent content and freeze the reviewed effect. */
import { and, eq } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { leaveType } from '../../db/schema';
import { todayInKualaLumpur } from '../../lib/hr-date';
import {
  OwnLeaveHumanSelection, OwnLeaveHumanText, OwnLeaveNomination,
} from '../../lib/assistant-actions/own-leave-contract';
import { leaveTypeIs, previewLeaveDeduction } from '../../packs/leave/service';
import { mayUseAssistant } from '../assistant-grant';
import { provenCompanyDatesTx } from '../employment-company';
import { isEmploymentEnded } from '../employment-status';
import { resolveEssView } from '../ess-view';
import { listEligibleLeaveTypesFor, myOwnEmploymentSubjectsTx } from '../read';
import { OwnLeaveBinding, ownLeaveIntentDigest } from './own-leave-review';

export type OwnLeaveReviewCandidate = {
  binding: OwnLeaveBinding;
  nomination: OwnLeaveNomination;
  humanText: OwnLeaveHumanText;
  intentDigest: string;
  companyName: string;
  employeeCode: string | null;
  leaveTypeName: string;
  deductionDays: number;
  /** Null means hidden by the canonical ESS setting, never zero or permission to infer it. */
  availableBalance: number | null;
  estimatedAvailableAfter: number | null;
  approvalRouting: 'unknown';
};
export type OwnLeaveCandidateResult =
  | { kind: 'candidate'; candidate: OwnLeaveReviewCandidate }
  | { kind: 'unavailable' }
  | { kind: 'needs_selection' }
  | { kind: 'needs_employee_remark' }
  | { kind: 'use_leave_form' };

/** The transaction must have THIS caller's context. Its entitlement snapshot must be freshly resolved.
 * A candidate is advisory even in one transaction: the menu answers as of today, policy may change,
 * and requestLeave remains the authority at submission. Never log/persist the returned private content
 * as lifecycle metadata or tool traces. Selection and text must come from the human input owner. */
export async function readOwnLeaveCandidateTx(
  tx: Tx, ctx: SessionContext, nominationValue: unknown, selectionValue: unknown,
  humanTextValue: unknown, locale?: string,
): Promise<OwnLeaveCandidateResult> {
  if (!ctx.userId || !ctx.personId) return { kind: 'unavailable' };
  if (!(await mayUseAssistant(ctx, tx)).allowed) return { kind: 'unavailable' };
  const nomination = OwnLeaveNomination.safeParse(nominationValue);
  const text = OwnLeaveHumanText.safeParse(humanTextValue);
  if (!nomination.success || !text.success) return { kind: 'use_leave_form' };
  const selection = OwnLeaveHumanSelection.safeParse(selectionValue);
  if (!selection.success || selection.data.employmentId !== nomination.data.employmentId
    || selection.data.leaveTypeId !== nomination.data.leaveTypeId) return { kind: 'needs_selection' };
  const intent = nomination.data;
  const today = todayInKualaLumpur();
  if (intent.date < today) return { kind: 'use_leave_form' };

  // Salary-free canonical own-subject inventory, including current login/person linkage checks.
  const subjects = await myOwnEmploymentSubjectsTx(tx, ctx);
  const subject = subjects.find(row => row.employmentId === intent.employmentId);
  if (!subject || subject.hiredOn > today || isEmploymentEnded(subject, today)
    || isEmploymentEnded(subject, intent.date)) return { kind: 'unavailable' };
  const dated = await provenCompanyDatesTx(tx, [{ employmentId: subject.employmentId, date: intent.date }]);
  const requestedCompany = dated.get(`${subject.employmentId}|${intent.date}`);
  // Missing/ambiguous dated assignment is Unknown. This first slice also hands a future company
  // transfer to the full form rather than guessing which company's card the person reviewed.
  if (!subject.companyProof.companyId || !requestedCompany?.companyId
    || subject.companyProof.companyId !== subject.currentCompanyId
    || requestedCompany.companyId !== subject.currentCompanyId) return { kind: 'use_leave_form' };
  const binding = OwnLeaveBinding.safeParse({ tenantId: ctx.tenantId, userId: ctx.userId,
    personId: subject.personId, companyId: requestedCompany.companyId, employmentId: subject.employmentId });
  if (!binding.success) return { kind: 'unavailable' };

  const eligible = await listEligibleLeaveTypesFor(ctx, subject.employmentId, locale, tx);
  const type = eligible.find(row => row.id === intent.leaveTypeId);
  if (!type) return { kind: 'unavailable' };
  const [identity] = await tx.select({ role: leaveType.role, code: leaveType.code, country: leaveType.country,
    essViewConfig: leaveType.essViewConfig }).from(leaveType)
    .where(and(eq(leaveType.tenantId, ctx.tenantId), eq(leaveType.id, type.id))).limit(1);
  if (!identity || !leaveTypeIs(identity, 'annual') || identity.country !== subject.country
    || !type.paid || type.requiresDocument || type.balanceSourceTypeId !== null) return { kind: 'use_leave_form' };
  if (type.employeeRemarkRequired && !text.data.employeeRemark?.trim()) return { kind: 'needs_employee_remark' };

  const preview = await previewLeaveDeduction(ctx, { employmentId: subject.employmentId,
    leaveTypeId: type.id, startDate: intent.date, endDate: intent.date, durationType: 'full_day',
    includeAvailableBalance: true, today }, tx);
  if (!Number.isFinite(preview.days) || preview.days <= 0 || preview.isEmergencySplit
    || (preview.unpaidDays ?? 0) > 0 || (preview.overrides?.length ?? 0) > 0
    || !Number.isFinite(preview.availableBalance) || !Number.isFinite(preview.availableAfter)
    || preview.availableBalance === undefined || preview.availableAfter === undefined
    || preview.availableBalance < preview.days) return { kind: 'use_leave_form' };
  const showAvailable = resolveEssView(identity.essViewConfig as Record<string, boolean> | null).available;
  return { kind: 'candidate', candidate: {
    binding: binding.data, nomination: intent, humanText: text.data,
    intentDigest: ownLeaveIntentDigest(binding.data, intent, text.data),
    companyName: subject.company, employeeCode: subject.employeeCode, leaveTypeName: type.name,
    deductionDays: preview.days,
    availableBalance: showAvailable ? preview.availableBalance : null,
    estimatedAvailableAfter: showAvailable ? preview.availableAfter : null,
    approvalRouting: 'unknown',
  } };
}
