/** Company template lifecycle; never an employee-code correction or counter-issuance command. */
import {z} from 'zod';
export const EMPLOYEE_ID_TEMPLATE_STATUS_ACTION='org.employee_id_template.status' as const;
const uuid=z.guid(),Status=z.enum(['active','inactive']);
const State=z.object({configId:uuid,companyId:uuid,companyName:z.string().min(1).max(4000),templateName:z.string().max(4000).nullable(),prefix:z.string().max(4000),suffix:z.string().max(4000),status:Status}).strict();
export const EmployeeIdTemplateStatusHuman=z.object({action:z.literal(EMPLOYEE_ID_TEMPLATE_STATUS_ACTION),contractVersion:z.literal(1),configId:uuid,expectedStatus:Status,status:Status}).strict().refine(v=>v.expectedStatus!==v.status);
export const EmployeeIdTemplateStatusReview=State.extend({afterStatus:Status}).strict().refine(v=>v.status!==v.afterStatus);
export const EmployeeIdTemplateStatusConfirmation=z.object({action:z.literal(EMPLOYEE_ID_TEMPLATE_STATUS_ACTION),contractVersion:z.literal(1),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const EmployeeIdTemplateStatusReceipt=State.omit({companyName:true}).extend({kind:z.literal('recorded'),eventId:uuid,semantics:z.literal('native_employee_id_template_status_current_record')}).strict();

const base={action:z.literal(EMPLOYEE_ID_TEMPLATE_STATUS_ACTION),contractVersion:z.literal(1)};
export const EmployeeIdTemplateStatusEnvelopeConfirmation=z.object({...base,actionId:uuid,reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const EmployeeIdTemplateStatusRetirement=z.object({...base,actionId:uuid}).strict();
export const EmployeeIdTemplateStatusPrepared=z.object({...base,actionId:uuid,reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:EmployeeIdTemplateStatusHuman,review:EmployeeIdTemplateStatusReview,consequence:z.literal('template_status_only_future_hire_rule_no_counter_or_existing_code_change')}).strict().refine(v=>v.content.configId===v.review.configId&&v.content.expectedStatus===v.review.status&&v.content.status===v.review.afterStatus&&Date.parse(v.expiresAt)>Date.parse(v.createdAt));
export const EmployeeIdTemplateStatusCompleted=z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:EmployeeIdTemplateStatusReceipt}).strict();
export const EmployeeIdTemplateStatusRetired=z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict();
export const EmployeeIdTemplateStatusIndex=z.object({kind:z.literal('employee_id_template_status_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(r=>r.actionId)).size===rows.length)}).strict();
export const EmployeeIdTemplateStatusSelection=z.object({query:z.string().trim().max(80),configId:uuid.optional()}).strict();
export const EmployeeIdTemplateStatusChoices=z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),templates:z.array(State).max(25).refine(rows=>new Set(rows.map(r=>r.configId)).size===rows.length),truncated:z.boolean()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]);
