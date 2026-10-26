import {z} from 'zod';
export const OWN_LIFECYCLE_ACKNOWLEDGEMENT_ACTION='lifecycle.acknowledgement.submit' as const;
const action={action:z.literal(OWN_LIFECYCLE_ACKNOWLEDGEMENT_ACTION),contractVersion:z.literal(1)};
/** Model proposals name an existing source only. Equipment/contact facts and acknowledgement are human content. */
export const OwnLifecycleAcknowledgementNomination=z.object({...action,caseId:z.uuid()}).strict();
export const OwnLifecycleAcknowledgementHumanContent=z.object({...action,caseId:z.uuid(),contactNumber:z.string().min(1).max(40),serialNumber:z.string().min(1).max(100),accessories:z.string().max(300).nullable(),pcType:z.string().max(100).nullable(),hasMonitor:z.boolean(),monitorSerial:z.string().max(100).nullable(),receiptEmail:z.string().max(254).nullable(),acknowledged:z.literal(true)}).strict();
export type OwnLifecycleAcknowledgementHumanContent=z.infer<typeof OwnLifecycleAcknowledgementHumanContent>;
export const OwnLifecycleAcknowledgementConfirmation=z.object({...action,reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const OwnLifecycleAcknowledgementPreparedSource=z.object({kind:z.literal('prepared_source'),content:OwnLifecycleAcknowledgementHumanContent,caseNumber:z.string().min(1).max(100),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/),consequence:z.literal('equipment_acknowledgement_only')}).strict();
export const OwnLifecycleAcknowledgementSourceReceipt=z.object({kind:z.literal('acknowledgement_submitted'),caseId:z.uuid(),caseNumber:z.string().min(1).max(100),submittedEventId:z.uuid(),submittedAt:z.string().datetime(),currentStatus:z.enum(['in_progress','completed']),replayed:z.boolean()}).strict();
export type OwnLifecycleAcknowledgementPreparedSource=z.infer<typeof OwnLifecycleAcknowledgementPreparedSource>;
export type OwnLifecycleAcknowledgementSourceReceipt=z.infer<typeof OwnLifecycleAcknowledgementSourceReceipt>;
