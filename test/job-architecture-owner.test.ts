import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase } from './harness';
import { withTenant } from '../db/client';

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
});
afterAll(closeAll);

it('closes the application write and employee publication paths while retaining the Rewards reader', async () => {
  const base = await seedBase();
  const [privileges] = await withTenant(adminCtx(base), tx => tx.execute(sql`
    select
      has_table_privilege(current_user, 'job_architecture_seat', 'INSERT,UPDATE') as seats,
      has_table_privilege(current_user, 'job_architecture_proposal', 'INSERT,UPDATE') as proposals,
      has_table_privilege(current_user, 'job_architecture_position_revision', 'INSERT') as mappings,
      has_table_privilege(current_user, 'job_architecture_outlier', 'INSERT,UPDATE') as outliers,
      has_table_privilege(current_user, 'job_architecture_suggestion', 'INSERT,UPDATE') as suggestions,
      has_table_privilege(current_user, 'job_architecture_import_preview', 'INSERT,UPDATE') as imports,
      has_table_privilege(current_user, 'job_architecture_jd_publication', 'INSERT,UPDATE') as publications,
      has_function_privilege(current_user, 'app.own_job_architecture_description(uuid)', 'EXECUTE') as profile
  `));
  expect(privileges).toEqual({
    seats: false, proposals: false, mappings: false, outliers: false,
    suggestions: false, imports: false, publications: false, profile: false,
  });

  const [retained] = await owner.db.execute(sql`
    select has_table_privilege('ai_hr_reward_setup_reader', 'job_architecture_position_revision', 'SELECT') as rewards,
      exists(select 1 from pg_trigger where tgrelid = 'employment'::regclass
        and tgname = 'employment_architecture_grade' and tgenabled <> 'D') as grade_guard
  `);
  expect(retained).toEqual({ rewards: true, grade_guard: false });
});
