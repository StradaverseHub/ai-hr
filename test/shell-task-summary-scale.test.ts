import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  requestScopedReadStats,
  withBackgroundReadWork,
  withSharedReadSnapshot,
} from '../db/client';
import '../core/home-request-preamble';
import { pendingTaskSummary } from '../core/approvals-inbox';
import { readShellTaskSummary } from '../lib/shell-task-summary';
import { createClaimType } from '../packs/claims/service';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

afterAll(closeAll);

it('preserves the exact shell task summary across group and selected-company reads at scale', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  for (const code of ['attendance', 'claims', 'performance', 'recruitment', 'rewards', 'lifecycle']) {
    await setModule(base.tenantId, code, 'active');
  }
  const group = await buildScaleFixture(base, { employments: 1000, events: 0 });
  const claimType = await createClaimType(await entitledCtx(base), {
    code: 'SHELLSCALE',
    name: 'Fictional shell count diagnostic',
    defaultTaxable: false,
    requiresReceipt: false,
  });
  await owner.client`
    insert into claim_request (tenant_id, employment_id, claim_type_id, amount, incurred_on, description, status)
    select e.tenant_id, e.id, ${claimType.id}::uuid, '12.50', '2026-02-02', 'Fictional pending claim', 'pending'
    from employment e cross join generate_series(1, 10)
    where e.tenant_id = ${base.tenantId}::uuid and e.terminated_on is null
  `;
  await owner.client`analyze claim_request`;
  expect(group.companyIds).toHaveLength(71);
  expect(group.employmentIds).toHaveLength(1000);

  const modules = {
    attendance: true, claims: true, performance: true,
    recruitment: true, rewards: true, probation: true,
  };
  const cases = [
    { name: 'group-all', session: group.personas.group, scopeIds: [...group.companyIds] },
    { name: 'group-selected', session: group.personas.group, scopeIds: [group.singleCompanyId] },
    { name: 'company-hr', session: group.personas.single, scopeIds: [group.singleCompanyId] },
  ];

  const receipts = [];
  for (const { name, session, scopeIds } of cases) {
    const measure = async (candidate: boolean) => {
      const scope = {};
      const started = performance.now();
      const summary = await withBackgroundReadWork(session.tenantId, () => withSharedReadSnapshot(
        session,
        () => candidate ? readShellTaskSummary(session, scopeIds, modules)
          : pendingTaskSummary(session, scopeIds, modules, { deferClaimPreview: true }),
        undefined,
        scope,
      ));
      const snapshots = await requestScopedReadStats(scope);
      return {
        summary,
        sample: {
          elapsedMs: Math.round(performance.now() - started),
          statements: snapshots.reduce((total, stats) => total + stats.statements, 0),
          fallbacks: snapshots.reduce((total, stats) => total + stats.fallbacks, 0),
        },
      };
    };

    const baseline = await measure(false);
    const candidate = await measure(true);
    expect(candidate.summary).toEqual(baseline.summary);
    expect(candidate.summary.claimTotal).toBeGreaterThan(25);
    expect(candidate.summary.items.every(item => item.kind !== 'claim')).toBe(true);

    const samples = [{ baseline: baseline.sample, candidate: candidate.sample }];
    if (process.env.AIHR_FOCUSED_EVIDENCE_DIR) {
      for (let pair = 1; pair <= 4; pair++) {
        const left = await measure(pair % 2 === 1);
        const right = await measure(pair % 2 === 0);
        expect(left.summary).toEqual(right.summary);
        samples.push(pair % 2 === 1
          ? { baseline: right.sample, candidate: left.sample }
          : { baseline: left.sample, candidate: right.sample });
      }
    }
    receipts.push({ name, claimTotal: candidate.summary.claimTotal, samples });
  }

  const evidenceDir = process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if (evidenceDir) writeFileSync(join(evidenceDir, 'shell-task-summary-scale.json'), JSON.stringify({
    source: process.env.AIHR_CI_HEAD, companies: group.companyIds.length,
    employments: group.employmentIds.length, receipts,
  }));
}, 120000);
