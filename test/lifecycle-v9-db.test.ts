import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setEmploymentInfo, updatePersonProfilePartial } from '../core/org';
import { saveEmployeeDraft, completeEmployeeDraft } from '../core/employee-draft';
import { todayInKualaLumpur } from '../lib/hr-date';
import { addDays } from '../lib/lifecycle-v9-model';
import { currentReq } from '../lib/onboarding-model';
import { v9UploadEmailAsset, v9DownloadEmailAsset, v9Setup, v9Sweep, v9DeliverEmails, v9DownloadDocument, v9CaseDetail, v9PreviewUpdatedEmail, v9PreviewWorkflow, v9Workspace, v9PreviewEmail, v9SaveConfig, v9CreateOffboarding, v9Command, v9OwnWork, v9OwnTask, v9OwnItem, onboardingRecoverHoldingTx, registerAsset, returnAssetTx, issueAssetTx, getAsset, assetHistory, v9OwnDocument, v9ReportOwnReturn, v9OwnEquipmentReceipt, v9UploadFile, v9DownloadFile, onboardingContext, onboardingSaveConfig, onboardingList, onboardingCommand, onboardingAssignmentLoadsTx, onboardingHoldingsTx } from '../packs/lifecycle/service';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser, type Base } from './harness';

let base: Base, admin: SessionContext, employee: SessionContext, other: SessionContext, employmentId: string;
beforeAll(async () => {
  assetPng = await (await import('sharp')).default({ create: { width: 2, height: 2, channels: 4, background: { r: 79, g: 70, b: 229, alpha: 1 } } }).png().toBuffer();
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
it('reports retained V9 company history without granting private case access to organisation HR',async()=>{
  const c=await prepared(),userId=await createAppUser(base.tenantId,other.personId!,'hr_admin');
  await owner.client`update role_assignment set company_id=${base.companyId}::uuid where tenant_id=${base.tenantId}::uuid and app_user_id=${userId}::uuid and role='hr_admin'`;
  const reviewer:SessionContext={...other,userId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:base.companyId}]};
  expect(await withTenant(reviewer,tx=>tx.execute(sql`select id from lc_v9_case where id=${c.id}::uuid`))).toEqual([]);
  const retained=(ctx:SessionContext,company:string)=>withTenant(ctx,tx=>tx.execute<{used:boolean}>(sql`select app.lc_v9_company_employee_history_in_use(${company}::uuid) as used`));
  expect(await retained(reviewer,base.companyId)).toEqual([{used:true}]);
  expect(await retained(employee,base.companyId)).toEqual([{used:false}]);
  expect(await retained(reviewer,randomUUID())).toEqual([{used:false}]);
  const foreignBase=await seedBase(),foreign=await entitledCtx(foreignBase);
  expect(await retained(foreign,base.companyId)).toEqual([{used:false}]);
  await owner.client`update role_assignment set role='employee' where tenant_id=${base.tenantId}::uuid and app_user_id=${userId}::uuid and role='hr_admin'`;
  expect(await retained(reviewer,base.companyId)).toEqual([{used:false}]);
});
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
it('protects shared groups referenced by V9 recipients and open offboarding snapshots', async () => {
  const native = await onboardingContext(admin), ids = ['v9-people-ops', 'v9-mail-group', 'v9-flow-group', 'v9-snapshot-group', 'v9-unused-group'];
  native.config.groups.push(...ids.map(id => ({ id, name: id, members: [base.adminUserId], limit: 0 })));
  await onboardingSaveConfig(admin, native.revision, native.config);
  let config = (await v9Workspace(admin)).config!;
  config.peopleOpsGroup = ids[0];
  config.emails[0].cc.push(`group:${ids[1]}`);
  for (const workflow of config.workflows) workflow.status = 'draft';
  config.workflows.push({ id: 'group-ref', name: 'Group reference', module: 'off', status: 'draft', trigger: { event: 'manual', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'notify', type: 'notify', subject: 'Review', body: 'Review', to: [`group:${ids[2]}`], cc: [] }], description: '' });
  config.checklists = [...config.checklists.filter(checklist => checklist.module === 'onb'), { id: 'group-ref-exit', name: 'Group snapshot', module: 'off', rules: {}, tasks: [{ id: 'review', name: 'Review handover', by: 'group', group: ids[3], mode: 'manual', opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'completed' }] }];
  await v9SaveConfig(admin, config.revision, config);
  const id = await v9CreateOffboarding(admin, { employmentId, type: 'Resignation', noticeDate: todayInKualaLumpur(), lastDay: addDays(todayInKualaLumpur(), 30) });
  await v9Command(admin, id, 1, { type: 'submit' });
  config = (await v9Workspace(admin)).config!;
  config.checklists.find(checklist => checklist.id === 'group-ref-exit')!.tasks[0].group = config.groups[0].id;
  await v9SaveConfig(admin, config.revision, config);
  const refs = await withTenant(admin, tx => tx.execute<{ ids: string[] }>(sql`select app.onboarding_v9_group_references() as ids`));
  expect(refs[0].ids).toEqual(expect.arrayContaining(ids.slice(0, 4)));
  expect(refs[0].ids).not.toContain(ids[4]);
  expect(await withTenant(other, tx => tx.execute<{ ids: string[] }>(sql`select app.onboarding_v9_group_references() as ids`))).toEqual([{ ids: [] }]);
  for (const group of ids.slice(0, 4)) {
    const current = await onboardingContext(admin), proposed = structuredClone(current.config);
    proposed.groups = proposed.groups.filter(candidate => candidate.id !== group);
    await expect(onboardingSaveConfig(admin, current.revision, proposed, { [group]: current.config.groups[0].id })).rejects.toThrow('used by V9');
  }
  const current = await onboardingContext(admin);
  current.config.groups = current.config.groups.filter(group => group.id !== ids[4]);
  await onboardingSaveConfig(admin, current.revision, current.config);
  expect((await onboardingContext(admin)).config.groups.some(group => group.id === ids[4])).toBe(false);
  expect((await v9Workspace(admin)).cases.find(row => row.id === id)!.tasks[0].group).toBe(ids[3]);
});

it('uses native checklist and claimed-equipment load for offboarding, without counting existing leaver work', async () => {
  const context = await onboardingContext(admin), native = structuredClone(context.config), group = native.groups[0];
  group.members = [base.adminUserId, other.userId!]; group.limit = 2;
  native.catalogue = [{ id: 'workload-laptop', name: 'Fixture laptop', type: 'device', active: true, rules: {}, workflow: null, team: group.id, card: false }];
  await onboardingSaveConfig(admin, context.revision, native);
  const onboardingDefinitions = (await v9Workspace(admin)).config!;
  onboardingDefinitions.checklists = [...onboardingDefinitions.checklists.filter(checklist => checklist.module === 'off'), { id: 'workload-checklist', name: 'Workload fixture', module: 'onb', rules: {}, tasks: [{ id: 'prepare', name: 'Prepare workspace', by: 'group', group: group.id, mode: 'rr', opens: null, due: 1, required: false, documentTemplate: null, documentAction: 'completed' }] }];
  await v9SaveConfig(admin, onboardingDefinitions.revision, onboardingDefinitions);
  await saveEmployeeDraft(admin, { data: { profile: { fullName: 'Fictional workload joiner', primaryEmail: 'workload@test.invalid' }, employment: { companyId: base.companyId, reportingManagerEmploymentId: employmentId, departmentId: base.deptA, positionId: base.positionId, hiredOn: todayInKualaLumpur() } }, currentStep: 1 });
  let [joiner] = await onboardingList(admin);
  await onboardingCommand(admin, joiner.case.id, joiner.revision, { type: 'save', patch: { hiring: 'new_hire', local: { supervisor: employmentId }, selected: ['workload-laptop'], equipmentOverrides: { 'workload-laptop': { method: 'manual' } } } });
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
  for (const workflow of config.workflows) workflow.status = 'draft';
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
  await expect(v9Workspace(other)).rejects.toThrow('module access');
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

it('freezes company letterhead defaults and later presentation edits with each generated document', async () => {
  await owner.client`update company set registration_no='CANONICAL-FICTIONAL',address_line1='Canonical fictional address',city='Fixture City' where id=${base.companyId}::uuid`;
  const c = await prepared(), first = structuredClone(c.documents[0]);
  expect(first.mergeValues).toMatchObject({ 'company.regNo': 'CANONICAL-FICTIONAL', 'company.address': 'Canonical fictional address, Fixture City', 'company.color': '#4F46E5' });
  const workspace = await v9Workspace(admin), config = workspace.config!;
  expect(workspace.options.companies.find(company => company.id === base.companyId)).toMatchObject({ registrationNo: 'CANONICAL-FICTIONAL', address: 'Canonical fictional address, Fixture City' });
  config.companies = [{ companyId: base.companyId, signatoryUserId: null, signatoryTitle: '', letterhead: { registrationNo: 'LETTERHEAD-FICTIONAL', address: 'Formatted fictional address\nSecond line', color: '#336699' } }];
  await v9SaveConfig(admin, config.revision, config);
  expect((await v9CaseDetail(admin, c.id)).case.documents[0]).toEqual(first);
  const template = config.templates.find(template => template.module === 'off' && template.id !== 'fixture-form')!;
  await v9Command(admin, c.id, c.revision, { type: 'generate', template: template.id });
  const next = (await v9CaseDetail(admin, c.id)).case.documents.find(document => document.templateId === template.id)!;
  expect(next.mergeValues).toMatchObject({ 'company.regNo': 'LETTERHEAD-FICTIONAL', 'company.address': 'Formatted fictional address\nSecond line', 'company.color': '#336699' });
  const [company] = await owner.client`select registration_no,address_line1 from company where id=${base.companyId}::uuid`;
  expect(company).toEqual({ registration_no: 'CANONICAL-FICTIONAL', address_line1: 'Canonical fictional address' });
  const invalid = (await v9Workspace(admin)).config!;
  invalid.companies![0].letterhead!.color = 'url(https://untrusted.invalid/logo)';
  await expect(v9SaveConfig(admin, invalid.revision, invalid)).rejects.toThrow();
});

it('keeps Native case-form answers private and enforces matching required fields on submission', async () => {
  const { defaultV9CaseFields }=await import('../lib/lifecycle-v9-case-form');
  const config=(await v9Workspace(admin)).config!;
  config.caseForms={onb:[...defaultV9CaseFields('onb'),{key:'privateDetail',label:'Private replacement detail',type:'long',show:true,required:true,hrOnly:true,rules:{company:[base.companyId]},options:[],help:'',when:{field:'hireType',value:'replacement'}},{key:'sharedDetail',label:'Shared case detail',type:'text',show:true,required:false,hrOnly:false,rules:{},options:[],help:''}]};
  config.emails.push({id:'private-case-email',name:'Private case merge hold',module:'onb',active:true,sender:'onboarding',subject:'Private case check',body:'{case.privateDetail}',cc:[],links:[],attachments:[],slots:[]});
  await v9SaveConfig(admin,config.revision,config);
  const draft=await saveEmployeeDraft(admin,{currentStep:1,data:{profile:{fullName:'Fictional private case form',primaryEmail:'form-source@test.invalid'},employment:{companyId:base.companyId,departmentId:base.deptA,positionId:base.positionId,hiredOn:addDays(todayInKualaLumpur(),5),reportingManagerEmploymentId:employmentId}}});
  const row=(await onboardingList(admin)).find(row=>row.case.sourceDraftId===draft.id)!;
  await expect(onboardingCommand(admin,row.case.id,row.revision,{type:'save',patch:{local:{employeeId:'FORGED-PM-ID'}}})).rejects.toThrow('Personnel Management');
  await expect(onboardingCommand(admin,row.case.id,row.revision,{type:'saveSubmit',patch:{hiring:'replacement',replacedEmployee:'Fictional departing employee'}})).rejects.toThrow('Private replacement detail');
  expect((await onboardingList(admin)).find(candidate=>candidate.case.id===row.case.id)!.revision).toBe(row.revision);
  await onboardingCommand(admin,row.case.id,row.revision,{type:'saveSubmit',patch:{hiring:'replacement',replacedEmployee:'Fictional departing employee',caseValues:{privateDetail:'Private HR replacement answer',sharedDetail:'Ordinary source answer'},caseContactEmail:'form-contact@test.invalid'}});
  const [stored]=await owner.client`select data from lc_onboarding_case where id=${row.case.id}::uuid`;
  expect(JSON.stringify(stored.data)).not.toContain('Private HR replacement answer');expect(stored.data.caseContactEmail).toBeUndefined();
  const [secret]=await owner.client`select data from lc_onboarding_private where case_id=${row.case.id}::uuid`;
  expect(secret.data).toMatchObject({caseValues:{privateDetail:'Private HR replacement answer'},caseContactEmail:'form-contact@test.invalid'});
  const native=await onboardingContext(admin);native.config.access.onboarding.push(other.userId!);await onboardingSaveConfig(admin,native.revision,native.config);
  const {onboardingDetail}=await import('../packs/lifecycle/service');
  const outsider=await onboardingDetail(other,row.case.id);expect(outsider.case.caseValues).toEqual({sharedDetail:'Ordinary source answer'});expect(outsider.case.caseContactEmail).toBe('form-contact@test.invalid');
  await expect(onboardingCommand(other,row.case.id,outsider.revision,{type:'save',patch:{caseValues:{privateDetail:'Unauthorized'}}})).rejects.toThrow('HR access');
  await expect(withTenant(other,tx=>tx.execute(sql`select app.onboarding_v9_save_case_values(${row.case.id}::uuid,${outsider.revision},'{"caseValues":{"sharedDetail":"Unpaired bypass"}}'::jsonb)`))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringContaining('case changed')})});
  await expect(withTenant(other,async tx=>{await tx.execute(sql`update lc_onboarding_case set revision=revision+1 where id=${row.case.id}::uuid`);await tx.execute(sql`select app.onboarding_v9_save_case_values(${row.case.id}::uuid,${outsider.revision+1},'{"caseValues":{"privateDetail":"SQL bypass"}}'::jsonb)`);})).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringContaining('requires HR access')})});
  await onboardingCommand(other,row.case.id,outsider.revision,{type:'save',patch:{caseValues:{sharedDetail:'Ordinary module edit'}}});
  const detail=await onboardingDetail(admin,row.case.id);expect(detail.case.caseValues).toEqual({privateDetail:'Private HR replacement answer',sharedDetail:'Ordinary module edit'});
  await v9Command(admin,row.case.id,detail.revision,{type:'generate',template:'tdev'});
  const document=(await v9CaseDetail(admin,row.case.id)).case.documents[0];expect(document.mergeValues?.['case.privateDetail']).toBeUndefined();
  const preview=await v9PreviewEmail(admin,row.case.id,'private-case-email');expect(preview.canSend).toBe(false);expect(preview.holds).toContain('Remove sensitive fields from the email text.');const latest=(await v9CaseDetail(admin,row.case.id)).case;await expect(v9Command(admin,row.case.id,latest.revision,{type:'emailSend',emailId:'private-case-email'})).rejects.toThrow('Sensitive');
  const [persisted]=await owner.client`select data from lc_onboarding_config where tenant_id=${base.tenantId}::uuid`;expect(persisted.data.v9CaseFields).toBeUndefined();
});

