import type {SessionContext} from '../db/client';
/** Internal owner-to-inbox metadata. No request body, proposal, amount, reason or attachment belongs here. */
export type AssignedApprovalMetadata={
 id:string;employmentId:string;personId:string;employee:string|null;createdAt:Date;dueDate?:string;
};
/** Personal action metadata. sourceUpdatedAt is an owner timestamp, never a guessed task age. */
export type AssignedPersonalTaskMetadata={
 id:string;kind:'feedback'|'onboarding';subjectName:string;sourceUpdatedAt:Date;linkPath:string;dueDate?:string;
};
export class AssignedWorkPrincipalUnavailableError extends Error{
 constructor(){super('Assigned work is unavailable for this principal.');this.name='AssignedWorkPrincipalUnavailableError';}
}
/**
 * Module-owned task kinds (WP-A1). A pack whose work belongs in the shared task list (bell Task tab,
 * Home, the dashboard tile) projects its OWN assignment owner into this shape; core/approvals-inbox.ts
 * calls the provider only when the caller has resolved the module as enabled. Five keys, exactly:
 * never a band, rating, score, amount, remark or plan body — the link opens the owning screen, which
 * applies its own authorization again.
 */
export const PACK_TASK_KINDS=['performanceReview','assessmentWork','careerPlan','calibration','rewardReview',
 // Probation (core/probation.ts pendingProbationTasks): Approve steps, and every other Probation task (employee, Line
 // Manager, PBP and GBS tasks, letter Sign steps). Both open the case view.
 'probationApproval','probationTask','contractApproval','contractLetter','contractDecision','contractPosting','contractPay'] as const;
export type PackTaskKind=typeof PACK_TASK_KINDS[number];
/**
 * Probation only (lane L, L5): the plain step code of the caller's task (app.probation_task_list `kind`, for example
 * `letter_sign`) and its part number, so the queues name the step ("Sign probation letter") instead of a generic
 * "Probation task". A code and a part number, never content; other packs keep exactly the five keys above.
 */
export type PackTaskAction={code:string;part:number|null};
export type PackTaskItem={id:string;kind:PackTaskKind;subjectName:string|null;createdAt:string;linkPath:string;action?:PackTaskAction};
/** A pack's task provider. `scopeIds` is the company-switcher selection; undefined means no filter. */
export type PackTaskProvider=(ctx:SessionContext,scopeIds:string[]|undefined)=>Promise<PackTaskItem[]>;
