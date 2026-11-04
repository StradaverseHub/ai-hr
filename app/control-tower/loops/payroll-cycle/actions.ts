'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getBrowserCommandSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz-model';
import { PayrollLoopRefused, decideThresholdProposal, setPayrollLoopSetting } from '@/core/loops/payroll-loop-settings';
import { recordSwingDisposition } from '@/core/loops/salary-swing-service';
import { disposeSwingGroup, resolveAcknowledgedBlock } from '@/core/loops/grouped-dispositions';
import { AcknowledgementRefused, acknowledgeCheck, decideRuleProposal, revokeAcknowledgement } from '@/core/loops/acknowledgements';
import { PayrollLearningRefused, setPayrollLearningMode } from '@/core/payroll-learning/mode';

/** AI v2 P2-2a — Operations › Loops › Payroll cycle. Three commands, each re-checked by its service and by the database
 * (migration 0964), each attributed to the person who sends it and audited:
 *  - payroll HR records a net-swing flag's disposition (expected, or a real problem);
 *  - an administrator of a company changes its Pre-salary interval, net-swing threshold (at most 50%) or automatic cut-off
 *    reminders, or removes an exclusion;
 *  - a group administrator approves a threshold proposal (never one whose own dispositions it rests on), and any
 *    administrator of the company rejects one (approving re-derives it first).
 * Phase 2 hardening adds, each a person's own decision re-checked by its service and the database (migration 2011):
 *  - payroll HR disposes of a whole group of net-swing flags (one company, month and pattern) in one tap, having seen the
 *    evidence; "expected" also resolves the same people's net-swing-only anomaly verdicts (one decision, not two);
 *  - payroll HR resolves an acknowledged blocking exception with its pre-filled reason;
 *  - payroll HR records or revokes a standing "expected" acknowledgement; a group administrator approves a proposed
 *    standing rule, or any administrator rejects one.
 * None of them changes pay, a payroll run or a detector. Each returns to its page with a closed result code. */
const ROOT = '/control-tower/loops/payroll-cycle';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
type ErrorCode = 'invalid' | 'refused' | 'changed' | 'already' | 'failed' | 'groupAdministrator' | 'ownEvidence' | 'own' | 'learningGroup';
const codeOf = (e: unknown): ErrorCode => e instanceof PayrollLoopRefused || e instanceof AcknowledgementRefused
  ? (e.reason === 'not_administrator' ? 'refused' : e.reason === 'changed' ? 'changed' : e.reason === 'already' ? 'already'
    : e.reason === 'group_administrator' ? 'groupAdministrator' : e.reason === 'own_evidence' ? 'ownEvidence' : e.reason === 'own' ? 'own' : 'invalid') : 'failed';
const back = (path: string, params: Record<string, string | null>) => {
  const q = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => !!entry[1]));
  return `${path}?${q}`;
};
async function session() {
  const s = await getBrowserCommandSession();
  if (!s.userId || s.agent || !isAdmin(s)) throw new PayrollLoopRefused('not_administrator');
  return s;
}

export async function recordSwingDispositionAction(formData: FormData) {
  const caseId = formData.get('case'), disposition = formData.get('disposition'), period = formData.get('period'), company = formData.get('company');
  let error: ErrorCode | null = null;
  try {
    if (typeof caseId !== 'string' || !UUID.test(caseId) || (disposition !== 'expected' && disposition !== 'problem')) throw new PayrollLoopRefused('invalid');
    await recordSwingDisposition(await session(), { caseId, disposition });
  } catch (e) { error = codeOf(e); }
  revalidatePath(ROOT, 'layout');
  redirect(back(`${ROOT}/salary`, { period: typeof period === 'string' && PERIOD.test(period) ? period : null,
    company: typeof company === 'string' && UUID.test(company) ? company : null, ...(error ? { error } : { saved: 'disposition' }) }));
}

export async function setPayrollLoopSettingAction(formData: FormData) {
  const company = formData.get('company'), interval = formData.get('interval'), threshold = formData.get('threshold'), remove = formData.get('removeExclusion');
  const reminders = formData.get('reminders');
  let error: ErrorCode | null = null;
  try {
    if (typeof company !== 'string' || !UUID.test(company)) throw new PayrollLoopRefused('invalid');
    const percent = typeof threshold === 'string' && threshold.trim() !== '' ? Number(threshold) : null;
    if (percent !== null && (!Number.isFinite(percent) || Math.abs(percent * 100 - Math.round(percent * 100)) > 1e-6)) throw new PayrollLoopRefused('invalid');
    await setPayrollLoopSetting(await session(), {
      companyId: company,
      ...(typeof interval === 'string' && interval ? { interval } : {}),
      ...(percent !== null ? { thresholdBp: Math.round(percent * 100) } : {}),
      ...(typeof remove === 'string' && remove ? { removeExclusion: remove } : {}),
      ...(reminders === 'on' || reminders === 'off' ? { remindersEnabled: reminders === 'on' } : {}),
    });
  } catch (e) { error = codeOf(e); }
  revalidatePath(ROOT, 'layout');
  redirect(back(`${ROOT}/settings`, error ? { error } : { saved: 'setting' }));
}

