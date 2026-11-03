'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getBrowserCommandSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz-model';
import { PayrollLoopRefused, decideThresholdProposal, setPayrollLoopSetting } from '@/core/loops/payroll-loop-settings';
import { recordSwingDisposition } from '@/core/loops/salary-swing-service';

/** AI v2 P2-2a — Operations › Loops › Payroll cycle. Three commands, each re-checked by its service and by the database
 * (migration 0964), each attributed to the person who sends it and audited:
 *  - payroll HR records a net-swing flag's disposition (expected, or a real problem);
 *  - an administrator of a company changes its Pre-salary interval or net-swing threshold, or removes an exclusion;
 *  - an administrator of a company approves or rejects a threshold proposal (approving re-derives it first).
 * None of them changes pay, a payroll run or a detector. Each returns to its page with a closed result code. */
const ROOT = '/control-tower/loops/payroll-cycle';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
type ErrorCode = 'invalid' | 'refused' | 'changed' | 'already' | 'failed';
const codeOf = (e: unknown): ErrorCode => e instanceof PayrollLoopRefused
  ? (e.reason === 'not_administrator' ? 'refused' : e.reason === 'changed' ? 'changed' : e.reason === 'already' ? 'already' : 'invalid') : 'failed';
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
