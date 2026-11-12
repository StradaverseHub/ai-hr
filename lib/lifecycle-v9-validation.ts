import { z } from 'zod';
import { v9CaseFieldSchema, validateV9CaseFields } from './lifecycle-v9-case-form';
import { v9LiteralAddress } from './lifecycle-v9-recipient';
import { recipientListProblems, replaceableRoles, roleLabel, toRoles } from './lifecycle-v9-recipients';
import { V9Error, workflowProblems, currentVersion, type Config, type TemplateUsage } from './lifecycle-v9-model';
const id = z.string().min(1).max(120), text = z.string().max(20000), day = z.number().int().min(-3660).max(3660);
const emailAsset = z.object({ id: z.uuid(), kind: z.enum(['file','image']), name: z.string().min(1).max(180).regex(/^[^\u0000-\u001f\u007f/\\:]+$/u), mimeType: z.string().max(200), size: z.number().int().positive().max(10485760), contentHash: z.string().regex(/^[0-9a-f]{64}$/), at: z.iso.datetime(), by: z.string().max(200) }).strict();
const moduleSchema = z.enum(['onb', 'off']);
const rules = z.object({ businessGroup: z.array(id).max(200).optional(), company: z.array(id).max(200).optional(), department: z.array(id).max(200).optional(), grade: z.array(id).max(200).optional(), employmentType: z.array(id).max(200).optional(), title: z.array(id).max(200).optional(), caseType: z.array(id).max(200).optional() }).strict();
export const v9RoleSchema = z.union([z.enum(['employeeWork', 'employeePersonal', 'employee', 'supervisor', 'pbp', 'ta', 'peopleOps', 'taskOwners', 'hrSignatory', 'starter']), z.string().regex(/^person:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i), z.string().regex(/^group:[^\u0000-\u001f\u007f]{1,120}$/u), z.string().refine(value => !!v9LiteralAddress(value), 'Enter a valid email address.')]) as z.ZodType<import('./lifecycle-v9-model').Role>;
const role = v9RoleSchema;
const field = z.object({ id, label: z.string().min(1).max(500), type: z.enum(['text', 'textarea', 'select', 'date', 'checkbox', 'phone', 'email', 'number', 'table']), owner: z.enum(['employee', 'hr', 'pmLocked']), pmKey: id.nullable(), required: z.boolean(), sensitive: z.boolean(), options: z.array(z.string().max(500)).max(200), section: id, width: z.enum(['half', 'full']).optional(), columns: z.array(z.string().min(1).max(200)).max(30).optional(), when: z.object({ field: id, value: z.string().max(500) }).strict().nullable() }).strict();
const block = z.object({ id, type: z.enum(['letterhead', 'heading', 'subheading', 'text', 'fields', 'field', 'table', 'signature']), text, section: z.string().max(120), fieldId: id.optional(), columns: text.optional(), rows: text.optional(), role: z.string().max(120).optional(), label: z.string().max(1000).optional() }).strict();
const task = z.object({ id, name: z.string().min(1).max(500), by: z.enum(['group', 'manager', 'employee']), group: id.nullable(), mode: z.enum(['rr', 'manual']), opens: day.nullable(), due: day, required: z.boolean(), documentTemplate: id.nullable(), documentAction: z.enum(['completed', 'signed', 'sent']) }).strict();
const period = z.object({ value: z.number().int().min(0).max(120), unit: z.enum(['month', 'week', 'day']) }).strict();
const step = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('doc'), template: z.string().max(120), release: z.boolean() }).strict(),
  z.object({ id, type: z.literal('waitSign'), template: z.string().max(120), by: z.enum(['hr', 'employee']) }).strict(),
  z.object({ id, type: z.literal('waitFile'), slot: z.string().max(120), label: z.string().max(500) }).strict(),
  z.object({ id, type: z.literal('email'), template: z.string().max(120), to: z.union([role, z.array(role).max(8)]), cc: z.array(role).max(8), recipientReview: z.literal(true).optional() }).strict(),
  z.object({ id, type: z.literal('notify'), subject: z.string().max(1000), body: text, to: z.union([role, z.array(role).max(8)]), cc: z.array(role).max(8), recipientReview: z.literal(true).optional() }).strict(),
]);
export const v9ConfigSchema = z.object({
  caseForms: z.object({ onb: z.array(v9CaseFieldSchema).max(100).optional(), off: z.array(v9CaseFieldSchema).max(100).optional() }).strict().optional(),
  version: z.literal(9), revision: z.number().int().positive(), groupsRevision: z.number().int().nonnegative().optional(),
  checklists: z.array(z.object({ id, name: z.string().min(1).max(200), module: moduleSchema, ownerUserId: z.string().uuid().optional(), createdAt: z.string().datetime().optional(), rules, tasks: z.array(task).max(300) }).strict()).max(200),
  templates: z.array(z.object({ id, name: z.string().min(1).max(200), module: moduleSchema, type: z.enum(['Form', 'Letter', 'Acknowledgement', 'Attachment']), rules, hrStep: z.enum(['none', 'before', 'after']), employeeAck: z.boolean(), retired: z.boolean(), currentVersion: z.number().int().positive().optional(), note: text.optional(), versions: z.array(z.object({ version: z.number().int().positive(), state: z.enum(['draft', 'published']), at: z.string().max(100), by: z.string().max(200), blocks: z.array(block).max(500), fields: z.array(field).max(500) }).strict()).max(100) }).strict()).max(200),
  emails: z.array(z.object({ id, name: z.string().min(1).max(200), module: moduleSchema, active: z.boolean(), sender: id, subject: z.string().max(1000), body: text, files: z.array(emailAsset).max(20).optional(), images: z.array(emailAsset).max(3).optional(), cc: z.array(role).max(8), recipientReview: z.literal(true).optional(), links: z.array(id).max(100), attachments: z.array(id).max(100), slots: z.array(z.object({ id, label: z.string().max(500), required: z.boolean() }).strict()).max(50) }).strict()).max(200),
  workflows: z.array(z.object({ id, name: z.string().min(1).max(200), module: moduleSchema, status: z.enum(['draft', 'published', 'retired']), retired: z.object({ at: z.iso.datetime(), by: z.object({ id: z.string().max(120), name: z.string().max(200) }).strict(), cases: z.number().int().nonnegative(), automatic: z.boolean() }).strict().optional(), trigger: z.object({ event: z.enum(['submitted', 'hrSigned', 'docSigned', 'taskDone', 'fileUploaded', 'manual', 'beforeJoin', 'afterJoin', 'beforeLWD', 'afterLWD']), days: z.number().int().min(0).max(3660), workdays: z.boolean(), repeat: z.boolean(), skipIf: z.string().max(500).refine(s => ['', 'noPre', 'allDocsDone'].includes(s) || s.startsWith('task:')) }).strict(), conditions: z.array(z.object({ field: z.enum(['businessGroup', 'company', 'department', 'grade', 'employmentType', 'title', 'caseType', 'joinWithin']), op: z.enum(['is', 'isNot', 'lt', 'gte']), value: z.string().max(500) }).strict()).max(30), steps: z.array(step).max(100), description: text }).strict()).max(200),
  groups: z.array(z.object({ id, name: z.string().min(1).max(200), members: z.array(z.string().uuid()).max(500), limit: z.number().int().min(0).max(1000) }).strict()).max(100),
  peopleOpsGroup: id.nullable(), bpRules: z.array(z.object({ rules: z.object({ businessGroup: z.array(id).optional(), company: z.array(id).optional(), department: z.array(id).optional() }).strict(), userId: z.string().uuid() }).strict()).max(500),
  settlementPolicy: z.object({ bands: z.array(z.object({ id, name: z.string().min(1).max(200), grades: z.array(id).max(200), permanent: period, contract: period, probation: period }).strict()).max(100), defaultNotice: period, noticeDays: z.enum(['calendar', 'working']), allowLeaveOffset: z.boolean(), includeAllowances: z.boolean(), encashmentCap: z.number().min(0).max(10000).nullable(), rateBasis: z.number().positive().max(366), payDay: z.number().int().min(1).max(31), leaveTypeIds: z.array(z.string().uuid()).max(100) }).strict().optional(),
  signatoryTitles: z.record(z.string().uuid(),z.string().max(500)).refine(value=>Object.keys(value).length<=500).optional(),
  companies: z.array(z.object({ companyId: z.string().uuid(), signatoryUserId: z.string().uuid().nullable(), signatoryTitle: z.string().max(500), allowedSignatoryUserIds:z.array(z.string().uuid()).max(100).refine(ids=>new Set(ids).size===ids.length).optional(), letterhead: z.object({ registrationNo: z.string().max(200).optional(), address: z.string().max(2000).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).strict().optional() }).strict()).max(500).optional(),
}).strict();
export function parseV9Config(value: unknown, previous?: Config) {
  const config = v9ConfigSchema.parse(value);
  // Every template sends as the tenant's single On/Off Boarding sender. Earlier per-name values are rewritten on this save;
  // nothing else in the template changes, so an active template stays active. Stored revisions are history and stay as they were.
  for (const email of config.emails) email.sender = 'noreply';
  for (const module of ['onb','off'] as const) if (config.caseForms?.[module]) { try { validateV9CaseFields(module, config.caseForms[module]!); } catch (error) { throw new V9Error(error instanceof Error ? error.message : 'Review the case form fields.'); } }
  const unique = (values: string[], what: string) => { if (new Set(values).size !== values.length) throw new V9Error(`Duplicate ${what} identifiers.`); };
  unique(config.groups.map(g => g.id), 'group'); unique(config.checklists.map(g => g.id), 'checklist'); unique(config.templates.map(g => g.id), 'template'); unique(config.emails.map(g => g.id), 'email'); unique(config.workflows.map(g => g.id), 'workflow');
  const templates = new Set(config.templates.map(t => t.id)), emails = new Set(config.emails.map(e => e.id)), groups = new Set(config.groups.map(g => g.id));
  const recipientRoles = [...config.emails.flatMap(email => email.cc), ...config.workflows.flatMap(workflow => workflow.steps.flatMap(step => 'to' in step ? [...(Array.isArray(step.to) ? step.to : [step.to]), ...step.cc] : []))];
  if (recipientRoles.some(role => role.startsWith('group:') && !groups.has(role.slice(6)))) throw new V9Error('Choose an existing assignment group for the recipient.');
  if (config.peopleOpsGroup && !groups.has(config.peopleOpsGroup)) throw Error('Select an existing People Ops group.');
  for (const definition of [...config.checklists, ...config.templates]) if (definition.rules.employmentType?.some(value => !['permanent','contract','probation'].includes(value.toLowerCase()))) throw new V9Error('Choose Permanent, Contract or Probation for V9 employment matching.');
  for (const workflow of config.workflows) if (workflow.conditions.some(condition => condition.field === 'employmentType' && condition.value.trim() && !['permanent','contract','probation'].includes(condition.value.toLowerCase()))) throw new V9Error('Choose Permanent, Contract or Probation for V9 employment matching.');
  for (const cl of config.checklists) { if (cl.module === 'onb' && cl.rules.caseType?.length) throw new V9Error('Case type matching is only available for offboarding.'); unique(cl.tasks.map(t => t.id), 'task'); for (const t of cl.tasks) { if (cl.module === 'onb' && (t.due === 0 || t.opens === 0)) throw Error('Onboarding Day 1 is the join date.'); if (t.group && !groups.has(t.group)) throw Error('An assignment group no longer exists.'); if (t.documentTemplate && !templates.has(t.documentTemplate)) throw Error('A linked document template no longer exists.'); } }
  for (const wf of config.workflows) { unique(wf.steps.map(s => s.id), 'workflow step'); for (const s of wf.steps) if ('template' in s && s.template && !(s.type === 'email' ? emails : templates).has(s.template)) throw Error('A workflow references an unavailable template.'); }
  for (const email of config.emails) { unique([...(email.files ?? []), ...(email.images ?? [])].map(asset => asset.id), 'email asset'); if (email.files?.some(asset => asset.kind !== 'file') || email.images?.some(asset => asset.kind !== 'image' || asset.size > 1048576 || !['image/png','image/jpeg','image/gif','image/webp'].includes(asset.mimeType))) throw new V9Error('Use a supported email file or an image of at most 1 MB.'); }
  for (const email of config.emails) for (const id of [...email.links, ...email.attachments]) if (!templates.has(id)) throw Error('An email references an unavailable document template.');
  for (const template of config.templates) {
    unique(template.versions.map(v => String(v.version)), 'template version');
    if (template.currentVersion !== undefined && !template.versions.some(version => version.version === template.currentVersion && version.state === 'published')) throw new V9Error('The version in use must be published.');
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
  for (const cl of config.checklists) for (const t of cl.tasks) if (t.documentTemplate) {
    sameModule(cl.module, t.documentTemplate, 'document');
    if (t.documentAction !== 'sent' && config.templates.find(d => d.id === t.documentTemplate)?.type === 'Attachment') throw new V9Error('Attachments can complete a task when sent, but cannot be signed.');
  }
  for (const wf of config.workflows) {
    if (wf.status === 'published') {
      // Turning an email off preserves an unchanged live workflow; its next email step holds.
      // A new or edited live workflow still has to select active email definitions.
      const before = previous?.workflows.find(workflow => workflow.id === wf.id);
      const problems = workflowProblems(wf as Config['workflows'][number], config as Config, { allowInactiveEmail: before?.status === 'published' && v9Equal(before, wf) });
      if (problems.length) throw new V9Error(problems.join(' '));
    }
    if (wf.module === 'onb' && ['beforeLWD','afterLWD'].includes(wf.trigger.event) || wf.module === 'off' && ['beforeJoin', 'afterJoin'].includes(wf.trigger.event)) throw new V9Error('Choose a trigger for this module.');
    for (const s of wf.steps) if ('template' in s && s.template) sameModule(wf.module, s.template, s.type === 'email' ? 'email' : 'document');
  }
  for (const email of config.emails) {
    if (email.active && !email.subject.trim()) throw new V9Error('Add a subject before activating this email.');
    unique(email.slots.map(slot => slot.id), 'email file slot');
    for (const slot of email.slots) if (!slot.label.trim()) throw new V9Error('Give each per-person file a label.');
    for (const templateId of [...email.links, ...email.attachments]) sameModule(email.module, templateId, 'document');
    for (const templateId of email.attachments) if (!['Letter', 'Attachment'].includes(config.templates.find(template => template.id === templateId)!.type)) throw new V9Error('Forms and acknowledgements are sent as links.');
    for (const templateId of email.links) if (config.templates.find(template => template.id === templateId)!.type === 'Attachment') throw new V9Error('Attachments are sent as PDFs.');
  }
  unique((config.companies ?? []).map(c => c.companyId), 'company signatory');
  validateV9Recipients(config as Config, previous);
  return config as Config;
}
/** Board 4a60b3ec: removed roles are flagged, never added, and a definition that still uses one cannot change or go live until it is replaced. */
function validateV9Recipients(config: Config, previous?: Config): void {
  const names = { group: (id: string) => config.groups.find(group => group.id === id)?.name };
  for (const wf of config.workflows) {
    const before = previous?.workflows.find(workflow => workflow.id === wf.id);
    for (const step of wf.steps) {
      if (step.type !== 'email' && step.type !== 'notify') continue;
      const old = before?.steps.find(candidate => candidate.id === step.id && 'to' in candidate) as typeof step | undefined;
      const kept = previous ? old ? [...toRoles(old.to), ...old.cc] : [] : [...toRoles(step.to), ...step.cc];
      const problems = [...recipientListProblems(toRoles(step.to), wf.module, kept, 'To recipients'), ...recipientListProblems(step.cc, wf.module, kept, 'CC recipients')];
      if (problems.length) throw new V9Error(`${wf.name}: ${[...new Set(problems)].join(' ')}`);
    }
    const removed = replaceableRoles(wf.steps.flatMap(step => 'to' in step ? [...toRoles(step.to), ...step.cc] : []));
    if (previous && removed.length && !v9Equal(before, wf)) throw new V9Error(`Replace recipient in ${wf.name}: ${removed.map(role => roleLabel(role, names)).join(', ')} can no longer be used. Replace it before changing this workflow or turning it on.`);
  }
  for (const email of config.emails) {
    const before = previous?.emails.find(candidate => candidate.id === email.id);
    const problems = recipientListProblems(email.cc, email.module, previous ? before?.cc ?? [] : email.cc, 'Default CC recipients');
    if (problems.length) throw new V9Error(`${email.name}: ${problems.join(' ')}`);
    const removed = replaceableRoles(email.cc);
    if (previous && removed.length && before && !v9Equal({ ...before, sender: email.sender }, email)) throw new V9Error(`Replace recipient in ${email.name}: ${removed.map(role => roleLabel(role, names)).join(', ')} can no longer be used in Default CC. Replace it before changing this template.`);
  }
}

/** Published bodies are historical evidence; edits start a new numbered draft. */
export function validateV9ConfigChange(previous: Config, next: Config, usage?: TemplateUsage[]): void {
  // Retiring and restoring are separate audited actions; a general settings save cannot do either or edit a retired workflow.
  for (const workflow of next.workflows) {
    const before = previous.workflows.find(candidate => candidate.id === workflow.id);
    if ((workflow.status === 'retired' || workflow.retired || before?.status === 'retired') && !v9Equal(before, workflow)) throw new V9Error(before?.status === 'retired' ? 'This workflow is retired. Restore it before changing it.' : 'Use Delete to retire a workflow.', 'conflict');
  }
  if (previous.workflows.some(workflow => workflow.status === 'retired' && !next.workflows.some(candidate => candidate.id === workflow.id))) throw new V9Error('A retired workflow is kept for case history.', 'conflict');
  for (const template of previous.templates) {
    const retainedTemplate = next.templates.find(next => next.id === template.id);
    if (!retainedTemplate) {
      if (!usage || usage.some(row => row.templateId === template.id && row.documents > 0)) throw new V9Error('A used template is kept for document history. Retire it instead.');
      continue;
    }
    if (!retainedTemplate.versions.length) throw new V9Error('The only version cannot be deleted.');
    for (const version of template.versions) {
      const retained = retainedTemplate.versions.find(next => next.version === version.version);
      if (!retained) {
        if (template.versions.length < 2 || currentVersion(template)?.version === version.version) throw new V9Error('The only version or the version in use cannot be deleted.');
        if ((!usage && version.state === 'published') || usage?.some(row => row.templateId === template.id && row.version === version.version && row.documents > 0)) throw new V9Error('A used version is kept for document history.');
      } else if (version.state === 'published' && !v9Equal(retained, version)) throw new V9Error('Published template versions are immutable. Create a new draft version to make changes.');
    }
  }
}
/** JSONB reorders object keys; array order remains part of the definition. */
export function v9Equal(left: unknown, right: unknown): boolean {
  const serialize = (value: unknown) => JSON.stringify(value, (_, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return serialize(left) === serialize(right);
}
