/** Compare the two existing, permission-checked projections used around Personnel filter fingerprints. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTenant } from '../../db/client';
import { workforceViewScope } from '../../core/workforce-access';
import { closeAll, migrateTestDb, owner } from '../harness';
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
    // The fixture owner chooses only synthetic candidate IDs. Both readers still run under the
    // real application role, and neither learns anything through this seed lookup at runtime.
    const candidates = await owner.client<{ id: string }[]>`
      select id from employment where tenant_id=${fixture.base.tenantId}::uuid
        and company_id=any(${scope}::uuid[]) and voided_at is null
      order by id limit 8`;
    expect(candidates).toHaveLength(8);
    const companies = uuidArray(scope);
    const ids = uuidArray([...candidates.map(row => row.id), '00000000-0000-0000-0000-000000000000']);
    const readers = {
      full: sql`with listed as materialized (
        select value from app.personnel_list_rows(${fixture.today}::date, ${companies}) as src(value)
      ) select value from listed where (value->>'employmentId')::uuid = any(${ids})
        order by value->>'employmentId'`,
      bounded: sql`select value from app.personnel_list_rows_for_ids(${fixture.today}::date, ${companies}, ${ids}) as src(value)
        order by value->>'employmentId'`,
    };
    const timings = { full: [] as number[], bounded: [] as number[] };
    const compare = async (variant: keyof typeof readers) => {
      const start = performance.now();
      try {
        const rows = await withTenant(actor, tx => tx.execute<{ value: Record<string, unknown> }>(readers[variant]), { readOnlySnapshot: true });
        const values = rows.map(row => row.value);
        expect(values.every(row => typeof row.filterRevision === 'string')).toBe(true);
        return { values };
      } catch (error) {
        const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
        if (code !== '42501') throw error;
        return { refusal: code };
      } finally {
        timings[variant].push(Math.round(performance.now() - start));
      }
    };
    let equivalent = true;
    const outcomes = new Set<string>();
    for (const [first, second] of [['full', 'bounded'], ['bounded', 'full']] as const) {
      const left = await compare(first);
      const right = await compare(second);
      for (const outcome of [left, right]) outcomes.add('refusal' in outcome ? 'refused' : 'returned');
      try {
        expect(right).toEqual(left);
      } catch {
        equivalent = false;
      }
    }
    comparisons.push({ label, companies: scope.length, outcomes: [...outcomes], equivalent, ...timings });
  }
  const evidence = { kind: 'PERSONNEL_FILTER_PROJECTION_COMPONENT_ONLY', companies: fixture.companies.length, employments: count, comparisons };
  console.info(JSON.stringify(evidence));
  if (process.env.AIHR_FOCUSED_EVIDENCE_DIR) {
    writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR, 'personnel-bounded-filter-projection.json'), JSON.stringify(evidence));
  }
  expect(comparisons.filter(row => !row.equivalent).map(row => row.label)).toEqual([]);
  expect(comparisons.find(row => row.label === 'group-all')?.outcomes).toEqual(['returned']);
}, 180_000);
