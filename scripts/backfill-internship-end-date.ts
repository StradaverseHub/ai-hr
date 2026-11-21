/**
 * 2260a06b — THE ONE-OFF BACKFILL that gives interns activated before this release their internship end date.
 *
 *   node --import tsx scripts/backfill-internship-end-date.ts            # report only (default)
 *   node --import tsx scripts/backfill-internship-end-date.ts --apply    # write
 *
 * ON THE SERVER, SOURCE THE ENV (see scripts/backfill-assignment-company.ts for why `--env-file` is not used):
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && node --import tsx scripts/backfill-internship-end-date.ts
 *
 * THIS IS NOT PART OF DEPLOY. deploy.sh runs migrations, not scripts; the release is correct without it (the
 * Employment tab, the internship review and the status deriver all fall back to provisional_end_on), it simply
 * leaves employment.internship_end_date empty for those interns until this runs. Run it separately and record the
 * printed before/after counts as its evidence.
 *
 * WHAT IT DOES. hireEmployee wrote the Draft's internship end date only into provisional_end_on until this item, so
 * every CURRENT Intern employment (open, non-superseded assignment with employment_type 'intern') whose
 * internship_end_date is NULL and whose provisional_end_on is set gets internship_end_date := provisional_end_on.
 * Nobody's date is changed: a filled internship_end_date is never touched, and no other column is written.
 *
 * SHAPE. MIGRATION_DATABASE_URL (the owner role) enumerates across tenants, as every other repair script here does.
 * Writes run in bounded batches (BATCH rows per short transaction, set-wise UPDATE … WHERE id = ANY), so no long
 * lock is held on employment. SAFE TO RE-RUN: a second run finds nothing and says so.
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../db/client';

export const BATCH = 500;

type Db = ReturnType<typeof createDb>['db'];

/** Current interns still missing the typed column but holding the at-hire date. Bounded, keyset-ordered by id. */
async function candidates(db: Db, after: string | null, limit: number): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select e.id from employment e
    join assignment a on a.employment_id = e.id and a.tenant_id = e.tenant_id
      and a.valid_to is null and a.superseded_at is null and a.employment_type = 'intern'
    where e.internship_end_date is null and e.provisional_end_on is not null and e.voided_at is null
      and (${after}::uuid is null or e.id > ${after}::uuid)
    order by e.id limit ${limit}`);
  return rows.map((r) => r.id);
}

export async function countMissingInternshipEndDates(db: Db): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from employment e
    join assignment a on a.employment_id = e.id and a.tenant_id = e.tenant_id
      and a.valid_to is null and a.superseded_at is null and a.employment_type = 'intern'
    where e.internship_end_date is null and e.provisional_end_on is not null and e.voided_at is null`);
  return Number(row?.n ?? 0);
}

/** Fill the missing dates. Returns the before/after counts and how many rows were written. */
export async function backfillInternshipEndDates(db: Db, opts: { apply: boolean; batch?: number }) {
  const before = await countMissingInternshipEndDates(db);
  let written = 0;
  if (opts.apply) {
    let after: string | null = null;
    for (;;) {
      const ids = await candidates(db, after, opts.batch ?? BATCH);
      if (!ids.length) break;
      after = ids[ids.length - 1];
      const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
      // Re-checks the predicate inside the write so a row filled meanwhile is left alone.
      const updated = await db.execute<{ id: string }>(sql`
        update employment set internship_end_date = provisional_end_on
        where id = any(array[${idList}]) and internship_end_date is null and provisional_end_on is not null
        returning id`);
      written += updated.length;
    }
  }
  const afterCount = await countMissingInternshipEndDates(db);
  return { before, written, after: afterCount };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('backfill:internship-end-date requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  const storage = createDb(ownerUrl, { max: 1 });
  try {
    const result = await backfillInternshipEndDates(storage.db, { apply });
    console.log(
      `backfill:internship-end-date ${apply ? 'APPLIED' : 'DRY RUN (pass --apply to write)'} — ` +
        `missing before: ${result.before}, written: ${result.written}, missing after: ${result.after}`,
    );
  } finally {
    await storage.client.end();
  }
}

if (process.argv[1]?.endsWith('/backfill-internship-end-date.ts')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Backfill failed.');
    process.exitCode = 1;
  });
}
