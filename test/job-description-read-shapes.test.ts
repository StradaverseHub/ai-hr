import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getJobCompanyChoices, getJobDirectoryFilters, getJobMasters } from '../packs/job-descriptions/service';
import { closeAll, migrateTestDb, owner, resetDb, seedBase } from './harness';
import { buildScaleFixture, type ScaleFixture } from './helpers/ai-centre-scale-fixture';
import { observeStatements } from './helpers/statement-observer';

let fixture: ScaleFixture;

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  fixture = await buildScaleFixture(base, { employments: 1000, events: 0 });
  // Match the native document owner's supported legacy fixture mode.
  await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb
    where id in('workforce.view','workforce.maintain')`);
}, 120_000);

afterAll(closeAll);

it('returns the same choices at group scale while limiting the statements to what each screen needs', async () => {
  expect(fixture.companyIds).toHaveLength(71);
  expect(fixture.employmentIds).toHaveLength(1000);
  const { group, single } = fixture.personas;

  for (const actor of [group, single]) {
    const baseline = await getJobMasters(actor);
    expect(baseline.companies).toContainEqual(expect.objectContaining({ value: fixture.singleCompanyId }));
    expect(baseline.companies.length).toBe(actor === group ? 71 : 1);
    const picker = await observeStatements(() => getJobCompanyChoices(actor));
    expect(picker.result).toEqual(baseline.companies);
    expect(picker.transactions).toBe(1);
    expect(picker.statements.some(({ sql }) => /job_document_reviewer_eligible|from "department"|from "position"/.test(sql))).toBe(false);

    const directory = await observeStatements(() => getJobDirectoryFilters(actor));
    const { companies, businessUnit, department, grade, family } = baseline;
    expect(directory.result).toEqual({ companies, businessUnit, department, grade, family });
    expect(directory.transactions).toBe(1);
    expect(directory.statements.some(({ sql }) => /job_document_reviewer_eligible|from "profile_option"|from "location"/.test(sql))).toBe(false);

    const companyId = fixture.singleCompanyId;
    const eligible = baseline.people.filter(person => person.companyIds?.includes(companyId));
    expect(eligible).toContainEqual(expect.objectContaining({ value: actor.userId }));
    const editor = await observeStatements(() => getJobMasters(actor, companyId));
    expect(editor.result).toEqual({ ...baseline, people: eligible.map(person => ({ ...person, companyIds: [companyId] })) });
    const eligibility = editor.statements.filter(({ sql }) => sql.includes('job_document_reviewer_eligible'));
    expect(eligibility).toHaveLength(1);
    expect(eligibility[0].params).toContain(companyId);
  }
}, 90_000); // The full master reader is exercised at the same large fixture as the new projections.
