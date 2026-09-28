/**
 * DEV FIXTURE — A POOLED SHARED LEAVE GROUP ON THE DEMO TENANT.  `pnpm dev:fixture-pooled-leave`
 *
 * ⚠️ WHY THIS FILE EXISTS, AND WHY IT IS COMMITTED. `pnpm db:seed` configures no shared leave group and no
 * pooled leave type — `db/seed.ts` grants ANNUAL, SICK and HOSPITALIZATION and nothing routes its balance
 * through another type. So the ENTIRE shared-group feature is invisible on a freshly seeded database: the
 * merged "one card for one pool" layout (r341), its ceiling lines, and the standalone group tile all render
 * only for a tenant that has the rows. lib/shared-leave-pool.ts records that gap; r341 verified around it by
 * writing a throwaway fixture and NOT committing it, which is why r355 could not reproduce r341's screen
 * either and had to write this one from scratch. It is committed so the next round does not pay that cost a
 * third time, and so the §8 render check on this area is a real render rather than a 200.
 *
 * WHAT IT MAKES, chosen to exercise every arm of `planSharedGroupCeilings` at once:
 *
 *   Group "Pooled Leave (dev fixture)"  ·  10.00 days shared, at most 3.00 per application, Secondary
 *     · SICK — the POOL. Another type's ledger routes to it, so core/read.ts gives its card a
 *       `sharedBalance` whose `sourceLeaveTypeId` is its own id. That is what makes it the MERGED host: the
 *       group's ceiling, membership, per-application cap and (r355) used-this-year line land on this card
 *       and the group draws no tile of its own. THIS IS THE CARD THE ITEM IS ABOUT.
 *
 *       ⚠️ AND IT MUST BE A TYPE THAT HOLDS ITS OWN GRANTED DAYS. r355's first cut of this fixture made
 *       HOSPITALIZATION the pool and produced no merged card at all: the demo seed's standing grants land
 *       on ANNUAL and SICK only, so HOSPITALIZATION holds 0.00, and a member of a PLACED group that holds
 *       nothing of its own draws no card (the a0b90c81 gate in core/read.ts). No card ⇒ no host ⇒
 *       `planSharedGroupCeilings` sends the group down the STANDALONE arm, and the screen the item is about
 *       never renders. It looked exactly like a working fixture. SICK carries 14.00 granted days in the
 *       seed, which is why it is the pool here.
 *     · HOSPITALIZATION — a folded BORROWER. `balance_source_type_id` points at SICK, so a day of it spends
 *       the pool's ledger and it holds nothing of its own; the same gate drops its card entirely.
 *       Production's CPL and NDL are this shape.
 *     · ANNUAL — an ALSO-COUNTS member. It holds its own granted days, so it keeps its card and gains one
 *       line naming the ceiling it counts towards. Production's Marriage Leave is this shape, and it is the
 *       half of the original ticket that was argued back: folding it would hide days people can spend.
 *       (It is also the RING card, so this covers the ceiling line on both card shapes in one render.)
 *
 *   Group "Standalone Pool (dev fixture)"  ·  6.00 days shared, no cap, Secondary
 *     · MATERNITY, and no pooled member anywhere in the group. There is nothing to merge onto, so this one
 *       keeps drawing its OWN tile — the out-of-the-box shape every tenant without a pooled type is on, and
 *       the arm a fixture that only built the merge would leave unrendered.
 *
 *   One approved 2.00-day request on the pool type per open employment, dated inside the current calendar
 *   year, so the group's `usedDays` is a NON-ZERO figure. Without it the used-this-year line renders 0.00,
 *   which proves the line exists but not that it carries the pool's arithmetic. The run PRINTS the figure
 *   each employment should then see, because the seed's own member-type requests count towards it too and
 *   a fixture that promised one number for everybody would be wrong for most of them.
 *
 * SAFETY. Every write is scoped to `tenant_id = DEMO_TENANT_ID` and the run refuses outright on a
 * deployment with real WorkOS keys or an undeclared production NODE_ENV (`demoSeedRefusal`, shared with
 * db/seed.ts). It does NOT truncate anything: unlike the seeder it only adds, and re-running replaces its
 * own two groups by name, so it is idempotent and safe over a seeded or an already-fixtured database.
 *
 * NOT A MIGRATION AND NOT PRODUCTION CONFIGURATION. Production already has its own Special Leave group,
 * configured by HR through components/leave-shared-group-config.tsx. This only makes a dev machine look
 * enough like it to render.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import * as schema from '../db/schema';
import { DEMO_TENANT_ID, demoSeedRefusal } from '../db/seed-guard';

const POOLED_GROUP = 'Pooled Leave (dev fixture)';
const STANDALONE_GROUP = 'Standalone Pool (dev fixture)';
/**
 * The pool's own code, the borrower routed onto it, and the member that keeps its own card.
 * ⚠️ POOL_CODE and ALSO_COUNTS_CODE must both be types the demo seed GRANTS days on (db/seed.ts's
 * `standingGrants`: ANNUAL, SICK, HOSPITALIZATION — and only the first two actually land on a ledger).
 * A pool holding 0.00 is folded away and the merged card never appears. See the header.
 */
