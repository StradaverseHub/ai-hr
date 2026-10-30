import { effectiveFacts, type Case as NativeCase } from './onboarding-model';
import type { Case } from './lifecycle-v9-model';
/** Private document state only; native onboarding remains the owner of case identity, facts and tasks. */
export type NativeDocumentState = Pick<Case, 'documents' | 'runs' | 'mails' | 'files' | 'pmChanges' | 'log' | 'emailEdits'>;
export function nativeDocumentState(c: Case): NativeDocumentState {
  return structuredClone({ documents: c.documents, runs: c.runs, mails: c.mails, files: c.files, pmChanges: c.pmChanges, log: c.log, ...(c.emailEdits ? { emailEdits: c.emailEdits } : {}) });
}
export function nativeV9Facts(native: NativeCase, employeeUserId: string | null = null, supervisorUserId: string | null = null): Case['facts'] {
  const facts = effectiveFacts(native);
  return { finalConfirmationDate: facts.finalConfirmationDate, confirmationDate: facts.confirmationDate, probationEndDate: facts.probationEndDate, provisionalEndOn: facts.provisionalEndOn, name: facts.fullName, employeeNo: facts.employeeId, employmentId: native.employmentId ?? '', personId: native.personId ?? '', joinDate: facts.joinDate, lastDay: '', noticeDate: '', employeeUserId, supervisorUserId, pbpUserId: null, taUserId: facts.gbsTa || null, starterUserId: native.submittedBy, businessGroup: facts.businessGroup, company: facts.company, department: facts.department, grade: facts.grade, employmentType: facts.employmentType, title: facts.title, caseType: '' };
}
export function projectNativeCase(native: NativeCase, revision: number, state?: NativeDocumentState | null, employeeUserId: string | null = null, supervisorUserId: string | null = null): Case {
  return { version: 9, id: native.id, number: native.number, module: 'onb', revision,
    state: native.state === 'submitted' ? 'submitted' : native.state === 'cancelled' ? 'cancelled' : 'pending',
    facts: nativeV9Facts(native, employeeUserId, supervisorUserId),
    checklistId: native.confirmedChecklist?.id ?? null, checklistName: native.confirmedChecklist?.name ?? '', override: native.checklistOverride ?? 'automatic',
    tasks: native.tasks.map(task => ({ id: task.id, name: task.name, by: task.by === 'joiner' ? 'employee' : task.by, group: task.group || null, mode: task.method, opens: task.opens, due: task.due, required: task.required ?? false, documentTemplate: task.documentTemplate ?? null, documentAction: task.documentAction ?? 'completed', opensOn: task.opensOn, dueOn: task.dueOn, assignee: task.assignee, status: task.status, reason: '', assignmentFailure: task.failure })),
    items: [], documents: structuredClone(state?.documents ?? []), runs: structuredClone(state?.runs ?? []), mails: structuredClone(state?.mails ?? []), files: structuredClone(state?.files ?? []), pmChanges: structuredClone(state?.pmChanges ?? []), log: structuredClone(state?.log ?? []), ...(state?.emailEdits ? { emailEdits: structuredClone(state.emailEdits) } : {}),
    sourceRevision: native.sourceVersion, submittedAt: native.submittedAt, closedAt: null, closedBy: null, closeReason: '', cancelReason: native.cancelReason ?? '', revokeDate: '', finalFigures: null, review: null };
}
