import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, updatePersonProfilePartial } from '../core/org';
import { saveEmployeeDraft } from '../core/employee-draft';
import { todayInKualaLumpur } from '../lib/hr-date';
import { addDays } from '../lib/lifecycle-v9-model';
import { currentReq } from '../lib/onboarding-model';
import { v9Setup, v9Workspace, v9SaveConfig, v9CreateOffboarding, v9Command, v9OwnWork, v9OwnTask, v9OwnDocument, v9UploadFile, v9DownloadFile, onboardingContext, onboardingSaveConfig, onboardingList, onboardingCommand, onboardingAssignmentLoadsTx } from '../packs/lifecycle/service';
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
  config.checklists = [{ id: 'fixture', name: 'Focused exit', module: 'off', rules: {}, tasks: [{ id: 'handover', name: 'Complete handover', by: 'employee', group: null, mode: 'manual', opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'completed' }] }];
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
  native.checklists = [{ id: 'workload-checklist', name: 'Workload fixture', owner: base.adminUserId, createdAt: new Date().toISOString(), rules: {}, tasks: [{ id: 'prepare', name: 'Prepare workspace', by: 'group', group: group.id, method: 'rr', opens: null, due: 1, gate: false }] }];
  native.catalogue = [{ id: 'workload-laptop', name: 'Fixture laptop', type: 'device', active: true, rules: {}, workflow: null, team: group.id, card: false }];
  await onboardingSaveConfig(admin, context.revision, native);
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
  config.checklists = [{ id: 'workload-exit', name: 'Workload exit', module: 'off', rules: {}, tasks: [{ id: 'return-work', name: 'Prepare return', by: 'group', group: group.id, mode: 'rr', opens: null, due: 0, required: false, documentTemplate: null, documentAction: 'completed' }] }];
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
