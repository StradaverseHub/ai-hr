/** Compare the pending append-only repair to both independent 2127 bodies as the real app login. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase } from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

const original = readFileSync(new URL('../db/migrations/2127_personnel_filter_search.sql', import.meta.url), 'utf8');
const draft = readFileSync(new URL('./fixtures/personnel-projection-candidate.sql', import.meta.url), 'utf8');
const oracleNames = {
  'app.personnel_filter_rows': 'app.fixture_personnel_projection_oracle',
  'app.employment_organisation_quality': 'app.fixture_personnel_quality_oracle',
};
const candidateNames = {
  'app.personnel_filter_rows': 'app.fixture_personnel_projection_candidate',
  'app.employment_organisation_quality': 'app.fixture_personnel_quality_candidate',
  'app.employment_organisation_quality_flags': 'app.fixture_personnel_flags_candidate',
};

function aliasFunctions(source: string, aliases: Record<string, string>): string {
  // Exact function-name substitutions leave longer identifiers and each original body intact.
  for (const [originalName, alias] of Object.entries(aliases)) {
    source = source.replaceAll(originalName + '(', alias + '(');
  }
  return source;
}

async function installFixtureFunctions() {
  const oracle = original.split('--> statement-breakpoint').filter(block =>
    Object.keys(oracleNames).some(name => block.includes('CREATE FUNCTION ' + name + '(')));
  expect(oracle).toHaveLength(2);
  await owner.client.begin(async tx => {
    await tx.unsafe(aliasFunctions(oracle.join('\n'), oracleNames)).simple();
    await tx.unsafe(aliasFunctions(draft, candidateNames)).simple();
    await tx.unsafe(`
      REVOKE ALL ON FUNCTION app.fixture_personnel_projection_candidate(date,uuid[]) FROM PUBLIC;
      REVOKE ALL ON FUNCTION app.fixture_personnel_quality_candidate(uuid,date) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION app.fixture_personnel_projection_candidate(date,uuid[]) TO ai_hr_app;
      GRANT EXECUTE ON FUNCTION app.fixture_personnel_quality_candidate(uuid,date) TO ai_hr_app;
    `).simple();
  });
}

async function dropFixtureFunctions() {
  await owner.client.unsafe(`
    DROP FUNCTION app.fixture_personnel_projection_candidate(date,uuid[]);
    DROP FUNCTION app.fixture_personnel_projection_oracle(date,uuid[]);
    DROP FUNCTION app.fixture_personnel_quality_candidate(uuid,date);
    DROP FUNCTION app.fixture_personnel_quality_oracle(uuid,date);
    DROP FUNCTION app.fixture_personnel_flags_candidate(uuid,date,date,uuid,jsonb);
  `).simple();
}

type ProjectedRow = {
  employmentId: string;
  companyId: string;
  reportingTo: string | null;
  quality: { missing_direct_superior: boolean };
};

async function compareProjection(ctx: SessionContext, asOf: string, companyIds: string[] | null, expectedIds: string[]) {
  const scope = companyIds === null ? sql`null::uuid[]`
    : sql`ARRAY[${sql.join(companyIds.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
  return withTenant(ctx, async tx => {
    const [result] = await tx.execute<{ role: string; differs: boolean; rows: ProjectedRow[] }>(sql`
      with oracle as materialized (
        select value from app.fixture_personnel_projection_oracle(${asOf}::date,${scope}) as t(value)
      ), candidate as materialized (
        select value from app.fixture_personnel_projection_candidate(${asOf}::date,${scope}) as t(value)
      ), diff as (
        (select value from oracle except all select value from candidate)
        union all
        (select value from candidate except all select value from oracle)
      )
      select current_user as role, exists(select 1 from diff) as differs,
        (select coalesce(jsonb_agg(value), '[]'::jsonb) from candidate) as rows
    `);
    expect(result.role).toBe('ai_hr_app');
    expect(result.differs, 'the JSONB row multisets must be identical').toBe(false);
    expect(result.rows.map(row => row.employmentId).sort()).toEqual([...expectedIds].sort());
    return result.rows;
  });
}

it('matches the full 2127 rows and quality across dated, narrowed and denied company scopes', async () => {
  await resetDb();
  const base = await seedBase();
  const group = adminCtx(base);
  const foreign = await seedBase();
  const [other] = await owner.db.insert(schema.company).values({
    tenantId: base.tenantId, legalName: 'Fictional second company',
  }).returning();
  const [department] = await owner.db.insert(schema.department).values({
    tenantId: base.tenantId, companyId: other.id, name: 'Fictional second department',
  }).returning();
  const hire = (ctx: SessionContext, companyId: string, departmentId: string, fullName: string) =>
    hireEmployee(ctx, {
      person: { fullName, primaryEmail: randomUUID() + '@fixture.test' },
      companyId, departmentId, employmentType: 'full_time', hiredOn: '2024-01-01',
    });

  const employee = await hire(group, base.companyId, base.deptA, 'Fictional employee');
  const manager = await hire(group, other.id, department.id, 'Fictional manager');
  await hire(adminCtx(foreign), foreign.companyId, foreign.deptA, 'Fictional foreign employee');
  await owner.db.insert(schema.reportingLine).values({
    tenantId: base.tenantId, subordinateEmploymentId: employee.employmentId,
    managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2025-01-01',
  });
  const userId = await createAppUser(base.tenantId, null, 'employee');
  await owner.db.insert(schema.roleAssignment).values({
    tenantId: base.tenantId, appUserId: userId, role: 'hr_admin', companyId: base.companyId,
  });
  const restricted: SessionContext = {
    ...group, userId, roles: ['employee', 'hr_admin'],
    grants: [{ role: 'employee', companyId: null }, { role: 'hr_admin', companyId: base.companyId }],
  };

  await installFixtureFunctions();
  try {
    const current = '2026-01-01';
    const historical = '2024-07-01';
    await compareProjection(group, current, null, [employee.employmentId, manager.employmentId]);
    await compareProjection(group, current, [], []);
    const [narrowed] = await compareProjection(group, current, [base.companyId], [employee.employmentId]);
    expect(narrowed).toMatchObject({
      companyId: base.companyId, reportingTo: 'Fictional manager', quality: { missing_direct_superior: false },
    });
    const [prior] = await compareProjection(group, historical, [base.companyId], [employee.employmentId]);
    expect(prior).toMatchObject({ reportingTo: null, quality: { missing_direct_superior: true } });
    const [scoped] = await compareProjection(
      restricted, current, [base.companyId, other.id, foreign.companyId], [employee.employmentId],
    );
    expect(scoped).toMatchObject({ companyId: base.companyId, reportingTo: null });
    await compareProjection(restricted, current, [other.id, foreign.companyId], []);

    const [quality] = await withTenant(group, tx => tx.execute<{ equal: boolean; canCallHelper: boolean }>(sql`
      select app.fixture_personnel_quality_oracle(${employee.employmentId}::uuid,${current}::date)
        is not distinct from app.fixture_personnel_quality_candidate(${employee.employmentId}::uuid,${current}::date) as equal,
        has_function_privilege(current_user, 'app.fixture_personnel_flags_candidate(uuid,date,date,uuid,jsonb)', 'EXECUTE')
        as "canCallHelper"
    `));
    expect(quality).toEqual({ equal: true, canCallHelper: false });
  } finally {
    await dropFixtureFunctions();
  }
});
