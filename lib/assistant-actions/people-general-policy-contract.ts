/** Implicit authenticated tenant policy. No company, person, employee or target selector. */
import {z} from 'zod';
export const PEOPLE_GENERAL_POLICY_ACTION='org.people_general.change' as const;
export const PeopleGeneralPolicyValues=z.object({allowDuplicatedNric:z.boolean(),allowDuplicatedEmail:z.boolean()}).strict();
const Values=PeopleGeneralPolicyValues,uuid=z.guid(),different=(a:z.infer<typeof Values>,b:z.infer<typeof Values>)=>a.allowDuplicatedNric!==b.allowDuplicatedNric||a.allowDuplicatedEmail!==b.allowDuplicatedEmail;
export const PeopleGeneralPolicyHuman=z.object({action:z.literal(PEOPLE_GENERAL_POLICY_ACTION),contractVersion:z.literal(1),expected:Values,desired:Values}).strict().refine(v=>different(v.expected,v.desired),{message:'Assistant requires a policy change; unchanged saves remain in native settings.'});
export const PeopleGeneralPolicyReview=z.object({tenantId:uuid,tenantName:z.string().min(1).max(4000),before:Values,after:Values,scope:z.literal('entire_current_organisation')}).strict().refine(v=>different(v.before,v.after));
export const PeopleGeneralPolicyNativeConfirmation=z.object({action:z.literal(PEOPLE_GENERAL_POLICY_ACTION),contractVersion:z.literal(1),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const PeopleGeneralPolicyReceipt=z.object({kind:z.literal('recorded'),tenantId:uuid,policy:Values,eventId:uuid,semantics:z.literal('native_people_general_policy_current_record')}).strict();
const base={action:z.literal(PEOPLE_GENERAL_POLICY_ACTION),contractVersion:z.literal(1)};
export const PeopleGeneralPolicyEnvelopeConfirmation=z.object({...base,actionId:uuid,reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const PeopleGeneralPolicyRetirement=z.object({...base,actionId:uuid}).strict();
export const PeopleGeneralPolicyPrepared=z.object({...base,actionId:uuid,reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:PeopleGeneralPolicyHuman,review:PeopleGeneralPolicyReview,consequence:z.literal('organisation_policy_future_admission_existing_records_unchanged')}).strict().refine(v=>JSON.stringify(v.content.expected)===JSON.stringify(v.review.before)&&JSON.stringify(v.content.desired)===JSON.stringify(v.review.after)&&Date.parse(v.expiresAt)>Date.parse(v.createdAt));
export const PeopleGeneralPolicyCompleted=z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:PeopleGeneralPolicyReceipt}).strict();
export const PeopleGeneralPolicyRetired=z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict();
export const PeopleGeneralPolicyIndex=z.object({kind:z.literal('people_general_policy_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(r=>r.actionId)).size===rows.length)}).strict();
