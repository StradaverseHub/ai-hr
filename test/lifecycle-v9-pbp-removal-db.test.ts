/** Board 42f2b8a9: populated rollout preserves history, keeps old pods safe and does not rewrite recipients. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { v9Setup, v9Workspace, v9CreateOffboarding, v9SaveConfig } from '../packs/lifecycle/service';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner } from './harness';

const migration = readFileSync('db/migrations/6103_lifecycle_pbp_removal.sql', 'utf8');
beforeEach(async () => { await resetDb(); });
afterAll(closeAll);
it('clears populated routing and case overrides with coherent revisions and system audit, retaining canonical SQL and saved recipients', async () => {
  const base = await seedBase(); await setModule(base.tenantId, 'lifecycle', 'active'); const admin = await entitledCtx(base);
  const employee = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, employmentType: 'full_time', hiredOn: '2026-01-01', person: { fullName: 'Fictional migration subject', primaryEmail: 'migration.subject@test.invalid' } });
  await v9Setup(admin);
  const caseId = await v9CreateOffboarding(admin, { employmentId: employee.employmentId, type: 'Resignation', noticeDate: '2026-10-01', lastDay: '2026-12-01' });
  const config = (await v9Workspace(admin)).config!;
  const priorConfig = { ...config, bpRules: [{ rules: {}, userId: admin.userId }], caseForms: { off: [{ key: 'pbp', label: 'People Business Partner', type: 'text', show: false, required: false, hrOnly: false, rules: {}, options: [], help: '' }] } };
  // Historical/test definitions may retain PBP under the owner's explicit exception; never rewrite them.
  priorConfig.workflows[0].steps = [{ id: 'legacy', type: 'notify', subject: 'Legacy subject', body: '', to: ['pbp'], cc: ['peopleOps'] }];
  priorConfig.emails[0].cc = ['pbp'];
  await owner.client`update lc_v9_config set data=${JSON.stringify(priorConfig)}::jsonb where tenant_id=${base.tenantId}::uuid`;
  await owner.client`update lc_v9_case set data=jsonb_set(data,'{facts,pbpUserId}',to_jsonb(${admin.userId}::text)) where id=${caseId}::uuid`;
  const [before] = await owner.client`select revision,data from lc_v9_case where id=${caseId}::uuid`;
  const signatures = ['app.lifecycle_canonical_pbp_user(uuid,uuid)', 'app.lifecycle_canonical_pbp_scope(uuid,uuid,uuid)', 'app.lc_v9_onboarding_shell()'];
  const definitions = await owner.client`select oid::regprocedure::text as identity,pg_get_functiondef(oid) as definition from pg_proc where oid=any(${signatures}::regprocedure[]) order by oid::regprocedure::text`;
  const apply = () => owner.client.begin(async tx => { for (const statement of migration.split('--> statement-breakpoint')) await tx.unsafe(statement); });
  await apply();
  const [afterConfig] = await owner.client`select revision,data from lc_v9_config where tenant_id=${base.tenantId}::uuid`;
  expect(afterConfig.revision).toBe(config.revision + 1);
  expect(afterConfig.data).toMatchObject({ revision: config.revision + 1, bpRules: [], caseForms: { off: [] } });
  expect(afterConfig.data.workflows).toEqual(priorConfig.workflows); expect(afterConfig.data.emails).toEqual(priorConfig.emails);
  const [configHistory] = await owner.client`select data,actor_user_id from lc_v9_config_revision where tenant_id=${base.tenantId}::uuid and revision=${config.revision}`;
  expect(configHistory).toEqual({ data: priorConfig, actor_user_id: null });
  const [after] = await owner.client`select revision,data from lc_v9_case where id=${caseId}::uuid`;
  expect(after.revision).toBe(before.revision + 1); expect(after.data.revision).toBe(after.revision);
  expect(after.data.facts.pbpUserId).toBeNull();
  expect(after.data.log.at(-1)).toMatchObject({ action: 'case.pbpCleared', actor: { id: 'system', name: 'System' } });
  const [caseHistory] = await owner.client`select data,actor_user_id from lc_v9_case_revision where case_id=${caseId}::uuid and revision=${before.revision}`;
  expect(caseHistory).toEqual({ data: before.data, actor_user_id: null });
  expect(await owner.client`select event_type,actor_type,actor_id from domain_event where tenant_id=${base.tenantId}::uuid and payload->>'migration'='6103_lifecycle_pbp_removal' order by event_type`).toEqual([
    { event_type: 'lifecycle-v9.case.pbpCleared', actor_type: 'system', actor_id: null },
    { event_type: 'lifecycle-v9.pbp-routing-removed', actor_type: 'system', actor_id: null },
  ]);
  expect(await owner.client`select oid::regprocedure::text as identity,pg_get_functiondef(oid) as definition from pg_proc where oid=any(${signatures}::regprocedure[]) order by oid::regprocedure::text`).toEqual(definitions);
  await apply();
  expect((await owner.client`select revision from lc_v9_case where id=${caseId}::uuid`)[0].revision).toBe(after.revision);
  expect((await owner.client`select revision from lc_v9_config where tenant_id=${base.tenantId}::uuid`)[0].revision).toBe(afterConfig.revision);
  // An old browser payload can still save after removing the legacy recipient from the edited definition.
  const latest = (await v9Workspace(admin)).config!;
  expect(latest).not.toHaveProperty('bpRules');
  latest.workflows[0].steps = [{ id: 'legacy', type: 'notify', subject: 'Updated subject', body: '', to: ['peopleOps'], cc: [] }];
  latest.emails[0].cc = [];
  await v9SaveConfig(admin, latest.revision, { ...latest, bpRules: [{ rules: {}, userId: admin.userId }] });
  expect((await owner.client`select data from lc_v9_config where tenant_id=${base.tenantId}::uuid`)[0].data).not.toHaveProperty('bpRules');
});
