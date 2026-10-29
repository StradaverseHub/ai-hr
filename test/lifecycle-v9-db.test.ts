import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, updatePersonProfilePartial } from '../core/org';
import { saveEmployeeDraft, completeEmployeeDraft } from '../core/employee-draft';
import { todayInKualaLumpur } from '../lib/hr-date';
import { addDays } from '../lib/lifecycle-v9-model';
import { currentReq } from '../lib/onboarding-model';
import { v9Setup, v9Sweep, v9CaseDetail, v9Workspace, v9PreviewEmail, v9SaveConfig, v9CreateOffboarding, v9Command, v9OwnWork, v9OwnTask, v9OwnDocument, v9UploadFile, v9DownloadFile, onboardingContext, onboardingSaveConfig, onboardingList, onboardingCommand, onboardingAssignmentLoadsTx } from '../packs/lifecycle/service';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser, type Base } from './harness';

let base: Base, admin: SessionContext, employee: SessionContext, other: SessionContext, employmentId: string;
beforeAll(async () => {
  // Draft rehearsal only. Move to the canonical append after coordinated journal allocation.
  await owner.client.unsafe(readFileSync('db/migration-drafts/lifecycle-v9.sql', 'utf8'));
});
beforeEach(async () => {
  await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'lifecycle', 'active'); admin = await entitledCtx(base);
  const subject = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'V9 subject', primaryEmail: 'subject@test.invalid', phone: '+60123456789' } });
  employmentId = subject.employmentId;
  employee = { ...admin, userId: await createAppUser(base.tenantId, subject.personId, 'employee'), personId: subject.personId, roles: ['employee'], grants: undefined };
  const stranger = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'Unrelated employee', primaryEmail: 'stranger@test.invalid' } });
  other = { ...employee, userId: await createAppUser(base.tenantId, stranger.personId, 'employee'), personId: stranger.personId };
  await v9Setup(admin);
});
afterAll(closeAll);
async function prepared() {
  const workspace = await v9Workspace(admin), config = workspace.config!;
  config.checklists = [...config.checklists.filter(checklist => checklist.module === 'onb'), { id: 'fixture', name: 'Focused exit', module: 'off', rules: {}, tasks: [{ id: 'handover', name: 'Complete handover', by: 'employee', group: null, mode: 'manual', opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'completed' }] }];
  config.templates.push({ id: 'fixture-form', name: 'Reviewed contact form', type: 'Form', module: 'off', rules: {}, hrStep: 'none', employeeAck: false, retired: false, versions: [{ version: 1, state: 'published', at: '', by: '', blocks: [{ id: 'body', type: 'text', text: 'Contact update for {employee.name}', section: '' }], fields: [{ id: 'mobile', label: 'Mobile', type: 'phone', owner: 'employee', pmKey: 'mobile', required: true, sensitive: false, options: [], section: 'main', when: null }, { id: 'confirm', label: 'Confirmation', type: 'checkbox', owner: 'employee', pmKey: null, required: true, sensitive: false, options: [], section: 'main', when: null }] }] });
  config.workflows = [{ id: 'fixture-release', name: 'Release form', module: 'off', status: 'published', trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'document', type: 'doc', template: 'fixture-form', release: true }, { id: 'supporting', type: 'waitFile', slot: 'fixture-support', label: 'Supporting file' }], description: '' }];
  await v9SaveConfig(admin, config.revision, config);
  const id = await v9CreateOffboarding(admin, { employmentId, type: 'Resignation', noticeDate: '2026-10-01', lastDay: '2026-11-01' });
  await v9Command(admin, id, 1, { type: 'submit' });
  return (await v9Workspace(admin)).cases.find(c => c.id === id)!;
}
it('shares group ownership and detects a stale native group revision', async () => {
  const before = await v9Workspace(admin), config = structuredClone(before.config!);
  config.groups.find(g => g.name === 'Group Tech')!.members = [employee.userId!];
  await v9SaveConfig(admin, config.revision, config);
  const native = await onboardingContext(admin);
  expect(native.config.groups.filter(g => g.name === 'Group Tech')).toHaveLength(1);
  expect(native.config.groups.find(g => g.name === 'Group Tech')!.members).toEqual([employee.userId]);
  await expect(v9SaveConfig(admin, before.config!.revision, before.config)).rejects.toThrow('Settings changed');
});
it('uses native checklist and claimed-equipment load for offboarding, without counting existing leaver work', async () => {
  const context = await onboardingContext(admin), native = structuredClone(context.config), group = native.groups[0];
  group.members = [base.adminUserId, other.userId!]; group.limit = 2;
  native.catalogue = [{ id: 'workload-laptop', name: 'Fixture laptop', type: 'device', active: true, rules: {}, workflow: null, team: group.id, card: false }];
  await onboardingSaveConfig(admin, context.revision, native);
  const onboardingDefinitions = (await v9Workspace(admin)).config!;
  onboardingDefinitions.checklists = [...onboardingDefinitions.checklists.filter(checklist => checklist.module === 'off'), { id: 'workload-checklist', name: 'Workload fixture', module: 'onb', rules: {}, tasks: [{ id: 'prepare', name: 'Prepare workspace', by: 'group', group: group.id, mode: 'rr', opens: null, due: 1, required: false, documentTemplate: null, documentAction: 'completed' }] }];
  await v9SaveConfig(admin, onboardingDefinitions.revision, onboardingDefinitions);
  await saveEmployeeDraft(admin, { data: { profile: { fullName: 'Fictional workload joiner', primaryEmail: 'workload@test.invalid' }, employment: { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, hiredOn: todayInKualaLumpur() } }, currentStep: 1 });
  let [joiner] = await onboardingList(admin);
  await onboardingCommand(admin, joiner.case.id, joiner.revision, { type: 'save', patch: { hiring: 'new_hire', local: { supervisor: employmentId }, selected: ['workload-laptop'] } });
  [joiner] = await onboardingList(admin);
  await onboardingCommand(admin, joiner.case.id, joiner.revision, { type: 'submit' });
  [joiner] = await onboardingList(admin);
  expect(joiner.case.tasks[0].assignee).toBe(base.adminUserId);
  const item = currentReq(joiner.case)!.items[0];
  await onboardingCommand(admin, joiner.case.id, joiner.revision, { type: 'fulfil', itemId: item.id, status: 'progress' });
  const load = await withTenant(admin, onboardingAssignmentLoadsTx);
  expect(Number(load.find(l => l.user_id === base.adminUserId)?.task_load)).toBe(2);
  expect(await withTenant(employee, onboardingAssignmentLoadsTx)).toEqual([]);
  const config = (await v9Workspace(admin)).config!;
  config.checklists = [...config.checklists.filter(checklist => checklist.module === 'onb'), { id: 'workload-exit', name: 'Workload exit', module: 'off', rules: {}, tasks: [{ id: 'return-work', name: 'Prepare return', by: 'group', group: group.id, mode: 'rr', opens: null, due: 0, required: false, documentTemplate: null, documentAction: 'completed' }] }];
  config.workflows = [];
  await v9SaveConfig(admin, config.revision, config);
  const id = await v9CreateOffboarding(admin, { employmentId, type: 'Resignation', noticeDate: todayInKualaLumpur(), lastDay: addDays(todayInKualaLumpur(), 30) });
  await v9Command(admin, id, 1, { type: 'submit' });
  const leaver = (await v9Workspace(admin)).cases.find(c => c.id === id)!;
  expect(leaver.tasks[0].assignee).toBe(other.userId);
  const after = await withTenant(admin, onboardingAssignmentLoadsTx);
  expect(Number(after.find(l => l.user_id === other.userId)?.task_load)).toBe(0);
});
async function signedProposal() {
  const c = await prepared(), doc = c.documents[0];
  expect(doc.status).toBe('sent'); expect(doc.values.mobile).toBe('+60123456789');
  const input = { caseId: c.id, revision: c.revision, documentId: doc.id, values: { mobile: '+60111112222', confirm: 'false' }, signature: { method: 'typed' as const, value: 'V9 subject', consent: true as const } };
  await expect(v9OwnDocument(employee, input)).rejects.toThrow();
  await v9OwnDocument(employee, { ...input, values: { ...input.values, confirm: 'true' } });
  return (await v9Workspace(admin)).cases.find(x => x.id === c.id)!;
}
it('applies a signed form proposal through Personnel only after explicit HR review', async () => {
  const c = await signedProposal(), proposal = c.pmChanges[0];
  expect(proposal).toMatchObject({ field: 'mobile', before: '+60123456789', after: '+60111112222', status: 'proposed' });
  await v9Command(admin, c.id, c.revision, { type: 'pmPush', id: proposal.id });
  const [person] = await owner.client`select phone from person where id=${employee.personId!}::uuid`;
  expect(person.phone).toBe('+60111112222');
  const next = (await v9Workspace(admin)).cases.find(x => x.id === c.id)!;
  expect(next.pmChanges[0].status).toBe('pushed');
  await expect(v9Command(admin, next.id, next.revision, { type: 'pmPush', id: proposal.id })).rejects.toThrow('already applied');
});
it('preserves an intervening Personnel correction instead of overwriting it with an old form', async () => {
  const c = await signedProposal();
  await updatePersonProfilePartial(admin, { personId: employee.personId!, phone: '+60199998888' });
  await v9Command(admin, c.id, c.revision, { type: 'pmPush', id: c.pmChanges[0].id });
  const [person] = await owner.client`select phone from person where id=${employee.personId!}::uuid`;
  expect(person.phone).toBe('+60199998888'); expect((await v9Workspace(admin)).cases.find(x => x.id === c.id)!.pmChanges[0].status).toBe('conflict');
});
it('stores private file bytes, resumes the waiting workflow and deduplicates a successful retry', async () => {
  const c = await prepared(), bytes = Buffer.from('%PDF-1.4\nV9 fixture bytes\n%%EOF');
  expect(c.runs[0].status).toBe('waiting');
  const input = { caseId: c.id, revision: c.revision, slot: 'fixture-support', name: 'support.pdf', content: bytes };
  await expect(v9UploadFile(other, input)).rejects.toThrow();
  const id = await v9UploadFile(admin, input);
  expect(await v9UploadFile(admin, input)).toBe(id);
  const next = (await v9Workspace(admin)).cases.find(x => x.id === c.id)!;
  expect(next.files).toHaveLength(1); expect(next.runs[0].status).toBe('done');
  expect((await v9DownloadFile(admin, c.id, id)).content.equals(bytes)).toBe(true);
  await expect(v9DownloadFile(other, c.id, id)).rejects.toThrow();
  await expect(v9UploadFile(admin, { ...input, revision: next.revision, name: 'spoof.pdf', content: Buffer.from('not a PDF') })).rejects.toThrow('contents');
});
it('enforces revision, status and private configuration boundaries inside the SQL commands', async () => {
  const c = await prepared();
  await expect(withTenant(employee, tx => tx.execute(sql`select app.lc_v9_self_task(${c.id}::uuid,null,'handover','done','')`))).rejects.toThrow();
  await expect(withTenant(employee, tx => tx.execute(sql`select app.lc_v9_self_task(${c.id}::uuid,${c.revision},'handover',null,'')`))).rejects.toThrow();
  expect(await withTenant(employee, tx => tx.execute(sql`select data from lc_v9_config where tenant_id=${base.tenantId}::uuid`))).toHaveLength(0);
  expect((await v9OwnWork(employee))[0].tasks[0].status).toBe('todo');
  const [privilege] = await owner.client`select has_column_privilege('ai_hr_app','lc_v9_payroll_handover','data','UPDATE') as can_rewrite,has_column_privilege('ai_hr_app','lc_v9_payroll_handover','status','UPDATE') as can_review`;
  expect(privilege).toMatchObject({ can_rewrite: false, can_review: true });
});
it('permits only the assigned employee task and keeps the private case hidden', async () => {
  const c = await prepared();
  const visible = await v9OwnWork(employee);
  expect(visible.map(x => x.id)).toEqual([c.id]); expect(visible[0].tasks.map(t => t.id)).toEqual(['handover']);
  expect(JSON.stringify(visible)).not.toContain('pmChanges'); expect(JSON.stringify(visible)).not.toContain('finalFigures');
  expect(await v9OwnWork(other)).toEqual([]);
  await expect(v9OwnTask(other, { caseId: c.id, revision: c.revision, taskId: 'handover', status: 'done', reason: '' })).rejects.toThrow();
  await expect(v9Workspace(other)).rejects.toThrow('HR administration');
  await v9OwnTask(employee, { caseId: c.id, revision: c.revision, taskId: 'handover', status: 'done', reason: '' });
  expect((await v9OwnWork(employee))[0].tasks[0].status).toBe('done');
  await expect(v9OwnTask(employee, { caseId: c.id, revision: c.revision, taskId: 'handover', status: 'todo', reason: '' })).rejects.toThrow();
});
it('rejects fabricated subjects, stale writes and cross-tenant case identifiers', async () => {
  const c = await prepared();
  await expect(v9Command(admin, c.id, c.revision - 1, { type: 'cancel', reason: 'stale' })).rejects.toThrow('changed');
  await expect(withTenant(admin, tx => tx.execute(sql`update lc_v9_case set data=jsonb_set(data,'{facts,personId}',to_jsonb(${other.personId}::text)) where id=${c.id}::uuid`))).rejects.toThrow();
  const foreignBase = await seedBase(); await setModule(foreignBase.tenantId, 'lifecycle', 'active');
  const foreign = await entitledCtx(foreignBase);
  await expect(v9Command(foreign, c.id, c.revision, { type: 'cancel', reason: 'not my tenant' })).rejects.toThrow('not found');
  expect((await v9Workspace(admin)).cases.find(x => x.id === c.id)?.state).toBe('submitted');
});

