/**
 * r341 (8d3a7bff) RENDER-CHECK FIXTURE — THROWAWAY, and it exists because the seed cannot cover the branch.
 *
 * `pnpm db:seed` configures NO pooled leave type (`balance_source_type_id`) and NO shared leave group, so a
 * seeded dev database renders only the UNMERGED branch of this item: every group standalone, no card carrying
 * a ceiling. The approved plan says to cover both branches, and to seed the group THROUGH THE ENGINE rather
 * than by hand so the render check reads what `createLeaveSharedGroup` really writes.
 *
 * WHAT IT MAKES, on the demo tenant only, after a normal seed:
 *   · Special Leave (own ledger, granted to one employment) — the pot;
 *   · Compassionate Leave and Natural Disaster Leave pointing at it — the two that lose their cards;
 *   · Marriage Leave with its own grant, and Examination Leave with nothing — the two that keep theirs;
 *   · one shared group "Special Leave" over the four members, placed Primary, 10.00 days / 3.00 per apply.
 *
 * ⚠️ NOT A MIGRATION AND NOT PART OF THE PRODUCT. Nothing imports it, `deploy.sh` never runs it, and it
 * refuses any tenant but the demo one. Delete-safe.
 */
import { eq } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createLeaveSharedGroup } from '../core/leave-shared-group';
import { resolveEntitlementsTx } from '../core/entitlements';
import { DEMO_TENANT_ID } from '../db/seed-guard';

const owner = createDb(process.env.MIGRATION_DATABASE_URL!);
const DEV_ADMIN_USER_ID = '22222222-2222-2222-2222-222222222222';

async function leaveType(name: string, code: string, balanceSourceTypeId?: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: DEMO_TENANT_ID,
      code,
      name,
      paid: true,
      counting: 'calendar_days',
      essPlacement: 'secondary',
      ...(balanceSourceTypeId ? { balanceSourceTypeId } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function main() {
  const [t] = await owner.client<{ id: string }[]>`select id from tenant where id = ${DEMO_TENANT_ID}::uuid`;
  if (!t) {
    console.error('r341 fixture: the demo tenant is not present — run `pnpm db:seed` first.');
    process.exit(1);
  }
  // The employment whose /leave page the check renders: the first ESS employee the seed hired.
  const [emp] = await owner.db
    .select({ id: schema.employment.id, personId: schema.employment.personId })
    .from(schema.employment)
    .where(eq(schema.employment.tenantId, DEMO_TENANT_ID))
    // ORDER BY, because "the first employment" must be a fact about the data and not about the plan.
    .orderBy(schema.employment.hiredOn, schema.employment.id)
    .limit(1);
  if (!emp) {
    console.error('r341 fixture: no employment found — run `pnpm db:seed` first.');
    process.exit(1);
  }

  const sp = await leaveType('Special Leave (r341)', 'R341SP');
  const cpl = await leaveType('Compassionate Leave (r341)', 'R341CPL', sp);
  const ndl = await leaveType('Natural Disaster Leave (r341)', 'R341NDL', sp);
  const mrl = await leaveType('Marriage Leave (r341)', 'R341MRL');
  const exm = await leaveType('Examination Leave (r341)', 'R341EXM');

  for (const [leaveTypeId, days] of [
    [sp, '10.00'],
    [mrl, '3.00'],
  ] as const) {
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: DEMO_TENANT_ID,
      employmentId: emp.id,
      leaveTypeId,
      entryType: 'accrual',
      days,
      effectiveOn: '2026-01-01',
    });
  }

  // THROUGH THE ENGINE, deliberately: the group's validation, its placement resolution and its member rows
  // are what the screen reads, and writing them by hand would render a shape the product cannot produce.
  // A REAL entitlement snapshot, resolved from this tenant's own rows — never an exempt marker: the
  // exempt reasons are a ratcheted list of named owners (core/entitlement-types.ts) and a throwaway
  // fixture has no business being added to it.
  const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, DEMO_TENANT_ID));
  const ctx: SessionContext = {
    tenantId: DEMO_TENANT_ID,
    userId: DEV_ADMIN_USER_ID,
    personId: null,
    roles: ['hr_admin'],
    entitlements,
  };
  const g = await createLeaveSharedGroup(ctx, {
    name: 'Special Leave (r341)',
    totalLimitDays: 10,
    maxDaysPerApplication: 3,
    essPlacement: 'primary',
    leaveTypeIds: [cpl, ndl, mrl, exm],
  });

  console.log(
    JSON.stringify(
      { employmentId: emp.id, personId: emp.personId, groupId: g.id, pool: sp, borrowers: [cpl, ndl], keepers: [mrl, exm] },
      null,
      2,
    ),
  );
  process.exit(0);
}

void main();
