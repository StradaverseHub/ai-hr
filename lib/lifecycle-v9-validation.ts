import { z } from 'zod';
import { V9Error, type Config } from './lifecycle-v9-model';
const id = z.string().min(1).max(120), text = z.string().max(20000), day = z.number().int().min(-3660).max(3660);
const moduleSchema = z.enum(['onb', 'off']);
const rules = z.object({ businessGroup: z.array(id).max(200).optional(), company: z.array(id).max(200).optional(), department: z.array(id).max(200).optional(), grade: z.array(id).max(200).optional(), employmentType: z.array(id).max(200).optional(), title: z.array(id).max(200).optional(), caseType: z.array(id).max(200).optional() }).strict();
const role = z.enum(['employee', 'supervisor', 'pbp', 'ta', 'peopleOps', 'taskOwners']);
const field = z.object({ id, label: z.string().min(1).max(500), type: z.enum(['text', 'textarea', 'select', 'date', 'checkbox', 'phone', 'email', 'number', 'table']), owner: z.enum(['employee', 'hr', 'pmLocked']), pmKey: id.nullable(), required: z.boolean(), sensitive: z.boolean(), options: z.array(z.string().max(500)).max(200), section: id, width: z.enum(['half', 'full']).optional(), columns: z.array(z.string().min(1).max(200)).max(30).optional(), when: z.object({ field: id, value: z.string().max(500) }).strict().nullable() }).strict();
const block = z.object({ id, type: z.enum(['letterhead', 'heading', 'subheading', 'text', 'fields', 'field', 'table', 'signature']), text, section: z.string().max(120), fieldId: id.optional(), columns: text.optional(), rows: text.optional(), role: z.string().max(120).optional(), label: z.string().max(1000).optional() }).strict();
const task = z.object({ id, name: z.string().min(1).max(500), by: z.enum(['group', 'manager', 'employee']), group: id.nullable(), mode: z.enum(['rr', 'manual']), opens: day.nullable(), due: day, required: z.boolean(), documentTemplate: id.nullable(), documentAction: z.enum(['completed', 'signed', 'sent']) }).strict();
const period = z.object({ value: z.number().int().min(0).max(120), unit: z.enum(['month', 'week', 'day']) }).strict();
const step = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('doc'), template: id, release: z.boolean() }).strict(),
  z.object({ id, type: z.literal('waitSign'), template: id, by: z.enum(['hr', 'employee']) }).strict(),
  z.object({ id, type: z.literal('waitFile'), slot: id, label: z.string().max(500) }).strict(),
  z.object({ id, type: z.literal('email'), template: id, to: z.union([role, z.array(role).min(1).max(6)]), cc: z.array(role).max(6) }).strict(),
  z.object({ id, type: z.literal('notify'), subject: z.string().min(1).max(1000), body: text, to: z.union([role, z.array(role).min(1).max(6)]), cc: z.array(role).max(6) }).strict(),
]);
export const v9ConfigSchema = z.object({
  version: z.literal(9), revision: z.number().int().positive(), groupsRevision: z.number().int().nonnegative().optional(),
  checklists: z.array(z.object({ id, name: z.string().min(1).max(200), module: moduleSchema, rules, tasks: z.array(task).max(300) }).strict()).max(200),
  templates: z.array(z.object({ id, name: z.string().min(1).max(200), module: moduleSchema, type: z.enum(['Form', 'Letter', 'Acknowledgement', 'Attachment']), rules, hrStep: z.enum(['none', 'before', 'after']), employeeAck: z.boolean(), retired: z.boolean(), versions: z.array(z.object({ version: z.number().int().positive(), state: z.enum(['draft', 'published']), at: z.string().max(100), by: z.string().max(200), blocks: z.array(block).max(500), fields: z.array(field).max(500) }).strict()).max(100) }).strict()).max(200),
  emails: z.array(z.object({ id, name: z.string().min(1).max(200), module: moduleSchema, active: z.boolean(), sender: id, subject: z.string().min(1).max(1000), body: text, cc: z.array(role).max(6), links: z.array(id).max(100), attachments: z.array(id).max(100), slots: z.array(z.object({ id, label: z.string().max(500), required: z.boolean() }).strict()).max(50) }).strict()).max(200),
  workflows: z.array(z.object({ id, name: z.string().min(1).max(200), module: moduleSchema, status: z.enum(['draft', 'published']), trigger: z.object({ event: z.enum(['submitted', 'beforeJoin', 'afterJoin', 'beforeLWD']), days: z.number().int().min(0).max(3660), workdays: z.boolean(), repeat: z.boolean(), skipIf: z.string().max(500).refine(s => ['', 'noPre', 'allDocsDone'].includes(s) || s.startsWith('task:')) }).strict(), conditions: z.array(z.object({ field: z.enum(['businessGroup', 'company', 'department', 'grade', 'employmentType', 'title', 'caseType', 'joinWithin']), op: z.enum(['is', 'isNot', 'lt', 'gte']), value: z.string().max(500) }).strict()).max(30), steps: z.array(step).max(100), description: text }).strict()).max(200),
  groups: z.array(z.object({ id, name: z.string().min(1).max(200), members: z.array(z.string().uuid()).max(1000), limit: z.number().int().min(0).max(10000) }).strict()).max(200),
  peopleOpsGroup: id.nullable(), bpRules: z.array(z.object({ rules: z.object({ businessGroup: z.array(id).optional(), company: z.array(id).optional(), department: z.array(id).optional() }).strict(), userId: z.string().uuid() }).strict()).max(500),
  settlementPolicy: z.object({ bands: z.array(z.object({ id, name: z.string().min(1).max(200), grades: z.array(id).max(200), permanent: period, contract: period, probation: period }).strict()).max(100), defaultNotice: period, noticeDays: z.enum(['calendar', 'working']), allowLeaveOffset: z.boolean(), includeAllowances: z.boolean(), encashmentCap: z.number().min(0).max(10000).nullable(), rateBasis: z.number().positive().max(366), payDay: z.number().int().min(1).max(31), leaveTypeIds: z.array(z.string().uuid()).max(100) }).strict().optional(),
  companies: z.array(z.object({ companyId: z.string().uuid(), signatoryUserId: z.string().uuid().nullable(), signatoryTitle: z.string().max(500) }).strict()).max(500).optional(),
}).strict();
export function parseV9Config(value: unknown) {
  const config = v9ConfigSchema.parse(value);
  const unique = (values: string[], what: string) => { if (new Set(values).size !== values.length) throw new V9Error(`Duplicate ${what} identifiers.`); };
  unique(config.groups.map(g => g.id), 'group'); unique(config.checklists.map(g => g.id), 'checklist'); unique(config.templates.map(g => g.id), 'template'); unique(config.emails.map(g => g.id), 'email'); unique(config.workflows.map(g => g.id), 'workflow');
  const templates = new Set(config.templates.map(t => t.id)), emails = new Set(config.emails.map(e => e.id)), groups = new Set(config.groups.map(g => g.id));
  if (config.peopleOpsGroup && !groups.has(config.peopleOpsGroup)) throw Error('Select an existing People Ops group.');
  for (const cl of config.checklists) { unique(cl.tasks.map(t => t.id), 'task'); for (const t of cl.tasks) { if (cl.module === 'onb' && (t.due === 0 || t.opens === 0)) throw Error('Onboarding Day 1 is the join date.'); if (t.group && !groups.has(t.group)) throw Error('An assignment group no longer exists.'); if (t.documentTemplate && !templates.has(t.documentTemplate)) throw Error('A linked document template no longer exists.'); } }
  for (const wf of config.workflows) { unique(wf.steps.map(s => s.id), 'workflow step'); for (const s of wf.steps) if ('template' in s && !(s.type === 'email' ? emails : templates).has(s.template)) throw Error('A workflow references an unavailable template.'); }
  for (const email of config.emails) for (const id of [...email.links, ...email.attachments]) if (!templates.has(id)) throw Error('An email references an unavailable document template.');
  for (const template of config.templates) {
    unique(template.versions.map(v => String(v.version)), 'template version');
    if (template.versions.filter(v => v.state === 'draft').length > 1) throw new V9Error('A template can have only one draft version.');
    for (const version of template.versions) {
      unique(version.fields.map(f => f.id), 'form field'); unique(version.blocks.map(b => b.id), 'document block');
      const fields = new Set(version.fields.map(f => f.id));
      for (const block of version.blocks) if (block.type === 'field' && (!block.fieldId || !fields.has(block.fieldId))) throw new V9Error('A document block references an unavailable field.');
      for (const field of version.fields) if (field.when && (!fields.has(field.when.field) || field.when.field === field.id)) throw new V9Error('A conditional field must reference another field in its version.');
    }
  }
  const sameModule = (module: 'onb' | 'off', id: string, kind: 'email' | 'document') => {
    if (!(kind === 'email' ? config.emails : config.templates).some(t => t.id === id && t.module === module)) throw new V9Error('Linked templates must belong to the same module.');
  };
  for (const cl of config.checklists) for (const t of cl.tasks) if (t.documentTemplate) sameModule(cl.module, t.documentTemplate, 'document');
  for (const wf of config.workflows) {
    if (wf.module === 'onb' && wf.trigger.event === 'beforeLWD' || wf.module === 'off' && ['beforeJoin', 'afterJoin'].includes(wf.trigger.event)) throw new V9Error('Choose a trigger for this module.');
    for (const s of wf.steps) if ('template' in s) sameModule(wf.module, s.template, s.type === 'email' ? 'email' : 'document');
  }
  for (const email of config.emails) for (const templateId of [...email.links, ...email.attachments]) sameModule(email.module, templateId, 'document');
  unique((config.companies ?? []).map(c => c.companyId), 'company signatory');
  return config as Config;
}

/** Published bodies are historical evidence; edits start a new numbered draft. */
export function validateV9ConfigChange(previous: Config, next: Config): void {
  for (const template of previous.templates) for (const published of template.versions.filter(v => v.state === 'published')) {
    const retained = next.templates.find(t => t.id === template.id)?.versions.find(v => v.version === published.version);
    if (!retained || !v9Equal(retained, published)) throw new V9Error('Published template versions are immutable. Create a new draft version to make changes.');
  }
}
/** JSONB reorders object keys; array order remains part of the definition. */
export function v9Equal(left: unknown, right: unknown): boolean {
  const serialize = (value: unknown) => JSON.stringify(value, (_, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return serialize(left) === serialize(right);
}
