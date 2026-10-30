/** Human-only employment identifier correction. Null is an explicit stored baseline. */
import {z} from 'zod';
import {normalizeEmployeeCode} from '../employee-code';
export const EMPLOYEE_CODE_MAINTENANCE_ACTION='employees.code.maintain' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),code=z.string().max(4000).nullable(),base={action:z.literal(EMPLOYEE_CODE_MAINTENANCE_ACTION),contractVersion:z.literal(1)};
const Human=z.object({...base,employmentId:uuid,subjectId:uuid,expectedCode:code,employeeCode:z.string().min(1).max(100)}).strict().refine(v=>v.subjectId===v.employmentId);
const Subject=z.object({employmentId:uuid,employeeName:z.string().min(1).max(4000),employeeCode:code,companyName:z.string().min(1).max(4000)}).strict();
const Item=Subject.extend({subjectId:uuid,before:code,after:z.string().regex(/^[A-Z0-9-]{1,30}$/)}).strict().refine(v=>v.subjectId===v.employmentId&&v.before===v.employeeCode&&v.before!==v.after);
const Receipt=z.object({kind:z.literal('maintained'),subjectId:uuid,employmentId:uuid,eventId:uuid,before:code,after:z.string().regex(/^[A-Z0-9-]{1,30}$/)}).strict().refine(v=>v.subjectId===v.employmentId);
const consequence='employment_identifier_changed_not_person_pay_or_access' as const;
export const EmployeeCodeMaintenance={action:EMPLOYEE_CODE_MAINTENANCE_ACTION,Human,Item,Receipt,consequence,indexKind:'employee_code_maintenance_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>v.content.employmentId===v.review.employmentId&&v.content.expectedCode===v.review.before&&normalizeEmployeeCode(v.content.employeeCode)===v.review.after),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('employee_code_maintenance_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type EmployeeCodeMaintenanceHuman=z.infer<typeof Human>;
