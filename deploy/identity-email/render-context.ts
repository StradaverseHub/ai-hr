import {z} from 'zod';
const grant=z.object({role:z.string().min(1).max(100),companyId:z.uuid().nullable()}).strict();
/** SQL returns microseconds as text. Do not pass revision timestamps through JavaScript Date. */
const instant=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
export const masterRenderContext=z.object({tenantId:z.uuid(),ownerUserId:z.uuid(),recipientUserId:z.uuid(),recipientEmploymentId:z.uuid(),reportId:z.uuid(),reportVersion:z.number().int().positive(),scheduleId:z.uuid(),scheduleRevision:z.uuid(),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/),locale:z.enum(['en','ms','zh','vi','ta','th']),consentAfterSequence:z.number().int().nonnegative().safe(),policyAfterSequence:z.number().int().nonnegative().safe(),consentUpdatedAt:instant,policyUpdatedAt:instant,consentVerifiedAt:instant,ownerGrants:z.array(grant).max(1000),recipientGrants:z.array(grant).max(1000),ownerPersonId:z.uuid().nullable(),recipientPersonId:z.uuid().nullable(),accessStamp:z.string().regex(/^[a-f0-9]{64}$/),companyIds:z.array(z.uuid()).min(1).max(100)}).strict();
export type MasterRenderContext=z.infer<typeof masterRenderContext>;
export const masterRendererRequest=z.object({phase:z.enum(['render','authorize']),occurrenceId:z.uuid(),leaseToken:z.uuid(),expectedAccessStamp:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