it('edits a workflow while preserving waiting run definitions and refuses deletion of its history', async () => {
  const c = await prepared(), config = (await v9Workspace(admin)).config!;
  const initial = structuredClone(c.runs[0].definition);
  config.workflows[0].name = 'Revised for future cases';
  config.workflows[0].steps = [{ id: 'new-action', type: 'notify', subject: 'Future cases', body: '', to: ['employee'], cc: [] }];
  await v9SaveConfig(admin, config.revision, config);
  const changed = await v9Workspace(admin);
  expect(changed.cases.find(row => row.id === c.id)!.runs[0].definition).toEqual(initial);
  expect(changed.config!.workflows[0].name).toBe('Revised for future cases');
  const removed = structuredClone(changed.config!); removed.workflows = [];
  await expect(v9SaveConfig(admin, removed.revision, removed)).rejects.toThrow('history');
  await v9UploadFile(admin, { caseId: c.id, revision: c.revision, slot: 'fixture-support', name: 'support.pdf', content: Buffer.from('%PDF-1.4\nfixture\n%%EOF') });
  const resumed = (await v9Workspace(admin)).cases.find(row => row.id === c.id)!;
  expect(resumed.runs[0].status).toBe('done');
  expect(resumed.runs[0].definition).toEqual(initial);
  expect(resumed.mails).toHaveLength(0);
});