export async function decideThresholdProposalAction(formData: FormData) {
  const company = formData.get('company'), key = formData.get('proposal'), decision = formData.get('decision');
  let error: ErrorCode | null = null;
  try {
    if (typeof company !== 'string' || !UUID.test(company) || typeof key !== 'string' || (decision !== 'approved' && decision !== 'rejected')) throw new PayrollLoopRefused('invalid');
    await decideThresholdProposal(await session(), { companyId: company, proposalKey: key, decision });
  } catch (e) { error = codeOf(e); }
  revalidatePath(ROOT, 'layout');
  redirect(back(`${ROOT}/settings`, error ? { error } : { saved: decision === 'approved' ? 'approved' : 'rejected' }));
}

/** Where an acknowledgement or rule command returns: the Salary payroll page (with its month and company) or settings. */
const pageOf = (formData: FormData): { path: string; params: Record<string, string | null> } => {
  const to = formData.get('back'), period = formData.get('period'), company = formData.get('company');
  return to === 'salary' ? { path: `${ROOT}/salary`, params: { period: typeof period === 'string' && PERIOD.test(period) ? period : null,
    company: typeof company === 'string' && UUID.test(company) ? company : null } } : { path: `${ROOT}/settings`, params: {} };
};

export async function disposeSwingGroupAction(formData: FormData) {
  const target = formData.get('target'), period = formData.get('period'), pattern = formData.get('pattern'), disposition = formData.get('disposition');
  let error: ErrorCode | null = null;
  try {
    await disposeSwingGroup(await session(), { companyId: target, payPeriod: period, pattern, disposition });
  } catch (e) { error = codeOf(e); }
  revalidatePath(ROOT, 'layout');
  const { path, params } = pageOf(formData);
  redirect(back(path, { ...params, ...(error ? { error } : { saved: 'grouped' }) }));
}

export async function resolveAcknowledgedBlockAction(formData: FormData) {
  let error: ErrorCode | null = null;
  try {
    await resolveAcknowledgedBlock(await session(), { verdictId: formData.get('verdict'), companyId: formData.get('target'), payPeriod: formData.get('period') });
  } catch (e) { error = codeOf(e); }
  revalidatePath(ROOT, 'layout');
  const { path, params } = pageOf(formData);
  redirect(back(path, { ...params, ...(error ? { error } : { saved: 'resolved' }) }));
}

export async function acknowledgeCheckAction(formData: FormData) {
  const reviewOn = formData.get('reviewOn'), employmentId = formData.get('employment'), departmentId = formData.get('department');
  let error: ErrorCode | null = null;
  try {
    await acknowledgeCheck(await session(), { companyId: formData.get('target'), checkId: formData.get('check'), scope: formData.get('scope'),
      reason: formData.get('reason'), ...(typeof reviewOn === 'string' && reviewOn ? { reviewOn } : {}),
      ...(typeof employmentId === 'string' && employmentId ? { employmentId } : {}), ...(typeof departmentId === 'string' && departmentId ? { departmentId } : {}) });
  } catch (e) { error = codeOf(e); }
  revalidatePath(ROOT, 'layout');
  const { path, params } = pageOf(formData);
  redirect(back(path, { ...params, ...(error ? { error } : { saved: 'acknowledged' }) }));
}

export async function revokeAcknowledgementAction(formData: FormData) {
  let error: ErrorCode | null = null;
  try {
    await revokeAcknowledgement(await session(), { id: formData.get('acknowledgement') });
  } catch (e) { error = codeOf(e); }
  revalidatePath(ROOT, 'layout');
  redirect(back(`${ROOT}/settings`, error ? { error } : { saved: 'revoked' }));
}

export async function decideRuleProposalAction(formData: FormData) {
  const decision = formData.get('decision');
  let error: ErrorCode | null = null;
  try {
    await decideRuleProposal(await session(), { companyId: formData.get('target'), proposalKey: formData.get('proposal'), decision });
  } catch (e) { error = codeOf(e); }
  revalidatePath(ROOT, 'layout');
  redirect(back(`${ROOT}/settings`, error ? { error } : { saved: decision === 'approved' ? 'ruleApproved' : 'ruleRejected' }));
}

/** Payroll history learning (migration 2012): switch a company's learning on (evidence lines: a group administrator) or off
 * (any payroll administrator of the company). Classify is never set here: only an approved proposal reaches it. Re-checked
 * by the service and the database, attributed and audited as a configuration event; it changes no pay, run or check. */
export async function setPayrollLearningModeAction(formData: FormData) {
  const company = formData.get('company'), mode = formData.get('mode');
  let error: ErrorCode | null = null;
  try {
    if (typeof company !== 'string' || !UUID.test(company) || (mode !== 'evidence' && mode !== 'off')) throw new PayrollLoopRefused('invalid');
    await setPayrollLearningMode(await session(), { companyId: company, mode });
  } catch (e) {
    error = e instanceof PayrollLearningRefused ? (e.reason === 'group_administrator' ? 'learningGroup' : e.reason === 'not_permitted' ? 'refused'
      : e.reason === 'unchanged' ? 'already' : 'invalid') : codeOf(e);
  }
  revalidatePath(ROOT, 'layout');
  redirect(back(`${ROOT}/settings`, error ? { error } : { saved: 'learning' }));
}
