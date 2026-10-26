/** Source-only ESS approval-request contracts. A model nomination contains no new employee values;
 * only an independently supplied human v2 proposal may become review content. A digest is not a click. */
import {z} from 'zod';
import {parseEssProfileProposal} from '../personnel-ess-contract';
import {personnelField} from '../personnel-field-registry';
const UUID=z.string().uuid(),Digest=z.string().regex(/^[a-f0-9]{64}$/);
const HumanProposal=z.unknown().transform((value,ctx)=>{try{return parseEssProfileProposal(value);}catch{ctx.addIssue({code:z.ZodIssueCode.custom,message:'The profile proposal is unavailable.'});return z.NEVER;}});
export const OwnProfileChangeNomination=z.object({action:z.literal('profile.change.request'),contractVersion:z.literal(1),employmentId:UUID,fieldIds:z.array(z.string().min(1).max(200)).min(1).max(128)}).strict().superRefine((value,ctx)=>{if(new Set(value.fieldIds).size!==value.fieldIds.length||value.fieldIds.some(id=>{const field=personnelField(id);return !field||field.ess.visibility!=='visible'||!field.ess.binding||field.ess.edit!=='approval';}))ctx.addIssue({code:z.ZodIssueCode.custom,message:'The profile nomination is unavailable.'});});
export type OwnProfileChangeNomination=z.infer<typeof OwnProfileChangeNomination>;
export const OwnProfileChangeHumanContent=z.object({action:z.literal('profile.change.request'),contractVersion:z.literal(1),employmentId:UUID,proposal:HumanProposal}).strict();
export type OwnProfileChangeHumanContent=z.infer<typeof OwnProfileChangeHumanContent>;
export const OwnProfileChangeConfirmation=z.object({action:z.literal('profile.change.request'),contractVersion:z.literal(1),reviewedDigest:Digest}).strict();
export type OwnProfileChangeConfirmation=z.infer<typeof OwnProfileChangeConfirmation>;
/** Contains only the current permitted projection of the human-authored changes, never a full
 * current Person/statutory row, unmasked current value, authority carrier or model-generated value. */
export const OwnProfileChangePreparedSource=z.object({kind:z.literal('prepared_source'),content:OwnProfileChangeHumanContent,reviewedDigest:Digest,consequence:z.literal('request_hr_review')}).strict();
export type OwnProfileChangePreparedSource=z.infer<typeof OwnProfileChangePreparedSource>;
export const OwnProfileChangeSourceReceipt=z.object({kind:z.literal('submitted'),requestId:UUID,requestedEventId:UUID,employmentId:UUID,currentStatus:z.enum(['pending','approved','rejected']),replayed:z.boolean()}).strict();
export type OwnProfileChangeSourceReceipt=z.infer<typeof OwnProfileChangeSourceReceipt>;