it('submits offboarding with validated saved form answers and fresh workflow merge facts', async () => {
  const { defaultV9CaseFields }=await import('../lib/lifecycle-v9-case-form');
  const config=(await v9Workspace(admin)).config!;
  config.caseForms={off:[...defaultV9CaseFields('off'),{key:'decisionDetail',label:'Decision detail',type:'text',show:true,required:true,hrOnly:false,rules:{},options:[],help:'',when:{field:'type',value:'Termination'}}]};
  config.workflows=[{id:'case-form-trigger',name:'Fictional form trigger',module:'off',status:'published',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'notify',type:'notify',subject:'Case form',body:'{leaver.type}: {case.decisionDetail}',to:['address:review@fictional.invalid'],cc:[]}],description:''}];
  await v9SaveConfig(admin,config.revision,config);
  const id=await v9CreateOffboarding(admin,{employmentId,type:'Resignation',noticeDate:'2026-10-01',lastDay:'2026-11-01'});
  await expect(v9Command(admin,id,1,{type:'caseFormSave',values:{type:'Termination'},reason:'',submit:true})).rejects.toThrow('Decision detail');
  await expect(v9Command(admin,id,1,{type:'caseFormSave',values:{empNo:'FORGED'},reason:'',submit:false})).rejects.toThrow('Personnel fields are locked');
  await v9Command(admin,id,1,{type:'caseFormSave',values:{type:'Termination',notice:'2026-10-02',decisionDetail:'Reviewed explanation',revokeMode:'date',revokeDate:'2026-10-31',pbp:employee.userId!},reason:'',submit:true});
  const c=(await v9CaseDetail(admin,id)).case;
  expect(c).toMatchObject({state:'submitted',caseValues:{decisionDetail:'Reviewed explanation'},revokeMode:'date',revokeDate:'2026-10-31',facts:{caseType:'Termination',noticeDate:'2026-10-02',pbpUserId:employee.userId}});
  expect(c.mails[0].body).toBe('Termination: Reviewed explanation');
  await expect(v9Command(admin,id,c.revision,{type:'caseFormSave',values:{notice:'2026-10-03'},reason:'',submit:false})).rejects.toThrow('Record a reason');
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
  await saveEmployeeDraft(admin, { data: { profile: { fullName: 'Fictional V9 shared checklist', primaryEmail: 'v9-shared-native@test.invalid' }, employment: { companyId: base.companyId, reportingManagerEmploymentId: employmentId, departmentId: base.deptA, positionId: base.positionId, hiredOn: todayInKualaLumpur() } }, currentStep: 1 });
  let [joiner] = await onboardingList(admin);
  await onboardingCommand(admin, joiner.case.id, joiner.revision, { type: 'saveSubmit', patch: { hiring: 'new_hire', local: { supervisor: employmentId }, selected: [] } });
  [joiner] = await onboardingList(admin);
  expect(joiner.case.tasks.map(task => task.name)).toEqual(original.tasks.map(task => task.name));
  expect(joiner.case.confirmedChecklist!.id).toBe('c1');
  expect(joiner.case.reconcileNeeded).toBeFalsy();
  const unrelated = await onboardingContext(admin);
  unrelated.config.recentActiveDays += 1;
  await onboardingSaveConfig(admin, unrelated.revision, unrelated.config);
  const unchanged = (await onboardingList(admin)).find(row => row.case.id === joiner.case.id)!;
  expect(unchanged.revision).toBe(joiner.revision);
  expect(unchanged.case.reconcileNeeded).toBeFalsy();
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
  const draft = await saveEmployeeDraft(admin, { currentStep: 1, data: { profile: { fullName: 'Fictional private document joiner', primaryEmail: 'private-doc@test.invalid' }, employment: { companyId: base.companyId, reportingManagerEmploymentId: employmentId, positionId: base.positionId, hiredOn: addDays(todayInKualaLumpur(), 7), departmentId: base.deptA, employmentType: 'full_time' } } });
  const row = (await onboardingList(admin)).find(row => row.case.sourceDraftId === draft.id)!;
  await onboardingCommand(admin, row.case.id, row.revision, { type: 'saveSubmit', patch: { hiring: 'new_hire', local: { supervisor: employmentId } } });
  const before = await v9CaseDetail(admin, row.case.id);
  expect(before.case.id).toBe(row.case.id); expect(before.case.facts.employmentId).toBe(''); expect(before.case.facts.starterUserId).toBe(admin.userId);
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
  const pdf = await v9DownloadDocument(admin, row.case.id, after.case.documents[0].id);
  expect(pdf.name).toContain('Private native fixture'); expect(Buffer.from(pdf.content).subarray(0,5).toString()).toBe('%PDF-');
  await expect(v9DownloadDocument(other, row.case.id, after.case.documents[0].id)).rejects.toThrow('not found or unavailable');
  await onboardingCommand(admin, row.case.id, after.case.revision, { type: 'save', patch: { notes: 'Native case edit after document generation' } });
  expect((await v9CaseDetail(admin, row.case.id)).case.documents).toEqual(after.case.documents);
  await expect(v9CaseDetail(other, row.case.id)).rejects.toThrow();
  await expect(v9Command(admin, row.case.id, after.case.revision, { type: 'generate', template: template.id })).rejects.toThrow('changed');
  const current=(await v9CaseDetail(admin,row.case.id)).case,block=current.documents[0].blocks.find(block=>block.type==='heading')!;
  await v9Command(admin,row.case.id,current.revision,{type:'documentTextEdit',id:current.documents[0].id,edits:{[block.id]:'Fictional Native instance title'}});
  const edited=(await v9CaseDetail(admin,row.case.id)).case;
  expect(edited.documents[0].edits).toEqual({[block.id]:'Fictional Native instance title'});
  expect((await v9Workspace(admin)).config!.templates.find(candidate=>candidate.id===template.id)!.versions[0].blocks.find(candidate=>candidate.id===block.id)!.text).toBe(block.text);
  const workflowConfig=(await v9Workspace(admin)).config!;workflowConfig.workflows.push({id:'native-manual',name:'Fictional Native manual workflow',module:'onb',status:'published',trigger:{event:'manual',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'notify',type:'notify',to:'employee',cc:[],subject:'Fictional Native follow-up',body:'Fictional'}],description:''});
  await v9SaveConfig(admin,workflowConfig.revision,workflowConfig);await v9Command(admin,row.case.id,edited.revision,{type:'startWorkflow',workflowId:'native-manual'});
  const started=(await v9CaseDetail(admin,row.case.id)).case;expect(started.mails).toHaveLength(edited.mails.length+1);expect(started.mails.find(mail=>mail.workflowId==='native-manual')?.delivery?.contact).toMatchObject({kind:'onboardingContact',email:'private-doc@test.invalid'});expect(started.runs.find(run=>run.workflowId==='native-manual')?.status).toBe('waiting');


});

it('lets only the linked activated joiner complete a released native document and updates native task history', async () => {
  const config = (await v9Workspace(admin)).config!;
  config.templates.push({ id: 'native-self-form', name: 'Fictional native self form', module: 'onb', type: 'Form', rules: {}, hrStep: 'none', employeeAck: false, retired: false, versions: [{ version: 1, state: 'published', at: '', by: '', blocks: [{ id: 'body', type: 'text', text: 'Hello {employee.name}', section: '' }], fields: [{ id: 'contact', label: 'Contact', type: 'phone', owner: 'employee', pmKey: 'mobile', required: true, sensitive: false, options: [], section: 'main', when: null }] }] });
  config.checklists = [...config.checklists.filter(checklist => checklist.module === 'off'), { id: 'native-self-checklist', name: 'Native self fixture', module: 'onb', rules: {}, tasks: [{ id: 'native-self-task', name: 'Complete native form', by: 'employee', group: null, mode: 'manual', opens: 1, due: 1, required: true, documentTemplate: 'native-self-form', documentAction: 'signed' }] }];
  config.workflows = [{ id: 'native-self-release', name: 'Release native self form', module: 'onb', status: 'published', trigger: { event: 'beforeJoin', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'release', type: 'doc', template: 'native-self-form', release: true }, { id: 'wait', type: 'waitSign', template: 'native-self-form', by: 'employee' }, { id: 'notify', type: 'notify', subject: 'Native form completed', body: '{employee.name} completed the form.', to: 'supervisor', cc: [] }], description: '' }];
  for (const event of ['taskDone','docSigned'] as const) config.workflows.push({ id: 'native-' + event, name: 'Native ' + event, module: 'onb', status: 'published', trigger: { event, days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'notice', type: 'notify', to: 'employee', cc: [], subject: 'Native recorded ' + event, body: '' }], description: '' });
  await v9SaveConfig(admin, config.revision, config);
  const draft = await saveEmployeeDraft(admin, { currentStep: 5, data: { profile: { fullName: 'Fictional activated V9 joiner', employeeCode: 'V9-NATIVE-SELF', primaryEmail: 'native-self@test.invalid' }, employment: { companyId: base.companyId, reportingManagerEmploymentId: employmentId, departmentId: base.deptA, positionId: base.positionId, employmentType: 'full_time', hiredOn: todayInKualaLumpur() }, payroll: { basicSalary: '5000' } } });
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
  // This case already adopted V9 private documents before the newer public adoption flag existed.
  await owner.db.execute(sql`update lc_onboarding_case set data=data-'v9DefinitionRevision' where id=${own.id}::uuid`);
  const input = { caseId: own.id, revision: own.revision, documentId: own.documents[0].id, values: { contact: '+60111111111' }, signature: { method: 'typed' as const, value: 'Fictional activated V9 joiner', consent: true as const } };
  await expect(v9OwnDocument(other, input)).rejects.toMatchObject({ cause: { message: expect.stringContaining('not available') } });
  await expect(v9OwnDocument(joiner, { ...input, values: { forbidden: 'HR field tampering' } })).rejects.toMatchObject({ cause: { message: expect.stringContaining('cannot be changed') } });
  for (const signature of [{ method: 'typed', value: 'Fictional', consent: 'true' }, { method: 'typed', value: 7, consent: true }, { method: 'typed', value: 'x'.repeat(201), consent: true }, { method: 'drawn', value: 'https://untrusted.invalid/signature.png', consent: true }]) await expect(v9OwnDocument(joiner, { ...input, signature: signature as unknown as typeof input.signature })).rejects.toMatchObject({ cause: { message: expect.stringContaining('provide your signature') } });
  // A released PDF attachment must remain read-only through direct service/SQL calls too.
  await owner.db.execute(sql`update lc_onboarding_private set data=jsonb_set(data,'{lifecycleV9,documents,0,templateType}','"Attachment"'::jsonb) where case_id=${own.id}::uuid`);
  await expect(v9OwnDocument(joiner, input)).rejects.toMatchObject({ cause: { message: expect.stringContaining('read-only PDFs') } });
  await expect(v9OwnDocument(joiner, { ...input, signature: undefined })).rejects.toMatchObject({ cause: { message: expect.stringContaining('read-only PDFs') } });
  await owner.db.execute(sql`update lc_onboarding_private set data=jsonb_set(data,'{lifecycleV9,documents,0,templateType}','"Form"'::jsonb) where case_id=${own.id}::uuid`);
  await v9OwnDocument(joiner, input);
  const done = (await onboardingList(admin)).find(row => row.case.id === own.id)!;
  expect(done.case.tasks[0]).toMatchObject({ status: 'done', completedBy: userId });
  expect(done.case.history.at(-1)).toMatchObject({ action: 'document.signed', by: userId });
  const sourceRuns = (await v9CaseDetail(admin, own.id)).case.runs.filter(run => run.sourceEvent);
  expect(sourceRuns.map(run => run.sourceEvent!.kind).sort()).toEqual(['docSigned','taskDone']);
  expect(sourceRuns.every(run => run.actor?.id === userId)).toBe(true);
  const system = { ...admin, userId: undefined, personId: null };
  const sweepAt = new Date(todayInKualaLumpur() + 'T15:59:00Z');
  await expect(v9Sweep(system, { withTenant }, sweepAt)).rejects.toThrow('storage owner');
  expect(await v9Sweep(system, owner, sweepAt)).toEqual({ processed: 1, failed: 0 });
  expect(await v9Sweep(system, owner, sweepAt)).toEqual({ processed: 0, failed: 0 });
  const detail = await v9CaseDetail(admin, own.id);
  expect(detail.case.runs).toHaveLength(3); expect(detail.case.runs[0]).toMatchObject({ status: 'waiting', reason: 'Waiting for email delivery confirmation.' });
  expect(detail.case.mails).toHaveLength(3); expect(detail.case.mails[0]).toMatchObject({ subject: 'Native form completed', status: 'pending', to: [employee.userId] });
  expect(detail.case.documents[0].employeeSignature?.by.id).toBe(userId);
  expect(detail.case.pmChanges).toHaveLength(1);
  const pdf = await v9DownloadDocument(joiner, own.id, own.documents[0].id); expect(Buffer.from(pdf.content).subarray(0,5).toString()).toBe('%PDF-');
  await expect(v9DownloadDocument(other, own.id, own.documents[0].id)).rejects.toThrow('not found or unavailable');
  await v9Command(admin, own.id, detail.case.revision, { type: 'pmPushSelected', ids: [detail.case.pmChanges[0].id] });
  const [updatedPerson] = await owner.db.execute<{ phone: string }>(sql`select phone from person where id=${subject.person_id}::uuid`);
  expect(updatedPerson.phone).toBe('+60111111111');
  expect((await v9CaseDetail(admin, own.id)).case.pmChanges[0].status).toBe('pushed');
  expect(JSON.stringify((await v9OwnWork(joiner)).find(c => c.id === own.id))).not.toContain('pmChanges');
  const [nativeHistory] = await owner.db.execute<{ count: number }>(sql`select count(*)::int as count from lc_onboarding_private_revision where case_id=${own.id}::uuid and data->'lifecycleV9'->'documents'->0->>'id'=${own.documents[0].id}`);
  expect(nativeHistory.count).toBeGreaterThan(0);
  expect((await v9Workspace(admin)).templateUsage?.find(row => row.templateId === 'native-self-form' && row.version === 1)).toEqual({ templateId: 'native-self-form', version: 1, documents: 1 });
  const removeNativeWorkflow = (await v9Workspace(admin)).config!; removeNativeWorkflow.workflows = [];
  await expect(v9SaveConfig(admin, removeNativeWorkflow.revision, removeNativeWorkflow)).rejects.toThrow('already run');

  await expect(v9OwnDocument(joiner, input)).rejects.toMatchObject({ cause: { message: expect.stringContaining('changed') } });
  // Independently drift the broader row as storage owner; private custody must still refuse redirection.
  const [differentSubject] = await owner.db.execute<{ id: string }>(sql`select id from employment where tenant_id=${base.tenantId}::uuid and person_id=${other.personId}::uuid`);
  expect(detail.case.mails.map(mail => mail.subject).sort()).toEqual(['Native form completed','Native recorded docSigned','Native recorded taskDone']);
  await owner.db.execute(sql`update lc_onboarding_case set employment_id=${differentSubject.id}::uuid,data=data||jsonb_build_object('employmentId',${differentSubject.id}::text,'personId',${other.personId}::text) where id=${own.id}::uuid`);
  expect((await v9OwnWork(other)).some(c => c.id === own.id)).toBe(false);
  await expect(v9OwnDocument(other, { ...input, revision: done.revision })).rejects.toMatchObject({ cause: { message: expect.stringContaining('not available') } });
  await expect(v9CaseDetail(admin, own.id)).rejects.toThrow('private document subject');
});

it('does not enroll historical native cases in V9 automation until HR adopts their definitions', async () => {
  await owner.db.execute(sql`delete from lc_v9_config where tenant_id=${base.tenantId}::uuid`);
  await saveEmployeeDraft(admin, { currentStep: 1, data: { profile: { fullName: 'Fictional historical native joiner', primaryEmail: 'legacy-native@test.invalid' }, employment: { companyId: base.companyId, reportingManagerEmploymentId: employmentId, departmentId: base.deptA, positionId: base.positionId, hiredOn: todayInKualaLumpur() } } });
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

it('stores native attachments against their real parent, resumes file waits and rejects cross-company references', async () => {
  const config = (await v9Workspace(admin)).config!;
  config.templates.push({ id: 'native-proof-attachment', name: 'Fictional proof summary', module: 'onb', type: 'Attachment', rules: {}, hrStep: 'none', employeeAck: false, retired: false, versions: [{ version: 1, state: 'published', at: '', by: '', blocks: [{ id: 'body', type: 'text', text: 'Evidence received for {employee.name}', section: '' }], fields: [] }] });
  config.workflows = [{ id: 'native-proof-wait', name: 'Wait for native proof', module: 'onb', status: 'published', trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'wait', type: 'waitFile', slot: 'native-proof', label: 'Fictional evidence' }, { id: 'document', type: 'doc', template: 'native-proof-attachment', release: false }], description: '' }];
  await v9SaveConfig(admin, config.revision, config);
  await saveEmployeeDraft(admin, { currentStep: 1, data: { profile: { fullName: 'Fictional native files', primaryEmail: 'native-files@test.invalid' }, employment: { companyId: base.companyId, reportingManagerEmploymentId: employmentId, departmentId: base.deptA, positionId: base.positionId, hiredOn: todayInKualaLumpur() } } });
  const [pending] = await onboardingList(admin);
  await onboardingCommand(admin, pending.case.id, pending.revision, { type: 'saveSubmit', patch: { hiring: 'new_hire', local: { supervisor: employmentId } } });
  const before = (await v9CaseDetail(admin, pending.case.id)).case; expect(before.runs[0].status).toBe('waiting');
  const content = Buffer.from('Fictional native attachment evidence.');
  const input = { caseId: before.id, revision: before.revision, slot: 'native-proof', name: 'fictional-evidence.txt', content };
  const fileId = await v9UploadFile(admin, input); expect(await v9UploadFile(admin, input)).toBe(fileId);
  const after = (await v9CaseDetail(admin, before.id)).case;
  expect(after.files).toHaveLength(1); expect(after.runs[0].status).toBe('done'); expect(after.documents[0].templateType).toBe('Attachment');
  const [storage] = await owner.db.execute<{ case_id: string | null; onboarding_case_id: string }>(sql`select case_id,onboarding_case_id from lc_v9_file where id=${fileId}::uuid`);
  expect(storage).toEqual({ case_id: null, onboarding_case_id: before.id });
  expect((await v9DownloadFile(admin, before.id, fileId)).content.equals(content)).toBe(true);
  await expect(v9DownloadFile(other, before.id, fileId)).rejects.toThrow();
  await expect(v9UploadFile(admin, { ...input, revision: after.revision, name: 'spoof.pdf' })).rejects.toThrow('contents');
  const foreign = await seedBase();
  await expect(owner.db.execute(sql`insert into lc_v9_file(tenant_id,onboarding_case_id,company_id,slot,filename,mime_type,content,uploaded_by) values(${base.tenantId}::uuid,${before.id}::uuid,${foreign.companyId}::uuid,'native-proof','wrong-company.txt','text/plain',decode('ZmljdGlvbmFs','base64'),${admin.userId}::uuid)`)).rejects.toMatchObject({ cause: { message: expect.stringContaining('does not belong') } });
});