it('pushes only the reviewed selection and keeps other proposals on the case with an audit record', async () => {
  const c = await signedProposal(), id = c.pmChanges[0].id;
  await v9Command(admin, c.id, c.revision, { type: 'pmKeep', ids: [id] });
  const kept = (await v9Workspace(admin)).cases.find(row => row.id === c.id)!;
  expect(kept.pmChanges[0].status).toBe('rejected'); expect(kept.log.at(-1)!.action).toBe('personnel.kept');
  const [person] = await owner.client`select phone from person where id=${employee.personId!}::uuid`;
  expect(person.phone).toBe('+60123456789');
  await expect(v9Command(admin, kept.id, kept.revision, { type: 'pmPushSelected', ids: [id] })).rejects.toThrow('already applied');
});
it('validates the complete reviewed selection before writing Personnel and rejects stale revisions', async () => {
  const c = await signedProposal(), id = c.pmChanges[0].id;
  await expect(v9Command(admin, c.id, c.revision, { type: 'pmPushSelected', ids: [id, 'fabricated'] })).rejects.toThrow('unavailable');
  await expect(v9Command(admin, c.id, c.revision, { type: 'pmPushSelected', ids: [id, id] })).rejects.toThrow('once');
  const [before] = await owner.client`select phone from person where id=${employee.personId!}::uuid`;
  expect(before.phone).toBe('+60123456789');
  await v9Command(admin, c.id, c.revision, { type: 'pmPushSelected', ids: [id] });
  const [after] = await owner.client`select phone from person where id=${employee.personId!}::uuid`;
  expect(after.phone).toBe('+60111112222');
  await expect(v9Command(admin, c.id, c.revision, { type: 'pmPushSelected', ids: [id] })).rejects.toThrow('changed');
});

