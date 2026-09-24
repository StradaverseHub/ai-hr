/**
 * §8 RENDER-CHECK FIXTURE for board item 2a57a007 — TEMPORARY, run INSIDE the devdb lock and undone by
 * the `pnpm db:seed` that follows it.
 *
 * `db/seed.ts` never sets `leave_type.balance_source_type_id`, so a plain seed reaches NONE of the pooled
 * branch this item changes: no Share figure, no badge, no tooltip, no per-type Explain list. This adds the
 * production shape (Emergency Leave drawing on Annual Leave) through the REAL engine — `requestLeave` /
 * `decideLeave`, never hand-written leave_request or leave_ledger rows — so what renders is what the app
 * would produce, not what a fixture asserted.
 */
import { and, eq, sql } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { requestLeave, decideLeave } from '../core/leave';
import { DEMO_TENANT_ID } from '../db/seed-guard';

const owner = createDb(process.env.MIGRATION_DATABASE_URL!);
const admin: SessionContext = {
  tenantId: DEMO_TENANT_ID,
  userId: '22222222-2222-2222-2222-222222222222',
  roles: ['hr_admin'],
  entitlementsExempt: 'seeding',
};

async function main() {
  const [annual] = await owner.db
    .select({ id: schema.leaveType.id, name: schema.leaveType.name })
    .from(schema.leaveType)
    .where(and(eq(schema.leaveType.tenantId, DEMO_TENANT_ID), eq(schema.leaveType.code, 'ANNUAL')));
  if (!annual) throw new Error('no ANNUAL leave type in the seeded dev DB');

  // Emergency Leave, drawing on the Annual pool — the shape production carries (EL → AL).
  const [el] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: DEMO_TENANT_ID,
      code: 'EL',
      name: 'Emergency Leave',
      paid: true,
      counting: 'calendar_days',
      balanceSourceTypeId: annual.id,
    })
    .returning({ id: schema.leaveType.id });

  // The employment the render check will open. Pick one deterministically by employee code.
  const [emp] = await owner.db
    .select({ id: schema.employment.id, code: schema.employment.employeeCode })
    .from(schema.employment)
    .where(eq(schema.employment.tenantId, DEMO_TENANT_ID))
    .orderBy(schema.employment.employeeCode)
    .limit(1);
  if (!emp) throw new Error('no employment in the seeded dev DB');

  // Headroom in the POOL so the two applications below are accepted by the real submit guard.
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: DEMO_TENANT_ID,
    employmentId: emp.id,
    leaveTypeId: annual.id,
    entryType: 'accrual',
    days: '10.00',
    effectiveOn: '2026-09-01',
  });

  const approved = await requestLeave(admin, {
    employmentId: emp.id,
    leaveTypeId: el.id,
    startDate: '2026-09-10',
    endDate: '2026-09-10',
    today: '2026-09-01',
  });
  await decideLeave(admin, { leaveRequestId: approved.leaveRequestId, decision: 'approved' });
  // A multi-step approval company needs a second decision to finalize (db/seed.ts does the same dance).
  for (let i = 0; i < 3; i++) {
    const [row] = await owner.db
      .select({ status: schema.leaveRequest.status })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, approved.leaveRequestId));
    if (row?.status !== 'pending') break;
    await decideLeave(admin, { leaveRequestId: approved.leaveRequestId, decision: 'approved' });
  }
  const [approvedRow] = await owner.db
    .select({ status: schema.leaveRequest.status })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.id, approved.leaveRequestId));
  console.log(`APPROVED_STATUS=${approvedRow?.status}`);
  await requestLeave(admin, {
    employmentId: emp.id,
    leaveTypeId: el.id,
    startDate: '2026-09-15',
    endDate: '2026-09-16',
    today: '2026-09-01',
  });

  const [check] = await owner.db
    .select({ n: sql<string>`count(*)` })
    .from(schema.leaveRequest)
    .where(and(eq(schema.leaveRequest.employmentId, emp.id), eq(schema.leaveRequest.leaveTypeId, el.id)));
  console.log(`EMP=${emp.id}`);
  console.log(`EMPCODE=${emp.code}`);
  console.log(`ANNUAL=${annual.id} (${annual.name})`);
  console.log(`EL=${el.id}`);
  console.log(`EL_REQUESTS=${check.n}`);
  await owner.client.end();
  // The app-role pool opened at import of db/client keeps the event loop alive; this is a fixture script.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
