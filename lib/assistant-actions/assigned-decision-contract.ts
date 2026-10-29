/** ADR-0151 wave 1b: an ASSIGNED approver decides one pending claim, attendance request or replacement
 * leave (TOIL) request from their own inbox. The decider is the caller; the subject is someone else's
 * employment and never the decider's own. The native service decides authority, limits, workflow levels
 * and every effect. The decision and the note are the decider's own input; the model never chooses them. */
import {z} from 'zod';
export const ASSIGNED_CLAIM_DECISION_ACTION='approvals.claim.decide' as const;
export const ASSIGNED_ATTENDANCE_DECISION_ACTION='approvals.attendance.decide' as const;
export const ASSIGNED_TOIL_DECISION_ACTION='approvals.toil.decide' as const;
export const ASSIGNED_DECISION_ACTIONS=[ASSIGNED_CLAIM_DECISION_ACTION,ASSIGNED_ATTENDANCE_DECISION_ACTION,ASSIGNED_TOIL_DECISION_ACTION] as const;
export type AssignedDecisionAction=typeof ASSIGNED_DECISION_ACTIONS[number];
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),date=z.iso.date(),text=z.string().max(4000),name=z.string().min(1).max(240),code=z.string().max(100).nullable();
const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);
const State=z.enum(['awaiting_confirmation','completed','discarded','expired','refused']);
export const AssignedDecision=z.enum(['approved','rejected']);
export type AssignedDecision=z.infer<typeof AssignedDecision>;

/** Item facts a decider needs to recognise the request. Stored native values only; nothing is computed. */
export const AssignedClaimItem=z.object({employmentId:uuid,subjectId:uuid,employeeName:name,employeeCode:code,claimTypeName:name,itemName:name.nullable(),incurredOn:date,
 amount:z.string().regex(/^-?\d+\.\d{2}$/),description:text.nullable()}).strict();
export const AssignedAttendanceItem=z.object({employmentId:uuid,subjectId:uuid,employeeName:name,employeeCode:code,date,overtime:z.boolean(),
 proposedCheckIn:time.nullable(),proposedCheckOut:time.nullable(),plannedStartTime:time.nullable(),plannedEndTime:time.nullable(),requestedOtMinutes:z.number().int().nonnegative().nullable(),reason:text.nullable()}).strict();
export const AssignedToilItem=z.object({employmentId:uuid,subjectId:uuid,employeeName:name,employeeCode:code,submittedOn:date,totalDays:z.number().finite().nonnegative(),
 totalHours:z.number().finite().nonnegative(),lines:z.number().int().positive(),reason:text.nullable()}).strict();

function contract<A extends AssignedDecisionAction,I extends z.ZodObject>(action:A,item:I,consequence:string,indexKind:string,note:z.ZodType<string|undefined>){
 const base={action:z.literal(action),contractVersion:z.literal(1)};
 const Human=z.object({...base,employmentId:uuid,subjectId:uuid,decision:AssignedDecision,note}).strict();
 const Receipt=z.object({kind:z.literal('decided'),subjectId:uuid,eventId:uuid,employmentId:uuid,decision:AssignedDecision,
  /** 'final' when this decision settled the request; 'level' when a multi-level workflow still needs a later approver. */
  recorded:z.enum(['final','level']),currentStatus:z.enum(['pending','approved','rejected','cancelled','paid'])}).strict();
 return {
  action,Item:item,Human,Receipt,
  Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),items:z.array(item).max(25),truncated:z.boolean()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
  Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),
  Retirement:z.object({...base,actionId:uuid}).strict(),
  Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:item,consequence:z.literal(consequence)}).strict(),
  Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),
  Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
  Index:z.object({kind:z.literal(indexKind),reviews:z.array(z.object({...base,actionId:uuid,state:State,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
  consequence,indexKind,
 } as const;
}
const optionalNote=z.string().max(1000).optional();
/** Optional on the stored wire for old sealed reviews; new rejections require the human reason. */
export const AssignedClaimDecision=contract(ASSIGNED_CLAIM_DECISION_ACTION,AssignedClaimItem,'assigned_claim_decided_payment_by_payroll_or_reimbursement','claim_decision_review_index',optionalNote);
/** A rejected attendance request needs the decider's 1–1000 character explanation (native rule). */
export const AssignedAttendanceDecision=contract(ASSIGNED_ATTENDANCE_DECISION_ACTION,AssignedAttendanceItem,'assigned_attendance_decision_may_remain_pending','attendance_decision_review_index',optionalNote);
export const AssignedToilDecision=contract(ASSIGNED_TOIL_DECISION_ACTION,AssignedToilItem,'assigned_toil_decided_credit_minted_on_approval','toil_decision_review_index',optionalNote);
export const ASSIGNED_DECISION_CONTRACTS={[ASSIGNED_CLAIM_DECISION_ACTION]:AssignedClaimDecision,[ASSIGNED_ATTENDANCE_DECISION_ACTION]:AssignedAttendanceDecision,[ASSIGNED_TOIL_DECISION_ACTION]:AssignedToilDecision} as const;
export type AssignedClaimHuman=z.infer<typeof AssignedClaimDecision.Human>;
export type AssignedAttendanceHuman=z.infer<typeof AssignedAttendanceDecision.Human>;
export type AssignedToilHuman=z.infer<typeof AssignedToilDecision.Human>;