it('returns actual config revisions and authenticated version stamps for automatic-save acknowledgments', async () => {
  const before = await v9Workspace(admin), config = before.config!, template = config.templates.find(template => template.versions.length === 1 && template.versions[0].state === 'published')!;
  const published = structuredClone(template.versions[0]);
  template.versions.push({ ...structuredClone(published), version: 2, state: 'draft', by: 'Fabricated actor', at: '1800-01-01' });
  const receipt = await v9SaveConfig(admin, config.revision, config);
  expect(receipt).toMatchObject({ revision: config.revision + 1, groupsRevision: config.groupsRevision });
  expect(receipt.versionStamps).toContainEqual({ templateId: template.id, version: 2, state: 'draft', at: todayInKualaLumpur(), by: before.actor.name });
  const saved = (await v9Workspace(admin)).config!;
  expect(saved.templates.find(t => t.id === template.id)!.versions[0]).toEqual(published);
  saved.templates.find(t => t.id === template.id)!.versions[1].state = 'published';
  const next = await v9SaveConfig(admin, saved.revision, saved);
  expect(next.versionStamps).toContainEqual({ templateId: template.id, version: 2, state: 'published', at: todayInKualaLumpur(), by: before.actor.name });
});

it('previews an HR-held acceptance message without changing its case and refuses unrelated users', async () => {
  const c = await prepared(), before = structuredClone(c);
  const preview = await v9PreviewEmail(admin, c.id, 'e3');
  expect(preview.emailId).toBe('e3'); expect(preview.canSend).toBe(false);
  expect(preview.holds.some(hold => hold.includes('HR must review and sign'))).toBe(true);
  expect((await v9Workspace(admin)).cases.find(row => row.id === c.id)).toEqual(before);
  await expect(v9PreviewEmail(other, c.id, 'e3')).rejects.toThrow();
});

