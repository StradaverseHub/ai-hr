/** Compare the two existing, permission-checked projections used around Personnel filter fingerprints. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTenant } from '../../db/client';
import { workforceViewScope } from '../../core/workforce-access';
import { closeAll, migrateTestDb } from '../harness';
import { restoreWorkforceCapabilityCatalogue } from './personnel-scale-fixture';
import { seedPersonnelSearchFixture } from './personnel-search-fixture';

const uuidArray = (ids: readonly string[]) => sql`ARRAY[${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[]`;

beforeAll(migrateTestDb);
afterAll(async () => {
  try {
    await restoreWorkforceCapabilityCatalogue();
  } finally {
    await closeAll();
  }
}, 120_000);

it('projects the same complete filter facts for a bounded candidate set across scopes', async () => {
  const count = process.env.AIHR_FOCUSED_SUITE_CAPACITY === 'true' ? 10_000 : 1_000;
  const fixture = await seedPersonnelSearchFixture({ count, companies: 76, runs: 8 });
  const cases = [
    { label: 'group-all', actor: fixture.admin, scope: fixture.companies },
    { label: 'group-single', actor: fixture.admin, scope: [fixture.companies[0]] },
    { label: 'scoped-hr', actor: fixture.manager, scope: (await workforceViewScope(fixture.manager, { personnelList: true })).companyIds },
    { label: 'capability-viewer', actor: fixture.viewer, scope: (await workforceViewScope(fixture.viewer, { personnelList: true })).companyIds },
  ];
  const comparisons = [];
  for (const { label, actor, scope } of cases) {
    const result = await withTenant(actor, async tx => {
      const companies = uuidArray(scope);
      const visible = await tx.execute<{ id: string }>(sql`
        select value->>'employmentId' as id
        from app.personnel_search_rows(${companies}) as src(value)
        order by id limit 8`);
      expect(visible).toHaveLength(8);
      // Include a non-existent candidate so a point read cannot manufacture an admitted row.
      const ids = uuidArray([...visible.map(row => row.id), '00000000-0000-0000-0000-000000000000']);
      const readers = {
        full: sql`with listed as materialized (
          select value from app.personnel_list_rows(${fixture.today}::date, ${companies}) as src(value)
        ) select value from listed where (value->>'employmentId')::uuid = any(${ids})
          order by value->>'employmentId'`,
        bounded: sql`select value from app.personnel_list_rows_for_ids(${fixture.today}::date, ${companies}, ${ids}) as src(value)
          order by value->>'employmentId'`,
      };
      const timings = { full: [] as number[], bounded: [] as number[] };
      for (const order of [['full', 'bounded'], ['bounded', 'full']] as const) {
        const outputs = new Map<string, Record<string, unknown>[]>();
        for (const variant of order) {
          const start = performance.now();
          const rows = await tx.execute<{ value: Record<string, unknown> }>(readers[variant]);
          timings[variant].push(Math.round(performance.now() - start));
          outputs.set(variant, rows.map(row => row.value));
        }
        const full = outputs.get('full')!;
        expect(full).toHaveLength(8);
        expect(full.every(row => typeof row.filterRevision === 'string')).toBe(true);
        expect(outputs.get('bounded')).toEqual(full);
      }
      return timings;
    }, { readOnlySnapshot: true });
    comparisons.push({ label, companies: scope.length, ...result });
  }
  const evidence = { kind: 'PERSONNEL_FILTER_PROJECTION_COMPONENT_ONLY', companies: fixture.companies.length, employments: count, comparisons };
  console.info(JSON.stringify(evidence));
  if (process.env.AIHR_FOCUSED_EVIDENCE_DIR) {
    writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR, 'personnel-bounded-filter-projection.json'), JSON.stringify(evidence));
  }
}, 180_000);