async function queuedDelivery(withFile = false) {
  const c = await prepared(), workspace = await v9Workspace(admin), config = workspace.config!;
  config.emails.push({ id: 'receipt-fixture', name: 'Fictional receipt fixture', module: 'off', active: true, sender: 'hr', subject: 'Fictional saved message', body: 'Your recorded handover form.', cc: [], links: ['fixture-form'], attachments: [], slots: withFile ? [{ id: 'proof', label: 'Fictional proof', required: true }] : [] });
  await v9SaveConfig(admin, config.revision, config);
  if (withFile) await v9UploadFile(admin, { caseId: c.id, revision: c.revision, slot: 'receipt-fixture:proof', name: 'fictional-proof.txt', content: Buffer.from('Fictional attachment bytes') });
  const revision = (await v9CaseDetail(admin, c.id)).case.revision;
  await v9Command(admin, c.id, revision, { type: 'emailSend', emailId: 'receipt-fixture' });
  const [job] = await owner.db.execute<{ id: string; payload: { mail: { id: string; subject: string }; documents: { id: string }[] } }>(sql`select id,payload from lc_v9_email_delivery where case_id=${c.id}::uuid`);
  expect(job).toBeDefined(); return { caseId: c.id, job, system: { ...admin, userId: undefined, personId: null } };
}
it('captures one immutable private outbox snapshot and rejects direct application reads and writes', async () => {
  const { caseId, job } = await queuedDelivery();
  expect(job.payload.mail.subject).toBe('Fictional saved message'); expect(job.payload.documents.map(document => document.id)).toHaveLength(1);
  await expect(withTenant(admin, tx => tx.execute(sql`select payload from lc_v9_email_delivery`))).rejects.toThrow();
  await expect(withTenant(admin, tx => tx.execute(sql`update lc_v9_email_delivery set status='sent' where id=${job.id}::uuid`))).rejects.toThrow();
  await expect(owner.db.execute(sql`update lc_v9_email_delivery set payload='{}'::jsonb where id=${job.id}::uuid`)).rejects.toMatchObject({ cause: { message: 'A queued lifecycle delivery is immutable' } });
  const config = (await v9Workspace(admin)).config!; config.emails.find(email => email.id === 'receipt-fixture')!.body = 'Changed future template'; await v9SaveConfig(admin, config.revision, config);
  const [snapshot] = await owner.db.execute<{ count: number; body: string }>(sql`select count(*)::int as count,min(payload->'mail'->>'body') as body from lc_v9_email_delivery where case_id=${caseId}::uuid`);
  expect(snapshot).toEqual({ count: 1, body: 'Your recorded handover form.' });
});
it('does not mark a message sent merely because the IPC caller returns success', async () => {
  const { caseId, system } = await queuedDelivery();
  await expect(v9DeliverEmails(system, { withTenant }, async () => ({ outcome: 'sent', error: null }))).rejects.toThrow('storage owner');
  const output = await v9DeliverEmails(system, owner, async request => {
    expect(Object.keys(request).sort()).toEqual(['deliveryId','leaseToken']);
    return { outcome: 'sent', error: null };
  });
  expect(output).toEqual({ attempted: 1, sent: 0, held: 0, failed: 1 });
  expect((await v9CaseDetail(admin, caseId)).case.mails[0]).toMatchObject({ status: 'failed', deliveredAt: null, failure: 'notEligible' });
});
it('holds a lost acknowledgement after the committed start and never automatically resends it', async () => {
  const { caseId, system } = await queuedDelivery(); let attempts = 0;
  const output = await v9DeliverEmails(system, owner, async request => {
    attempts++;
    await owner.db.execute(sql`update lc_v9_email_delivery set status='sending',started_at=now() where id=${request.deliveryId}::uuid and lease_token=${request.leaseToken}::uuid`);
    throw new Error('Controlled acknowledgement loss');
  });
  expect(output).toEqual({ attempted: 1, sent: 0, held: 1, failed: 0 });
  expect((await v9CaseDetail(admin, caseId)).case.mails[0]).toMatchObject({ status: 'uncertain', deliveredAt: null, failure: 'uncertain' });
  expect(await v9DeliverEmails(system, owner, async () => { attempts++; throw new Error('Unexpected resend'); })).toEqual({ attempted: 0, sent: 0, held: 0, failed: 0 });
  expect(attempts).toBe(1);
});
it('records an actual late SMTP receipt while preserving a cancelled case', async () => {
  const { caseId, system } = await queuedDelivery();
  const output = await v9DeliverEmails(system, owner, async request => {
    await owner.db.execute(sql`update lc_v9_email_delivery set status='sending',started_at=now() where id=${request.deliveryId}::uuid and lease_token=${request.leaseToken}::uuid`);
    const c = (await v9CaseDetail(admin, caseId)).case;
    await v9Command(admin, caseId, c.revision, { type: 'cancel', reason: 'Fictional cancellation after SMTP start' });
    const [receipt] = await owner.db.execute<{ finished: boolean }>(sql`select app.lc_v9_email_finish(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'sent',null) as finished`);
    expect(receipt.finished).toBe(true); return { outcome: 'sent', error: null };
  });
  expect(output).toEqual({ attempted: 1, sent: 1, held: 0, failed: 0 });
  const c = (await v9CaseDetail(admin, caseId)).case;
  expect(c.state).toBe('cancelled'); expect(c.mails[0].status).toBe('sent'); expect(c.finalFigures).toBeNull();
});
it('binds the private capability to its current subject, exact identity, saved documents and real file bytes', async () => {
  const { caseId, system } = await queuedDelivery(true), origin = 'https://v9-capability.example', subject = randomUUID(); let verified = false, verificationError: unknown;
  await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${origin + '/auth/' + base.tenantId},${subject},${employee.userId!}::uuid)`;
  await v9DeliverEmails(system, owner, async request => {
    const read = async (token = request.leaseToken, installation = origin) => (await owner.client`select app.lc_v9_email_target(${request.deliveryId}::uuid,${token}::uuid,${installation}) as target`)[0].target;
    try {
    const target = await read();
    expect(target).toMatchObject({ tenantId: base.tenantId, companyId: base.companyId, caseId, bindings: [{ userId: employee.userId, subject, issuer: origin + '/auth/' + base.tenantId }] });
    expect(await read(randomUUID())).toBeNull(); expect(await read(request.leaseToken, 'https://other.example')).toBeNull();
    const files = await owner.client`select * from app.lc_v9_email_files(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${origin})`;
    expect(files).toHaveLength(1); expect(files[0].filename).toBe('fictional-proof.txt'); expect(Buffer.from(files[0].bytes,'base64').toString()).toBe('Fictional attachment bytes');
    await owner.client`update app_external_identity set revoked_at=now() where issuer=${origin + '/auth/' + base.tenantId} and subject=${subject}`;
    expect(await read()).toBeNull();
    await owner.client`update app_external_identity set revoked_at=null where issuer=${origin + '/auth/' + base.tenantId} and subject=${subject}`;
    expect(await read()).not.toBeNull();
    await owner.client`update lc_v9_case set data=jsonb_set(data,'{documents,0,name}','"Changed after queue"'::jsonb) where id=${caseId}::uuid`;
    expect(await read()).toBeNull();
    verified = true; return { outcome: 'skipped', error: 'notEligible' };
    } catch (error) { verificationError = error; throw error; }
  });
  if (verificationError) throw verificationError;
  expect(verified).toBe(true);
});
it('verifies explicit mailbox destinations and their exact database start proof without linking accounts', async () => {
  const config = (await v9Workspace(admin)).config!;
  config.workflows = [{ id: 'literal-intent', name: 'Fictional literal intent', module: 'off', status: 'published', trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'notice', type: 'notify', subject: 'Fictional mailbox notice', body: 'Fictional test intent', to: ['address:subject@test.invalid'], cc: ['address:archive@fictional.invalid'] }], description: '' }];
  await v9SaveConfig(admin, config.revision, config);
  const [{ count: usersBefore }] = await owner.client`select count(*)::integer as count from app_user where tenant_id=${base.tenantId}::uuid`;
  const id = await v9CreateOffboarding(admin, { employmentId, type: 'Resignation', noticeDate: todayInKualaLumpur(), lastDay: addDays(todayInKualaLumpur(),30) });
  await v9Command(admin, id, 1, { type: 'submit' });
  let checked = false, failure: unknown;
  const output = await v9DeliverEmails({ ...admin, userId: undefined, personId: null }, owner, async request => {
    try {
      const origin = 'https://literal-capability.example';
      const [{ target }] = await owner.client`select app.lc_v9_email_target(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${origin}) as target`;
      expect(target).toMatchObject({ bindings: [], contact: null, literals: [{ key: 'address:subject@test.invalid', email: 'subject@test.invalid', position: 1 }, { key: 'address:archive@fictional.invalid', email: 'archive@fictional.invalid', position: 2 }] });
      const proof = { bindings: [], contact: null, literals: target.literals, addresses: ['subject@test.invalid','changed@fictional.invalid'], relayRevision: 'controlled-database-proof' };
      const start = async () => (await owner.client`select app.lc_v9_email_start(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${origin},${JSON.stringify(proof)}::jsonb) as started`)[0].started;
      expect(await start()).toBe(false);
      proof.addresses[1] = 'archive@fictional.invalid'; expect(await start()).toBe(true);
      const [{ finished }] = await owner.client`select app.lc_v9_email_finish(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'failed','smtpRejected') as finished`;
      expect(finished).toBe(true); checked = true;
      return { outcome: 'failed', error: 'smtpRejected' };
    } catch (error) { failure = error; throw error; }
  });
  if (failure) throw failure;
  expect(checked).toBe(true); expect(output).toEqual({ attempted: 1, sent: 0, held: 0, failed: 1 });
  const [{ count: usersAfter }] = await owner.client`select count(*)::integer as count from app_user where tenant_id=${base.tenantId}::uuid`;
  expect(usersAfter).toBe(usersBefore);
  const c = (await v9CaseDetail(admin, id)).case;
  expect(c.mails[0]).toMatchObject({ to: ['address:subject@test.invalid'], cc: ['address:archive@fictional.invalid'], status: 'failed' });
});

it('authorizes a real prehire contact without an app account and refuses an address changed after queue', async () => {
  const config = (await v9Workspace(admin)).config!;
  config.workflows = []; config.checklists = [{ id: 'contact-onb', name: 'Contact fixture', module: 'onb', rules: {}, tasks: [] }];
  config.emails = [{ id: 'contact-welcome', name: 'Fictional contact welcome', module: 'onb', active: true, sender: 'onboarding', subject: 'Welcome {employee.name}', body: 'Before your first day.', cc: [], links: [], attachments: [], slots: [] }];
  await v9SaveConfig(admin, config.revision, config);
  await saveEmployeeDraft(admin, { data: { profile: { fullName: 'Fictional prehire contact', primaryEmail: 'prehire-contact@fictional.invalid' }, employment: { companyId: base.companyId, reportingManagerEmploymentId: employmentId, departmentId: base.deptA, positionId: base.positionId, hiredOn: addDays(todayInKualaLumpur(), 10) } }, currentStep: 1 });
  let [native] = await onboardingList(admin);
  await onboardingCommand(admin, native.case.id, native.revision, { type: 'save', patch: { hiring: 'new_hire', local: { supervisor: employmentId } } });
  [native] = await onboardingList(admin); await onboardingCommand(admin, native.case.id, native.revision, { type: 'submit' });
  const c = (await v9CaseDetail(admin, native.case.id)).case;
  expect(c.facts.employeeUserId).toBeNull(); expect(c.facts.personId).toBe('');
  expect((await v9PreviewEmail(admin, c.id, 'contact-welcome')).canSend).toBe(true);
  await v9Command(admin, c.id, c.revision, { type: 'emailSend', emailId: 'contact-welcome' });
  expect((await v9Workspace(admin)).definitionUsage?.find(row => row.kind === 'email' && row.definitionId === 'contact-welcome')).toEqual({ kind: 'email', definitionId: 'contact-welcome', messages: 1, runs: 0 });
  let verified = false;
  const output = await v9DeliverEmails({ ...admin, userId: undefined, personId: null }, owner, async request => {
    const read = async () => (await owner.client`select app.lc_v9_email_target(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'https://prehire.example') as target`)[0].target;
    expect(await read()).toMatchObject({ caseId: c.id, bindings: [], contact: { kind: 'onboardingContact', email: 'prehire-contact@fictional.invalid', caseId: c.id } });
    await owner.client`update lc_onboarding_case set data=jsonb_set(data,'{source,email}','"changed-contact@fictional.invalid"'::jsonb) where id=${c.id}::uuid`;
    expect(await read()).toBeNull(); verified = true;
    return { outcome: 'skipped', error: 'recipientChanged' };
  });
  expect(verified).toBe(true); expect(output).toEqual({ attempted: 1, sent: 0, held: 0, failed: 1 });
  expect((await v9CaseDetail(admin, c.id)).case.mails[0]).toMatchObject({ status: 'failed', failure: 'recipientChanged', to: ['prehire-contact@fictional.invalid'] });
});
it('records sent truth without releasing a different document copy changed during SMTP', async () => {
  const { caseId, system } = await queuedDelivery();
  const output = await v9DeliverEmails(system, owner, async request => {
    await owner.client`update lc_v9_email_delivery set status='sending',started_at=now() where id=${request.deliveryId}::uuid and lease_token=${request.leaseToken}::uuid`;
    // Controlled owner-only fault injection represents another writer changing the current copy.
    await owner.client`update lc_v9_case set data=jsonb_set(jsonb_set(jsonb_set(data,'{documents,0,name}','"Different current copy"'::jsonb),'{documents,0,status}','"draft"'::jsonb),'{documents,0,sentAt}','null'::jsonb) where id=${caseId}::uuid`;
    await owner.client`select app.lc_v9_email_finish(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'sent',null)`;
    return { outcome: 'sent', error: null };
  });
  expect(output).toEqual({ attempted: 1, sent: 1, held: 0, failed: 0 });
  const c = (await v9CaseDetail(admin, caseId)).case;
  expect(c.mails[0].status).toBe('sent'); expect(c.documents[0]).toMatchObject({ name: 'Different current copy', status: 'draft', sentAt: null });
  expect(c.log.at(-1)?.action).toBe('email.documentChanged');
});
it('guards version deletion using deduplicated current and historical instances', async () => {
  const c = await prepared(), config = (await v9Workspace(admin)).config!, template = config.templates.find(template => template.id === 'fixture-form')!;
  template.versions.push({ ...structuredClone(template.versions[0]), version: 2 }); template.currentVersion = 2;
  await v9SaveConfig(admin, config.revision, config);
  // A real service command preserves the prior document instance before an owner-only loss injection.
  await v9Command(admin, c.id, c.revision, { type: 'runWorkflows' });
  await owner.client`update lc_v9_case set data=jsonb_set(data,'{documents}','[]'::jsonb) where id=${c.id}::uuid`;
  const workspace = await v9Workspace(admin);
  expect(workspace.templateUsage?.find(row => row.templateId === template.id && row.version === 1)).toEqual({ templateId: template.id, version: 1, documents: 1 });
  const removeUsed = structuredClone(workspace.config!); removeUsed.templates.find(row => row.id === template.id)!.versions = [structuredClone(template.versions[1])];
  await expect(v9SaveConfig(admin, removeUsed.revision, removeUsed)).rejects.toThrow('history');
  const unused = structuredClone(workspace.config!), definition = unused.templates.find(row => row.id === template.id)!;
  definition.versions.push({ ...structuredClone(definition.versions[0]), version: 3 });
  await v9SaveConfig(admin, unused.revision, unused);
  const removeUnused = (await v9Workspace(admin)).config!; removeUnused.templates.find(row => row.id === template.id)!.versions = removeUnused.templates.find(row => row.id === template.id)!.versions.filter(version => version.version !== 3);
  await expect(v9SaveConfig(admin, removeUnused.revision, removeUnused)).resolves.toMatchObject({ revision: removeUnused.revision + 1 });
  await expect(withTenant(employee, tx => tx.execute(sql`select * from app.lc_v9_document_usage()`))).rejects.toThrow();
  await expect(withTenant(admin, tx => tx.execute(sql`select * from app.lc_v9_usage_instances()`))).rejects.toThrow();
});
let assetPng: Buffer;
it('keeps shared email bytes private and immutable and validates the actual upload receipt', async () => {
  const config = (await v9Workspace(admin)).config!, content = Buffer.from('Fictional shared handbook');
  const input = { revision: config.revision, emailId: 'e1', kind: 'file' as const, name: 'Fictional handbook.txt', content };
  const asset = await v9UploadEmailAsset(admin,input); expect(asset).toMatchObject({ kind: 'file', name: input.name, size: content.length });
  expect(await v9UploadEmailAsset(admin,input)).toEqual(asset);
  expect((await v9DownloadEmailAsset(admin,asset.id)).content).toEqual(content);
  await expect(v9UploadEmailAsset(employee,input)).rejects.toThrow('permission');
  await expect(v9DownloadEmailAsset(employee,asset.id)).rejects.toThrow('not found');
  await expect(withTenant(admin,tx=>tx.execute(sql`update lc_v9_email_asset set content='tampered' where id=${asset.id}::uuid`))).rejects.toThrow();
  const tampered = structuredClone(config); tampered.emails.find(email=>email.id==='e1')!.files = [{ ...asset, size: 1 }];
  await expect(v9SaveConfig(admin,config.revision,tampered)).rejects.toThrow('receipt');
  const wrongParent = structuredClone(config); wrongParent.emails.find(email=>email.id==='e2')!.files = [asset];
  await expect(v9SaveConfig(admin,config.revision,wrongParent)).rejects.toThrow('receipt');
  config.emails.find(email=>email.id==='e1')!.files = [asset]; await v9SaveConfig(admin,config.revision,config);
  expect((await v9Workspace(admin)).config!.emails.find(email=>email.id==='e1')!.files).toEqual([asset]);
});
it('accepts only supported bounded email images through the existing raster validator', async () => {
  const config = (await v9Workspace(admin)).config!, input = { revision: config.revision, emailId: 'e1', kind: 'image' as const, name: 'Fictional logo.png', content: assetPng };
  const image = await v9UploadEmailAsset(admin,input); expect(image).toMatchObject({ kind: 'image', mimeType: 'image/png', size: assetPng.length });
  expect((await v9DownloadEmailAsset(admin,image.id)).content).toEqual(assetPng);
  await expect(v9UploadEmailAsset(admin,{...input, content: Buffer.alloc(1048577)})).rejects.toThrow('1 MB');
  await expect(v9UploadEmailAsset(admin,{...input, name: 'script.svg', content: Buffer.from('<svg/>')})).rejects.toThrow();
  await expect(v9UploadEmailAsset(admin,{...input, content: Buffer.from('Not an image')})).rejects.toThrow('contents');
});
it('retains the queued shared files and inline images after the future definition is changed', async () => {
  const c = await prepared(), config = (await v9Workspace(admin)).config!;
  config.emails.push({ id: 'asset-message', name: 'Fictional shared asset message', module: 'off', active: true, sender: 'hr', subject: 'Fictional assets', body: 'Saved body', cc: [], links: [], attachments: [], slots: [] });
  const saved = await v9SaveConfig(admin,config.revision,config);
  const file = await v9UploadEmailAsset(admin,{ revision: saved.revision, emailId: 'asset-message', kind: 'file', name: 'Fictional handbook.txt', content: Buffer.from('Fictional handbook bytes') });
  const image = await v9UploadEmailAsset(admin,{ revision: saved.revision, emailId: 'asset-message', kind: 'image', name: 'Fictional logo.png', content: assetPng });
  const linked = (await v9Workspace(admin)).config!, email = linked.emails.find(email=>email.id==='asset-message')!;
  email.files = [file]; email.images = [image]; email.body = `Saved body\n{image:${image.id}}`; await v9SaveConfig(admin,linked.revision,linked);
  await v9Command(admin,c.id,c.revision,{ type: 'emailSend', emailId: email.id });
  const future = (await v9Workspace(admin)).config!, nextEmail = future.emails.find(email=>email.id==='asset-message')!;
  nextEmail.files = []; nextEmail.images = []; nextEmail.body = 'Future message'; await v9SaveConfig(admin,future.revision,future);
  const origin = 'https://asset-packet.example', subject = randomUUID();
  await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${origin + '/auth/' + base.tenantId},${subject},${employee.userId!}::uuid)`;
  let verified = false, verificationError: unknown;
  await v9DeliverEmails({ ...admin, userId: undefined, personId: null },owner,async request=>{
    try {
      const [target] = await owner.client`select app.lc_v9_email_target(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${origin}) as target`;
      expect(target.target.payload.mail).toMatchObject({ body: `Saved body\n{image:${image.id}}`, delivery: { assets: [file,image] } });
      const assets = await owner.client`select * from app.lc_v9_email_assets(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${origin})`;
      expect(assets).toHaveLength(2);
      expect(Buffer.from(assets.find(asset=>asset.kind==='file')!.bytes,'base64').toString()).toBe('Fictional handbook bytes');
      expect(Buffer.from(assets.find(asset=>asset.kind==='image')!.bytes,'base64')).toEqual(assetPng);
      verified = true; return { outcome: 'skipped', error: 'notEligible' };
    } catch (error) { verificationError = error; throw error; }
  });
  if (verificationError) throw verificationError; expect(verified).toBe(true);
});
it('does not link or disclose a shared email asset from another tenant', async () => {
  const foreignBase = await seedBase(); await setModule(foreignBase.tenantId,'lifecycle','active'); const foreignAdmin = await entitledCtx(foreignBase); await v9Setup(foreignAdmin);
  const foreignConfig = (await v9Workspace(foreignAdmin)).config!;
  const asset = await v9UploadEmailAsset(foreignAdmin,{ revision: foreignConfig.revision, emailId: 'e1', kind: 'file', name: 'Foreign fictional handbook.txt', content: Buffer.from('Foreign fictional content') });
  await expect(v9DownloadEmailAsset(admin,asset.id)).rejects.toThrow('not found');
  expect(await withTenant(admin,tx=>tx.execute(sql`select id from lc_v9_email_asset where id=${asset.id}::uuid`))).toEqual([]);
  const localConfig = (await v9Workspace(admin)).config!; localConfig.emails.find(email=>email.id==='e1')!.files = [asset];
  await expect(v9SaveConfig(admin,localConfig.revision,localConfig)).rejects.toThrow('receipt');
});
it('supports the source CSV, GIF and WebP file formats with actual byte validation', async () => {
  const config = (await v9Workspace(admin)).config!, revision = config.revision;
  const sharp = (await import('sharp')).default, webp = await sharp(assetPng).webp().toBuffer(), gif = await sharp(assetPng).gif().toBuffer();
  for (const file of [{ name: 'Fictional.csv', content: Buffer.from('Name,Status\nFictional,Ready'), mime: 'text/csv' }, { name: 'Fictional.gif', content: gif, mime: 'image/gif' }, { name: 'Fictional.webp', content: webp, mime: 'image/webp' }]) {
    const asset = await v9UploadEmailAsset(admin,{ revision, emailId: 'e1', kind: 'file', name: file.name, content: file.content });
    expect(asset.mimeType).toBe(file.mime); expect((await v9DownloadEmailAsset(admin,asset.id)).content).toEqual(file.content);
  }
  await expect(v9UploadEmailAsset(admin,{ revision, emailId: 'e1', kind: 'file', name: 'Fake.gif', content: assetPng })).rejects.toThrow('contents');
  await expect(v9UploadEmailAsset(admin,{ revision, emailId: 'e1', kind: 'file', name: 'Binary.csv', content: Buffer.from([0,1,2]) })).rejects.toThrow('contents');
});
it('keeps the person-specific attachment frozen while its queued delivery is pending', async () => {
  const { caseId }=await queuedDelivery(true),before=(await v9CaseDetail(admin,caseId)).case;
  await expect(v9UploadFile(admin,{caseId,revision:before.revision,slot:'receipt-fixture:proof',name:'Fictional replacement.txt',content:Buffer.from('Changed after queue')})).rejects.toThrow('reserved');
  const after=(await v9CaseDetail(admin,caseId)).case;expect(after.revision).toBe(before.revision);expect(after.files).toEqual(before.files);
});

