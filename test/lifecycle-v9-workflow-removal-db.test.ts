import { afterAll, beforeEach, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import type { Workflow } from '../lib/lifecycle-v9-model';
import { v9Setup, v9Workspace, v9SaveConfig, v9CreateOffboarding, v9Command, v9UploadFile, v9PreviewWorkflowRemoval, v9RemoveWorkflow, v9RestoreWorkflow } from '../packs/lifecycle/service';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser, type Base } from './harness';

let base: Base, admin: SessionContext, employee: SessionContext, employmentId: string, secondEmploymentId: string, secondPersonId: string;
beforeEach(async () => {
  await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'lifecycle', 'active'); admin = await entitledCtx(base);
  const subject = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'Fictional leaver', primaryEmail: 'leaver@test.invalid', phone: '+60123456789' } });
  employmentId = subject.employmentId;
  employee = { ...admin, userId: await createAppUser(base.tenantId, subject.personId, 'employee'), personId: subject.personId, roles: ['employee'], grants: undefined };
  const second = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'Fictional second leaver', primaryEmail: 'second@test.invalid' } });
  secondEmploymentId = second.employmentId; secondPersonId = second.personId;
  await v9Setup(admin);
});
afterAll(closeAll);

const draft = (id: string, name: string): Workflow => ({ id, name, module: 'off', status: 'draft', description: '', trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'notify', type: 'notify', subject: 'Fictional', body: '', to: ['employee'], cc: [] }] });
/** One live, automatic offboarding workflow whose run waits for a file on the submitted case. */
async function usedWorkflowCase() {
  const config = (await v9Workspace(admin)).config!;
  config.checklists = [...config.checklists.filter(checklist => checklist.module === 'onb'), { id: 'fixture', name: 'Focused exit', module: 'off', rules: {}, tasks: [{ id: 'handover', name: 'Complete handover', by: 'employee', group: null, mode: 'manual', opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'completed' }] }];
  config.templates.push({ id: 'fixture-form', name: 'Reviewed contact form', type: 'Form', module: 'off', rules: {}, hrStep: 'none', employeeAck: false, retired: false, versions: [{ version: 1, state: 'published', at: '', by: '', blocks: [{ id: 'body', type: 'text', text: 'Contact update for {employee.name}', section: '' }], fields: [{ id: 'mobile', label: 'Mobile', type: 'phone', owner: 'employee', pmKey: 'mobile', required: true, sensitive: false, options: [], section: 'main', when: null }, { id: 'confirm', label: 'Confirmation', type: 'checkbox', owner: 'employee', pmKey: null, required: true, sensitive: false, options: [], section: 'main', when: null }] }] });
  config.workflows = [{ id: 'fixture-release', name: 'Release form', module: 'off', status: 'published', trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'document', type: 'doc', template: 'fixture-form', release: true }, { id: 'supporting', type: 'waitFile', slot: 'fixture-support', label: 'Supporting file' }], description: '' }];
  await v9SaveConfig(admin, config.revision, config);
  const id = await v9CreateOffboarding(admin, { employmentId, type: 'Resignation', noticeDate: '2026-10-01', lastDay: '2026-11-01' });
  await v9Command(admin, id, 1, { type: 'submit' });
  return (await v9Workspace(admin)).cases.find(c => c.id === id)!;
}
const workflowEvents = (tenantId: string) => owner.client<{ event_type: string; actor_id: string | null; payload: Record<string, unknown> }[]>`select event_type,actor_id,payload from domain_event where tenant_id=${tenantId}::uuid and event_type in ('lifecycle-v9.workflowDeleted','lifecycle-v9.workflowRetired','lifecycle-v9.workflowRestored') order by sequence`;
async function retire(workflowId: string) {
  const preview = await v9PreviewWorkflowRemoval(admin, workflowId);
  return v9RemoveWorkflow(admin, { revision: preview.revision, workflowId, expected: { mode: preview.mode, cases: preview.cases, automatic: preview.automatic } });
}

