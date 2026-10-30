/** One existing pending request. No proposal values, photo, upload or field-application inputs. */
import {z} from 'zod';
import {personnelField} from '../personnel-field-registry';
export const PROFILE_REQUEST_REJECTION_ACTION='employees.profile_request.reject' as const;
const id=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),base={action:z.literal(PROFILE_REQUEST_REJECTION_ACTION),contractVersion:z.literal(1)};
const Human=z.object({...base,employmentId:id,subjectId:id,reason:z.string().trim().min(1).max(2000)}).strict();
const Subject=z.object({subjectId:id,employmentId:id,employeeName:z.string().min(1).max(4000),employeeCode:z.string().max(4000).nullable(),companyName:z.string().min(1).max(4000),requestedAt:z.iso.datetime(),fieldIds:z.array(z.string().min(1).max(160)).min(1).max(32).refine(ids=>new Set(ids).size===ids.length&&ids.every(id=>personnelField(id)?.ess.visibility==='visible'))}).strict();
const Item=Subject.extend({before:z.object({status:z.literal('pending'),reason:z.null()}).strict(),after:z.object({status:z.literal('rejected'),reason:z.string().min(1).max(2000)}).strict()}).strict();
const Receipt=z.object({kind:z.literal('rejected'),subjectId:id,employmentId:id,eventId:id}).strict();
const consequence='request_rejected_reason_shared_with_employee_no_profile_fields_applied' as const;
export const ProfileRequestRejection={action:PROFILE_REQUEST_REJECTION_ACTION,Human,Item,Receipt,Subject,consequence,indexKind:'profile_request_rejection_review_index',
 Selection:z.object({query:z.string().trim().max(80),subjectId:id.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),requests:z.array(Subject).max(25),truncated:z.boolean()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:id,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:id}).strict(),
 Prepared:z.object({...base,actionId:id,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>v.content.subjectId===v.review.subjectId&&v.content.employmentId===v.review.employmentId&&v.content.reason===v.review.after.reason&&new TextEncoder().encode(JSON.stringify(v)).byteLength<=65536),
 Completed:z.object({...base,actionId:id,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:id,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('profile_request_rejection_review_index'),reviews:z.array(z.object({...base,actionId:id,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type ProfileRequestRejectionHuman=z.infer<typeof Human>;
