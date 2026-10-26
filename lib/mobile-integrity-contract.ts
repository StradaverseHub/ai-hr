/** Integrity protocol v1. A capability or prepared proof is never accepted attendance. */
import {z} from 'zod';
import {KeyEnrollmentContext} from './mobile-key-enrollment';
import {OnlineClockIntegrityData} from './mobile-clock-integrity';
import {ClockReceipt} from './mobile-api/contract';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const base64=z.string().min(4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const hash32=z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/);
export const IntegrityEnrollmentIntent=z.object({requestId:uuid,appInstallationId:uuid}).strict();
export const IntegrityEnrollmentProof=IntegrityEnrollmentIntent.extend({challengeId:uuid,vendorKeyId:hash32,attestation:base64.max(87384)}).strict();
export const IntegrityClockIntent=z.object({appInstallationId:uuid,keyId:uuid,deviceToken:uuid.optional(),
  command:OnlineClockIntegrityData.shape.command.omit({photo:true}),evidence:OnlineClockIntegrityData.shape.evidence}).strict();
export const IntegrityClockProof=IntegrityClockIntent.extend({challengeId:uuid,assertion:base64.max(10924)}).strict();
export const IntegrityRevokeIntent=z.object({keyId:uuid}).strict();
export const IntegrityKeyReceipt=z.object({keyId:uuid,originChallengeId:uuid,platform:z.literal('ios'),appId:z.string().max(300),
  environment:z.enum(['production','development']),proofKind:z.enum(['apple_key_proof','apple_app_metadata']),
  createdAt:z.string().datetime(),revokedAt:z.string().datetime().nullable()}).strict();
export const IntegrityRefused=z.object({outcome:z.literal('refused'),code:z.enum(['subject_unavailable','key_unavailable','key_exists','key_limit',
  'binding_conflict','challenge_unavailable','invalid_proof','clock_conflict','corrected_day','location_required','outside_geofence','photo_required','photo_invalid','device_required']),
  locationReason:z.enum(['location_required','invalid_location','poor_accuracy','no_assigned_site','outside_site']).optional()}).strict();
export const IntegrityUnavailable=z.object({outcome:z.literal('unavailable'),code:z.enum(['not_configured','configuration_unavailable','metadata_unavailable','proof_unavailable','module_unavailable'])}).strict();
const state=z.enum(['active','expired','consumed']);
const result=<S extends z.ZodType>(success:S)=>z.union([success,IntegrityRefused,IntegrityUnavailable]);
export const IntegrityCapabilities=result(z.object({outcome:z.literal('capabilities'),protocol:z.literal(1),platform:z.literal('ios'),
  features:z.tuple([z.literal('key_enrollment'),z.literal('online_clock_assertion')]),offline:z.literal(false)}).strict());
export const IntegrityEnrollmentPrepared=result(z.object({outcome:z.literal('prepared'),protocol:z.literal(1),context:KeyEnrollmentContext,
  clientDataHash:hash32,alias:z.string().regex(/^aihr_[a-f0-9]{64}$/),state}).strict());
export const IntegrityEnrollmentResult=result(z.object({outcome:z.literal('enrolled'),key:IntegrityKeyReceipt}).strict());
export const IntegrityKeysResult=result(z.object({outcome:z.literal('keys'),items:z.array(IntegrityKeyReceipt).max(20)}).strict());
export const IntegrityRevocationResult=result(z.object({outcome:z.literal('revoked'),key:IntegrityKeyReceipt}).strict());
export const IntegrityClockPrepared=result(z.object({outcome:z.literal('prepared'),protocol:z.literal(1),context:OnlineClockIntegrityData,state}).strict());
export const IntegrityClockResult=result(z.object({outcome:z.literal('accepted'),receipt:ClockReceipt}).strict());