it('persists turning off an email referenced by an unchanged live workflow', async () => {
  const before = (await v9Workspace(admin)).config!, next = structuredClone(before);
  const workflow = next.workflows.find(workflow => workflow.status === 'published' && workflow.steps.some(step => step.type === 'email'))!;
  const step = workflow.steps.find(step => step.type === 'email')!;
  if (step.type !== 'email') throw Error('Expected email step');
  next.emails.find(email => email.id === step.template)!.active = false;
  await v9SaveConfig(admin, before.revision, next);
  const saved = (await v9Workspace(admin)).config!;
  expect(saved.emails.find(email => email.id === step.template)?.active).toBe(false);
  expect(saved.workflows.find(candidate => candidate.id === workflow.id)).toEqual(workflow);
  saved.workflows.find(candidate => candidate.id === workflow.id)!.name += ' changed';
  await expect(v9SaveConfig(admin, saved.revision, saved)).rejects.toThrow('active email');
});
it('deletes unused whole definitions but retains canonical historical delivery evidence', async () => {
  let config = (await v9Workspace(admin)).config!;
  config.emails.push({ id:'unused-email',name:'Unused fictional email',module:'off',active:false,sender:'hr',subject:'',body:'',cc:[],links:[],attachments:[],slots:[] });
  config.templates.push({ id:'unused-template',name:'Unused fictional template',module:'off',type:'Form',rules:{},hrStep:'none',employeeAck:false,retired:false,versions:[{version:1,state:'draft',at:'',by:'',blocks:[],fields:[]}] });
  await v9SaveConfig(admin,config.revision,config);
  config=(await v9Workspace(admin)).config!;config.emails=config.emails.filter(email=>email.id!=='unused-email');config.templates=config.templates.filter(template=>template.id!=='unused-template');
  await v9SaveConfig(admin,config.revision,config);
  expect((await v9Workspace(admin)).config!.emails.some(email=>email.id==='unused-email')).toBe(false);
  const {caseId}=await queuedDelivery();const c=(await v9CaseDetail(admin,caseId)).case;
  await v9Command(admin,caseId,c.revision,{type:'runWorkflows'});
  await owner.client`update lc_v9_case set data=jsonb_set(data,'{mails}','[]'::jsonb) where id=${caseId}::uuid`;
  const workspace=await v9Workspace(admin);
  expect(workspace.definitionUsage?.find(row=>row.kind==='email'&&row.definitionId==='receipt-fixture')).toEqual({kind:'email',definitionId:'receipt-fixture',messages:1,runs:0});
  config=workspace.config!;config.emails=config.emails.filter(email=>email.id!=='receipt-fixture');
  await expect(v9SaveConfig(admin,config.revision,config)).rejects.toThrow('Turn it off');
  await expect(withTenant(employee,tx=>tx.execute(sql`select * from app.lc_v9_definition_usage()`))).rejects.toThrow();
  const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');const foreignAdmin=await entitledCtx(foreign);await v9Setup(foreignAdmin);
  expect((await v9Workspace(foreignAdmin)).definitionUsage).toEqual([]);
});
it('protects an email referenced by a frozen waiting run even before any message is queued', async () => {
  const c=await prepared();let config=(await v9Workspace(admin)).config!;
  config.emails.push({id:'waiting-email',name:'Waiting fictional email',module:'off',active:true,sender:'hr',subject:'Fictional',body:'Fictional',cc:[],links:[],attachments:[],slots:[]});
  config.workflows.push({id:'frozen-mail',name:'Fictional frozen reference',module:'off',status:'published',trigger:{event:'beforeLWD',days:30,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'file',type:'waitFile',slot:'frozen-proof',label:'Fictional proof'},{id:'mail',type:'email',template:'waiting-email',to:'employee',cc:[]}],description:''});
  await v9SaveConfig(admin,config.revision,config);await v9Command(admin,c.id,c.revision,{type:'runWorkflows'});
  const workspace=await v9Workspace(admin);
  expect(workspace.definitionUsage?.find(row=>row.kind==='email'&&row.definitionId==='waiting-email')).toEqual({kind:'email',definitionId:'waiting-email',messages:0,runs:1});
  config=workspace.config!;const changed=config.workflows.find(workflow=>workflow.id==='frozen-mail')!;changed.status='draft';changed.steps=[];
  config.emails=config.emails.filter(email=>email.id!=='waiting-email');
  await expect(v9SaveConfig(admin,config.revision,config)).rejects.toThrow('workflow history');
});
it('saves per-person text through the case owner, retains it in PDF content and denies employees', async () => {
  const released=await prepared(),config=(await v9Workspace(admin)).config!;
  await expect(v9Command(admin,released.id,released.revision,{type:'documentTextEdit',id:released.documents[0].id,edits:{body:'Released copy'}})).rejects.toThrow('unsigned');
  config.templates.push({...structuredClone(config.templates.find(template=>template.id==='fixture-form')!),id:'draft-text',name:'Fictional draft text'});await v9SaveConfig(admin,config.revision,config);
  await v9Command(admin,released.id,released.revision,{type:'generate',template:'draft-text'});
  const c=(await v9CaseDetail(admin,released.id)).case,doc=c.documents.find(document=>document.templateId==='draft-text')!;
  const edits={body:'Fictional case-specific wording for {employee.name}'};
  await v9Command(admin,c.id,c.revision,{type:'documentTextEdit',id:doc.id,edits});
  const after=(await v9CaseDetail(admin,c.id)).case;
  expect(after.documents.find(document=>document.id===doc.id)!.edits).toEqual(edits);expect((await v9Workspace(admin)).config!.templates.find(template=>template.id===doc.templateId)!.versions[0].blocks[0].text).toBe('Contact update for {employee.name}');
  const {v9PdfDocument}=await import('../lib/lifecycle-v9-pdf');expect(JSON.stringify(v9PdfDocument(after.documents.find(document=>document.id===doc.id)!,false))).toContain('Fictional case-specific wording for V9 subject');
  const pdf=await v9DownloadDocument(admin,c.id,doc.id);expect(Buffer.from(pdf.content).subarray(0,5).toString()).toBe('%PDF-');
  await expect(v9Command(employee,c.id,after.revision,{type:'documentTextEdit',id:doc.id,edits:{body:'Unauthorized'}})).rejects.toThrow();
  await expect(v9Command(admin,c.id,c.revision,{type:'documentTextEdit',id:doc.id,edits:{body:'Stale'}})).rejects.toThrow('changed');
  await v9Command(admin,c.id,after.revision,{type:'documentTextEdit',id:doc.id,edits:{}});expect((await v9CaseDetail(admin,c.id)).case.documents.find(document=>document.id===doc.id)!.edits).toEqual({});
});
it('fires the HR-signature workflow from an actual sign command and starts a manual workflow only through HR scope',async()=>{
  const before=await prepared(),config=(await v9Workspace(admin)).config!;
  config.companies=[{companyId:base.companyId,signatoryUserId:admin.userId!,signatoryTitle:'Fictional HR'}];
  config.templates.push({id:'event-letter',name:'Fictional event letter',module:'off',type:'Letter',rules:{},hrStep:'before',employeeAck:true,retired:false,versions:[{version:1,state:'published',at:'',by:'',blocks:[{id:'body',type:'text',text:'Fictional letter',section:''}],fields:[]}]});
  for(const event of ['hrSigned','manual'] as const)config.workflows.push({id:'event-'+event,name:'Fictional '+event,module:'off',status:'published',trigger:{event,days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'notify',type:'notify',to:event==='manual'?'starter':'employee',cc:event==='manual'?['hrSignatory']:[],subject:'Fictional '+event,body:'Fictional event'}],description:''});
  await v9SaveConfig(admin,config.revision,config);await v9Command(admin,before.id,before.revision,{type:'generate',template:'event-letter'});
  let c=(await v9CaseDetail(admin,before.id)).case;expect(c.mails).toEqual([]);const doc=c.documents.find(document=>document.templateId==='event-letter')!;
  await v9Command(admin,c.id,c.revision,{type:'documentSign',id:doc.id,signature:{method:'typed',value:'Fictional HR',consent:true}});c=(await v9CaseDetail(admin,c.id)).case;
  expect(c.documents.find(document=>document.id===doc.id)?.status).toBe('hrsigned');expect(c.mails.map(mail=>mail.workflowId)).toEqual(['event-hrSigned']);expect(c.runs.find(run=>run.workflowId==='event-hrSigned')?.status).toBe('waiting');
  await expect(v9Command(employee,c.id,c.revision,{type:'startWorkflow',workflowId:'event-manual'})).rejects.toThrow();
  await v9Command(admin,c.id,c.revision,{type:'startWorkflow',workflowId:'event-manual'});c=(await v9CaseDetail(admin,c.id)).case;expect(c.mails.map(mail=>mail.workflowId)).toEqual(['event-hrSigned','event-manual']);expect(c.facts.starterUserId).toBe(admin.userId);expect(c.mails.find(mail=>mail.workflowId==='event-manual')).toMatchObject({to:[admin.userId],cc:[]});
  await v9Command(admin,c.id,c.revision,{type:'startWorkflow',workflowId:'event-manual'});c=(await v9CaseDetail(admin,c.id)).case;expect(c.mails).toHaveLength(2);
  const next=(await v9Workspace(admin)).config!;next.workflows.find(workflow=>workflow.id==='event-manual')!.status='draft';await v9SaveConfig(admin,next.revision,next);
  await expect(v9Command(admin,c.id,c.revision,{type:'startWorkflow',workflowId:'event-manual'})).rejects.toThrow('live workflow');
});

it('accepts tenant directory recipients and rejects foreign people and deleted recipient groups', async () => {
  const c = await prepared(); const config = (await v9Workspace(admin)).config!;
  config.groups.push({ id: 'review-recipient-group', name: 'Fictional reviewers', members: [admin.userId!, other.userId!], limit: 0 });
  config.workflows.push({ id: 'directory-review', name: 'Directory review', module: 'off', status: 'published', trigger: { event: 'manual', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'notice', type: 'notify', to: 'group:review-recipient-group', cc: [`person:${other.userId}`], subject: 'Directory review', body: 'Fictional' }], description: '' });
  await v9SaveConfig(admin, config.revision, config);
  const before = await v9CaseDetail(admin, c.id); await v9Command(admin, c.id, before.case.revision, { type: 'startWorkflow', workflowId: 'directory-review' });
  const mail = (await v9CaseDetail(admin, c.id)).case.mails.find(mail => mail.workflowId === 'directory-review');
  expect(mail).toMatchObject({ to: [admin.userId], cc: [other.userId], status: 'pending' });
  const invalid = (await v9Workspace(admin)).config!;
  const notice = invalid.workflows.find(workflow => workflow.id === 'directory-review')!.steps[0]; if (!('to' in notice)) throw new Error('Expected notification step');
  notice.cc = [`person:${randomUUID()}`]; await expect(v9SaveConfig(admin, invalid.revision, invalid)).rejects.toThrow('available person from this tenant');
  notice.cc = []; invalid.groups = invalid.groups.filter(group => group.id !== 'review-recipient-group'); await expect(v9SaveConfig(admin, invalid.revision, invalid)).rejects.toThrow('existing assignment group');
});