it('permanently deletes a workflow no case has used and records the deletion', async () => {
  const config = (await v9Workspace(admin)).config!;
  config.workflows.push(draft('scratch', 'Scratch workflow'));
  await v9SaveConfig(admin, config.revision, config);
  const preview = await v9PreviewWorkflowRemoval(admin, 'scratch');
  expect(preview).toMatchObject({ workflowId: 'scratch', name: 'Scratch workflow', module: 'off', mode: 'delete', cases: 0, automatic: false });
  expect(await v9RemoveWorkflow(admin, { revision: preview.revision, workflowId: 'scratch', expected: { mode: 'delete', cases: 0, automatic: false } })).toEqual({ done: true, mode: 'delete', revision: preview.revision + 1 });
  const after = (await v9Workspace(admin)).config!;
  expect(after.revision).toBe(preview.revision + 1);
  expect(after.workflows.map(workflow => workflow.id)).not.toContain('scratch');
  expect(after.workflows.length).toBe(config.workflows.length - 1);
  const [kept] = await owner.client<{ data: { workflows: Workflow[] } }[]>`select data from lc_v9_config_revision where tenant_id=${base.tenantId}::uuid and revision=${preview.revision}`;
  expect(kept.data.workflows.some(workflow => workflow.id === 'scratch')).toBe(true);
  const events = await workflowEvents(base.tenantId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event_type: 'lifecycle-v9.workflowDeleted', actor_id: base.adminUserId, payload: { workflowId: 'scratch', name: 'Scratch workflow', module: 'off', outcome: 'deleted', cases: 0, stoppedAutomaticStart: false } });
  await expect(v9PreviewWorkflowRemoval(admin, 'scratch')).rejects.toThrow('Workflow not found');
});

it('retires a workflow with case history instead of deleting it, lets the running case finish and keeps it from new cases', async () => {
  const c = await usedWorkflowCase();
  expect(c.runs).toHaveLength(1); expect(c.runs[0]).toMatchObject({ workflowId: 'fixture-release', status: 'waiting' });
  const before = (await v9Workspace(admin)).config!.workflows.find(workflow => workflow.id === 'fixture-release')!;
  const preview = await v9PreviewWorkflowRemoval(admin, 'fixture-release');
  expect(preview).toMatchObject({ mode: 'retire', cases: 1, automatic: true, name: 'Release form' });
  // A confirmation made against an outdated decision changes nothing and returns the current one.
  expect(await v9RemoveWorkflow(admin, { revision: preview.revision, workflowId: 'fixture-release', expected: { mode: 'delete', cases: 0, automatic: true } })).toEqual({ done: false, preview });
  expect(await v9RemoveWorkflow(admin, { revision: preview.revision - 1, workflowId: 'fixture-release', expected: { mode: 'retire', cases: 1, automatic: true } })).toEqual({ done: false, preview });
  expect((await v9Workspace(admin)).config!.workflows.find(workflow => workflow.id === 'fixture-release')!.status).toBe('published');
  expect(await v9RemoveWorkflow(admin, { revision: preview.revision, workflowId: 'fixture-release', expected: { mode: 'retire', cases: 1, automatic: true } })).toEqual({ done: true, mode: 'retire', revision: preview.revision + 1 });

  const workspace = await v9Workspace(admin), retired = workspace.config!.workflows.find(workflow => workflow.id === 'fixture-release')!;
  expect(retired).toMatchObject({ status: 'retired', retired: { by: { id: base.adminUserId }, cases: 1, automatic: true } });
  expect(retired.steps).toEqual(before.steps); expect(retired.trigger).toEqual(before.trigger);
  await expect(v9PreviewWorkflowRemoval(admin, 'fixture-release')).rejects.toThrow('already retired');
  // A general settings save can neither re-activate, edit nor drop a retired workflow.
  const reactivated = structuredClone(workspace.config!); reactivated.workflows[0].status = 'published'; delete reactivated.workflows[0].retired;
  await expect(v9SaveConfig(admin, reactivated.revision, reactivated)).rejects.toThrow('Restore it before changing it');
  const dropped = structuredClone(workspace.config!); dropped.workflows = [];
  await expect(v9SaveConfig(admin, dropped.revision, dropped)).rejects.toThrow('kept for case history');

  // New cases neither start it automatically nor by hand.
  const second = await v9CreateOffboarding(admin, { employmentId: secondEmploymentId, type: 'Resignation', noticeDate: '2026-10-01', lastDay: '2026-11-01' });
  await v9Command(admin, second, 1, { type: 'submit' });
  const fresh = (await v9Workspace(admin)).cases.find(row => row.id === second)!;
  expect(fresh.runs).toEqual([]);
  await expect(v9Command(admin, second, fresh.revision, { type: 'startWorkflow', workflowId: 'fixture-release' })).rejects.toThrow('Choose a live workflow');
  await expect(v9Command(admin, second, fresh.revision, { type: 'testWorkflow', workflowId: 'fixture-release' })).rejects.toThrow('retired');

  // The case that already started keeps its saved steps and finishes when the awaited file arrives.
  const running = (await v9Workspace(admin)).cases.find(row => row.id === c.id)!;
  expect(running.runs[0].definition).toEqual(before);
  await v9UploadFile(admin, { caseId: c.id, revision: running.revision, slot: 'fixture-support', name: 'support.pdf', content: Buffer.from('%PDF-1.4\nfictional\n%%EOF') });
  const finished = (await v9Workspace(admin)).cases.find(row => row.id === c.id)!;
  expect(finished.runs).toHaveLength(1); expect(finished.runs[0]).toMatchObject({ workflowId: 'fixture-release', status: 'done' });
  expect(finished.runs[0].definition).toEqual(before);

  const events = await workflowEvents(base.tenantId);
  expect(events.map(event => event.event_type)).toEqual(['lifecycle-v9.workflowRetired']);
  expect(events[0]).toMatchObject({ actor_id: base.adminUserId, payload: { workflowId: 'fixture-release', name: 'Release form', outcome: 'retired', cases: 1, stoppedAutomaticStart: true } });
});

