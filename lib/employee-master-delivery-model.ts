import {z} from 'zod';
/** Only a durable occurrence and its unguessable lease capability cross the managed mail boundary. */
export const masterDeliveryRequest=z.discriminatedUnion('op',[
 z.object({op:z.literal('status')}).strict(),
 z.object({op:z.literal('sendReport'),occurrenceId:z.uuid(),leaseToken:z.uuid()}).strict(),
]);
export type MasterDeliveryRequest=z.infer<typeof masterDeliveryRequest>;
export type MasterDeliveryOutcome='sent'|'failed'|'skipped'|'uncertain';
export type MasterDeliveryReason='notEligible'|'recipientChanged'|'generationFailed'|'attachmentTooLarge'|'smtpRejected'|'smtpUnavailable'|'uncertain';
export const MASTER_EMAIL_ATTACHMENT_MAX_BYTES=20_000_000;
