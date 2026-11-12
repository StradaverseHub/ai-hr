/** Board 4a60b3ec: the held-email register is written and released with the case, and the Inbox rechecks access. */
import { afterAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { v9Setup, v9SaveConfig, v9CreateOffboarding, v9Command, v9CaseDetail, v9Workspace, v9EmailHoldInbox, onboardingContext, onboardingSaveConfig } from '../packs/lifecycle/service';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner, type Base } from './harness';

let base: Base, admin: SessionContext, employmentId: string;
beforeEach(async () => {
  await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'lifecycle', 'active'); admin = await entitledCtx(base);
  const subject = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'Fictional held subject', primaryEmail: 'held.subject@test.invalid' } });
  employmentId = subject.employmentId;
  await v9Setup(admin);
  const native = await onboardingContext(admin); native.config.access.offboarding = [admin.userId!]; await onboardingSaveConfig(admin, native.revision, native.config);
});
afterAll(closeAll);
async function heldCase() {
  const config = (await v9Workspace(admin)).config!;
  config.checklists = config.checklists.filter(checklist => checklist.module === 'onb');
  config.companies = [];
  config.workflows = [{ id: 'held', name: 'Fictional held notice', module: 'off', status: 'published', trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'notice', type: 'notify', subject: 'Fictional notice', body: 'Fictional body', to: ['employeeWork'], cc: ['hrSignatory'] }], description: '' }];
  await v9SaveConfig(admin, config.revision, config);
  const id = await v9CreateOffboarding(admin, { employmentId, type: 'Resignation', noticeDate: '2026-10-01', lastDay: '2026-12-01' });
  await v9Command(admin, id, 1, { type: 'submit' });
  return (await v9CaseDetail(admin, id)).case;
}
const register = (caseId: string) => owner.client`select step_id,workflow_name,email_name,missing,released_at,released_by from lc_v9_email_hold where case_id=${caseId}::uuid order by held_at`;

it('writes the hold with the case, shows it in the Inbox and releases it when the email is sent after Continue', async () => {
  const c = await heldCase();
  expect(c.runs[0]).toMatchObject({ status: 'waiting', hold: { stepId: 'notice', missing: [{ role: 'hrSignatory', label: 'HR signatory', reason: 'no HR signatory is set for the company' }] } });
  expect(c.mails.filter(mail => mail.workflowId)).toEqual([]);
  const alert = c.mails.find(mail => mail.key.startsWith('hold-alert:'));
  expect(alert).toMatchObject({ to: [admin.userId], workflowId: null, status: 'pending' });
  expect(await register(c.id)).toEqual([{ step_id: 'notice', workflow_name: 'Fictional held notice', email_name: 'Fictional notice', missing: [{ label: 'HR signatory', reason: 'no HR signatory is set for the company' }], released_at: null, released_by: null }]);
  expect(await v9EmailHoldInbox(admin)).toMatchObject({ count: 1, items: [{ caseId: c.id, module: 'off', number: c.number, name: 'Fictional held subject', email: 'Fictional notice', workflow: 'Fictional held notice' }] });
  // The alert and register carry labels only, never an address.
  expect(JSON.stringify(await register(c.id))).not.toContain('@');
  await v9Command(admin, c.id, c.revision, { type: 'recipientsOverride', workflowId: 'held', stepId: 'notice', to: ['employeeWork'], cc: [] });
  let current = (await v9CaseDetail(admin, c.id)).case;
  expect(current.runs[0].hold).toBeDefined(); expect((await register(c.id))[0].released_at).toBeNull();
  await v9Command(admin, c.id, current.revision, { type: 'retryWorkflow', workflowId: 'held' });
  current = (await v9CaseDetail(admin, c.id)).case;
  expect(current.runs[0].hold).toBeUndefined();
  expect(current.mails.filter(mail => mail.workflowId === 'held')).toMatchObject([{ to: ['address:held.subject@test.invalid'], cc: [] }]);
  const [released] = await register(c.id); expect(released.released_at).not.toBeNull(); expect(released.released_by).toBe(admin.userId);
  expect(await v9EmailHoldInbox(admin)).toEqual({ count: 0, items: [] });
  const events = await owner.client`select payload from domain_event where event_type='lifecycle-v9.recipientsChanged'`;
  expect(events).toHaveLength(1); expect(events[0].payload).toMatchObject({ caseId: c.id, workflowId: 'held', stepId: 'notice', cleared: false, to: ['employeeWork'], cc: [] });
});

it('hides holds from another tenant and from a user who loses Full case view, and closes them with the case', async () => {
  const c = await heldCase();
  const foreign = await seedBase(); await setModule(foreign.tenantId, 'lifecycle', 'active'); const foreignAdmin = await entitledCtx(foreign);
  expect(await withTenant(foreignAdmin, tx => tx.execute(sql`select id from lc_v9_email_hold`))).toEqual([]);
  expect(await v9EmailHoldInbox(foreignAdmin)).toEqual({ count: 0, items: [] });
  const native = await onboardingContext(admin); native.config.access.offboarding = []; await onboardingSaveConfig(admin, native.revision, native.config);
  expect(await v9EmailHoldInbox(admin)).toEqual({ count: 0, items: [] });
  native.config.access.offboarding = [admin.userId!]; await onboardingSaveConfig(admin, (await onboardingContext(admin)).revision, native.config);
  expect((await v9EmailHoldInbox(admin)).count).toBe(1);
  await v9Command(admin, c.id, c.revision, { type: 'cancel', reason: 'Fictional cancellation' });
  expect((await register(c.id))[0].released_at).not.toBeNull();
  expect(await v9EmailHoldInbox(admin)).toEqual({ count: 0, items: [] });
});
