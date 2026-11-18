/** Kernel composition seam: the Leave pack owns balance calculation; lifecycle owns settlement. */
import type { SessionContext, Tx } from '../db/client';
import { leaveBalancesTx } from '../packs/leave/service';

export async function readSettlementLeaveSourceTx(tx: Tx, ctx: SessionContext, selection: { employmentId: string; asOf: string; leaveTypeIds: readonly string[] }) {
  if (!selection.leaveTypeIds.length) return [];
  const rows = await leaveBalancesTx(tx, ctx, selection.employmentId, 'en', { asOf: selection.asOf, includeHidden: true, includeArchived: true });
  return rows.filter(row => selection.leaveTypeIds.includes(row.leaveTypeId)).map(row => ({ id: row.leaveTypeId, name: row.leaveType, balance: row.balance }));
}