it('resumes offboarding waits before 08:00 without starting date workflows or clearance', async () => {
  const config = (await v9Workspace(admin)).config!;
  config.checklists = [...config.checklists.filter(checklist => checklist.module === 'onb'), { id: 'morning-checklist', name: 'Fictional morning checklist', module: 'off', rules: {}, tasks: [{ id: 'morning-task', name: 'Keep open', by: 'employee', group: null, mode: 'manual', opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'completed' }] }];
  config.workflows = [{ id: 'morning-wait', name: 'Morning wait', module: 'off', status: 'published', trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'wait', type: 'waitFile', slot: 'morning-slot', label: 'Fictional supporting file' }, { id: 'notice', type: 'notify', to: 'employee', cc: [], subject: 'Resumed before 08:00', body: '' }], description: '' }, { id: 'daily-date', name: 'Daily date', module: 'off', status: 'published', trigger: { event: 'beforeLWD', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'notice', type: 'notify', to: 'employee', cc: [], subject: 'Date work after 08:00', body: '' }], description: '' }];
  await v9SaveConfig(admin, config.revision, config);
  const lastDay = todayInKualaLumpur();
  const id = await v9CreateOffboarding(admin, { employmentId, type: 'Resignation', noticeDate: addDays(lastDay, -30), lastDay });
  // Isolate the minute-worker timing from the submission command's immediate date evaluation.
  const before = await v9CaseDetail(admin, id);
  await owner.db.execute(sql`update lc_v9_case set data=${JSON.stringify({ ...before.case, state: 'submitted', checklistId: 'morning-checklist', tasks: [{ id: 'morning-task', name: 'Keep open', status: 'todo', by: 'employee', required: true, dueOn: lastDay, assignee: employee.userId, reason: '', documentTemplate: null, documentAction: 'completed' }], files: [{ id: randomUUID(), slot: 'morning-slot', name: 'Fictional existing receipt', storageId: randomUUID() }], runs: [{ id: 'morning-wait:once', workflowId: 'morning-wait', revision: config.revision, date: lastDay, status: 'waiting', cursor: 0, reason: 'Upload Fictional supporting file.', at: lastDay + 'T00:00:00Z', definition: config.workflows[0] }] })}::jsonb where id=${id}::uuid`);
  const system = { ...admin, userId: undefined, personId: null }, morning = new Date(addDays(lastDay, -1) + 'T23:00:00Z');
  // 23:00 UTC is 07:00 Malaysia on the following day.
  expect(todayInKualaLumpur(morning)).toBe(lastDay);
  expect(await v9Sweep(system, owner, morning)).toEqual({ processed: 1, failed: 0 });
  const after = (await v9CaseDetail(admin, id)).case;
  expect(after.state).toBe('submitted'); expect(after.mails.map(mail => mail.subject)).toEqual(['Resumed before 08:00']);
  expect(after.runs.some(run => run.workflowId === 'daily-date')).toBe(false);
  expect(await v9Sweep(system, owner, morning)).toEqual({ processed: 0, failed: 0 });
});

it('captures a real employee task completion with its original workflow definition and no historical backfill', async () => {
  const c = await prepared(); const config = (await v9Workspace(admin)).config!;
  config.workflows.push({ id: 'task-event', name: 'Task event', module: 'off', status: 'published', trigger: { event: 'taskDone', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [{ field: 'caseType', op: 'is', value: 'Resignation' }], steps: [{ id: 'notice', type: 'notify', to: 'employee', cc: [], subject: 'Original completion definition', body: '' }], description: '' });
  await v9SaveConfig(admin, config.revision, config);
  await v9OwnTask(employee, { caseId: c.id, revision: c.revision, taskId: c.tasks[0].id, status: 'done', reason: '' });
  const captured = await v9CaseDetail(admin, c.id); expect(captured.case.mails).toEqual([]);
  expect(captured.case.runs.find(run => run.workflowId === 'task-event')).toMatchObject({ status: 'waiting', sourceEvent: { kind: 'taskDone', sourceId: c.tasks[0].id }, actor: { id: employee.userId } });
  const edited = (await v9Workspace(admin)).config!;
  const changed = edited.workflows.find(workflow => workflow.id === 'task-event')!.steps[0]; if (changed.type !== 'notify') throw Error('Expected notification'); changed.subject = 'Later definition';
  edited.workflows.push({ ...structuredClone(edited.workflows.find(workflow => workflow.id === 'task-event')!), id: 'later-task-event' });
  await v9SaveConfig(admin, edited.revision, edited);
  const system = { ...admin, userId: undefined, personId: null }, morning = new Date(addDays(todayInKualaLumpur(), -1) + 'T23:00:00Z');
  expect(await v9Sweep(system, owner, morning)).toEqual({ processed: 1, failed: 0 });
  const resumed = (await v9CaseDetail(admin, c.id)).case;
  expect(resumed.mails.map(mail => mail.subject)).toEqual(['Original completion definition']);
  expect(resumed.runs.some(run => run.workflowId === 'later-task-event')).toBe(false);
  expect(await v9Sweep(system, owner, morning)).toEqual({ processed: 0, failed: 0 });
  await expect(withTenant(employee, tx => tx.execute(sql`select app.lc_v9_capture_source_runs(${base.tenantId}::uuid,'off','{}','{}','{}',1)`))).rejects.toMatchObject({ cause: { message: expect.stringContaining('permission denied') } });
});

it('captures actual saved employee signatures and private file receipts as distinct source events', async () => {
  const c = await prepared(), config = (await v9Workspace(admin)).config!;
  for (const event of ['docSigned', 'fileUploaded'] as const) config.workflows.push({ id: event, name: event, module: 'off', status: 'published', trigger: { event, days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'notice', type: 'notify', to: 'employee', cc: [], subject: 'Actual ' + event, body: '' }], description: '' });
  await v9SaveConfig(admin, config.revision, config);
  await v9OwnDocument(employee, { caseId: c.id, revision: c.revision, documentId: c.documents[0].id, values: { mobile: '+60111111111', confirm: 'true' }, signature: { method: 'typed', value: 'V9 subject', consent: true } });
  const signed = (await v9CaseDetail(admin, c.id)).case;
  expect(signed.runs.find(run => run.workflowId === 'docSigned')).toMatchObject({ sourceEvent: { kind: 'docSigned', sourceId: c.documents[0].id } });
  const fileId = await v9UploadFile(admin, { caseId: c.id, revision: signed.revision, slot: 'fixture-support', name: 'fictional-source-event.txt', content: Buffer.from('Fictional source event fixture') });
  const uploaded = (await v9CaseDetail(admin, c.id)).case;
  expect(uploaded.runs.find(run => run.workflowId === 'fileUploaded')).toMatchObject({ sourceEvent: { kind: 'fileUploaded', sourceId: fileId } });
  await v9Sweep({ ...admin, userId: undefined, personId: null }, owner, new Date(addDays(todayInKualaLumpur(), -1) + 'T23:00:00Z'));
  const result = (await v9CaseDetail(admin, c.id)).case;
  expect(result.mails.map(mail => mail.subject).sort()).toEqual(['Actual docSigned', 'Actual fileUploaded']);
});

it('requires a definite private receipt before an HR retry and retains the original started delivery', async () => {
  const c = await prepared(), config = (await v9Workspace(admin)).config!;
  config.workflows.push({ id: 'receipt-retry', name: 'Receipt retry', module: 'off', status: 'published', trigger: { event: 'manual', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'notice', type: 'notify', to: 'employee', cc: [], subject: 'Fictional retry receipt', body: 'Original saved body' }], description: '' });
  await v9SaveConfig(admin, config.revision, config); await v9Command(admin, c.id, c.revision, { type: 'startWorkflow', workflowId: 'receipt-retry' });
  const before = (await v9CaseDetail(admin, c.id)).case, original = before.mails.find(mail => mail.workflowId === 'receipt-retry')!;
  await expect(v9Command(admin, c.id, before.revision, { type: 'emailRetry', id: original.id, reason: 'No failure yet' })).rejects.toThrow('does not allow a retry');
  // Isolated SQL receipt fixture: this is not evidence of an external SMTP rejection or delivery.
  await owner.db.execute(sql`update lc_v9_email_delivery set status='uncertain',started_at=now(),completed_at=now(),error_code='uncertain' where tenant_id=${base.tenantId}::uuid and case_id=${c.id}::uuid and mail_id=${original.id}`);
  const held = structuredClone(before); const mail = held.mails.find(mail => mail.id === original.id)!; mail.status = 'failed'; mail.failure = 'smtpTemporary';
  await owner.db.execute(sql`update lc_v9_case set data=${JSON.stringify(held)}::jsonb where id=${c.id}::uuid`);
  await expect(v9Command(admin, c.id, held.revision, { type: 'emailRetry', id: original.id, reason: 'Projection cannot override uncertainty' })).rejects.toThrow('does not allow a retry');
  await owner.db.execute(sql`update lc_v9_email_delivery set status='failed',error_code='smtpTemporary' where tenant_id=${base.tenantId}::uuid and case_id=${c.id}::uuid and mail_id=${original.id}`);
  const [receipt] = await owner.db.execute<{ started_at: string; payload: unknown }>(sql`select started_at,payload from lc_v9_email_delivery where tenant_id=${base.tenantId}::uuid and case_id=${c.id}::uuid and mail_id=${original.id}`);
  const [denied] = await withTenant(other, tx => tx.execute<{ allowed: boolean }>(sql`select app.lc_v9_email_retryable(${c.id}::uuid,${original.id}) as allowed`)); expect(denied.allowed).toBe(false);
  await v9Command(admin, c.id, held.revision, { type: 'emailRetry', id: original.id, reason: 'Fictional relay rejection reviewed.' });
  const after = (await v9CaseDetail(admin, c.id)).case, retry = after.mails.find(mail => mail.retryOf === original.id)!;
  expect(retry).toMatchObject({ body: original.body, status: 'pending', retryReason: 'Fictional relay rejection reviewed.' }); expect(after.mails.find(mail => mail.id === original.id)?.status).toBe('failed');
  const rows = await owner.db.execute<{ mail_id: string; status: string; started_at: string | null; payload: unknown }>(sql`select mail_id,status,started_at,payload from lc_v9_email_delivery where tenant_id=${base.tenantId}::uuid and case_id=${c.id}::uuid order by created_at,id`);
  expect(rows).toHaveLength(2); expect(rows.find(row => row.mail_id === original.id)).toMatchObject({ status: 'failed', started_at: receipt.started_at, payload: receipt.payload }); expect(rows.find(row => row.mail_id === retry.id)).toMatchObject({ status: 'queued', started_at: null });
  await expect(v9Command(admin, c.id, after.revision, { type: 'emailRetry', id: original.id, reason: 'Duplicate attempt' })).rejects.toThrow('does not allow a retry');
});

it('refuses a retry when a private per-person attachment has been replaced after failure', async () => {
  const c = await prepared(), config = (await v9Workspace(admin)).config!;
  config.emails.push({ id: 'retry-file-copy', name: 'Fictional saved file copy', module: 'off', active: true, sender: 'hr', subject: 'Fictional file receipt', body: '', cc: [], links: [], attachments: [], slots: [{ id: 'personal', label: 'Fictional personal file', required: true }] });
  await v9SaveConfig(admin, config.revision, config);
  await v9UploadFile(admin, { caseId: c.id, revision: c.revision, slot: 'retry-file-copy:personal', name: 'fictional-original.txt', content: Buffer.from('Fictional original saved copy') });
  const uploaded = (await v9CaseDetail(admin, c.id)).case; await v9Command(admin, c.id, uploaded.revision, { type: 'emailSend', emailId: 'retry-file-copy' });
  const queued = (await v9CaseDetail(admin, c.id)).case, mail = queued.mails.find(mail => mail.templateId === 'retry-file-copy')!;
  await owner.db.execute(sql`update lc_v9_email_delivery set status='failed',started_at=now(),completed_at=now(),error_code='smtpTemporary' where tenant_id=${base.tenantId}::uuid and case_id=${c.id}::uuid and mail_id=${mail.id}`);
  mail.status = 'failed'; mail.failure = 'smtpTemporary'; await owner.db.execute(sql`update lc_v9_case set data=${JSON.stringify(queued)}::jsonb where id=${c.id}::uuid`);
  const [before] = await withTenant(admin, tx => tx.execute<{ allowed: boolean }>(sql`select app.lc_v9_email_retryable(${c.id}::uuid,${mail.id}) as allowed`)); expect(before.allowed).toBe(true);
  await v9UploadFile(admin, { caseId: c.id, revision: queued.revision, slot: 'retry-file-copy:personal', name: 'fictional-replacement.txt', content: Buffer.from('Fictional replacement saved copy') });
  const changed = (await v9CaseDetail(admin, c.id)).case;
  await expect(v9Command(admin, c.id, changed.revision, { type: 'emailRetry', id: mail.id, reason: 'Changed file is a different saved copy' })).rejects.toThrow('does not allow a retry');
  expect((await v9CaseDetail(admin, c.id)).case.mails.filter(attempt => attempt.retryOf === mail.id)).toEqual([]);
  const [originalReceipt]=await owner.db.execute<{payload:{files:{name:string}[]};started_at:string}>(sql`select payload,started_at from lc_v9_email_delivery where case_id=${c.id}::uuid and mail_id=${mail.id}`);
  expect(originalReceipt.payload.files.map(file=>file.name)).toEqual(['fictional-original.txt']);
  const updated=await v9PreviewUpdatedEmail(admin,c.id,mail.id);expect(updated.files).toEqual(['fictional-replacement.txt']);
  await v9Command(admin,c.id,changed.revision,{type:'emailReplace',id:mail.id,reason:'Fictional replacement file reviewed.',sourceRevision:updated.sourceRevision});
  const result=(await v9CaseDetail(admin,c.id)).case,replacement=result.mails.find(attempt=>attempt.retryOf===mail.id)!;
  const [nextReceipt]=await owner.db.execute<{payload:{files:{name:string}[]};status:string;started_at:string|null}>(sql`select payload,status,started_at from lc_v9_email_delivery where case_id=${c.id}::uuid and mail_id=${replacement.id}`);
  expect(nextReceipt).toMatchObject({status:'queued',started_at:null});expect(nextReceipt.payload.files.map(file=>file.name)).toEqual(['fictional-replacement.txt']);
  const [preserved]=await owner.db.execute(sql`select payload,started_at from lc_v9_email_delivery where case_id=${c.id}::uuid and mail_id=${mail.id}`);expect(preserved).toEqual(originalReceipt);
});