it('projects V9 checklist definitions into native cases and preserves their task snapshots until reconciliation', async () => {
  const configured = (await v9Workspace(admin)).config!, original = configured.checklists.find(checklist => checklist.id === 'c1')!;
  const native = await onboardingContext(admin);
  expect(native.config.checklists.find(checklist => checklist.id === 'c1')!.tasks.map(task => task.name)).toEqual(original.tasks.map(task => task.name));
  expect(native.config.checklists.find(checklist => checklist.id === 'c1')!.tasks.find(task => task.documentTemplate === 'tdev')).toMatchObject({ by: 'joiner', documentAction: 'signed', gate: false });
  const attempted = structuredClone(native.config); attempted.checklists[0].name = 'Bypass shared owner';
  await expect(onboardingSaveConfig(admin, native.revision, attempted)).rejects.toThrow('V9 workspace');
  await saveEmployeeDraft(admin, { data: { profile: { fullName: 'Fictional V9 shared checklist', primaryEmail: 'v9-shared-native@test.invalid' }, employment: { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, hiredOn: todayInKualaLumpur() } }, currentStep: 1 });
  let [joiner] = await onboardingList(admin);
  await onboardingCommand(admin, joiner.case.id, joiner.revision, { type: 'saveSubmit', patch: { hiring: 'new_hire', local: { supervisor: employmentId }, selected: [] } });
  [joiner] = await onboardingList(admin);
  expect(joiner.case.tasks.map(task => task.name)).toEqual(original.tasks.map(task => task.name));
  expect(joiner.case.confirmedChecklist!.id).toBe('c1');
  const snapshot = structuredClone(joiner.case.tasks), config = (await v9Workspace(admin)).config!, expectedNativeRevision = (await onboardingContext(admin)).revision;
  config.checklists.find(checklist => checklist.id === 'c1')!.tasks[0].name = 'Reviewed welcome pack';
  const receipt = await v9SaveConfig(admin, config.revision, config);
  expect(receipt.groupsRevision).toBe(expectedNativeRevision + 1);
  [joiner] = await onboardingList(admin);
  expect(joiner.case.tasks).toEqual(snapshot); expect(joiner.case.reconcileNeeded).toBe(true);
  expect((await onboardingContext(admin)).config.checklists.find(checklist => checklist.id === 'c1')!.tasks[0].name).toBe('Reviewed welcome pack');
  const [stored] = await owner.client`select data from lc_onboarding_config where tenant_id=${base.tenantId}::uuid`;
  expect(stored.data.checklists.map((checklist: { id: string }) => checklist.id)).toEqual(['fallback']);
  const projection = await withTenant(other, tx => tx.execute<{ value: unknown }>(sql`select app.onboarding_v9_checklists() as value`));
  expect(JSON.stringify(projection)).not.toContain('versions'); expect(JSON.stringify(projection)).not.toContain('emails');
});

