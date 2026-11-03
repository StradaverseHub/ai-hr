'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getLocale } from 'next-intl/server';
import { getBrowserCommandSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz-model';
import { LearningRefused } from '@/core/learning/access';
import { recordAnswerMark, recordCardSignal } from '@/core/learning/signals';
import { editCandidate, markCandidateExported, moveCandidate, promoteSignal, reviewSignal, setGapStatus } from '@/core/learning/review';
import { decideLoopProposal, revertLoopProposal } from '@/core/learning/proposals';
import { PayrollLoopRefused } from '@/core/loops/payroll-loop-settings';
import { isQualityPeriod } from '@/core/learning/types';

/** AI v2 Phase 2, P2-6 — the learning loops' commands.
 *
 * recordCardSignalAction and markAnswerAction are posted by AI Centre's own chat (a prepared card's Confirm, Edit or
 * Discard; an answer's mark) for the signed-in person's own turn. They never change the card, the reply or a decision and
 * return only whether a signal was recorded: the service verifies the signed proposal for this caller and their own turn's
 * outcome record, and a gated turn is refused there and by the database.
 *
 * The rest are an administrator's decisions on AI Centre › Insights › AI quality. Each service checks the administrator
 * again and the 0972 policies narrow every row to the companies they administer. They return to the Insights view with a
 * closed result code the page translates; no other text crosses. */
const PAGE = '/assistant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: FormDataEntryValue | null) => (typeof value === 'string' ? value : '');
type Failure = 'invalid' | 'not_administrator' | 'not_found' | 'changed' | 'not_redacted' | 'state' | 'failed';

export async function recordCardSignalAction(input: { proposal: unknown; turnId: unknown; signal: unknown }): Promise<{ recorded: boolean }> {
  try {
    const session = await getBrowserCommandSession();
    return await recordCardSignal(session, { proposal: input?.proposal, turnId: input?.turnId, signal: input?.signal, locale: await getLocale() });
  } catch { return { recorded: false }; }
}

export async function markAnswerAction(input: { turnId: unknown; helpful: unknown }): Promise<{ recorded: boolean }> {
  try {
    const session = await getBrowserCommandSession();
    return await recordAnswerMark(session, { turnId: input?.turnId, helpful: input?.helpful, locale: await getLocale() });
  } catch { return { recorded: false }; }
}

/** The Insights view the administrator came from: its period and company filter kept. */
function back(form: FormData) {
  const params = new URLSearchParams({ view: 'insights' });
  const period = text(form.get('qperiod')), company = text(form.get('qcompany'));
  if (isQualityPeriod(period)) params.set('qperiod', period);
  if (UUID.test(company)) params.set('qcompany', company);
  return params;
}
async function admin() {
  const s = await getBrowserCommandSession();
  if (!s.userId || s.agent || !isAdmin(s)) throw new LearningRefused('not_administrator');
  return s;
}
const failure = (error: unknown): Failure => error instanceof LearningRefused ? error.reason
  : error instanceof PayrollLoopRefused ? (error.reason === 'not_administrator' || error.reason === 'invalid' || error.reason === 'changed' || error.reason === 'not_found' ? error.reason : 'changed')
  : 'failed';
/** Runs one decision, then returns to the page with `qsaved` or `qerror` (and any extra parameters). */
async function decide(form: FormData, saved: string, run: (session: Awaited<ReturnType<typeof admin>>) => Promise<Record<string, string> | void>, anchor = 'ai-quality') {
  const params = back(form);
  try {
    const extra = await run(await admin());
    params.set('qsaved', saved);
    for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
  } catch (error) {
    params.set('qerror', failure(error));
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?${params}#${anchor}`);
}

export async function dismissSignalAction(form: FormData) {
  const signalId = text(form.get('signalId'));
  await decide(form, 'dismissed', async s => { await reviewSignal(s, { signalId }, 'dismissed'); return { qsignal: signalId }; }, 'ai-quality-corrections');
}
export async function reopenSignalAction(form: FormData) {
  const signalId = text(form.get('signalId'));
  await decide(form, 'reopened', async s => { await reviewSignal(s, { signalId }, 'reopened'); }, 'ai-quality-corrections');
}
const candidateText = (form: FormData) => ({ question: text(form.get('question')), expectation: text(form.get('expectation')), kind: text(form.get('kind')), factor: text(form.get('factor')) });
export async function promoteSignalAction(form: FormData) {
  const signalId = text(form.get('signalId'));
  const params = back(form);
  try {
    const created = await promoteSignal(await admin(), { signalId, ...candidateText(form) });
    params.set('qsaved', 'candidate'); params.set('qcandidate', created.id);
  } catch (error) {
    // The form stays open with the error, the administrator's words not echoed in the address.
    params.set('qerror', failure(error)); params.set('qpromote', signalId);
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?${params}#ai-quality-candidates`);
}
export async function editCandidateAction(form: FormData) {
  const candidateId = text(form.get('candidateId')), version = Number(text(form.get('version')));
  const params = back(form);
  try {
    await editCandidate(await admin(), { candidateId, version, ...candidateText(form) });
    params.set('qsaved', 'edited');
  } catch (error) { params.set('qerror', failure(error)); }
  params.set('qcandidate', candidateId);
  revalidatePath(PAGE);
  redirect(`${PAGE}?${params}#ai-quality-candidates`);
}
const move = (transition: 'approve' | 'reopen' | 'withdraw', saved: string) => async (form: FormData) => {
  const candidateId = text(form.get('candidateId')), version = Number(text(form.get('version')));
  await decide(form, saved, async s => { await moveCandidate(s, { candidateId, version }, transition); return { qcandidate: candidateId }; }, 'ai-quality-candidates');
};
export async function approveCandidateAction(form: FormData) { await move('approve', 'approved')(form); }
export async function reopenCandidateAction(form: FormData) { await move('reopen', 'reopened_candidate')(form); }
export async function withdrawCandidateAction(form: FormData) { await move('withdraw', 'withdrawn')(form); }
/** Marks an approved candidate exported, then sends the browser to the download (a read-only route). */
export async function exportCandidateAction(form: FormData) {
  const candidateId = text(form.get('candidateId'));
  const params = back(form);
  let ok = false;
  try { await markCandidateExported(await admin(), { candidateId }); ok = true; } catch (error) { params.set('qerror', failure(error)); }
  revalidatePath(PAGE);
  if (ok && UUID.test(candidateId)) redirect(`${PAGE}/learning/export?candidate=${candidateId.toLowerCase()}`);
  redirect(`${PAGE}?${params}#ai-quality-candidates`);
}
export async function setGapStatusAction(form: FormData) {
  const companyIds = form.getAll('companyId').map(value => text(value)).filter(value => UUID.test(value));
  const intentKey = text(form.get('intentKey')), status = text(form.get('status')), duplicate = text(form.get('duplicateOf'));
  await decide(form, 'gap_status', async s => { await setGapStatus(s, { companyIds, intentKey, status, duplicateOf: status === 'duplicate' ? duplicate : null }); }, 'ai-quality-gaps');
}
export async function decideProposalAction(form: FormData) {
  const companyId = text(form.get('companyId')), proposalKey = text(form.get('proposalKey')), decision = text(form.get('decision'));
  await decide(form, decision === 'approved' ? 'proposal_approved' : 'proposal_rejected', async s => { await decideLoopProposal(s, { companyId, proposalKey, decision }); }, 'ai-quality-proposals');
}
export async function revertProposalAction(form: FormData) {
  const companyId = text(form.get('companyId')), decisionId = text(form.get('decisionId'));
  await decide(form, 'proposal_reverted', async s => { await revertLoopProposal(s, { companyId, decisionId }); }, 'ai-quality-proposals');
}