it('uses approved categories from real Personnel confirmation dates in both matching and source-event capture', async () => {
  await setEmploymentInfo(admin, { employmentId, confirmationDate: '2027-01-01' });
  const config = (await v9Workspace(admin)).config!;
  config.checklists = [...config.checklists.filter(checklist => checklist.module === 'onb'), ...['Permanent','Contract','Probation'].map(category => ({ id: 'category-' + category, name: 'Fictional ' + category + ' checklist', module: 'off' as const, rules: { employmentType: [category] }, tasks: [{ id: 'category-task', name: 'Fictional category work', by: 'employee' as const, group: null, mode: 'manual' as const, opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'completed' as const }] }))];
  config.workflows = [{ id: 'category-event', name: 'Fictional category event', module: 'off', status: 'published', trigger: { event: 'taskDone', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [{ field: 'employmentType', op: 'is', value: 'Probation' }], steps: [{ id: 'notice', type: 'notify', to: 'employee', cc: [], subject: 'Fictional probation task completed', body: '' }], description: '' }];
  await v9SaveConfig(admin, config.revision, config);
  const id = await v9CreateOffboarding(admin, { employmentId, type: 'Resignation', noticeDate: '2026-10-01', lastDay: '2026-11-01' }); await v9Command(admin, id, 1, { type: 'submit' });
  const c = (await v9CaseDetail(admin, id)).case; expect(c.checklistId).toBe('category-Probation'); expect(c.facts.employmentType).toBe('full_time'); expect(c.facts.finalConfirmationDate).toBe('2027-01-01');
  const [actual] = await owner.db.execute<{ employment_type: string }>(sql`select employment_type from assignment where employment_id=${employmentId}::uuid and superseded_at is null order by valid_from desc,id limit 1`); expect(actual.employment_type).toBe('full_time');
  const examples = [[{ employmentType: 'contract', confirmationDate: '2027-01-01', joinDate: '2026-10-01' }, 'contract'], [{ employmentType: 'full_time', confirmationDate: '2027-01-01', joinDate: '2026-10-01' }, 'probation'], [{ employmentType: 'full_time', confirmationDate: '2026-10-01', joinDate: '2026-10-01' }, 'permanent'], [{ employmentType: 'full_time', probationEndDate: '2027-01-01', joinDate: '2026-10-01' }, 'probation'], [{ employmentType: 'full_time', confirmationDate: '2026-02-30', joinDate: '2026-10-01' }, null], ...['part_time','intern','assignment'].map(employmentType => [{ employmentType, confirmationDate: '2027-01-01', joinDate: '2026-10-01' }, null])] as const;
  for (const [facts, expected] of examples) { const [result] = await withTenant(admin, tx => tx.execute<{ category: string | null }>(sql`select app.lc_v9_employment_class(${JSON.stringify(facts)}::jsonb) as category`)); expect(result.category).toBe(expected); }
  const own = (await v9OwnWork(employee)).find(own => own.id === id)!; expect(own.facts).not.toHaveProperty('confirmationDate'); expect(own.facts).not.toHaveProperty('finalConfirmationDate');
  await v9OwnTask(employee, { caseId: id, revision: c.revision, taskId: c.tasks[0].id, status: 'done', reason: '' });
  expect((await v9CaseDetail(admin, id)).case.runs).toMatchObject([{ workflowId: 'category-event', sourceEvent: { kind: 'taskDone' } }]);
});


it('snapshots handed Native items by employment and records recovery on their original owner atomically', async () => {
  const context = await onboardingContext(admin), native = structuredClone(context.config);
  native.groups.find(group => group.id === native.techGroup)!.members = [admin.userId!];
  native.catalogue = [
    { id: 'native-held-system', name: 'Fictional handed account', type: 'system', active: true, rules: {}, workflow: null, team: native.techGroup, card: false },
    { id: 'native-held-device', name: 'Fictional handed device', type: 'device', active: true, rules: {}, workflow: null, team: native.techGroup, card: false },
  ];
  await onboardingSaveConfig(admin, context.revision, native);
  const config = (await v9Workspace(admin)).config!;
  for (const workflow of config.workflows) workflow.status = 'draft';
  await v9SaveConfig(admin, config.revision, config);
  const draft = await saveEmployeeDraft(admin, { currentStep: 5, data: { profile: { fullName: 'Fictional holding subject', employeeCode: 'V9-HOLDING', primaryEmail: 'holding@test.invalid' }, employment: { companyId: base.companyId, reportingManagerEmploymentId: employmentId, departmentId: base.deptA, positionId: base.positionId, employmentType: 'full_time', hiredOn: todayInKualaLumpur() }, payroll: { basicSalary: '5000' } } });
  const active = await completeEmployeeDraft(admin, draft.id);
  let joiner = (await onboardingList(admin)).find(row => row.case.sourceDraftId === draft.id)!;
  await onboardingCommand(admin, joiner.case.id, joiner.revision, { type: 'saveSubmit', patch: { hiring: 'new_hire', local: { supervisor: employmentId }, selected: native.catalogue.map(item => item.id) } });
  for (const item of currentReq((await onboardingList(admin)).find(row => row.case.id === joiner.case.id)!.case)!.items) {
    joiner = (await onboardingList(admin)).find(row => row.case.sourceDraftId === draft.id)!;
    await onboardingCommand(admin, joiner.case.id, joiner.revision, { type: 'fulfil', itemId: item.id, status: 'done' });
  }
  joiner = (await onboardingList(admin)).find(row => row.case.sourceDraftId === draft.id)!;
  await onboardingCommand(admin, joiner.case.id, joiner.revision, { type: 'handover' });
  const providing=await onboardingContext(admin);providing.config.groups.find(group=>group.id===providing.config.techGroup)!.members=[admin.userId!,employee.userId!];
  await onboardingSaveConfig(admin,providing.revision,providing.config);
  const holdings = await withTenant(admin, tx => onboardingHoldingsTx(admin, tx, active.employmentId, base.companyId));
  expect(holdings.map(item => item.name).sort()).toEqual(['Fictional handed account', 'Fictional handed device']);
  expect(await withTenant(admin, tx => onboardingHoldingsTx(admin, tx, employmentId, base.companyId))).toEqual([]);
  await expect(withTenant(employee, tx => onboardingHoldingsTx(employee, tx, active.employmentId, base.companyId))).rejects.toThrow('Company HR');
  async function exit(recovered = false) {
    const id = await v9CreateOffboarding(admin, { employmentId: active.employmentId, type: 'Resignation', noticeDate: todayInKualaLumpur(), lastDay: addDays(todayInKualaLumpur(), 30) });
    const preview=await v9CaseDetail(admin,id); expect(preview.returns?.held.map(item=>item.name).sort()).toEqual(recovered ? [] : ['Fictional handed account','Fictional handed device']); expect(preview.case.items).toEqual([]);
    await v9Command(admin,id,preview.case.revision,{type:'returnSelections',ids:recovered ? [] : ['native-held-device']});
    await v9Command(admin, id, (await v9CaseDetail(admin,id)).case.revision, { type: 'submit' }); return (await v9CaseDetail(admin, id)).case;
  }
  const holder:SessionContext={...employee,userId:await createAppUser(base.tenantId,joiner.case.personId!,'employee'),personId:joiner.case.personId};
  await v9Command(admin,joiner.case.id,(await onboardingList(admin)).find(row=>row.case.id===joiner.case.id)!.revision,{type:'runWorkflows'});
  let receiptWork=(await v9OwnWork(holder)).find(row=>row.id===joiner.case.id)!;
  expect(receiptWork.equipment).toHaveLength(2);
  const receiptItem=receiptWork.equipment!.find(item=>item.kind==='device')!;
  expect(receiptItem.handedAt).toBeTruthy();
  expect(receiptItem).not.toHaveProperty('steps');
  await expect(v9OwnEquipmentReceipt(other,{caseId:joiner.case.id,revision:receiptWork.revision,itemId:receiptItem.id,status:'received',note:''})).rejects.toThrow();
  await expect(v9OwnEquipmentReceipt(holder,{caseId:joiner.case.id,revision:receiptWork.revision,itemId:receiptItem.id,status:'problem',note:' '})).rejects.toThrow();
  await v9OwnEquipmentReceipt(holder,{caseId:joiner.case.id,revision:receiptWork.revision,itemId:receiptItem.id,status:'problem',note:'Fictional charger missing'});
  await expect(v9OwnEquipmentReceipt(holder,{caseId:joiner.case.id,revision:receiptWork.revision,itemId:receiptItem.id,status:'received',note:''})).rejects.toThrow();
  receiptWork=(await v9OwnWork(holder)).find(row=>row.id===joiner.case.id)!;
  expect(receiptWork.equipment!.find(item=>item.id===receiptItem.id)?.receipt).toMatchObject({status:'problem',by:holder.userId,note:'Fictional charger missing'});
  await v9OwnEquipmentReceipt(holder,{caseId:joiner.case.id,revision:receiptWork.revision,itemId:receiptItem.id,status:'received',note:''});
  receiptWork=(await v9OwnWork(holder)).find(row=>row.id===joiner.case.id)!;
  await expect(v9OwnEquipmentReceipt(holder,{caseId:joiner.case.id,revision:receiptWork.revision,itemId:receiptItem.id,status:'problem',note:'repeat'})).rejects.toThrow();
  const receiptOwner=(await onboardingList(admin)).find(row=>row.case.id===joiner.case.id)!;
  expect(currentReq(receiptOwner.case)!.handedAt).toBe(receiptItem.handedAt);
  expect(currentReq(receiptOwner.case)!.items.find(item=>item.id===receiptItem.id)).toMatchObject({state:'handed',employeeReceipt:{status:'received',by:holder.userId}});
  expect(await withTenant(admin,tx=>onboardingHoldingsTx(admin,tx,active.employmentId,base.companyId))).toHaveLength(2);
  const first = await exit();
  await expect(exit()).rejects.toThrow('already has an open offboarding case');
  expect(first.items).toHaveLength(2);
  await expect(v9Command(admin, first.id, first.revision, {type:'assignItem',id:first.items[0].id,userId:other.userId!})).rejects.toThrow('providing group');
  await expect(v9Command(employee, first.id, first.revision, {type:'assignItem',id:first.items[0].id,userId:employee.userId!})).rejects.toThrow();
  await v9Command(admin, first.id, first.revision, {type:'assignItem',id:first.items[0].id,userId:employee.userId!});
  const reassigned=(await v9CaseDetail(admin,first.id)).case;
  expect(reassigned.items[0]).toMatchObject({...first.items[0],assignee:employee.userId});
  expect(reassigned.log.at(-1)).toMatchObject({action:'item.reassigned',userId:employee.userId});
  await expect(v9Command(admin,first.id,first.revision,{type:'assignItem',id:first.items[1].id,userId:employee.userId!})).rejects.toThrow('changed');
  const device=first.items.find(item=>item.kind==='device')!,system=first.items.find(item=>item.kind==='system')!;
  const ownCase=(await v9OwnWork(holder)).find(c=>c.id===first.id)!;
  expect(ownCase.items).toHaveLength(2);expect(ownCase.facts).not.toHaveProperty('confirmationDate');
  await expect(v9ReportOwnReturn(employee,{caseId:first.id,revision:reassigned.revision,itemId:device.id,note:''})).rejects.toThrow();
  await expect(v9ReportOwnReturn(holder,{caseId:first.id,revision:reassigned.revision,itemId:system.id,note:''})).rejects.toThrow();
  await expect(v9ReportOwnReturn(holder,{caseId:first.id,revision:first.revision,itemId:device.id,note:''})).rejects.toThrow();
  await v9ReportOwnReturn(holder,{caseId:first.id,revision:reassigned.revision,itemId:device.id,note:'Fictional team desk receipt'});
  const declared=(await v9CaseDetail(admin,first.id)).case;
  expect(declared.items.find(item=>item.id===device.id)).toMatchObject({status:device.status,returnReported:{by:holder.userId,note:'Fictional team desk receipt'}});
  expect(declared.items.find(item=>item.id===system.id)).not.toHaveProperty('returnReported');
  expect(declared.tasks.find(task=>task.name==='Return your company items')).toMatchObject({status:'done'});
  expect(await withTenant(admin,tx=>onboardingHoldingsTx(admin,tx,active.employmentId,base.companyId))).toHaveLength(2);
  expect(currentReq((await onboardingList(admin)).find(row=>row.case.id===joiner.case.id)!.case)!.items.every(item=>!item.recovery)).toBe(true);
  await expect(v9ReportOwnReturn(holder,{caseId:first.id,revision:declared.revision,itemId:device.id,note:'Duplicate'})).rejects.toThrow();
  const assigned = first.items[0], workInput={caseId:first.id,revision:declared.revision,itemId:assigned.id,status:'progress' as const,reason:'Fictional provider recovery'};
  expect((await v9OwnWork(employee)).find(row=>row.id===first.id)?.items).toEqual([expect.objectContaining({id:assigned.id,canFulfil:true})]);
  expect((await v9OwnWork(holder)).find(row=>row.id===first.id)?.items.every(item=>!item.canFulfil)).toBe(true);
  await expect(v9CaseDetail(employee,first.id)).rejects.toThrow();
  await expect(v9OwnItem(holder,workInput)).rejects.toThrow();
  await expect(v9OwnItem(other,workInput)).rejects.toThrow();
  await expect(v9OwnItem(employee,{...workInput,itemId:first.items[1].id})).rejects.toThrow();
  await expect(v9OwnItem(employee,{...workInput,revision:first.revision})).rejects.toThrow();
  for(const [revision,status] of [[null,'done'],[declared.revision,null],[declared.revision,'notNeeded'],[declared.revision,'done']] as const){
    await expect(withTenant(employee,tx=>tx.execute(sql`select app.lc_v9_fulfil_item(${first.id}::uuid,${revision},${assigned.id},${status},'')`))).rejects.toThrow();
  }
  // A real source-owner update is rolled back with the caller's failed transaction.
  await expect(withTenant(employee,async tx=>{
    await onboardingRecoverHoldingTx(employee,tx,active.employmentId,base.companyId,assigned.nativeSource!,first.id,'Fictional rollback',{revision:declared.revision,itemId:assigned.id});
    throw new Error('Fictional transaction rollback');
  })).rejects.toThrow('Fictional transaction rollback');
  expect(currentReq((await onboardingList(admin)).find(row=>row.case.id===joiner.case.id)!.case)!.items.every(item=>!item.recovery)).toBe(true);
  const revoked=await onboardingContext(admin);revoked.config.groups.find(group=>group.id===assigned.group)!.members=[admin.userId!];await onboardingSaveConfig(admin,revoked.revision,revoked.config);
  expect((await v9OwnWork(employee)).find(row=>row.id===first.id)?.items[0].canFulfil).toBe(false);
  await expect(v9OwnItem(employee,workInput)).rejects.toThrow();
  const restored=await onboardingContext(admin);restored.config.groups.find(group=>group.id===assigned.group)!.members=[admin.userId!,employee.userId!];await onboardingSaveConfig(admin,restored.revision,restored.config);
  await expect(withTenant({...employee,tenantId:randomUUID()},tx=>tx.execute(sql`select app.lc_v9_assigned_item(${first.id}::uuid,${declared.revision},${assigned.id})`))).rejects.toThrow();
  await owner.client`update app_user set archived_at=now() where id=${employee.userId!}::uuid`;
  await expect(v9OwnItem(employee,workInput)).rejects.toThrow();
  await owner.client`update app_user set archived_at=null where id=${employee.userId!}::uuid`;
  await v9OwnItem(employee,workInput);
  await expect(v9OwnItem(employee,{...workInput,status:'done'})).rejects.toThrow();
  let fresh=(await v9CaseDetail(admin,first.id)).case;
  await v9OwnItem(employee,{...workInput,revision:fresh.revision,status:'done'});
  fresh=(await v9CaseDetail(admin,first.id)).case;
  expect(fresh.items[0]).toMatchObject({status:'done',reason:workInput.reason});
  expect(fresh.log.at(-1)).toMatchObject({action:'item.teamUpdated',actor:{id:employee.userId}});
  await expect(v9OwnItem(employee,{...workInput,revision:fresh.revision,status:'todo'})).rejects.toThrow();
  for (const item of first.items.slice(1)) {
    expect(item.sourceId).toBeNull(); expect(item.nativeSource).toMatchObject({ caseId: joiner.case.id, requestId: currentReq(joiner.case)!.id });
    const fresh = (await v9CaseDetail(admin, first.id)).case;
    await v9Command(admin, first.id, fresh.revision, { type: 'item', id: item.id, status: 'done', reason: 'HR confirmed the recovery with the fulfilling team.' });
  }
  expect(await withTenant(admin, tx => onboardingHoldingsTx(admin, tx, active.employmentId, base.companyId))).toEqual([]);
  const resolved=(await v9CaseDetail(admin,first.id)).case;
  await expect(v9Command(admin,first.id,resolved.revision,{type:'assignItem',id:first.items[0].id,userId:admin.userId!})).rejects.toThrow('recorded owner');
  const recovered = (await onboardingList(admin)).find(row => row.case.id === joiner.case.id)!;
  expect(currentReq(recovered.case)!.items.map(item => item.recovery?.outcome).sort()).toEqual(['returned', 'revoked']);
  expect(currentReq(recovered.case)!.items.every(item => item.recovery?.offboardingCaseId === first.id)).toBe(true);
  expect(recovered.case.history.filter(event => event.action.startsWith('holding.'))).toHaveLength(2);
  expect(currentReq(recovered.case)!.handedAt).toBe(receiptItem.handedAt);
  expect(currentReq(recovered.case)!.items.find(item=>item.id===receiptItem.id)?.employeeReceipt).toMatchObject({status:'received',by:holder.userId});
  const finished = (await v9CaseDetail(admin, first.id)).case;
  await expect(v9Command(admin, first.id, finished.revision, { type: 'item', id: first.items[0].id, status: 'todo', reason: '' })).rejects.toThrow('issuing record');
  await v9Command(admin, first.id, finished.revision, { type: 'cancel', reason: 'Fictional duplicate-case recovery check.' });
  await expect(v9OwnItem(employee,{...workInput,revision:finished.revision+1,status:'done'})).rejects.toThrow();
  expect((await exit(true)).items).toEqual([]);
});

it('keeps team asset recovery behind existing IT authority, locked holder checks and atomic issuing history',async()=>{
  const native=await onboardingContext(admin);native.config.groups.find(group=>group.id===native.config.techGroup)!.members=[employee.userId!];await onboardingSaveConfig(admin,native.revision,native.config);
  const config=(await v9Workspace(admin)).config!;for(const workflow of config.workflows)workflow.status='draft';await v9SaveConfig(admin,config.revision,config);
  const id=await v9CreateOffboarding(admin,{employmentId,type:'Resignation',noticeDate:todayInKualaLumpur(),lastDay:addDays(todayInKualaLumpur(),30)});
  let c=(await v9CaseDetail(admin,id)).case;
  expect(c.facts.employeeNo).toBeTruthy();
  const asset=await registerAsset(admin,{companyId:base.companyId,assetType:'laptop',status:'issued',userName:c.facts.name,userEmployeeNo:c.facts.employeeNo});
  await v9Command(admin,id,c.revision,{type:'submit'});c=(await v9CaseDetail(admin,id)).case;
  expect(c.items).toHaveLength(1);expect(c.items[0]).toMatchObject({sourceId:asset.id,assignee:employee.userId});
  const input={caseId:id,revision:c.revision,itemId:c.items[0].id,status:'done' as const,reason:'Fictional desk recovery'};
  await expect(v9OwnItem(employee,input)).rejects.toThrow();
  expect((await getAsset(admin,asset.code)).status).toBe('issued');
  // Test-only IT authority, never a real account grant.
  await owner.client`insert into lc_staff(tenant_id,user_id,company_id,level) values(${base.tenantId}::uuid,${employee.userId!}::uuid,${base.companyId}::uuid,'agent')`;
  await expect(withTenant(employee,tx=>tx.execute(sql`select app.lc_v9_fulfil_item(${id}::uuid,${c.revision},${input.itemId},'done','')`))).rejects.toThrow();
  await expect(withTenant(employee,tx=>returnAssetTx(tx,employee,asset.code,{requisitionNumber:c.number,expectedHolder:{companyId:base.companyId,employeeNo:'FICTIONAL-WRONG-HOLDER'}}))).rejects.toThrow('holder changed');
  await expect(withTenant(employee,async tx=>{
    await returnAssetTx(tx,employee,asset.code,{requisitionNumber:c.number,expectedHolder:{companyId:base.companyId,employeeNo:c.facts.employeeNo}});
    await tx.execute(sql`select app.lc_v9_fulfil_item(${id}::uuid,${c.revision-1},${input.itemId},'done','')`);
  })).rejects.toThrow();
  expect((await getAsset(admin,asset.code)).status).toBe('issued');
  expect((await assetHistory(admin,asset.code)).filter(event=>event.action==='asset.returned')).toHaveLength(0);
  await v9OwnItem(employee,input);
  expect(await getAsset(admin,asset.code)).toMatchObject({status:'returned',userEmployeeNo:null});
  expect((await assetHistory(admin,asset.code)).filter(event=>event.action==='asset.returned')).toMatchObject([{actorUserId:employee.userId,detail:expect.objectContaining({requisition:c.number})}]);
  const done=(await v9CaseDetail(admin,id)).case;expect(done.items[0].status).toBe('done');
  await expect(v9OwnItem(employee,{...input,revision:done.revision,status:'todo'})).rejects.toThrow();
  await withTenant(admin,tx=>issueAssetTx(tx,admin,asset.code,{name:'Fictional subsequent holder',employeeNo:'V9-ANOTHER',department:null,email:null},{}));
  await expect(withTenant(employee,tx=>returnAssetTx(tx,employee,asset.code,{expectedHolder:{companyId:base.companyId,employeeNo:c.facts.employeeNo}}))).rejects.toThrow('holder changed');
  expect(await getAsset(admin,asset.code)).toMatchObject({status:'issued',userEmployeeNo:'V9-ANOTHER'});
});

it('applies live equipment bulk changes atomically and keeps completed items and group-scoped operators intact', async () => {
  const context = await onboardingContext(admin), config = structuredClone(context.config), team = config.techGroup, second = randomUUID();
  config.groups.find(group => group.id === team)!.members = [admin.userId!];
  config.groups.push({ id: second, name: 'Fictional second equipment team', members: [other.userId!], limit: 0 });
  config.catalogue = ['bulk-one','bulk-two'].map(id => ({ id, name: 'Fictional ' + id, type: 'system', active: true, rules: {}, workflow: null, team, card: false }));
  await onboardingSaveConfig(admin, context.revision, config);
  const shared = (await v9Workspace(admin)).config!; for (const workflow of shared.workflows) workflow.status = 'draft'; await v9SaveConfig(admin, shared.revision, shared);
  const draft = await saveEmployeeDraft(admin, { currentStep: 1, data: { profile: { fullName: 'Fictional bulk joiner' }, employment: { companyId: base.companyId, reportingManagerEmploymentId: employmentId, departmentId: base.deptA, positionId: base.positionId, hiredOn: addDays(todayInKualaLumpur(), 5) } } });
  let row = (await onboardingList(admin)).find(row => row.case.sourceDraftId === draft.id)!;
  await onboardingCommand(admin, row.case.id, row.revision, { type: 'saveSubmit', patch: { hiring: 'new_hire', local: { supervisor: employmentId }, selected: config.catalogue.map(item => item.id) } });
  row = (await onboardingList(admin)).find(candidate => candidate.case.id === row.case.id)!;
  const [ready, pending] = currentReq(row.case)!.items;
  expect(ready.claim).toBe(admin.userId); expect(pending.fulfilmentMethod).toBe('rr'); expect(pending.dueDay).toBe(-1);
  await onboardingCommand(admin, row.case.id, row.revision, { type: 'fulfil', itemId: ready.id, status: 'done' });
  row = (await onboardingList(admin)).find(candidate => candidate.case.id === row.case.id)!; const completed = structuredClone(currentReq(row.case)!.items[0]);
  await onboardingCommand(admin, row.case.id, row.revision, { type: 'equipmentBulk', ids: [ready.id,pending.id], group: second, method: 'rr', due: 0 });
  row = (await onboardingList(admin)).find(candidate => candidate.case.id === row.case.id)!;
  expect(currentReq(row.case)!.items[0]).toEqual(completed);
  expect(currentReq(row.case)!.items[1]).toMatchObject({ id: pending.id, team: second, claim: other.userId, dueDay: 0 });
  await expect(onboardingCommand(other, row.case.id, row.revision, { type: 'equipmentAssignee', itemId: pending.id, user: employee.userId!, roundRobin: false })).rejects.toThrow('eligible member');
  await onboardingCommand(other, row.case.id, row.revision, { type: 'fulfil', itemId: pending.id, status: 'progress' });
  row = (await onboardingList(admin)).find(candidate => candidate.case.id === row.case.id)!;
  expect(currentReq(row.case)!.items[1].state).toBe('progress');
  await expect(onboardingCommand(employee, row.case.id, row.revision, { type: 'fulfil', itemId: pending.id, status: 'done' })).rejects.toThrow();
  const snapshot = JSON.stringify(row.case);
  await expect(onboardingCommand(admin, row.case.id, row.revision, { type: 'equipmentBulk', ids: [pending.id,randomUUID()], group: team })).rejects.toThrow('no longer available');
  expect(JSON.stringify((await onboardingList(admin)).find(candidate => candidate.case.id === row.case.id)!.case)).toBe(snapshot);
});

it('limits unsigned signer choices to fresh company HR and lets an authorized HR reviewer countersign',async()=>{
  let c=await prepared();const alternateId=await createAppUser(base.tenantId,other.personId!,'hr_admin'),alternate:SessionContext={...admin,userId:alternateId,personId:other.personId,roles:['hr_admin'],grants:undefined};
  const signerAccess=await onboardingContext(admin);signerAccess.config.access.offboarding.push(alternateId);await onboardingSaveConfig(admin,signerAccess.revision,signerAccess.config);
  let config=(await v9Workspace(admin)).config!;config.companies=[{companyId:base.companyId,signatoryUserId:admin.userId!,signatoryTitle:'Default title',allowedSignatoryUserIds:[admin.userId!,alternateId]}];config.signatoryTitles={[alternateId]:'Alternate printed title'};
  config.templates.push({id:'signer-letter',name:'Fictional signer letter',module:'off',type:'Letter',rules:{},hrStep:'before',employeeAck:true,retired:false,versions:[{version:1,state:'published',at:'',by:'',blocks:[{id:'signature-name',type:'text',text:'{signatory.name} · {signatory.title}',section:''}],fields:[{id:'printed-signer',label:'Printed signer',type:'text',owner:'pmLocked',pmKey:'signatory.name',required:false,sensitive:false,options:[],section:'main',when:null},{id:'printed-title',label:'Printed title',type:'text',owner:'pmLocked',pmKey:'signatory.title',required:false,sensitive:false,options:[],section:'main',when:null}]}]});
  const bad=structuredClone(config);bad.companies![0].allowedSignatoryUserIds!.push(employee.userId!);await expect(v9SaveConfig(admin,bad.revision,bad)).rejects.toThrow('company HR');
  await v9SaveConfig(admin,config.revision,config);
  const workspace=await v9Workspace(admin);expect(workspace.options.signatoryCandidates![base.companyId]).toContain(alternateId);expect(workspace.options.signatoryCandidates![base.companyId]).not.toContain(employee.userId);
  await v9Command(admin,c.id,c.revision,{type:'generate',template:'signer-letter'});c=(await v9CaseDetail(admin,c.id)).case;const doc=c.documents.find(doc=>doc.templateId==='signer-letter')!;
  await expect(v9Command(employee,c.id,c.revision,{type:'documentSignatory',id:doc.id,userId:employee.userId!})).rejects.toThrow();
  await expect(v9Command(admin,c.id,c.revision,{type:'documentSignatory',id:doc.id,userId:employee.userId!})).rejects.toThrow('permitted');
  await v9Command(admin,c.id,c.revision,{type:'documentSignatory',id:doc.id,userId:alternateId});c=(await v9CaseDetail(admin,c.id)).case;
  expect(c.documents.find(doc=>doc.templateId==='signer-letter')).toMatchObject({signatoryUserId:alternateId,mergeValues:{'signatory.title':'Alternate printed title'},values:{'printed-signer':'Unrelated employee','printed-title':'Alternate printed title'}});
  await v9Command(admin,c.id,c.revision,{type:'documentRefresh',id:doc.id});c=(await v9CaseDetail(admin,c.id)).case;expect(c.documents.find(d=>d.id===doc.id)?.signatoryUserId).toBe(alternateId);
  await expect(v9Command(admin,c.id,c.revision,{type:'documentSign',id:doc.id,signature:{method:'typed',value:'Wrong designated signer',consent:true}})).rejects.toThrow('designated');
  await v9Command(alternate,c.id,c.revision,{type:'documentSign',id:doc.id,signature:{method:'typed',value:'Alternate HR',consent:true}});c=(await v9CaseDetail(admin,c.id)).case;
  await expect(v9Command(admin,c.id,c.revision,{type:'documentSignatory',id:doc.id,userId:admin.userId!})).rejects.toThrow('unsigned');expect(c.documents.find(document=>document.id===doc.id)?.hrSignature?.printedTitle).toBe('Alternate printed title');
  config=(await v9Workspace(admin)).config!;expect(config.companies![0].signatoryUserId).toBe(admin.userId);
  config.companies![0].signatoryUserId=alternateId;config.signatoryTitles![admin.userId!]='Counter review title';config.templates.push({...structuredClone(config.templates.find(template=>template.id==='signer-letter')!),id:'counter-letter',hrStep:'after'});
  config.workflows.push({id:'counter-release',name:'Fictional counter release',module:'off',status:'published',trigger:{event:'manual',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'release',type:'doc',template:'counter-letter',release:true}],description:''});
  await v9SaveConfig(admin,config.revision,config);await v9Command(admin,c.id,c.revision,{type:'startWorkflow',workflowId:'counter-release'});c=(await v9CaseDetail(admin,c.id)).case;const counter=c.documents.find(doc=>doc.templateId==='counter-letter')!;expect(counter.signatoryUserId).toBe(alternateId);
  await v9OwnDocument(employee,{caseId:c.id,revision:c.revision,documentId:counter.id,values:{},signature:{method:'typed',value:'Employee acknowledgement',consent:true}});c=(await v9CaseDetail(admin,c.id)).case;expect(c.documents.find(doc=>doc.id===counter.id)?.status).toBe('countersign');
  await expect(v9Command(other,c.id,c.revision,{type:'documentSign',id:counter.id,signature:{method:'typed',value:'Unrelated',consent:true}})).rejects.toThrow();
  await v9Command(admin,c.id,c.revision,{type:'documentSign',id:counter.id,signature:{method:'typed',value:'Authorized HR counter reviewer',consent:true}});c=(await v9CaseDetail(admin,c.id)).case;
  expect(c.documents.find(doc=>doc.id===counter.id)).toMatchObject({status:'signed',hrSignature:{by:{id:admin.userId},printedTitle:'Counter review title'}});
});