it('keeps native onboarding document state private and preserves it through later native edits', async () => {
  const draft = await saveEmployeeDraft(admin, { currentStep: 1, data: { profile: { fullName: 'Fictional private document joiner', primaryEmail: 'private-doc@test.invalid' }, employment: { companyId: base.companyId, positionId: base.positionId, hiredOn: addDays(todayInKualaLumpur(), 7), departmentId: base.deptA, employmentType: 'full_time' } } });
  const row = (await onboardingList(admin)).find(row => row.case.sourceDraftId === draft.id)!;
  await onboardingCommand(admin, row.case.id, row.revision, { type: 'saveSubmit', patch: { hiring: 'new_hire', local: { supervisor: employmentId } } });
  const before = await v9CaseDetail(admin, row.case.id);
  expect(before.case.id).toBe(row.case.id); expect(before.case.facts.employmentId).toBe('');
  const config = (await v9Workspace(admin)).config!;
  const template = { ...structuredClone(config.templates.find(template => template.module === 'onb' && template.type === 'Form')!), id: 'native-private-fixture', name: 'Private native fixture', retired: false, rules: {} };
  config.templates.push(template);
  await v9SaveConfig(admin, config.revision, config);
  await v9Command(admin, row.case.id, before.case.revision, { type: 'generate', template: template.id });
  const after = await v9CaseDetail(admin, row.case.id);
  expect(after.case.documents).toHaveLength(1); expect(after.case.revision).toBe(before.case.revision + 1);
  const [storage] = await owner.db.execute<{ public_data: Record<string, unknown>; private_data: Record<string, unknown>; copies: number }>(sql`select c.data as public_data,p.data as private_data,(select count(*)::int from lc_v9_case where id=c.id) as copies from lc_onboarding_case c join lc_onboarding_private p on p.case_id=c.id where c.id=${row.case.id}::uuid`);
  expect(storage.public_data).not.toHaveProperty('lifecycleV9'); expect(storage.public_data).not.toHaveProperty('documents');
  expect(storage.private_data).toHaveProperty('lifecycleV9.documents'); expect(storage.copies).toBe(0);
  await onboardingCommand(admin, row.case.id, after.case.revision, { type: 'save', patch: { notes: 'Native case edit after document generation' } });
  expect((await v9CaseDetail(admin, row.case.id)).case.documents).toEqual(after.case.documents);
  await expect(v9CaseDetail(other, row.case.id)).rejects.toThrow();
  await expect(v9Command(admin, row.case.id, after.case.revision, { type: 'generate', template: template.id })).rejects.toThrow('changed');
});

