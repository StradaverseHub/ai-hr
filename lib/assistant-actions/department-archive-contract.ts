/** A department is a catalogue entity, never an employee or a person. Uses the genuine catalogue binding. */
import {z} from 'zod';
export const DEPARTMENT_ARCHIVE_ACTION='org.department.archive' as const;
const uuid=z.guid();
const State=z.object({departmentId:uuid,companyId:uuid,name:z.string().min(1).max(4000),archived:z.boolean()}).strict();
export const DepartmentArchiveHuman=z.object({action:z.literal(DEPARTMENT_ARCHIVE_ACTION),contractVersion:z.literal(1),departmentId:uuid,expectedArchived:z.boolean(),archived:z.boolean()}).strict().refine(v=>v.expectedArchived!==v.archived);
export const DepartmentArchiveReview=State.extend({companyName:z.string().min(1).max(4000),afterArchived:z.boolean()}).strict().refine(v=>v.archived!==v.afterArchived);
export const DepartmentArchiveConfirmation=z.object({action:z.literal(DEPARTMENT_ARCHIVE_ACTION),contractVersion:z.literal(1),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const DepartmentArchiveReceipt=State.extend({eventId:uuid,kind:z.literal('recorded'),semantics:z.literal('native_department_archive_current_record')}).strict();

/** Public custody digest is the encrypted envelope commitment, never the inner native digest above. */
const base={action:z.literal(DEPARTMENT_ARCHIVE_ACTION),contractVersion:z.literal(1)};
export const DepartmentArchiveEnvelopeConfirmation=z.object({...base,actionId:uuid,reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const DepartmentArchiveRetirement=z.object({...base,actionId:uuid}).strict();
export const DepartmentArchivePrepared=z.object({...base,actionId:uuid,reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:DepartmentArchiveHuman,review:DepartmentArchiveReview,consequence:z.literal('catalogue_archive_state_only_no_assignment_or_access_change')}).strict().refine(v=>v.content.departmentId===v.review.departmentId&&v.content.expectedArchived===v.review.archived&&v.content.archived===v.review.afterArchived&&Date.parse(v.expiresAt)>Date.parse(v.createdAt));
export const DepartmentArchiveCompleted=z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:DepartmentArchiveReceipt}).strict();
export const DepartmentArchiveRetired=z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict();
export const DepartmentArchiveIndex=z.object({kind:z.literal('department_archive_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(r=>r.actionId)).size===rows.length)}).strict();
export const DepartmentArchiveSelection=z.object({query:z.string().trim().max(80),departmentId:uuid.optional()}).strict();
export const DepartmentArchiveChoices=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('choices'),departments:z.array(State.extend({companyName:z.string().min(1).max(4000),inUse:z.boolean()}).strict()).max(25).refine(rows=>new Set(rows.map(r=>r.departmentId)).size===rows.length),truncated:z.boolean()}).strict(),
 z.object({kind:z.literal('unavailable')}).strict(),
]);