it('previews real holdings and selects existing catalogue identities before submission with retirement and deletion guards', async () => {
  const native = await onboardingContext(admin), team = native.config.techGroup;
  native.config.catalogue = [
    { id: 'additional-system', name: 'Fictional extra account', type: 'system', active: true, rules: {}, workflow: null, team, card: false },
    { id: 'retired-device', name: 'Fictional retired device', type: 'device', active: false, rules: {}, workflow: null, team, card: false },
  ];
  await onboardingSaveConfig(admin, native.revision, native.config);
  const configuration = (await v9Workspace(admin)).config!;
  for (const workflow of configuration.workflows) workflow.status = 'draft';
  await v9SaveConfig(admin, configuration.revision, configuration);
  const id = await v9CreateOffboarding(admin, { employmentId, type: 'Resignation', noticeDate: todayInKualaLumpur(), lastDay: addDays(todayInKualaLumpur(), 30) });
  let detail = await v9CaseDetail(admin, id);
  expect(detail.returns).toMatchObject({ held: [], selected: [], catalogue: [{ id: 'additional-system', active: true }, { id: 'retired-device', active: false }] });
  expect(detail.case.items).toEqual([]);
  await expect(v9CaseDetail(employee, id)).rejects.toThrow();
  await expect(v9Command(admin, id, detail.case.revision, { type: 'returnSelections', ids: ['retired-device'] })).rejects.toThrow('active item');
  await expect(v9Command(admin, id, detail.case.revision, { type: 'returnSelections', ids: ['unknown'] })).rejects.toThrow('active item');
  await v9Command(admin, id, detail.case.revision, { type: 'returnSelections', ids: ['additional-system'] });
  await expect(v9Command(admin, id, detail.case.revision, { type: 'returnSelections', ids: [] })).rejects.toThrow('changed');
  detail = await v9CaseDetail(admin, id);
  expect(detail.returns?.selected).toEqual(['additional-system']);
  expect(detail.case.items).toEqual([]);
  let updated = await onboardingContext(admin);
  updated.config.catalogue = updated.config.catalogue.filter(item => item.id !== 'additional-system');
  await expect(onboardingSaveConfig(admin, updated.revision, updated.config)).rejects.toThrow('Retire');
  updated = await onboardingContext(admin);
  updated.config.catalogue.find(item => item.id === 'additional-system')!.active = false;
  await onboardingSaveConfig(admin, updated.revision, updated.config);
  await expect(v9Command(admin, id, detail.case.revision, { type: 'submit' })).rejects.toThrow('no longer available');
  expect((await v9CaseDetail(admin, id)).case.state).toBe('pending');
  updated = await onboardingContext(admin);
  updated.config.catalogue.find(item => item.id === 'additional-system')!.active = true;
  await onboardingSaveConfig(admin, updated.revision, updated.config);
  await v9Command(admin, id, detail.case.revision, { type: 'submit' });
  detail = await v9CaseDetail(admin, id);
  expect(detail).not.toHaveProperty('returns');
  expect(detail.case.returnSelections).toEqual([]);
  expect(detail.case.items).toMatchObject([{ name: 'Fictional extra account', sourceCatalogueId: 'additional-system', sourceId: null, group: team, status: 'todo' }]);
  expect(detail.case.items[0]).not.toHaveProperty('nativeSource');
  await expect(v9Command(admin, id, detail.case.revision, { type: 'returnSelections', ids: [] })).rejects.toThrow('before submission');
  updated = await onboardingContext(admin);
  updated.config.catalogue = updated.config.catalogue.filter(item => item.id !== 'additional-system');
  await expect(onboardingSaveConfig(admin, updated.revision, updated.config)).rejects.toThrow('Retire');
});

it('persists offboarding notes with canonical revisions and keeps private conversations out of self work',async()=>{
  let c=await prepared();
  await v9Command(admin,c.id,c.revision,{type:'note',context:'handover',body:'Fictional HR note for @Subject',mentions:[employee.userId!]});
  c=(await v9CaseDetail(admin,c.id)).case;
  const note=c.notes![0];expect(note).toMatchObject({by:admin.userId,context:'handover',body:'Fictional HR note for @Subject',mentions:[employee.userId]});
  expect((await v9OwnWork(employee)).find(row=>row.id===c.id)).not.toHaveProperty('notes');
  await expect(v9Command(employee,c.id,c.revision,{type:'note',id:note.id,context:'handover',body:'Overwrite',mentions:[]})).rejects.toThrow();
  const before=c.revision;
  await v9Command(admin,c.id,c.revision,{type:'note',id:note.id,context:'handover',body:'Fictional revised note',mentions:[]});
  c=(await v9CaseDetail(admin,c.id)).case;
  expect(c.notes![0].revisions).toMatchObject([{body:'Fictional HR note for @Subject',mentions:[employee.userId]}]);
  const prior=await withTenant(admin,tx=>tx.execute<{data:{notes:{body:string}[]}}>(sql`select data from lc_v9_case_revision where case_id=${c.id}::uuid and revision=${before}`));
  expect(prior[0].data.notes[0].body).toBe('Fictional HR note for @Subject');
  await v9Command(admin,c.id,c.revision,{type:'note',id:note.id,context:'handover',body:'',mentions:[],deleted:true});
  expect((await v9CaseDetail(admin,c.id)).case.notes![0]).toMatchObject({deleted:true,body:'Fictional revised note'});
});

it('separates module membership, company HR scope and the minimal onboarding shell',async()=>{
  const c=await prepared();
  await expect(v9Workspace(employee)).rejects.toThrow('module access');
  let native=await onboardingContext(admin);native.config.access.onboarding.push(employee.userId!);native.config.access.offboarding.push(employee.userId!);
  await onboardingSaveConfig(admin,native.revision,native.config);
  const shell=await v9Workspace(employee);
  expect(shell.permissions).toEqual({onboarding:true,offboarding:false,administration:false,records:true});
  expect(shell.cases).toEqual([]);expect(shell.config!.checklists.every(checklist=>checklist.module==='onb')).toBe(true);
  expect(shell.config).toMatchObject({templates:[],emails:[],workflows:[],bpRules:[]});
  expect(shell.config).not.toHaveProperty('settlementPolicy');expect(shell.config).not.toHaveProperty('companies');
  await expect(v9CaseDetail(employee,c.id)).rejects.toThrow();
  const scopedId=await createAppUser(base.tenantId,other.personId!,'hr_admin');
  await owner.client`update role_assignment set company_id=${base.companyId} where tenant_id=${base.tenantId} and app_user_id=${scopedId} and role='hr_admin'`;
  const scoped:SessionContext={...admin,userId:scopedId,personId:other.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:base.companyId}]};
  await expect(v9Workspace(scoped)).rejects.toThrow('module access');
  await expect(v9CaseDetail(scoped,c.id)).rejects.toThrow();
  native=await onboardingContext(admin);native.config.access.offboarding.push(scopedId);await onboardingSaveConfig(admin,native.revision,native.config);
  expect((await v9Workspace(scoped)).permissions).toMatchObject({onboarding:false,offboarding:true});
  expect((await v9CaseDetail(scoped,c.id)).case.id).toBe(c.id);
  const foreign=await withTenant(scoped,tx=>tx.execute<{ok:boolean}>(sql`select app.lc_v9_off_access(${randomUUID()}::uuid) as ok`));expect(foreign[0].ok).toBe(false);
  native=await onboardingContext(admin);native.config.access.offboarding=native.config.access.offboarding.filter(id=>id!==scopedId);await onboardingSaveConfig(admin,native.revision,native.config);
  await expect(v9CaseDetail(scoped,c.id)).rejects.toThrow();
  expect((await v9OwnWork(employee)).some(row=>row.id===c.id)).toBe(true);
  native=await onboardingContext(admin);native.config.access.offboarding=native.config.access.offboarding.filter(id=>id!==admin.userId);await onboardingSaveConfig(admin,native.revision,native.config);
  expect((await v9Workspace(admin)).permissions).toMatchObject({onboarding:true,offboarding:false,administration:true});
  await expect(v9CaseDetail(admin,c.id)).rejects.toThrow();
});