it('lets only the linked activated joiner complete a released native document and updates native task history', async () => {
  const config = (await v9Workspace(admin)).config!;
  config.templates.push({ id: 'native-self-form', name: 'Fictional native self form', module: 'onb', type: 'Form', rules: {}, hrStep: 'none', employeeAck: false, retired: false, versions: [{ version: 1, state: 'published', at: '', by: '', blocks: [{ id: 'body', type: 'text', text: 'Hello {employee.name}', section: '' }], fields: [{ id: 'contact', label: 'Contact', type: 'phone', owner: 'employee', pmKey: 'mobile', required: true, sensitive: false, options: [], section: 'main', when: null }] }] });
  config.checklists = [...config.checklists.filter(checklist => checklist.module === 'off'), { id: 'native-self-checklist', name: 'Native self fixture', module: 'onb', rules: {}, tasks: [{ id: 'native-self-task', name: 'Complete native form', by: 'employee', group: null, mode: 'manual', opens: 1, due: 1, required: true, documentTemplate: 'native-self-form', documentAction: 'signed' }] }];
  config.workflows = [{ id: 'native-self-release', name: 'Release native self form', module: 'onb', status: 'published', trigger: { event: 'beforeJoin', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'release', type: 'doc', template: 'native-self-form', release: true }, { id: 'wait', type: 'waitSign', template: 'native-self-form', by: 'employee' }, { id: 'notify', type: 'notify', subject: 'Native form completed', body: '{employee.name} completed the form.', to: 'supervisor', cc: [] }], description: '' }];
  await v9SaveConfig(admin, config.revision, config);
  const draft = await saveEmployeeDraft(admin, { currentStep: 5, data: { profile: { fullName: 'Fictional activated V9 joiner', employeeCode: 'V9-NATIVE-SELF', primaryEmail: 'native-self@test.invalid' }, employment: { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, employmentType: 'full_time', hiredOn: todayInKualaLumpur() }, payroll: { basicSalary: '5000' } } });
  const active = await completeEmployeeDraft(admin, draft.id);
  const [subject] = await owner.db.execute<{ person_id: string }>(sql`select person_id from employment where id=${active.employmentId}::uuid`);
  const userId = await createAppUser(base.tenantId, subject.person_id, 'employee');
  const joiner: SessionContext = { ...employee, personId: subject.person_id, userId };
  const native = (await onboardingList(admin)).find(row => row.case.sourceDraftId === draft.id)!;
  await onboardingCommand(admin, native.case.id, native.revision, { type: 'saveSubmit', patch: { hiring: 'new_hire', local: { supervisor: employmentId } } });
  const submitted = await v9CaseDetail(admin, native.case.id);
  expect(submitted.case.tasks[0].assignee).toBe(userId);
  expect((await v9OwnWork(joiner)).find(c => c.id === native.case.id)?.documents).toHaveLength(1);
  await v9Command(admin, native.case.id, submitted.case.revision, { type: 'runWorkflows' });
  const own = (await v9OwnWork(joiner)).find(c => c.id === native.case.id)!;
  expect(own.documents).toHaveLength(1); expect(own.documents[0].status).toBe('sent');
  expect((await v9OwnWork(other)).some(c => c.id === native.case.id)).toBe(false);
  const input = { caseId: own.id, revision: own.revision, documentId: own.documents[0].id, values: { contact: '+60111111111' }, signature: { method: 'typed' as const, value: 'Fictional activated V9 joiner', consent: true as const } };
  await expect(v9OwnDocument(other, input)).rejects.toMatchObject({ cause: { message: expect.stringContaining('not available') } });
  await expect(v9OwnDocument(joiner, { ...input, values: { forbidden: 'HR field tampering' } })).rejects.toMatchObject({ cause: { message: expect.stringContaining('cannot be changed') } });
  await v9OwnDocument(joiner, input);
  const done = (await onboardingList(admin)).find(row => row.case.id === own.id)!;
  expect(done.case.tasks[0]).toMatchObject({ status: 'done', completedBy: userId });
  expect(done.case.history.at(-1)).toMatchObject({ action: 'document.signed', by: userId });
  const system = { ...admin, userId: undefined, personId: null };
  const sweepAt = new Date(todayInKualaLumpur() + 'T15:59:00Z');
  await expect(v9Sweep(system, { withTenant }, sweepAt)).rejects.toThrow('storage owner');
  expect(await v9Sweep(system, owner, sweepAt)).toEqual({ processed: 1, failed: 0 });
  expect(await v9Sweep(system, owner, sweepAt)).toEqual({ processed: 0, failed: 0 });
  const detail = await v9CaseDetail(admin, own.id);
  expect(detail.case.runs).toHaveLength(1); expect(detail.case.runs[0].status).toBe('done');
  expect(detail.case.mails).toHaveLength(1); expect(detail.case.mails[0]).toMatchObject({ subject: 'Native form completed', status: 'pending', to: [employee.userId] });
  expect(detail.case.documents[0].employeeSignature?.by.id).toBe(userId);
  expect(detail.case.pmChanges).toHaveLength(1);
  await v9Command(admin, own.id, detail.case.revision, { type: 'pmPushSelected', ids: [detail.case.pmChanges[0].id] });
  const [updatedPerson] = await owner.db.execute<{ phone: string }>(sql`select phone from person where id=${subject.person_id}::uuid`);
  expect(updatedPerson.phone).toBe('+60111111111');
  expect((await v9CaseDetail(admin, own.id)).case.pmChanges[0].status).toBe('pushed');
  expect(JSON.stringify((await v9OwnWork(joiner)).find(c => c.id === own.id))).not.toContain('pmChanges');
  await expect(v9OwnDocument(joiner, input)).rejects.toMatchObject({ cause: { message: expect.stringContaining('changed') } });
  // Independently drift the broader row as storage owner; private custody must still refuse redirection.
  const [differentSubject] = await owner.db.execute<{ id: string }>(sql`select id from employment where tenant_id=${base.tenantId}::uuid and person_id=${other.personId}::uuid`);
  await owner.db.execute(sql`update lc_onboarding_case set employment_id=${differentSubject.id}::uuid,data=data||jsonb_build_object('employmentId',${differentSubject.id}::text,'personId',${other.personId}::text) where id=${own.id}::uuid`);
  expect((await v9OwnWork(other)).some(c => c.id === own.id)).toBe(false);
  await expect(v9OwnDocument(other, { ...input, revision: done.revision })).rejects.toMatchObject({ cause: { message: expect.stringContaining('not available') } });
  await expect(v9CaseDetail(admin, own.id)).rejects.toThrow('private document subject');
});

