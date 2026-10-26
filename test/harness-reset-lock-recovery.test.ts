import {afterAll, beforeAll, expect, it} from 'vitest';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {closeAll, migrateTestDb, owner, resetDb, seedBase} from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

it('recovers a wrapped reset lock refusal, empties the fixture and retains installation catalogs', async () => {
  await resetDb();
  await seedBase();
  const blocker = postgres(process.env.TEST_MIGRATION_DATABASE_URL!, {max: 1, onnotice: () => {}});
  let ready!: () => void, release!: () => void;
  const acquired = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transaction = blocker.begin(async tx => {
    await tx.unsafe('LOCK TABLE public.tenant IN ACCESS SHARE MODE');
    ready();
    await held;
  }).then(() => null, error => error);
  try {
    await acquired;
    await expect(resetDb()).resolves.toBeUndefined();
    expect((await owner.db.execute(sql`SELECT count(*)::int AS n FROM person`))[0].n).toBe(0);
    expect((await owner.db.execute(sql`SELECT count(*)::int AS n FROM tenant WHERE id <> '00000000-0000-0000-0000-000000000000'::uuid`))[0].n).toBe(0);
    expect(Number((await owner.db.execute(sql`SELECT count(*)::int AS n FROM module`))[0].n)).toBeGreaterThan(0);
  } finally {
    release();
    await transaction;
    await blocker.end({timeout: 5});
  }
});