it('requires a definite receipt and current reviewed sources for a changed-copy replacement',async()=>{
 let c=await prepared();let config=(await v9Workspace(admin)).config!;
 config.emails.push({id:'updated-copy',name:'Fictional updated copy',module:'off',active:true,sender:'hr',subject:'Original saved subject',body:'Original saved body',cc:[],links:[],attachments:[],slots:[]});await v9SaveConfig(admin,config.revision,config);
 await v9Command(admin,c.id,c.revision,{type:'emailSend',emailId:'updated-copy'});c=(await v9CaseDetail(admin,c.id)).case;const original=c.mails.find(mail=>mail.templateId==='updated-copy')!;
 await expect(v9PreviewUpdatedEmail(admin,c.id,original.id)).rejects.toThrow('does not allow');
 await owner.db.execute(sql`update lc_v9_email_delivery set status='uncertain',started_at=now(),completed_at=now(),error_code='uncertain' where tenant_id=${base.tenantId}::uuid and case_id=${c.id}::uuid and mail_id=${original.id}`);
 const system={...admin,userId:undefined,personId:null};let transportCalls=0;await v9DeliverEmails(system,owner,async()=>{transportCalls++;throw Error('Unexpected transport for an uncertain receipt');});expect(transportCalls).toBe(0);
 await expect(v9PreviewUpdatedEmail(admin,c.id,original.id)).rejects.toThrow('does not allow');
 await owner.db.execute(sql`update lc_v9_email_delivery set status='failed',error_code='smtpRejected',projected_at=null where tenant_id=${base.tenantId}::uuid and case_id=${c.id}::uuid and mail_id=${original.id}`);
 await v9DeliverEmails(system,owner,async()=>{transportCalls++;throw Error('Unexpected transport for a completed failure');});expect(transportCalls).toBe(0);
 c=(await v9CaseDetail(admin,c.id)).case;expect(c.mails.find(mail=>mail.id===original.id)?.status).toBe('failed');const [receipt]=await owner.db.execute<{payload:unknown;started_at:string}>(sql`select payload,started_at from lc_v9_email_delivery where case_id=${c.id}::uuid and mail_id=${original.id}`);
 await v9Command(admin,c.id,c.revision,{type:'emailEdit',emailId:'updated-copy',subject:'Reviewed new subject',body:'Reviewed new body'});c=(await v9CaseDetail(admin,c.id)).case;
 const first=await v9PreviewUpdatedEmail(admin,c.id,original.id);expect(first).toMatchObject({subject:'Reviewed new subject',body:'Reviewed new body',to:['V9 subject']});await expect(v9PreviewUpdatedEmail(other,c.id,original.id)).rejects.toThrow();
 await v9Command(admin,c.id,c.revision,{type:'emailEdit',emailId:'updated-copy',subject:'Final reviewed subject',body:'Final reviewed body'});c=(await v9CaseDetail(admin,c.id)).case;
 await expect(v9Command(admin,c.id,c.revision,{type:'emailReplace',id:original.id,reason:'Stale review',sourceRevision:first.sourceRevision})).rejects.toThrow('changed');
 const preview=await v9PreviewUpdatedEmail(admin,c.id,original.id);
 await v9Command(admin,c.id,c.revision,{type:'emailReplace',id:original.id,reason:'Fictional replacement after a recorded rejection.',sourceRevision:preview.sourceRevision});c=(await v9CaseDetail(admin,c.id)).case;
 expect(c.mails.find(mail=>mail.retryOf===original.id)).toMatchObject({subject:'Final reviewed subject',body:'Final reviewed body',status:'pending',retryMode:'updated',retryReason:'Fictional replacement after a recorded rejection.'});expect(c.mails.find(mail=>mail.id===original.id)).toMatchObject({subject:'Original saved subject',body:'Original saved body',status:'failed'});
 const [retained]=await owner.db.execute<{payload:unknown;started_at:string;status:string}>(sql`select payload,started_at,status from lc_v9_email_delivery where case_id=${c.id}::uuid and mail_id=${original.id}`);expect(retained).toEqual({...receipt,status:'failed'});
 await expect(v9PreviewUpdatedEmail(admin,c.id,original.id)).rejects.toThrow('does not allow');
});

it('allows an onboarding-only company HR signer without granting offboarding case access',async()=>{
  let exit=await prepared();const signerId=await createAppUser(base.tenantId,other.personId!,'hr_admin');
  await owner.client`update role_assignment set company_id=${base.companyId} where tenant_id=${base.tenantId} and app_user_id=${signerId} and role='hr_admin'`;
  const signer:SessionContext={...admin,userId:signerId,personId:other.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:base.companyId}]};
  const native=await onboardingContext(admin);native.config.access.onboarding.push(signerId);await onboardingSaveConfig(admin,native.revision,native.config);
  const config=(await v9Workspace(admin)).config!;config.companies=[{companyId:base.companyId,signatoryUserId:signerId,signatoryTitle:'Fictional onboarding HR',allowedSignatoryUserIds:[admin.userId!,signerId]}];
  for(const module of ['onb','off'] as const)config.templates.push({id:'module-letter-'+module,name:'Fictional module letter '+module,module,type:'Letter',rules:{},hrStep:'before',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',fields:[],blocks:[{id:'body',type:'text',text:'Fictional module review',section:''}]}]});
  await v9SaveConfig(admin,config.revision,config);const options=(await v9Workspace(admin)).options;
  expect(options.signatoryCandidates![base.companyId]).toContain(signerId);expect(options.signatoryCandidatesByModule!.onb[base.companyId]).toContain(signerId);expect(options.signatoryCandidatesByModule!.off[base.companyId]).not.toContain(signerId);
  await expect(v9CaseDetail(signer,exit.id)).rejects.toThrow();
  await v9Command(admin,exit.id,exit.revision,{type:'generate',template:'module-letter-off'});exit=(await v9CaseDetail(admin,exit.id)).case;
  await expect(v9Command(admin,exit.id,exit.revision,{type:'documentSignatory',id:exit.documents.find(document=>document.templateId==='module-letter-off')!.id,userId:signerId})).rejects.toThrow('permitted');
  const draft=await saveEmployeeDraft(admin,{currentStep:5,data:{profile:{fullName:'Fictional module signer subject',employeeCode:'V9-MODULE-SIGNER',primaryEmail:'fictional-module-signer@example.test'},employment:{companyId:base.companyId,reportingManagerEmploymentId:employmentId,departmentId:base.deptA,positionId:base.positionId,employmentType:'full_time',hiredOn:todayInKualaLumpur()},payroll:{basicSalary:'5000'}}});await completeEmployeeDraft(admin,draft.id);
  let row=(await onboardingList(admin)).find(row=>row.case.sourceDraftId===draft.id)!;await onboardingCommand(admin,row.case.id,row.revision,{type:'saveSubmit',patch:{hiring:'new_hire',local:{supervisor:employmentId}}});row=(await onboardingList(admin)).find(candidate=>candidate.case.id===row.case.id)!;
  await v9Command(signer,row.case.id,row.revision,{type:'generate',template:'module-letter-onb'});let detail=await v9CaseDetail(signer,row.case.id);const document=detail.case.documents.find(document=>document.templateId==='module-letter-onb')!;expect(document.signatoryUserId).toBe(signerId);
  await v9Command(signer,row.case.id,detail.case.revision,{type:'documentSign',id:document.id,signature:{method:'typed',value:'Fictional onboarding HR',consent:true}});detail=await v9CaseDetail(signer,row.case.id);expect(detail.case.documents.find(candidate=>candidate.id===document.id)?.hrSignature).toMatchObject({by:{id:signerId},printedTitle:'Fictional onboarding HR'});
});

it('workflow test sends cannot resume an independently ready real waiting run',async()=>{
 const config=(await v9Workspace(admin)).config!;config.workflows=[{id:'test-only',name:'Fictional test',module:'off',status:'published',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'notice',type:'notify',to:'employee',cc:['supervisor'],subject:'Fictional test',body:'Test copy'}],description:''}];await v9SaveConfig(admin,config.revision,config);
 const day=todayInKualaLumpur(),id=await v9CreateOffboarding(admin,{employmentId,type:'Resignation',noticeDate:addDays(day,-30),lastDay:day});const before=(await v9CaseDetail(admin,id)).case;
 const waiting={id:'waiting-real',workflowId:'test-only',revision:config.revision,date:day,status:'waiting',cursor:0,reason:'Ready to resume',at:day+'T00:00:00Z',definition:config.workflows[0]};
 await owner.db.execute(sql`update lc_v9_case set data=${JSON.stringify({...before,state:'submitted',runs:[waiting]})}::jsonb where id=${id}::uuid`);
 await v9Command(admin,id,before.revision,{type:'testWorkflow',workflowId:'test-only'});const after=(await v9CaseDetail(admin,id)).case;
 expect(after.runs).toEqual([waiting]);expect(after.mails).toHaveLength(1);expect(after.mails[0]).toMatchObject({to:[admin.userId],cc:[],test:true,workflowId:null});
});

it.each(['pending','cancelled','cleared'] as const)('captures and receipts only actor-bound self-tests for a %s case',async state=>{
 const config=(await v9Workspace(admin)).config!,template=config.templates.find(template=>template.module==='off'&&template.type==='Form')!;
 config.emails.push({id:'closed-self',name:'Fictional self-test',module:'off',active:true,sender:'hr',subject:'Fictional self-test',body:'For {employee.name}',cc:['supervisor'],links:[template.id],attachments:[],slots:[{id:'required-proof',label:'Fictional proof',required:true}]});config.workflows=[{id:'closed-self-flow',name:'Fictional self-test flow',module:'off',status:'published',trigger:{event:'manual',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'earlier-notify',type:'notify',to:'employee',cc:[],subject:'Wrong earlier output',body:''},{id:'email',type:'email',template:'closed-self',to:'employee',cc:['supervisor']}],description:''}];await v9SaveConfig(admin,config.revision,config);
 const day=todayInKualaLumpur(),id=await v9CreateOffboarding(admin,{employmentId,type:'Resignation',noticeDate:addDays(day,-30),lastDay:day}),before=(await v9CaseDetail(admin,id)).case;
 await owner.db.execute(sql`update lc_v9_case set data=${JSON.stringify({...before,state})}::jsonb where id=${id}::uuid`);
 await expect(v9Command(other,id,before.revision,{type:'testWorkflow',workflowId:'closed-self-flow'})).rejects.toThrow();
 await v9Command(admin,id,before.revision,{type:'emailEdit',emailId:'closed-self',subject:'Reviewed self-test',body:'Future personal copy'}).then(()=>{expect(state).toBe('pending');},error=>{expect(state).not.toBe('pending');expect(error.message).toContain('Reopen this case');});
 const ready=(await v9CaseDetail(admin,id)).case;
 await v9Command(admin,id,ready.revision,{type:'testWorkflow',workflowId:'closed-self-flow'});
 const queued=(await v9CaseDetail(admin,id)).case;expect(queued.mails).toHaveLength(1);expect(queued.mails[0]).toMatchObject({templateId:'closed-self',to:[admin.userId],cc:[],test:true,documentIds:[]});expect(queued.state).toBe(state);
 const origin='https://self-test.fictional.invalid',subject='fictional-current-actor';await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+base.tenantId},${subject},${admin.userId!}::uuid)`;
 let checked=false,failure:unknown;const result=await v9DeliverEmails({...admin,userId:undefined,personId:null},owner,async request=>{try{
  const [{target}]=await owner.client`select app.lc_v9_email_target(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${origin}) as target`;expect(target).toMatchObject({caseId:id,bindings:[{userId:admin.userId}],literals:[]});expect(target.payload.mail).toMatchObject({test:true,to:[admin.userId],cc:[]});expect(target.contact).toBeNull();
  const proof={bindings:target.bindings,contact:null,literals:[],addresses:['actor@fictional.invalid'],relayRevision:'controlled-self-test-proof'};
  const [{started}]=await owner.client`select app.lc_v9_email_start(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${origin},${JSON.stringify(proof)}::jsonb) as started`;expect(started).toBe(true);
  const [{finished}]=await owner.client`select app.lc_v9_email_finish(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'sent',null) as finished`;expect(finished).toBe(true);checked=true;return{outcome:'sent',error:null};
 }catch(error){failure=error;throw error;}});if(failure)throw failure;expect(checked).toBe(true);expect(result).toEqual({attempted:1,sent:1,held:0,failed:0});
 const after=(await v9CaseDetail(admin,id)).case;expect(after.state).toBe(state);expect({documents:after.documents,tasks:after.tasks,items:after.items,runs:after.runs}).toEqual({documents:before.documents,tasks:before.tasks,items:before.items,runs:before.runs});expect(after.mails[0].status).toBe('sent');
});
it('refuses forged closed-case test recipients, CC and onboarding contacts at the SQL capture boundary',async()=>{
 const day=todayInKualaLumpur(),id=await v9CreateOffboarding(admin,{employmentId,type:'Resignation',noticeDate:addDays(day,-30),lastDay:day}),before=(await v9CaseDetail(admin,id)).case;
 const delivery={version:1,queuedBy:{id:admin.userId!,name:'Fictional HR'},sender:'hr',linkDocumentIds:[],pdfDocumentIds:[],toNames:[],ccNames:[]};
 for(const [index,patch]of [{to:[employee.userId!]},{cc:[employee.userId!]},{to:[employee.userId!],delivery:{...delivery,queuedBy:{id:employee.userId!,name:'Forged initiating actor'}}},{delivery:{...delivery,contact:{kind:'onboardingContact',caseId:id,email:'external@fictional.invalid',sourceRevision:'fictional'}}}].entries()){
  const mail={id:'forged-'+index,key:'forged-'+index,workflowId:null,templateId:null,to:[admin.userId!],cc:[],subject:'Fictional forged test',body:'',documentIds:[],fileIds:[],status:'pending',test:true,at:day+'T00:00:00Z',deliveredAt:null,failure:null,delivery,...patch};
  await owner.db.execute(sql`update lc_v9_case set data=${JSON.stringify({...before,state:'cancelled',mails:[mail]})}::jsonb where id=${id}::uuid`);
 }
 const [{count}]=await owner.client`select count(*)::int as count from lc_v9_email_delivery where case_id=${id}::uuid`;expect(count).toBe(0);
});
it('previews only the first notification or first document without creating live case work',async()=>{
 const config=(await v9Workspace(admin)).config!,templates=config.templates.filter(template=>template.module==='off').slice(0,2);expect(templates).toHaveLength(2);
 const common={module:'off' as const,status:'published' as const,trigger:{event:'manual' as const,days:0,workdays:false,repeat:false,skipIf:'' as const},conditions:[],description:''};
 config.workflows=[{...common,id:'preview-notice',name:'Fictional notice preview',steps:[{id:'first',type:'notify',to:'employee',cc:['supervisor'],subject:'First notification',body:'Read only'},{id:'second',type:'notify',to:'employee',cc:[],subject:'Second notification',body:''},{id:'doc',type:'doc',template:templates[0].id,release:false}]},{...common,id:'preview-document',name:'Fictional document preview',steps:templates.map((template,index)=>({id:'doc'+index,type:'doc' as const,template:template.id,release:false}))}];await v9SaveConfig(admin,config.revision,config);
 const day=todayInKualaLumpur(),id=await v9CreateOffboarding(admin,{employmentId,type:'Resignation',noticeDate:addDays(day,-30),lastDay:day}),before=(await v9CaseDetail(admin,id)).case;
 const notification=await v9PreviewWorkflow(admin,id,'preview-notice');expect(notification.messages).toEqual([expect.objectContaining({subject:'First notification',to:'Employee',cc:'Line manager'})]);expect(notification.documents).toEqual([]);
 const document=await v9PreviewWorkflow(admin,id,'preview-document');expect(document.messages).toEqual([]);expect(document.documents).toHaveLength(1);expect(document.documents[0].templateId).toBe(templates[0].id);expect((await v9CaseDetail(admin,id)).case).toEqual(before);
 const older={...document.documents[0],id:'fictional-existing-document',version:0,name:'Old saved document',edits:{},hrSignature:null,employeeSignature:null};
 await owner.db.execute(sql`update lc_v9_case set data=${JSON.stringify({...before,documents:[older]})}::jsonb where id=${id}::uuid`);
 const current=await v9PreviewWorkflow(admin,id,'preview-document');expect(current.documents[0].version).not.toBe(0);expect(current.documents[0].name).not.toBe('Old saved document');expect(current.documents[0].hrSignature).toBeNull();expect((await v9CaseDetail(admin,id)).case.documents).toEqual([older]);
});

it.each(['pending','cancelled'] as const)('captures native onboarding %s self-tests without exposing the contact or creating employee work',async state=>{
 const draft=await saveEmployeeDraft(admin,{currentStep:1,data:{profile:{fullName:'Fictional native self-test',primaryEmail:'native-self@fictional.invalid'},employment:{companyId:base.companyId,departmentId:base.deptA,positionId:base.positionId,hiredOn:addDays(todayInKualaLumpur(),7),employmentType:'full_time'}}});const row=(await onboardingList(admin)).find(row=>row.case.sourceDraftId===draft.id)!;
 if(state==='cancelled')await owner.db.execute(sql`update lc_onboarding_case set data=jsonb_set(data,'{state}','"cancelled"'::jsonb) where id=${row.case.id}::uuid`);
 const config=(await v9Workspace(admin)).config!;config.workflows=[{id:'native-self-test',name:'Fictional native self-test',module:'onb',status:'published',trigger:{event:'manual',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'notice',type:'notify',to:'employee',cc:['supervisor'],subject:'Fictional native self-test',body:'Read only copy'}],description:''}];await v9SaveConfig(admin,config.revision,config);
 const before=(await v9CaseDetail(admin,row.case.id)).case;await v9Command(admin,row.case.id,before.revision,{type:'testWorkflow',workflowId:'native-self-test'});const after=(await v9CaseDetail(admin,row.case.id)).case;
 expect(after.state).toBe(state);expect(after.mails[0]).toMatchObject({test:true,to:[admin.userId],cc:[],documentIds:[]});expect(after.mails[0].delivery).not.toHaveProperty('contact');expect({tasks:after.tasks,documents:after.documents,runs:after.runs}).toEqual({tasks:before.tasks,documents:before.documents,runs:before.runs});
 const [job]=await owner.db.execute<{payload:{mail:{test:boolean;to:string[];cc:string[]}}}>(sql`select payload from lc_v9_email_delivery where onboarding_case_id=${row.case.id}::uuid`);expect(job.payload.mail).toMatchObject({test:true,to:[admin.userId],cc:[]});
});
