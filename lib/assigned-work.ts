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
 // Recruitment slice 9 (packs/recruitment/tasks.ts): the viewer's personal recruitment to-dos for the bell and My tasks —
 // a requisition or offer approval step waiting for them, and interview feedback due. Per-job counts stay on the
 // Recruitment Overview (D-035). Slice 10: an agency submission waiting for the administrator's review, and the HR contact's
 // agency contract expiry. Slice 11: a screening request waiting for the hiring manager's feedback. Slice 12: the recorder's
 // background check waiting for the candidate's authorisation, and one in progress for more than 14 Kuala Lumpur days.
 'recruitmentRequisitionApproval','recruitmentOfferApproval','recruitmentFeedback','recruitmentAgencyReview','recruitmentContractExpiry','recruitmentScreening',
 'recruitmentBackgroundCheckAuthorisation','recruitmentBackgroundCheckOverdue',
 // Probation (core/probation.ts pendingProbationTasks): Approve steps, and every other Probation task (employee, Line
 // Manager, PBP and GBS tasks, letter Sign steps). Both open the case view.
 'probationApproval','probationTask'] as const;
/** The Recruitment kinds above. Only surfaces that ask for them (core/approvals-inbox.ts InboxModulesWithRecruitment) get them. */
export const RECRUITMENT_TASK_KINDS=['recruitmentRequisitionApproval','recruitmentOfferApproval','recruitmentFeedback','recruitmentAgencyReview','recruitmentContractExpiry','recruitmentScreening','recruitmentBackgroundCheckAuthorisation','recruitmentBackgroundCheckOverdue'] as const satisfies readonly PackTaskKind[];
export type PackTaskKind=typeof PACK_TASK_KINDS[number];
export type RecruitmentTaskKind=typeof RECRUITMENT_TASK_KINDS[number];
/**
 * Probation only (lane L, L5): the plain step code of the caller's task (app.probation_task_list `kind`, for example
 * `letter_sign`) and its part number, so the queues name the step ("Sign probation letter") instead of a generic
 * "Probation task". A code and a part number, never content; other packs keep exactly the five keys above.
 */
export type PackTaskAction={code:string;part:number|null};
export type PackTaskItem={id:string;kind:PackTaskKind;subjectName:string|null;createdAt:string;linkPath:string;action?:PackTaskAction};
/** A pack's task provider. `scopeIds` is the company-switcher selection; undefined means no filter. */
export type PackTaskProvider=(ctx:SessionContext,scopeIds:string[]|undefined)=>Promise<PackTaskItem[]>;