it('restores a retired workflow as a draft with its saved setup, refusing a duplicate active name', async () => {
  const c = await usedWorkflowCase();
  const before = (await v9Workspace(admin)).config!.workflows.find(workflow => workflow.id === 'fixture-release')!;
  expect(await retire('fixture-release')).toMatchObject({ done: true, mode: 'retire' });
  let config = (await v9Workspace(admin)).config!;
  config.workflows.push(draft('replacement', ' release FORM '));
  await v9SaveConfig(admin, config.revision, config);
  config = (await v9Workspace(admin)).config!;
  const caseBefore = (await v9Workspace(admin)).cases.find(row => row.id === c.id)!;
  await expect(v9RestoreWorkflow(admin, { revision: config.revision, workflowId: 'fixture-release' })).rejects.toThrow('Rename one of them before restoring');
  await expect(v9RestoreWorkflow(admin, { revision: config.revision - 1, workflowId: 'fixture-release', name: 'Release form (2025)' })).rejects.toThrow('Settings changed');
  await expect(v9RestoreWorkflow(admin, { revision: config.revision, workflowId: 'replacement' })).rejects.toThrow('Only a retired workflow');

  expect(await v9RestoreWorkflow(admin, { revision: config.revision, workflowId: 'fixture-release', name: 'Release form (2025)' })).toEqual({ revision: config.revision + 1 });
  const workspace = await v9Workspace(admin), restored = workspace.config!.workflows.find(workflow => workflow.id === 'fixture-release')!;
  expect(restored).toEqual({ ...before, name: 'Release form (2025)', status: 'draft' });
  expect(restored.retired).toBeUndefined();
  expect(workspace.cases.find(row => row.id === c.id)).toEqual(caseBefore);
  // A restored draft does not start for new cases until HR makes it live again.
  const second = await v9CreateOffboarding(admin, { employmentId: secondEmploymentId, type: 'Resignation', noticeDate: '2026-10-01', lastDay: '2026-11-01' });
  await v9Command(admin, second, 1, { type: 'submit' });
  expect((await v9Workspace(admin)).cases.find(row => row.id === second)!.runs).toEqual([]);

  const events = await workflowEvents(base.tenantId);
  expect(events.map(event => event.event_type)).toEqual(['lifecycle-v9.workflowRetired', 'lifecycle-v9.workflowRestored']);
  expect(events[1]).toMatchObject({ actor_id: base.adminUserId, payload: { workflowId: 'fixture-release', name: 'Release form (2025)', previousName: 'Release form', module: 'off', outcome: 'restored' } });
  await expect(v9RestoreWorkflow(admin, { revision: config.revision + 1, workflowId: 'fixture-release' })).rejects.toThrow('Only a retired workflow');
});

