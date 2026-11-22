import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { listEmployees } from '../core/read';
import { withTenant, type SessionContext } from '../db/client';
import { assignment, company, department, employment, person, position } from '../db/schema';
import { buildScaleFixture, type ScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, migrateTestDb, owner, resetDb, seedBase } from './harness';

const header = {
  employmentId: employment.id,
  name: person.fullName,
  employeeCode: employment.employeeCode,
  company: company.legalName,
  department: department.name,
  position: position.title,
};

type DirectoryRow = Awaited<ReturnType<typeof listEmployees>>[number];
function shownFields(row: DirectoryRow | undefined) {
  if (!row) return null;
  const { employmentId, name, employeeCode, company, department, position } = row;
  return { employmentId, name, employeeCode, company, department, position };
}

// Isolated experiment for the Attendance detail projection. Use the web actor's
// tenant transaction and the original directory scope, joins, and display fields.
function readOne(ctx: SessionContext, companyIds: string[], employmentId: string) {
  return withTenant(ctx, async tx => {
    const [row] = await tx.select(header)
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(assignment, and(
        eq(assignment.employmentId, employment.id),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ))
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .where(and(eq(employment.id, employmentId), companyIds.length ? inArray(employment.companyId, companyIds) : undefined))
      .limit(1);
    return row ?? null;
  });
}

let fixture: ScaleFixture;
let selected: string;
let outside: string;

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  fixture = await buildScaleFixture(base, { employments: 1000, events: 0 });
  const rows = await owner.db.select({ id: employment.id, companyId: employment.companyId })
    .from(employment).where(inArray(employment.id, [...fixture.activeEmploymentIds])).orderBy(employment.id);
  selected = rows.find(row => row.companyId === fixture.singleCompanyId)!.id;
  outside = rows.find(row => row.companyId !== fixture.singleCompanyId)!.id;
}, 90_000);

afterAll(closeAll);

it('matches the original Attendance header without materializing the employee directory', async () => {
  expect(fixture.companyIds).toHaveLength(71);
  expect(fixture.employmentIds).toHaveLength(1000);
  const cases = [
    { label: 'group-all', ctx: fixture.personas.group, companyIds: [...fixture.companyIds] },
    { label: 'group-selected-company', ctx: fixture.personas.group, companyIds: [fixture.singleCompanyId] },
    { label: 'company-hr', ctx: fixture.personas.single, companyIds: [fixture.singleCompanyId] },
  ];
  const percentile95 = (times: number[]) => [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];

  for (const { label, ctx, companyIds } of cases) {
    const original = await listEmployees(ctx, companyIds);
    const expected = shownFields(original.find(row => row.employmentId === selected));
    expect(expected).not.toBeNull();
    expect(await readOne(ctx, companyIds, selected)).toEqual(expected);
    expect(await readOne(ctx, companyIds, outside)).toEqual(
      shownFields(original.find(row => row.employmentId === outside)),
    );
    expect(await readOne(ctx, companyIds, '00000000-0000-4000-8000-000000000000')).toBeNull();
    if (label === 'group-all') expect(original.length).toBeGreaterThanOrEqual(1000);
    else expect(original.some(row => row.employmentId === outside)).toBe(false);

    const directoryMs: number[] = [];
    const singleMs: number[] = [];
    const measure = async (clock: number[], read: () => Promise<ReturnType<typeof shownFields>>) => {
      const started = performance.now();
      const result = await read();
      clock.push(performance.now() - started);
      expect(result).toEqual(expected);
    };
    const directory = () => measure(directoryMs, async () =>
      shownFields((await listEmployees(ctx, companyIds)).find(row => row.employmentId === selected)));
    const bounded = () => measure(singleMs, () => readOne(ctx, companyIds, selected));
    for (let iteration = 0; iteration < 16; iteration++) {
      if (iteration % 2 === 0) {
        await directory();
        await bounded();
      } else {
        await bounded();
        await directory();
      }
    }
    console.log(JSON.stringify({
      case: label,
      samples: singleMs.length,
      directoryRows: original.length,
      selectedRows: Number(expected !== null),
      directoryP95Ms: Math.round(percentile95(directoryMs)),
      singleP95Ms: Math.round(percentile95(singleMs)),
    }));
  }
}, 90_000);
