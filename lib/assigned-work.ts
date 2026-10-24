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