const POOL_CODE = 'SICK';
const BORROWER_CODE = 'HOSPITALIZATION';
const ALSO_COUNTS_CODE = 'ANNUAL';
const STANDALONE_MEMBER_CODE = 'MATERNITY';

const refusal = demoSeedRefusal(process.env);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

const owner = createDb(process.env.MIGRATION_DATABASE_URL!);

/**
 * A DATE INSIDE THE GROUP'S CYCLE, DERIVED FROM THE CLOCK. `sharedGroupCycleWindow` makes a group's cycle
 * the CALENDAR YEAR of the date the screen is read at, so a hardcoded year would make this fixture stop
 * producing a non-zero `usedDays` the moment that year passed — silently, with the line still rendering.
 * Mid-January is inside every year's window and inside no month a reader would mistake for "today".
 */
function usageWindow(): { start: string; end: string; year: number } {
  const year = new Date().getUTCFullYear();
  return { start: `${year}-01-12`, end: `${year}-01-13`, year };
}

async function main() {
  const tenantId = DEMO_TENANT_ID;
  const demo = await owner.db.select({ id: schema.tenant.id }).from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  if (demo.length === 0) {
    console.error(`No demo tenant ${tenantId} in this database. Run \`pnpm db:seed\` first.`);
    process.exit(1);
  }

  const types = await owner.db
    .select({ id: schema.leaveType.id, code: schema.leaveType.code, name: schema.leaveType.name })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.tenantId, tenantId));
  const byCode = new Map(types.map((t) => [t.code, t]));
  const need = [POOL_CODE, BORROWER_CODE, ALSO_COUNTS_CODE, STANDALONE_MEMBER_CODE];
  const absent = need.filter((c) => !byCode.has(c));
  if (absent.length > 0) {
    console.error(`Leave type(s) missing from the demo tenant: ${absent.join(', ')}. Run \`pnpm db:seed\` first.`);
    process.exit(1);
  }
  const pool = byCode.get(POOL_CODE)!;
  const borrower = byCode.get(BORROWER_CODE)!;
  const alsoCounts = byCode.get(ALSO_COUNTS_CODE)!;
  const standaloneMember = byCode.get(STANDALONE_MEMBER_CODE)!;

  // 1. THE LEDGER ROUTE, which is what makes the pool card a pool card. Without this nothing in the tenant
  //    has a `sharedBalance`, so `planSharedGroupCeilings` finds no host and BOTH groups draw standalone
  //    tiles — the merged card the item is about never appears and the render check proves nothing.
  await owner.db
    .update(schema.leaveType)
    .set({ balanceSourceTypeId: pool.id })
    .where(and(eq(schema.leaveType.tenantId, tenantId), eq(schema.leaveType.id, borrower.id)));

  // 2. THE GROUPS. Deleted by name first so a re-run replaces rather than duplicates; members cascade on
  //    the group FK, and `leave_shared_group_member_uq` is on (tenant, leave_type) — a type belongs to at
  //    most ONE group tenant-wide, so a stale fixture group would block the new one's members.
  await owner.db
    .delete(schema.leaveSharedGroup)
    .where(
      and(
        eq(schema.leaveSharedGroup.tenantId, tenantId),
        inArray(schema.leaveSharedGroup.name, [POOLED_GROUP, STANDALONE_GROUP]),
      ),
    );

  const [pooled] = await owner.db
    .insert(schema.leaveSharedGroup)
    .values({
      tenantId,
      name: POOLED_GROUP,
      totalLimitDays: '10.00',
      maxDaysPerApplication: '3.00',
      // NOT 'hidden'. A hidden group is never returned by `sharedLeaveGroupBalances`, so the whole feature
      // stays invisible — which is precisely the default (migration 0438) this fixture exists to escape.
      essPlacement: 'secondary',
    })
    .returning({ id: schema.leaveSharedGroup.id });

  const [standalone] = await owner.db
    .insert(schema.leaveSharedGroup)
    .values({
      tenantId,
      name: STANDALONE_GROUP,
      totalLimitDays: '6.00',
      maxDaysPerApplication: null,
      essPlacement: 'secondary',
    })
    .returning({ id: schema.leaveSharedGroup.id });

  await owner.db.insert(schema.leaveSharedGroupMember).values([
    { tenantId, groupId: pooled.id, leaveTypeId: pool.id },
    { tenantId, groupId: pooled.id, leaveTypeId: borrower.id },
    { tenantId, groupId: pooled.id, leaveTypeId: alsoCounts.id },
    { tenantId, groupId: standalone.id, leaveTypeId: standaloneMember.id },
  ]);

  // 3. USAGE, so `usedDays` is not 0.00. The group's measure is pending + approved days on any member type
  //    whose request STARTS inside the cycle — the same measure `enforceSharedLeaveGroupLimit` takes — so
  //    one approved request on the pool type is enough and is what a real tenant's figure is made of.
  const { start, end, year } = usageWindow();
  const employments = await owner.db
    .select({ id: schema.employment.id })
    .from(schema.employment)
    // Open employments only: an ended one has no self-service reader, so a request against it would be a
    // figure nobody can look at. `terminated_on` is the column that closes an employment here.
    .where(and(eq(schema.employment.tenantId, tenantId), sql`${schema.employment.terminatedOn} is null`));

  await owner.db
    .delete(schema.leaveRequest)
    .where(
      and(
        eq(schema.leaveRequest.tenantId, tenantId),
        eq(schema.leaveRequest.leaveTypeId, pool.id),
        eq(schema.leaveRequest.startDate, start),
      ),
    );
  if (employments.length > 0) {
    await owner.db.insert(schema.leaveRequest).values(
      employments.map((e) => ({
        tenantId,
        employmentId: e.id,
        leaveTypeId: pool.id,
        startDate: start,
        endDate: end,
        days: '2.00',
        status: 'approved' as const,
      })),
    );
  }

  /**
   * ⚠️ THE CHECK THAT THE FIXTURE ACTUALLY BUILT THE MERGED CASE, not a silently standalone one.
   *
   * A pool type holding no granted days is folded away by the a0b90c81 gate, and then the group renders as a
   * plain tile — the arm the item is NOT about — with no error anywhere. That is precisely how this fixture's
   * first cut wasted a render check, so the condition is asserted here rather than left to the reader's eye.
   */
  const [grant] = await owner.db
    .select({ days: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.tenantId, tenantId), eq(schema.leaveLedger.leaveTypeId, pool.id)));
  if (Number(grant?.days ?? 0) <= 0) {
    console.error(
      `\nREFUSING TO CLAIM SUCCESS: no employment holds any ${pool.code} days, so its card is folded by the\n` +
        `a0b90c81 gate in core/read.ts and "${POOLED_GROUP}" will draw a STANDALONE tile instead of merging.\n` +
        `Pick a POOL_CODE the seed grants days on, or grant some, and re-run.`,
    );
    process.exit(1);
  }

  // What each employment's merged card should then read for "used this year": the fixture's own 2.00 PLUS
  // whatever the seed already committed on a member type inside the cycle. Printed per employment because
  // one promised number would be wrong for most of them.
  const used = await owner.db
    .select({
      employmentId: schema.leaveRequest.employmentId,
      days: sql<string>`coalesce(sum(${schema.leaveRequest.days}), 0)`,
    })
    .from(schema.leaveRequest)
    .where(
      and(
        eq(schema.leaveRequest.tenantId, tenantId),
        inArray(schema.leaveRequest.leaveTypeId, [pool.id, borrower.id, alsoCounts.id]),
        inArray(schema.leaveRequest.status, ['pending', 'approved']),
        sql`${schema.leaveRequest.startDate} between ${`${year}-01-01`} and ${`${year}-12-31`}`,
      ),
    )
    .groupBy(schema.leaveRequest.employmentId);

  console.log(`Pooled-leave dev fixture applied to tenant ${tenantId}.`);
  console.log(`  ${POOLED_GROUP}  id=${pooled.id}  ·  10.00 shared, max 3.00 per application, Secondary`);
  console.log(`    MERGED host      ${pool.code} (${pool.name}) — expect ONE card, carrying the ceiling`);
  console.log(`    folded borrower  ${borrower.code} (${borrower.name}) — expect NO card`);
  console.log(`    also-counts      ${alsoCounts.code} (${alsoCounts.name}) — expect its card + a ceiling line`);
  console.log(`  ${STANDALONE_GROUP}  id=${standalone.id}  ·  6.00 shared, no cap, Secondary`);
  console.log(`    member           ${standaloneMember.code} — expect the group's OWN tile, not a merge`);
  console.log(`  usage: 2.00 approved ${pool.code} day(s) written on ${employments.length} employment(s) at ${start}`);
  console.log(`  "used this year" per employment, for the ${year} cycle:`);
  for (const u of used) console.log(`    ${u.employmentId}  ${Number(u.days).toFixed(2)}`);
  console.log(`  and the merged card must carry NO "View details" link — r355 deleted`);
  console.log(`  /leave/shared/[groupId], so GET /leave/shared/${pooled.id} must 404.`);
  await owner.client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
