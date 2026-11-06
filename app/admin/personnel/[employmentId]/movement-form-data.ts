import { withTenant, type SessionContext } from '@/db/client';
import { movementCurrentStateTx } from '@/core/movement';
import { movementTypeControlsTx } from '@/core/movement-type-controls';
import { terminationReasonCatalogueTx } from '@/core/termination-reason-catalog';

/** These reads feed the New/Edit form only. History keeps its own event labels and data. */
export async function readPersonnelMovementFormData(
  session: SessionContext,
  employmentId: string,
  types: Parameters<typeof movementTypeControlsTx>[2],
  open: boolean,
) {
  if (!open) return null;
  return withTenant(session, async tx => {
    const controls = await movementTypeControlsTx(tx, session.tenantId, types);
    const reasons = await terminationReasonCatalogueTx(tx, session.tenantId);
    const current = await movementCurrentStateTx(tx, employmentId);
    return { controls, reasons, current };
  });
}
