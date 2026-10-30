/** A position is a catalogue entity, never an employee or a person. Unmounted pending custody. */
import {z} from 'zod';
export const POSITION_ARCHIVE_ACTION='org.position.archive' as const;
const uuid=z.guid();
const State=z.object({positionId:uuid,companyId:uuid,title:z.string().min(1).max(4000),archived:z.boolean()}).strict();
export const PositionArchiveHuman=z.object({action:z.literal(POSITION_ARCHIVE_ACTION),contractVersion:z.literal(1),positionId:uuid,expectedArchived:z.boolean(),archived:z.boolean()}).strict().refine(v=>v.expectedArchived!==v.archived);
export const PositionArchiveReview=State.extend({afterArchived:z.boolean()}).strict().refine(v=>v.archived!==v.afterArchived);
export const PositionArchiveConfirmation=z.object({action:z.literal(POSITION_ARCHIVE_ACTION),contractVersion:z.literal(1),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const PositionArchiveReceipt=State.extend({eventId:uuid,kind:z.literal('recorded'),semantics:z.literal('native_position_archive_current_record')}).strict();

/** Public custody digest is the encrypted envelope commitment, never the inner native digest above. */
const base={action:z.literal(POSITION_ARCHIVE_ACTION),contractVersion:z.literal(1)};
export const PositionArchiveEnvelopeConfirmation=z.object({...base,actionId:uuid,reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const PositionArchiveRetirement=z.object({...base,actionId:uuid}).strict();
export const PositionArchivePrepared=z.object({...base,actionId:uuid,reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:PositionArchiveHuman,review:PositionArchiveReview,consequence:z.literal('catalogue_archive_state_only_no_assignment_or_access_change')}).strict().refine(v=>v.content.positionId===v.review.positionId&&v.content.expectedArchived===v.review.archived&&v.content.archived===v.review.afterArchived&&Date.parse(v.expiresAt)>Date.parse(v.createdAt));
export const PositionArchiveCompleted=z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:PositionArchiveReceipt}).strict();
export const PositionArchiveRetired=z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict();
export const PositionArchiveIndex=z.object({kind:z.literal('position_archive_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(r=>r.actionId)).size===rows.length)}).strict();
export const PositionArchiveSelection=z.object({query:z.string().trim().max(80),positionId:uuid.optional()}).strict();
export const PositionArchiveChoices=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('choices'),positions:z.array(State.extend({companyName:z.string().min(1).max(4000),inUse:z.boolean()}).strict()).max(25).refine(rows=>new Set(rows.map(r=>r.positionId)).size===rows.length),truncated:z.boolean()}).strict(),
 z.object({kind:z.literal('unavailable')}).strict(),
]);
