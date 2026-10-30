import { z } from 'zod';
import { v9CaseFieldSchema } from './lifecycle-v9-case-form';
const id = z.string().min(1).max(100);
const name = z.string().trim().min(1).max(200);
const rules = z.object({ businessGroup: z.array(id).max(300).optional(), company: z.array(id).max(300).optional(), department: z.array(id).max(300).optional(), title: z.array(id).max(300).optional(), grade: z.array(id).max(300).optional(), employmentType: z.array(id).max(30).optional() }).strict();
const step = z.object({ id, label: name, type: z.enum(['group', 'routing', 'person']), target: z.string().max(100), method: z.enum(['manual', 'rr']) }).strict();
export const onboardingTaskSchema = z.object({ id, name, by: z.enum(['group', 'joiner', 'manager']), group: z.string().max(100), method: z.enum(['manual', 'rr']), opens: z.number().int().min(-365).max(365).nullable(), due: z.number().int().min(-365).max(365), gate: z.boolean(), required: z.boolean().optional(), documentTemplate: id.nullable().optional(), documentAction: z.enum(['completed', 'signed', 'sent']).optional() }).strict();
export const onboardingConfigSchema = z.object({
    version: z.literal(1), v9CaseFields: z.array(v9CaseFieldSchema).max(100).optional(), v9ChecklistRevision: z.number().int().positive().optional(), groups: z.array(z.object({ id, name, members: z.array(id).max(500), limit: z.number().int().min(0).max(1000) }).strict()).max(100),
    workflows: z.array(z.object({ id, name, mode: z.enum(['seq', 'par']), steps: z.array(step).min(1).max(30) }).strict()).max(100),
    routings: z.array(z.object({ id, name, rows: z.array(z.object({ id, rules, group: z.string().max(100) }).strict()).max(300) }).strict()).max(100),
    checklists: z.array(z.object({ id, name, owner: id, createdAt: z.string().datetime(), rules, tasks: z.array(onboardingTaskSchema).max(100) }).strict()).max(100),
    catalogue: z.array(z.object({ id, name, type: z.enum(['system', 'device']), active: z.boolean(), rules, workflow: id.nullable(), team: z.string().max(100), card: z.boolean() }).strict()).max(500),
    access: z.object({ onboarding: z.array(id).max(1000), offboarding: z.array(id).max(1000),
      joinerViewGroups:z.array(id).max(100).optional(),recordGroups:z.array(id).max(100).optional(),recordHR:z.boolean().optional(),
      joinerSections:z.record(id,z.object({preset:z.enum(['full','coord','fulfil','approver','custom']),s:z.object({case:z.enum(['hidden','view']).optional(),hr:z.enum(['hidden','view']).optional(),notes:z.enum(['hidden','view']).optional(),checklist:z.enum(['hidden','team','all']).optional(),equip:z.enum(['hidden','view','act']).optional(),history:z.enum(['hidden','equip','full']).optional(),actions:z.enum(['none','allowed']).optional()}).strict().optional()}).strict()).refine(value=>Object.keys(value).length<=100).optional(),
    }).strict(),
    countEquipment: z.boolean(), techGroup: z.string().max(100), exceptions: z.object({ groups: z.array(id).max(100), workflow: id.nullable(), always: z.boolean(), remindDays: z.number().int().min(0).max(365), confirmingGroup: z.string().max(100) }).strict(),
    recentActiveDays: z.number().int().min(1).max(365),
}).strict();
const fact = z.string().max(500);
export const onboardingPatchSchema = z.object({
    caseValues: z.record(id,z.string().max(10000)).refine(value => Object.keys(value).length <= 100).optional(), caseContactEmail: z.union([z.literal(''),z.email().max(254)]).optional(),
    equipmentOverrides: z.record(id, z.object({ group: id.optional(), method: z.enum(['rr','manual']).optional(), due: z.number().int().min(-999).max(9999).optional() }).strict()).refine(value => Object.keys(value).length <= 500).optional(),
    local: z.object({ fullName: fact, employeeId: fact, joinDate: fact, title: fact, department: fact, company: fact, businessGroup: fact, grade: fact, employmentType: fact, supervisor: fact, gbsTa: fact, email: fact, costCentre: fact, ic: fact, passport: fact }).partial().strict().optional(),
    hiring: z.enum(['', 'new_hire', 'replacement']).optional(), replacedEmployee: fact.optional(), deviceType: fact.optional(), floor: fact.optional(), notes: z.string().max(10000).optional(),
    selected: z.array(id).max(500).optional(), extras: z.array(z.object({ catalogueId: id, reason: z.string().max(2000), approval: z.boolean() }).strict()).max(500).optional(), checklistOverride: z.string().max(100).nullable().optional(),
}).strict();
export const onboardingCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('save'), patch: onboardingPatchSchema }).strict(),
    z.object({ type: z.literal('saveSubmit'), patch: onboardingPatchSchema }).strict(), z.object({ type: z.literal('submit') }).strict(), z.object({ type: z.literal('cancel'), reason: z.string().min(1).max(1000), note: z.string().max(10000).optional() }).strict(), z.object({ type: z.literal('reopen') }).strict(),
    z.object({ type: z.literal('releaseClaim'), itemId: id }).strict(),
    z.object({ type: z.literal('retryApproval'), itemId: id }).strict(),
    z.object({ type: z.literal('equipmentAssignee'), itemId: id, user: id.nullable(), roundRobin: z.boolean() }).strict(),
    z.object({ type: z.literal('equipmentBulk'), ids: z.array(id).min(1).max(500), group: id.optional(), method: z.enum(['rr','manual']).optional(), due: z.number().int().min(-999).max(9999).optional() }).strict(),
    z.object({ type: z.literal('itemTeam'), itemId: id, group: z.string().max(100) }).strict(),
    z.object({ type: z.literal('taskGroup'), taskId: id, group: z.string().max(100) }).strict(),
    z.object({ type: z.literal('task'), taskId: id, status: z.enum(['todo', 'progress', 'done']) }).strict(),
    z.object({ type: z.literal('assignTask'), taskId: id, user: id.nullable(), roundRobin: z.boolean() }).strict(),
    z.object({ type: z.literal('approve'), itemIds: z.array(id).min(1).max(500), decision: z.enum(['approve', 'reject']) }).strict(),
    z.object({ type: z.literal('assignApproval'), itemId: id, stepId: id, user: id.nullable() }).strict(),
    z.object({ type: z.literal('fulfil'), itemId: id, status: z.enum(['todo', 'progress', 'done']) }).strict(),
    z.object({ type: z.literal('addItem'), catalogueId: id, reason: z.string().min(1).max(2000), approval: z.boolean(), confirmedBy: id.nullable() }).strict(),
    z.object({ type: z.literal('removeItem'), itemId: id }).strict(), z.object({ type: z.literal('handover') }).strict(), z.object({ type: z.literal('readNote') }).strict(),
    z.object({ type: z.literal('keepProviding'), itemId: id }).strict(),
    z.object({ type: z.literal('acknowledge'), data: z.record(z.string().max(100), z.string().max(2000)) }).strict(),
]);
export const onboardingNoteSchema = z.object({ id: id.optional(), context: id, body: z.string().max(10000), mentions: z.array(id).max(50), deleted: z.boolean().optional(), resolve: z.boolean().optional() }).strict();
