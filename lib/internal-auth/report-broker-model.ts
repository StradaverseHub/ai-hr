/** Closed, key-free managed-report IPC contract. No caller identity or arbitrary record/path input. */
import {emailDesignEnvelope} from '../email-design/model';
import {z} from 'zod';
import {masterRenderContext} from '../../deploy/identity-email/render-context';
import {masterArtifactFingerprint} from '../employee-master-artifact-model';
import {deliveryEmailRelay} from '../identity/email-relay';
export const REPORT_BROKER_REQUEST_MAX_BYTES=4096;
export const REPORT_BROKER_REPLY_MAX_BYTES=512*1024;
export const REPORT_INSPECTION_MAX_CHARS=3000;
export const reportBrokerTarget=masterRenderContext.extend({subject:z.uuid(),email:z.email().max(320).regex(/^[\x21-\x7e]+$/)}).strict();
export type ReportBrokerTarget=z.infer<typeof reportBrokerTarget>;
export const reportBrokerRelay=deliveryEmailRelay;
const nonce={occurrenceId:z.uuid(),leaseToken:z.uuid()};
export const reportBrokerRequest=z.discriminatedUnion('phase',[
 z.object({phase:z.literal('status')}).strict(),
 z.object({phase:z.literal('inspect'),...nonce}).strict(),
 z.object({phase:z.literal('start'),...nonce,inspectionProof:z.string().min(1).max(REPORT_INSPECTION_MAX_CHARS).regex(/^[A-Za-z0-9_-]+$/),expectedArtifact:masterArtifactFingerprint}).strict(),
]);
export const reportBrokerFailureReason=z.enum(['notEligible','busy','unavailable','generationFailed','attachmentTooLarge']);
export type ReportBrokerFailureReason=z.infer<typeof reportBrokerFailureReason>;
export const reportBrokerResponse=z.union([
 z.object({available:z.boolean()}).strict(),
 z.object({ok:z.literal(false),reason:reportBrokerFailureReason}).strict(),
 z.object({ok:z.literal(true),phase:z.literal('inspect'),target:reportBrokerTarget,inspectionProof:z.string().min(1).max(REPORT_INSPECTION_MAX_CHARS).regex(/^[A-Za-z0-9_-]+$/)}).strict(),
 z.object({ok:z.literal(true),phase:z.literal('start'),target:reportBrokerTarget,artifact:masterArtifactFingerprint,relay:reportBrokerRelay,design:emailDesignEnvelope.optional()}).strict(),
]);
export type ReportBrokerRequest=z.infer<typeof reportBrokerRequest>;
export type ReportBrokerResponse=z.infer<typeof reportBrokerResponse>;
