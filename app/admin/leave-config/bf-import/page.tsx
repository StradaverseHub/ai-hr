import { requireAdmin } from '@/lib/authz';
import { PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import { listLeaveBfImportRuns } from '@/core/leave-bf-import';
import { LeaveBfImport } from './leave-bf-import';

/**
 * db55d08a (r369) — LEAVE B/F DATA IMPORT (`/admin/leave-config/bf-import`).
 *
 * The OPENING-FIGURE third of a migration, and the reporter's go-live order is printed on the screen
 * itself: generate the year's entitlements, then load B/F, then load the leave taken. Its two siblings are
 * Leave Adjustments › Leave Balance Import (raw ledger movements) one row above, and Leave History Data
 * Import (the leave RECORDS) immediately above this one. See core/leave-bf-import.ts for why Brought
 * Forward cannot simply be typed into the balance importer, and for the year-cancelling trap that made a
 * screen of its own the answer.
 *
 * A ROW AND A GROUP OF ITS OWN, not a tab of Leave History Data Import and not a third tab of Leave
 * Adjustments. A tab of the first would inherit "load past leave records" — and this tool creates no leave
 * record at all; a tab of the second would inherit "change an employee's balance by hand", which describes
 * the wrong mechanism. The group is of one, so `LeaveConfigMap` draws no tab strip — the same shape Leave
 * History Data Import, Leave Balance Health, Run earned accrual and Special Setting take.
 *
 * TRUSTED-HR-ADMIN ONLY: `requireAdmin()` here, `requireAdmin()` again on all three server actions, and the
 * run log is admin-only at the row level by the RLS policy in migration 0497. There is deliberately no
 * company selector — a migration file routinely spans companies, and the importer rejects rows outside the
 * acting admin's authority at PREVIEW time, so narrowing the screen would describe a restriction the engine
 * does not apply (the Leave Balance Import and Leave History Data Import precedent).
 *
 * SERVER COMPONENT. The run log is read here, not inside the island, so it is RLS-scoped and
 * server-rendered; the commit and rollback actions revalidate this path, so a finished run appears in the
 * log without a reload. Every prop crossing to the island is plain data (test/server-client-boundary).
 */
export default async function LeaveBfImportPage() {
  const s = await requireAdmin();
  const header = await leaveConfigPageHeader('leaveBfImport');
  const runs = await listLeaveBfImportRuns(s);

  return (
    <div className="space-y-6">
      <PageHeader title={header.title} description={header.description} />
      <LeaveConfigMap current="leaveBfImport" />
      <LeaveBfImport runs={runs} />
    </div>
  );
}
