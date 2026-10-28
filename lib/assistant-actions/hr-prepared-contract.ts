/** ADR-0151 (amendment 2026-10-29): the first HR-administrator actions. HR acts on SOMEONE ELSE's employment
 * through the wave 1b assigned binding: the caller is the administrator, the subject is the employee's
 * employment and never the caller's own, and the native service decides authority and every effect.
 * Days, dates, reasons and destinations are HR's own inputs on the review card; the model never chooses
 * them, and nothing here computes a balance or money. */
import {z} from 'zod';
export const HR_LEAVE_ADJUSTMENT_ACTION='leave.adjustment.apply' as const;
export const HR_MOVEMENT_TRANSFER_ACTION='employees.movement.transfer' as const;
export const HR_PREPARED_ACTIONS=[HR_LEAVE_ADJUSTMENT_ACTION,HR_MOVEMENT_TRANSFER_ACTION] as const;
export type HrPreparedAction=typeof HR_PREPARED_ACTIONS[number];
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),date=z.iso.date(),name=z.string().min(1).max(240),code=z.string().max(100).nullable();
/** No transform: the store compares the parsed content with the posted input byte for byte. */
const reason=z.string().max(500).refine(value=>value.trim().length>0&&!value.trim().startsWith('sys:'),'reason');
const State=z.enum(['awaiting_confirmation','completed','discarded','expired','refused']);

/** The employee HR chose, with the stored labels HR recognises them by. */
export const HrSubject=z.object({employmentId:uuid,employeeName:name,employeeCode:code,companyName:name}).strict();
/** A bounded name search over the employees this administrator may act on; never another tenant's. */
export const HrChoicesSelection=z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict();
const option=z.object({id:uuid,name}).strict();

// Leave adjustment: one employee, one leave type, whole or half days, an effective date and HR's reason.
const LeaveAdjustmentHuman=z.object({action:z.literal(HR_LEAVE_ADJUSTMENT_ACTION),contractVersion:z.literal(1),employmentId:uuid,subjectId:uuid,
 leaveTypeId:uuid,direction:z.enum(['add','deduct']),days:z.string().regex(/^(?:[1-9]\d{0,2}|0)(?:\.[05])?$/).refine(v=>Number(v)>0&&Number(v)<=366),effectiveOn:date,reason}).strict()
 .refine(v=>v.subjectId===v.employmentId);
const LeaveAdjustmentItem=z.object({employmentId:uuid,subjectId:uuid,employeeName:name,employeeCode:code,companyName:name,leaveTypeName:name,
 signedDays:z.string().regex(/^-?\d{1,3}\.\d{2}$/),effectiveOn:date,reason:z.string().max(500)}).strict();
const LeaveAdjustmentChoices=z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(HrSubject).max(25),truncated:z.boolean(),leaveTypes:z.array(option).max(60)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]);
const LeaveAdjustmentReceipt=z.object({kind:z.literal('adjusted'),subjectId:uuid,eventId:uuid,employmentId:uuid,batchId:uuid,written:z.number().int().positive()}).strict();

// Movement: an assignment-only Transfer or Organisation Assignment Change. No grade, pay, company or exit.
const MovementHuman=z.object({action:z.literal(HR_MOVEMENT_TRANSFER_ACTION),contractVersion:z.literal(1),employmentId:uuid,subjectId:uuid,
 kind:z.enum(['transfer','orgAssignmentChange']),effectiveDate:date,departmentId:uuid.nullable(),positionId:uuid.nullable(),businessUnitId:uuid.nullable(),locationId:uuid.nullable(),
 remarks:z.string().max(1000).optional()}).strict()
 .refine(v=>v.subjectId===v.employmentId&&(v.departmentId||v.positionId||v.businessUnitId||v.locationId));
const MovementItem=z.object({employmentId:uuid,subjectId:uuid,employeeName:name,employeeCode:code,companyName:name,kind:z.enum(['transfer','orgAssignmentChange']),effectiveDate:date,
 department:name.nullable(),position:name.nullable(),businessUnit:name.nullable(),location:name.nullable(),remarks:z.string().max(1000).nullable(),scheduled:z.boolean()}).strict();
const MovementChoices=z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(HrSubject).max(25),truncated:z.boolean(),
 departments:z.array(option).max(200),positions:z.array(option).max(200),businessUnits:z.array(option).max(200),locations:z.array(option).max(200)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]);
const MovementReceipt=z.object({kind:z.literal('moved'),subjectId:uuid,eventId:uuid,employmentId:uuid,recorded:z.enum(['applied','scheduled'])}).strict();

function contract<A extends HrPreparedAction,H extends z.ZodType<{employmentId:string;subjectId:string}>,I extends z.ZodObject,C extends z.ZodType,R extends z.ZodObject>(action:A,human:H,item:I,choices:C,receipt:R,consequence:string,indexKind:string){
 const base={action:z.literal(action),contractVersion:z.literal(1)};
 return {
  action,Human:human,Item:item,Choices:choices,Receipt:receipt,
  Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),
  Retirement:z.object({...base,actionId:uuid}).strict(),
  Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:human,review:item,consequence:z.literal(consequence)}).strict(),
  Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt}).strict(),
  Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
  Index:z.object({kind:z.literal(indexKind),reviews:z.array(z.object({...base,actionId:uuid,state:State,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
  consequence,indexKind,
 } as const;
}
/** The balance changes from the effective date; payroll and encashment read it like any other entry. */
export const HrLeaveAdjustment=contract(HR_LEAVE_ADJUSTMENT_ACTION,LeaveAdjustmentHuman,LeaveAdjustmentItem,LeaveAdjustmentChoices,LeaveAdjustmentReceipt,'hr_leave_adjustment_balance_changes_from_effective_date','leave_adjustment_review_index');
/** A past or current date applies now; a future date waits as a pending movement until that morning. */
export const HrMovementTransfer=contract(HR_MOVEMENT_TRANSFER_ACTION,MovementHuman,MovementItem,MovementChoices,MovementReceipt,'hr_movement_applies_on_effective_date','movement_transfer_review_index');
export const HR_PREPARED_CONTRACTS={[HR_LEAVE_ADJUSTMENT_ACTION]:HrLeaveAdjustment,[HR_MOVEMENT_TRANSFER_ACTION]:HrMovementTransfer} as const;
export type HrLeaveAdjustmentHuman=z.infer<typeof LeaveAdjustmentHuman>;
export type HrMovementTransferHuman=z.infer<typeof MovementHuman>;
