/** Prepare and drain one payroll correction in the workflow-owned fictional database. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const env = process.env;
assert(env.GITHUB_ACTIONS === 'true' && env.CI === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted');
assert(env.GITHUB_REPOSITORY === 'StradaverseHub/ai-hr' && env.GITHUB_EVENT_NAME === 'workflow_dispatch');
assert(env.GITHUB_WORKFLOW === 'alpha-focused-checks' && env.GITHUB_JOB === 'selected-tests');
assert(env.AIHR_BROWSER_STATIC_SHARD === 'payroll-corrections' && env.AUTH_PROVIDER === 'internal');
assert.equal(env.DATABASE_URL, 'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev');
assert.equal(env.MIGRATION_DATABASE_URL, 'postgres://postgres@127.0.0.1:5433/ai_hr_dev');
const mode = process.argv[2];
assert(mode === 'seed' || mode === 'drain');
const fixture = JSON.parse(readFileSync(resolve(env.PERF_PRIVATE_DIR, 'fixture.json'), 'utf8'));
const [group] = fixture.users;
const subject = fixture.users[4];
const { batchId } = fixture.tenants[0].companies[0];
assert(fixture.users.length === 500 && fixture.tenants.length === 2);
assert(group.role === 'groupHR' && subject.role === 'employee' && group.tenant === 0 && subject.tenant === 0);
assert(group.tenantId === subject.tenantId && group.companyId === subject.companyId && group.batchId === batchId);
const source = file => import(pathToFileURL(resolve(process.cwd(), file)).href);
const {client,createDb} = await source('db/client.ts');
const owner = createDb(env.MIGRATION_DATABASE_URL, {max: 1});
try {
  if (mode === 'seed') {
    await owner.client.begin(async tx => {
      await tx`select set_config('app.tenant_id', ${group.tenantId}, true)`;
      await tx`insert into tenant_module (tenant_id, module_code, status)
        values (${group.tenantId}::uuid, 'multi_cycle_payroll', 'active')`;
      await tx`insert into tenant_setting (tenant_id, key, value, source)
        values (${group.tenantId}::uuid, 'payroll.reset_enabled', 'true'::jsonb, 'platform')
        on conflict (tenant_id, key) do update set value = excluded.value, source = excluded.source`;
    });
    const {resolveEntitlementsTx} = await source('core/entitlements.ts');
    const {generatePayslips} = await source('packs/payroll/service.ts');
    const grants = [{role: 'employee', companyId: group.companyId}, {role: 'hr_admin', companyId: null},
      {role: 'payroll_partner', companyId: null}, {role: 'performance_comp_partner', companyId: null}];
    await generatePayslips({
      tenantId: group.tenantId, userId: group.userId, personId: group.personId,
      grants, roles: grants.map(grant => grant.role),
      entitlements: await owner.db.transaction(tx => resolveEntitlementsTx(tx, group.tenantId)),
    }, {batchId});
  } else {
    const {runBulkJobTick} = await source('core/bulk-job-worker.ts');
    const {payrollReprocessJobHandler} = await source('core/payroll-reprocess-job.ts');
    const readJob = () => owner.client`
      select status, employment_ids from payroll_reprocess_job
      where tenant_id = ${group.tenantId}::uuid and batch_id = ${batchId}::uuid
    `;
    const [job, extra] = await readJob();
    assert(job?.status === 'queued' && !extra && job.employment_ids.length === 1
      && job.employment_ids[0] === subject.employmentId, 'Expected a single acknowledged fictional correction');
    for (let step = 0; step < 20; step++) {
      await runBulkJobTick(owner.client, {handlers: [payrollReprocessJobHandler]});
      const [state] = await readJob();
      if (state?.status === 'completed') break;
      assert(state?.status !== 'failed', 'Fictional correction worker failed');
    }
    assert((await readJob())[0]?.status === 'completed', 'Fictional correction worker did not complete');
  }
} finally {
  await Promise.all([owner.client.end({timeout: 5}),client.end({timeout: 5})]);
}
