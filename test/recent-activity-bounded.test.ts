/**
 * THE DASHBOARD'S ACTIVITY FEED MUST NEVER AGAIN READ THE WHOLE EVENT LOG.
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * Reported as "why does it take so long to go into the page after selecting the user?". Measured on a
 * local restore of the production database: HR Admin 0.36s, employee 4.4s, manager 5.7s — for the SAME
 * page. One of the dashboard's six parallel reads accounted for the entire gap: recentActivity(), the
 * eight-row activity card, cost 35ms for the admin and 4,369ms for everybody else.
 *
 * domain_event's read policy is `app.is_admin() OR app.can_see_employment(subject_employment_id)`.
 * `app.is_admin()` takes no row and short-circuits, so an admin's predicate is a constant; everyone else
 * pays a recursive SECURITY DEFINER function ONCE PER ROW EXAMINED. With no index on occurred_at, "the
 * eight newest" was a Seq Scan + top-N sort, and a sort must see every row — 10,276 calls to return 8.
 *
 * ═══ THE FIX IS TWO HALVES IN TWO FILES, AND EITHER ONE ALONE SILENTLY DEGRADES ═══
 *
 * That is the reason this file exists rather than a comment. The defect lives in the CONTRACT between
 * migration 0455's index and core/read.ts's window, and each half looks complete on its own:
 *
 *   · The INDEX (tenant_id, occurred_at DESC) lets the planner walk newest-first and stop once eight
 *     rows have passed the policy. 4,082ms -> 60ms. But "stop at eight" only stops early for someone who
 *     HAS eight visible events near the top; a new joiner on day one still walks to the end, and the end
 *     moves further away every day (measured 525ms at 10,276 rows, growing ~133 rows/day on this tenant).
 *   · The WINDOW bounds that walk, so the worst case is a function of the ACTIVITY RATE rather than of
 *     the table's AGE (525ms -> 183ms, and it stays there). But a window WITHOUT the index is still a
 *     Seq Scan over everything inside it.
 *
 * Delete either and the page is fast on a young database and slow on a real one — which is precisely how
 * this shipped in the first place. So both are asserted, and asserted as a pair.
 *
 * ⚠️ THE INDEX CASE READS pg_indexes, NOT db/schema.ts. A drizzle declaration that never reached a
 * migration produces a green schema and no index in production, which is the failure that matters.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { withTenant } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { recentActivity } from '../core/read';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';

let b: Base;

const READ = fs.readFileSync(path.resolve(__dirname, '../core/read.ts'), 'utf8');

/** Append one event and force its occurred_at to `daysAgo`, which appendEvent itself cannot set. */
async function eventAgedDays(ctx: ReturnType<typeof adminCtx>, eventType: string, daysAgo: number) {
  const aggregateId = randomUUID();
  await withTenant(ctx, async (tx) => {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId,
      eventType,
      actor: actorOf(ctx),
      payload: {},
    });
  });
  await owner.db
    .update(schema.domainEvent)
    .set({ occurredAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000) })
    .where(eq(schema.domainEvent.aggregateId, aggregateId));
  return aggregateId;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('recentActivity is bounded — the 8.5-second dashboard', () => {
  it('returns events inside the window and EXCLUDES ones older than it', async () => {
    const ctx = adminCtx(b);
    // Straddle the 30-day edge on both sides, close enough that only the bound can separate them.
    await eventAgedDays(ctx, 'person.inside.window', 2);
    await eventAgedDays(ctx, 'person.outside.window', 45);

    const rows = await recentActivity(ctx, 8);
    const types = rows.map((r) => r.eventType);

    expect(types).toContain('person.inside.window');
    // The load-bearing assertion. Without the .where() this row comes back — it is only 45 days old and
    // the card asks for eight — and the scan it implies is the whole table.
    expect(types).not.toContain('person.outside.window');
  });

  it('an event just inside the edge is still returned — the bound is 30 days, not "recent-ish"', async () => {
    // Guards the other direction: a window narrowed to a few days would pass the test above while
    // quietly emptying the card. Measured on production data, an employee has 159 visible events inside
    // 30 days and a manager 1,014, against a card that shows eight — so 30 days costs nothing on screen.
    const ctx = adminCtx(b);
    await eventAgedDays(ctx, 'person.day.twentynine', 29);
    const types = (await recentActivity(ctx, 8)).map((r) => r.eventType);
    expect(types).toContain('person.day.twentynine');
  });

  it('a time-ordered index EXISTS IN THE DATABASE, on tenant_id then occurred_at', async () => {
    /**
     * pg_indexes, not the drizzle declaration: a schema entry that never reached a migration is green
     * here and absent in production, which is the failure that costs a round.
     *
     * ⚠️ THE DIRECTION IS NOT ASSERTED, AND THAT IS A CORRECTION. This case first required `occurred_at
     * DESC` on the reasoning that an ascending index "cannot stop early for a newest-first query".
     * That is FALSE, and measuring it said so: on the restored production data an ascending index gives
     * `Index Scan Backward`, the same plan cost and the same 183ms. We still SHIP descending — it matches
     * the convention every other newest-first index here follows (assistant_exchange_user_asked_idx,
     * agent_proposal_type_time_idx) and states the intent at the definition — but pinning it would be
     * pinning a preference while claiming it was a performance property.
     *
     * The COLUMNS are the real property. Dropping tenant_id, or ordering by something other than
     * occurred_at, is what puts the sort back and takes the page to 4.4s.
     */
    const res = await owner.db.execute(
      sql`select indexdef from pg_indexes where tablename = 'domain_event' and indexname = 'domain_event_recent_idx'`,
    );
    const rows = (res as unknown as { rows?: { indexdef: string }[] }).rows ?? (res as unknown as { indexdef: string }[]);
    expect(rows.length, 'domain_event_recent_idx is missing — migration 0455 did not run').toBe(1);
    const def = rows[0].indexdef.toLowerCase();
    expect(def).toMatch(/\(\s*tenant_id\s*,\s*occurred_at\b/);
  });

  it('the query still carries the window, so the index is never left to do it alone', () => {
    // Source-shape, and deliberately so: the two behavioural cases above pass on a database with a
    // handful of rows whether or not the bound is expressed in a way the PLANNER can use. What must not
    // drift is the pairing — a filter applied after the scan, or a JS-side cutoff, satisfies "old rows
    // are excluded" while restoring the unbounded walk this whole round was about.
    expect(READ).toContain('RECENT_ACTIVITY_WINDOW_DAYS = 30');
    expect(READ).toMatch(/now\(\) - make_interval\(days => \$\{RECENT_ACTIVITY_WINDOW_DAYS\}\)/);
  });
});
