import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { withAttendanceTenant } from '../core/module-gate';
import type { SessionContext } from '../db/client';
import { clockingImportRun } from '../db/schema';
import { getClockingImportRun } from '../packs/attendance/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';

afterAll(closeAll);

type Line = { lineNo: number; result: string; rawLine: string | null; employeeName: string | null };
const project = ({ lineNo, result, rawLine, employeeName }: Line) => ({ lineNo, result, rawLine, employeeName });

// A test-only proposal. Production still uses getClockingImportRun.
async function readPage(session: SessionContext, runId: string, result: 'imported' | 'unmatched_card' | 'invalid_time', offset = 0) {
  return withAttendanceTenant(session, async tx => {
    const [run] = await tx.execute<{ id: string }>(sql`select id from clocking_import_run where id=${runId}::uuid`);
    if (!run) return null;
    const [counts] = await tx.execute<{ total: number; filtered: number }>(sql`
      select count(*)::int as total, count(*) filter (where result=${result})::int as filtered
      from clocking_import_line where run_id=${run.id}::uuid
    `);
    const lines = await tx.execute<Line>(sql`
      select l.line_no as "lineNo", l.result, l.raw_line as "rawLine", p.full_name as "employeeName"
      from clocking_import_line l
      left join employment e on e.id=l.employment_id
      left join person p on p.id=e.person_id
      where l.run_id=${run.id}::uuid and l.result=${result}
      order by l.line_no,l.id limit 200 offset ${offset}
    `);
    return { ...counts, lines: Array.from(lines, project) };
  });
}

it('compares the full import log with a SQL page under group, company and cross-tenant grants', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  await setModule(base.tenantId, 'attendance', 'active');
  const group = await buildScaleFixture(base, { employments: 1000, events: 0 });
  expect(group.companyIds).toHaveLength(71);
  const [run] = await owner.db.insert(clockingImportRun).values({
    tenantId: base.tenantId, mappingName: 'Fictional scale layout', fileName: 'fictional-scale-import.csv',
    totalLines: 24_000, importedLines: 18_000, unmatchedCardLines: 3_000, invalidDatetimeLines: 3_000,
  }).returning({ id: clockingImportRun.id });
  // Prior import receipt shape. Unmatched rows stay visible beside the narrower
  // set of employment-bound lines visible to a company administrator.
  await owner.db.execute(sql`
    with staff as (
      select id, row_number() over(order by id)::int as n
      from employment where tenant_id=${base.tenantId}::uuid
      order by id limit 1000
    )
    insert into clocking_import_line(tenant_id,run_id,line_no,employment_id,result,raw_line)
    select ${base.tenantId}::uuid,${run.id}::uuid,n,
      case when n%8=0 then null else staff.id end,
      case when n%8=0 then 'unmatched_card' when n%8=1 then 'invalid_time' else 'imported' end,
      case when n%8 in(0,1) then repeat('Fictional receipt row ',16) else null end
    from generate_series(1,24000) n join staff on staff.n=((n-1)/24)+1
  `);

  for (const [role, session] of [['group', group.personas.group], ['company', group.personas.single]] as const) {
    const samples = [];
    const offset = role === 'group' ? 200 : 0;
    for (const result of ['imported', 'unmatched_card', 'invalid_time'] as const) {
      const startedAt = performance.now();
      const full = await getClockingImportRun(session, run.id);
      const fullMs = performance.now() - startedAt;
      if (!full) throw new Error('The authorized reader must see its fictional run');
      expect(full.run.id).toBe(run.id);
      const expected = full.lines.filter(line => line.result === result);
      const pageStartedAt = performance.now();
      const actual = await readPage(session, run.id, result, offset);
      const pageMs = performance.now() - pageStartedAt;
      expect(actual).toEqual({ total: full.lines.length, filtered: expected.length,
        lines: expected.slice(offset, offset + 200).map(project) });
      expect(actual?.lines.length).toBeGreaterThan(0);
      expect(full.lines.length).toBeGreaterThan(200);
      if (role === 'group') expect(full.lines).toHaveLength(24_000);
      else expect(full.lines.length).toBeLessThan(24_000);
      samples.push({ result, fullRows: full.lines.length, pageRows: actual?.lines.length, fullMs, pageMs });
    }
    console.info('CLOCKING_LOG_PAGINATION_PROFILE', JSON.stringify({ role, samples }));
  }

  const foreign = await seedBase();
  await setModule(foreign.tenantId, 'attendance', 'active');
  const outsider = await entitledCtx(foreign);
  expect(await getClockingImportRun(outsider, run.id)).toBeNull();
  expect(await readPage(outsider, run.id, 'imported')).toBeNull();
}, 90_000);
