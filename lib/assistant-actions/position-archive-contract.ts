/** A position is a catalogue entity, never an employee or a person. Unmounted pending custody. */
import {z} from 'zod';
export const POSITION_ARCHIVE_ACTION='org.position.archive' as const;
const uuid=z.guid();
const State=z.object({positionId:uuid,companyId:uuid,title:z.string().min(1).max(4000),archived:z.boolean()}).strict();
export const PositionArchiveHuman=z.object({action:z.literal(POSITION_ARCHIVE_ACTION),contractVersion:z.literal(1),positionId:uuid,expectedArchived:z.boolean(),archived:z.boolean()}).strict().refine(v=>v.expectedArchived!==v.archived);
export const PositionArchiveReview=State.extend({afterArchived:z.boolean()}).strict().refine(v=>v.archived!==v.afterArchived);
export const PositionArchiveConfirmation=z.object({action:z.literal(POSITION_ARCHIVE_ACTION),contractVersion:z.literal(1),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const PositionArchiveReceipt=State.extend({eventId:uuid,kind:z.literal('recorded'),semantics:z.literal('native_position_archive_current_record')}).strict();
