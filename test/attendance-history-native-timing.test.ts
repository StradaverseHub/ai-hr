import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import { attendanceApplicationFilterOptions, countOfflineClaimsAwaitingReview, listAttendanceApplicationHistory, searchAttendanceApprovers } from '../packs/attendance/service';
import { closeAll, migrateTestDb, resetDb, seedBase, setModule } from './harness';
import { buildScaleFixture, type ScaleFixture } from './helpers/ai-centre-scale-fixture';

let fixture: ScaleFixture;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  await setModule(base.tenantId, 'attendance', 'active');
  fixture = await buildScaleFixture(base, { employments: 1000, events: 0 });
}, 90_000);
afterAll(closeAll);

async function timed<T>(read: () => Promise<T>) {
  const started = performance.now();
  const value = await read();
  return { value, elapsedMs: Math.round((performance.now() - started) * 100) / 100 };
}

it('attributes empty-results History load to the browser page’s existing read owners', async () => {
  expect(fixture.companyIds).toHaveLength(71);
  expect(fixture.employmentIds).toHaveLength(1000);
  const scopes = [
    { name: 'groupHR-all', actor: fixture.personas.group, companies: [...fixture.companyIds] },
    { name: 'groupHR-one', actor: fixture.personas.group, companies: [fixture.singleCompanyId] },
    { name: 'companyHR-one', actor: fixture.personas.single, companies: [fixture.singleCompanyId] },
  ];
  const measure = async ({ name, actor, companies }: typeof scopes[number]) => {
    const [results, choices, offlineCount] = await Promise.all([
      timed(() => listAttendanceApplicationHistory(actor, companies, {
        companyId: fixture.singleCompanyId, query: 'PERF-NO-ATTENDANCE-HISTORY-MATCH', status: 'pending',
      })),
      timed(() => attendanceApplicationFilterOptions(actor, companies)),
      timed(() => countOfflineClaimsAwaitingReview(actor, companies)),
    ]);
    expect(results.value.total).toBe(0);
    expect(results.value.rows).toEqual([]);
    expect(choices.value.companies.map(row => row.id).sort()).toEqual([...companies].sort());
    expect(choices.value.employees.length).toBeGreaterThan(0);
    expect(choices.value.employees.every(employee => companies.includes(employee.companyId))).toBe(true);
    const orderedCompanyIds = choices.value.companies.map(row => sql`${row.id}::uuid`);
    const approvers = await timed(() => withTenant(actor, tx => tx.execute<{
      id: string; name: string; employeeCode: string | null;
    }>(sql`select id,name,employee_code as "employeeCode"
      from app.attendance_workflow_v3_approver_options(ARRAY[${sql.join(orderedCompanyIds, sql`, `)}]::uuid[]) limit 50`)));
    expect([...approvers.value]).toEqual(choices.value.approverEmployees);
    return {
      scope: name, companies: companies.length, employees: choices.value.employees.length,
      resultsMs: results.elapsedMs, filterOptionsMs: choices.elapsedMs, offlineCountMs: offlineCount.elapsedMs,
      workflowApproverOptionsMs: approvers.elapsedMs, workflowApproverOptionsCount: approvers.value.length,
    };
  };
  for (const scope of scopes) await measure(scope);
  const samples = [];
  for (let round = 0; round < 3; round++) {
    for (const scope of scopes) samples.push(await measure(scope));
  }
  expect(samples.find(sample => sample.scope === 'groupHR-all')?.employees)
    .toBeGreaterThan(samples.find(sample => sample.scope === 'groupHR-one')!.employees);
  const directory = process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if (directory) writeFileSync(join(directory, 'attendance-history-native-timing.json'), JSON.stringify({
    kind: 'FICTIONAL_ATTENDANCE_HISTORY_READ_TIMING', releaseEligible: false, samples,
  }, null, 2), { mode: 0o600 });
}, 180_000);

it('measures the editor’s on-demand picker with and without a search term', async () => {
  expect(fixture.companyIds).toHaveLength(71);
  expect(fixture.employmentIds).toHaveLength(1000);
  const actor = fixture.personas.group;
  const employeeCode = 'FX-GRP1';
  const scopes = [
    { name: 'groupHR-all', companyIds: [...fixture.companyIds] },
    { name: 'groupHR-one', companyIds: [fixture.singleCompanyId] },
  ];
  const samples = [];
  for (const { name, companyIds } of scopes) {
    const empty = await timed(() => searchAttendanceApprovers(actor, { companyIds, query: '', page: 0 }));
    expect(empty.value.rows).toHaveLength(50);
    expect(empty.value.more).toBe(true);
    const named = await timed(() => searchAttendanceApprovers(actor, { companyIds, query: employeeCode, page: 0 }));
    expect(named.value.rows).toEqual([expect.objectContaining({ employeeCode, eligible: true })]);
    const selectedId = named.value.rows[0].id;
    const selected = await timed(() => searchAttendanceApprovers(actor, {
      companyIds, query: 'PERF-NO-APPROVER-MATCH', page: 0, selectedIds: [selectedId],
    }));
    expect(selected.value.rows).toEqual([]);
    expect(selected.value.selected).toEqual(named.value.rows);
    samples.push({
      scope: name, companies: companyIds.length,
      firstPageMs: empty.elapsedMs, namedSearchMs: named.elapsedMs, selectedLabelMs: selected.elapsedMs,
    });
  }
  const directory = process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if (directory) writeFileSync(join(directory, 'attendance-editor-approver-search-timing.json'), JSON.stringify({
    kind: 'FICTIONAL_ATTENDANCE_EDITOR_APPROVER_SEARCH_TIMING', releaseEligible: false, samples,
  }, null, 2), { mode: 0o600 });
}, 120_000);