it('refuses callers who cannot edit workflows and keeps each tenant and company to its own workflows and case history', async () => {
  await usedWorkflowCase();
  let config = (await v9Workspace(admin)).config!;
  config.workflows.push(draft('scratch', 'Scratch workflow'));
  await v9SaveConfig(admin, config.revision, config);
  config = (await v9Workspace(admin)).config!;
  const expected = { mode: 'delete' as const, cases: 0, automatic: false };

  // An ordinary employee and a company-scoped HR administrator are not group workflow editors.
  const companyHrUser = await createAppUser(base.tenantId, secondPersonId, 'hr_admin');
  await owner.client`update role_assignment set company_id=${base.companyId}::uuid where tenant_id=${base.tenantId}::uuid and app_user_id=${companyHrUser}::uuid and role='hr_admin'`;
  const companyHr: SessionContext = { ...admin, userId: companyHrUser, personId: secondPersonId, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: base.companyId }] };
  for (const caller of [employee, companyHr]) {
    await expect(v9PreviewWorkflowRemoval(caller, 'scratch')).rejects.toThrow('permission');
    await expect(v9RemoveWorkflow(caller, { revision: config.revision, workflowId: 'scratch', expected })).rejects.toThrow('permission');
  }
  expect(await retire('fixture-release')).toMatchObject({ done: true });
  config = (await v9Workspace(admin)).config!;
  for (const caller of [employee, companyHr]) await expect(v9RestoreWorkflow(caller, { revision: config.revision, workflowId: 'fixture-release' })).rejects.toThrow('permission');

  // Another tenant cannot see, count or change this tenant's workflows, even with a colliding identifier.
  const foreignBase = await seedBase(); await setModule(foreignBase.tenantId, 'lifecycle', 'active');
  const foreign = await entitledCtx(foreignBase); await v9Setup(foreign);
  await expect(v9PreviewWorkflowRemoval(foreign, 'scratch')).rejects.toThrow('Workflow not found');
  const foreignConfig = (await v9Workspace(foreign)).config!;
  await expect(v9RemoveWorkflow(foreign, { revision: foreignConfig.revision, workflowId: 'scratch', expected })).rejects.toThrow('Workflow not found');
  await expect(v9RestoreWorkflow(foreign, { revision: foreignConfig.revision, workflowId: 'fixture-release' })).rejects.toThrow('Workflow not found');
  foreignConfig.workflows.push({ ...draft('fixture-release', 'Release form'), status: 'draft' });
  await v9SaveConfig(foreign, foreignConfig.revision, foreignConfig);
  const foreignPreview = await v9PreviewWorkflowRemoval(foreign, 'fixture-release');
  expect(foreignPreview).toMatchObject({ mode: 'delete', cases: 0 });
  expect(await v9RemoveWorkflow(foreign, { revision: foreignPreview.revision, workflowId: 'fixture-release', expected: { mode: 'delete', cases: 0, automatic: false } })).toMatchObject({ done: true, mode: 'delete' });

  const after = (await v9Workspace(admin)).config!;
  expect(after.revision).toBe(config.revision);
  expect(after.workflows.find(workflow => workflow.id === 'fixture-release')!.status).toBe('retired');
  expect(after.workflows.some(workflow => workflow.id === 'scratch')).toBe(true);
  expect((await workflowEvents(base.tenantId)).map(event => event.event_type)).toEqual(['lifecycle-v9.workflowRetired']);
  expect((await workflowEvents(foreignBase.tenantId)).map(event => event.payload.outcome)).toEqual(['deleted']);
});
