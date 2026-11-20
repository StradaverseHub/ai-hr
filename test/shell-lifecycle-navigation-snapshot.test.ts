import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { lifecycleModuleNavigation } from '../app/lifecycle/workflow-availability';
import { requestScopedReadStats } from '../db/client';
import { withRequestReadScope } from '../lib/request-read-scope';
import { readShellLifecycleNavigation } from '../lib/shell-lifecycle-navigation';
import { onboardingNavigation } from '../packs/lifecycle/service';
import { offboardingPostingAccess } from '../packs/personnel-postings/service';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, migrateTestDb, resetDb, seedBase, setModule } from './harness';

afterAll(closeAll);

it('shares one request snapshot for the rail without changing the lifecycle owners’ results', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  await setModule(base.tenantId, 'lifecycle', 'active');
  const group = await buildScaleFixture(base, { employments: 1000, events: 0 });
  expect(group.companyIds).toHaveLength(71);
  expect(group.employmentIds).toHaveLength(1000);

  const receipts = [];
  for (const [role, session] of [['group', group.personas.group], ['company', group.personas.single]] as const) {
    const before = performance.now();
    const expected = await Promise.all([
      onboardingNavigation(session),
      lifecycleModuleNavigation(session),
      offboardingPostingAccess(session).catch(() => false),
    ]);
    const originalMs = Math.round(performance.now() - before);
    expect(expected[0].master).toBe(role === 'group');

    const scope = {};
    const start = performance.now();
    const actual = await withRequestReadScope(scope, () => readShellLifecycleNavigation(session, true));
    const sharedMs = Math.round(performance.now() - start);
    expect(actual).toEqual(expected);
    const stats = await requestScopedReadStats(scope);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ carriers: 1, joins: 4, fallbacks: 0 });

    const [legacyDisabled, scoped, postings] = await readShellLifecycleNavigation(session, false);
    expect(legacyDisabled).toMatchObject({ module: false, v9: false, joiners: 0, checklists: 0 });
    expect(scoped).toEqual(expected[1]);
    expect(postings).toBe(false);
    receipts.push({ role, originalMs, sharedMs, carriers: stats[0].carriers, joins: stats[0].joins });
  }

  const directory = process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if (directory) writeFileSync(join(directory, 'shell-lifecycle-navigation-snapshot.json'), JSON.stringify({
    source: process.env.AIHR_CI_HEAD, companies: group.companyIds.length, employments: group.employmentIds.length, receipts,
  }));
}, 120000);
