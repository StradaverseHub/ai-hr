import { requireAdmin } from '@/lib/authz';
import { PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import { listLeaveHistoryImportRuns } from '@/core/leave-history-import';
import { LeaveHistoryImport } from './leave-history-import';

/**
 * 3f15ffdb (r362) — LEAVE HISTORY DATA IMPORT (`/admin/leave-config/history-import`).
 *
 * The RECORD half of a migration. Its sibling one row above — Leave Adjustments › Leave Balance
 * Import — loads the BALANCES (leave_ledger rows); this loads the past leave itself into
 * `leave_request`, which is what every Leave History surface reads. See core/leave-history-import.ts
 * for why an imported record deliberately moves no balance, and what that cost elsewhere.
 *
 * A ROW AND A GROUP OF ITS OWN, not a tab of Leave Adjustments. A tab there would inherit that row's
 * heading and its "change an employee's balance" description, which is the one thing this tool must
 * never be read as doing. The group is of one, so `LeaveConfigMap` draws no tab strip — the same
 * shape Leave Balance Health, Run earned accrual and Special Setting take.
 *
 * TRUSTED-HR-ADMIN ONLY (ticket point 11): `requireAdmin()` here, `requireAdmin()` again on both
 * server actions, and the run log is admin-only at the row level by the RLS policy in migration 0490.
 * There is deliberately no company selector — a migration file routinely spans companies, and the
 * importer rejects rows outside the acting admin's authority at PREVIEW time, so narrowing the screen
 * would describe a restriction the engine does not apply (the Leave Balance Import precedent).
 *
 * SERVER COMPONENT. The run log is read here, not inside the island, so it is RLS-scoped and
 * server-rendered; `commitLeaveHistoryImportAction` revalidates this path, so a finished import
 * appears in the log without a reload.
 */
export default async function LeaveHistoryImportPage() {
  const s = await requireAdmin();
  const header = await leaveConfigPageHeader('leaveHistoryImport');
  const runs = await listLeaveHistoryImportRuns(s);

  return (
    <div className="space-y-6">
      <PageHeader title={header.title} description={header.description} />
      <LeaveConfigMap current="leaveHistoryImport" />
      <LeaveHistoryImport runs={runs} />
    </div>
  );
}
