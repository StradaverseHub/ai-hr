'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import { getSession } from '@/lib/session';
import { ModuleNotEnabledError } from '@/core/entitlements';
import { assignTestingCase, SystemTestingError, raiseRunAsFeedback, beginTestingExecution, confirmTestingCatalogue, publishTestInstruction, raiseTestingExecutionFeedback, requestTestingRetest, saveTestInstructionDraft, saveTestingExecution } from '@/core/system-testing';
import { TestingRefusal, testingUuid } from '@/lib/system-testing/model';
import type { TestingActionState } from '@/lib/system-testing/action-model';
import { feedbackBoardOpen } from '@/app/feedback/board';
const adminBase='/admin/system-testing',ownBase='/system-testing';
function refused(error: unknown): TestingActionState {
  if (error instanceof TestingRefusal) return { error: error.code };
  if (error instanceof SystemTestingError) return { error: 'invalid' };
  if (error instanceof ZodError || error instanceof SyntaxError) return { error: 'invalid' };
  if (error instanceof ModuleNotEnabledError) return { error: 'module_unavailable' };
  throw error; // Unknown SQL/auth/runtime failures must not masquerade as a completed save.
}
function value(form: FormData,key: string) { return String(form.get(key)??''); }
function integer(form: FormData,key: string) { const text=value(form,key); if (!/^\d+$/.test(text)) throw new TestingRefusal('invalid'); return Number(text); }
function json(form: FormData,key: string,max=8388608): unknown { const raw=value(form,key); if (Buffer.byteLength(raw,'utf8')>max) throw new TestingRefusal('limit'); return JSON.parse(raw); }
function boolean(form: FormData,key: string) {const v=value(form,key);if(v!=='true'&&v!=='false')throw new TestingRefusal('invalid');return v==='true';}
function refresh() { revalidatePath(adminBase); revalidatePath(ownBase); }
export async function saveTestingInstructionAction(_prior: TestingActionState,form: FormData): Promise<TestingActionState> {
  const ctx=await getSession(); let caseId: string; let savedDraft: TestingActionState['savedDraft'];
  try {
    if(!['draft','publish'].includes(value(form,'intent')))throw new TestingRefusal('invalid');
    const inputCase=value(form,'caseId'); if (inputCase) testingUuid.parse(inputCase);
    const saved=await saveTestInstructionDraft(ctx,{ caseId: inputCase||null,expectedRevision: integer(form,'draftRevision'),definition: json(form,'definition') }); caseId=saved.caseId; savedDraft={ caseId,revision: saved.revision,versionId: value(form,'versionId')||null };
    if (value(form,'intent')==='publish') { const published=await publishTestInstruction(ctx,{ caseId,expectedDraftRevision: saved.revision,expectedVersionId: value(form,'versionId')||null }); savedDraft={caseId,revision:published.draftRevision,versionId:published.versionId}; }
  } catch (error) { return { ...refused(error),...(savedDraft ? { savedDraft } : {}) }; }
  refresh(); revalidatePath(`${adminBase}/${caseId}`); return {error:null,savedDraft};
}
export async function assignTestingCaseAction(_prior: TestingActionState,form: FormData): Promise<TestingActionState> {
  const ctx=await getSession(); const caseId=value(form,'caseId');
  try { await assignTestingCase(ctx,{ caseId,testerUserId: value(form,'testerUserId'),expectedVersionId: value(form,'versionId'),active: boolean(form,'active'),expectedRevision: value(form,'assignmentRevision')===''?null:integer(form,'assignmentRevision') }); }
  catch (error) { return refused(error); }
  refresh(); revalidatePath(`${adminBase}/${testingUuid.parse(caseId)}`); return { error: null };
}
export async function beginTestingExecutionAction(_prior: TestingActionState,form: FormData): Promise<TestingActionState> {
  const ctx=await getSession();
  let executionId:string;
  try { const begun=await beginTestingExecution(ctx,{ assignmentId: value(form,'assignmentId'),expectedVersionId: value(form,'versionId'),newAttempt: boolean(form,'newAttempt') }); executionId=begun.executionId; } catch(error) { return refused(error); }
  redirect(`${ownBase}/executions/${executionId}`);
}
export async function saveTestingObservationAction(_prior: TestingActionState,form: FormData): Promise<TestingActionState> {
  const ctx=await getSession(); const executionId=value(form,'executionId'); let savedObservation: TestingActionState['savedObservation'];
  try { const saved=await saveTestingExecution(ctx,{ executionId,assignmentId: value(form,'assignmentId'),versionId: value(form,'versionId'),expectedRevision: integer(form,'revision'),status: value(form,'status') as Parameters<typeof saveTestingExecution>[1]['status'],actualResult: value(form,'actualResult'),comments: value(form,'comments'),defectNotes: value(form,'defectNotes'),improvementNotes: value(form,'improvementNotes') }); savedObservation={executionId,revision:saved.revision}; }
  catch (error) { return refused(error); }
  refresh(); revalidatePath(`${ownBase}/executions/${testingUuid.parse(executionId)}`); return { error: null,savedObservation };
}
export async function raiseTestingFeedbackAction(_prior: TestingActionState,form: FormData): Promise<TestingActionState> {
  const ctx=await getSession(); let feedbackId: string;
  if (!feedbackBoardOpen(ctx)) return { error: 'feedback_unavailable' }; // operator switch (0696): no board to raise onto
  try { const raised=await raiseTestingExecutionFeedback(ctx,{ executionId: value(form,'executionId'),expectedRevision: integer(form,'revision'),kind: value(form,'kind') as 'defect'|'improvement' }); feedbackId=raised.feedbackId; }
  catch (error) { return refused(error); }
  refresh(); redirect(`/feedback/${feedbackId}`);
}
export async function requestTestingRetestAction(_prior: TestingActionState,form: FormData): Promise<TestingActionState> {
  const ctx=await getSession();
  if (!feedbackBoardOpen(ctx)) return { error: 'feedback_unavailable' };
  try { await requestTestingRetest(ctx,{ assignmentId: value(form,'assignmentId'),expectedRevision: integer(form,'assignmentRevision'),expectedVersionId: value(form,'versionId'),feedbackId: value(form,'feedbackId') }); }
  catch (error) { return refused(error); }
  refresh(); revalidatePath('/admin/system-testing/executions/[id]','page'); return { error: null };
}
export async function confirmTestingCatalogueAction(_prior: TestingActionState,form: FormData): Promise<TestingActionState> {
  const ctx=await getSession();
  try { const mappings=json(form,'legacyMappings',262144); await confirmTestingCatalogue(ctx,{ expectedPreviewHash: value(form,'previewHash'),semanticIds: form.getAll('semanticId').map(String),replaceLocal: form.getAll('replaceLocal').map(String),distinctLegacy: form.getAll('distinctLegacy').map(String),legacyMappings: mappings as Parameters<typeof confirmTestingCatalogue>[1]['legacyMappings'] }); }
  catch (error) { return refused(error); }
  refresh(); return { error: null };
}

export async function raiseLegacyTestingFeedbackAction(_prior: TestingActionState,form: FormData): Promise<TestingActionState> {
  const ctx=await getSession(); let feedbackId: string;
  if (!feedbackBoardOpen(ctx)) return { error: 'feedback_unavailable' };
  try { ({feedbackId}=await raiseRunAsFeedback(ctx,{runId: value(form,'runId'),reporterEmploymentId:null})); }
  catch(error) { return refused(error); }
  refresh(); redirect(`/feedback/${feedbackId}`);
}
