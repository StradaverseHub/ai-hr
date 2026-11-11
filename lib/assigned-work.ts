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
 // Recruitment Overview (D-035).
 'recruitmentRequisitionApproval','recruitmentOfferApproval','recruitmentFeedback'] as const;
/** The Recruitment kinds above. Only surfaces that ask for them (core/approvals-inbox.ts InboxModulesWithRecruitment) get them. */
export const RECRUITMENT_TASK_KINDS=['recruitmentRequisitionApproval','recruitmentOfferApproval','recruitmentFeedback'] as const satisfies readonly PackTaskKind[];
export type PackTaskKind=typeof PACK_TASK_KINDS[number];
export type RecruitmentTaskKind=typeof RECRUITMENT_TASK_KINDS[number];
export type PackTaskItem={id:string;kind:PackTaskKind;subjectName:string|null;createdAt:string;linkPath:string};
/** A pack's task provider. `scopeIds` is the company-switcher selection; undefined means no filter. */
export type PackTaskProvider=(ctx:SessionContext,scopeIds:string[]|undefined)=>Promise<PackTaskItem[]>;
