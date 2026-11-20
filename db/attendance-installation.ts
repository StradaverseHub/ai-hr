import { sql } from 'drizzle-orm';
import type { Tx } from './client';
import { appendEvent } from './events';
import { attendanceRule } from './schema';

/** The provisioning and activation owners already hold the tenant configuration locks. */
export async function installAttendanceStandardRule(tx: Tx, tenantId: string): Promise<boolean> {
  const [created] = await tx.insert(attendanceRule).values({
    tenantId,
    name: 'Standard',
    description: 'Default attendance calculation rule.',
    isDefault: true,
    status: 'active',
    // Match the existing first-use rule's whole-minute difference from the oldest policy.
    lateGracePeriodMinutes: sql`coalesce((
      select greatest(0, floor(extract(epoch from p.late_after) / 60) - floor(extract(epoch from p.work_start) / 60))
      from public.attendance_policy p where p.tenant_id = ${tenantId}::uuid order by p.created_at limit 1
    ), 0)`,
  }).onConflictDoNothing().returning({ id: attendanceRule.id });
  if (!created) return false;
  await appendEvent(tx, {
    tenantId,
    aggregateType: 'attendance-rule',
    aggregateId: created.id,
    eventType: 'attendance-rule.created',
    actor: { type: 'system' },
    payload: { name: 'Standard', isDefault: true, seeded: true },
  });
  return true;
}