it('does not enroll historical native cases in V9 automation until HR adopts their definitions', async () => {
  await owner.db.execute(sql`delete from lc_v9_config where tenant_id=${base.tenantId}::uuid`);
  await saveEmployeeDraft(admin, { currentStep: 1, data: { profile: { fullName: 'Fictional historical native joiner', primaryEmail: 'legacy-native@test.invalid' }, employment: { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, hiredOn: todayInKualaLumpur() } } });
  const [pending] = await onboardingList(admin);
  await onboardingCommand(admin, pending.case.id, pending.revision, { type: 'saveSubmit', patch: { hiring: 'new_hire', local: { supervisor: employmentId } } });
  expect((await onboardingList(admin))[0].case.v9DefinitionRevision).toBeUndefined();
  await v9Setup(admin);
  const [before] = await onboardingList(admin);
  expect(before.case.reconcileNeeded).toBe(true);
  const system = { ...admin, userId: undefined, personId: null };
  expect(await v9Sweep(system, owner, new Date(todayInKualaLumpur() + 'T15:59:00Z'))).toEqual({ processed: 0, failed: 0 });
  expect((await onboardingList(admin))[0].revision).toBe(before.revision);
  const [privateRow] = await owner.db.execute<{ data: Record<string, unknown> }>(sql`select data from lc_onboarding_private where case_id=${before.case.id}::uuid`);
  expect(privateRow.data).not.toHaveProperty('lifecycleV9');
});
