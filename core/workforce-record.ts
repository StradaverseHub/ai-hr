import {sql} from 'drizzle-orm';
import {withTenant, type SessionContext} from '../db/client';
import type {EmployeeListRow} from './read';
import type {WorkforceProfile} from '../lib/workforce-record-fields';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';

export type WorkforceRecord = {employment: EmployeeListRow; profile: WorkforceProfile};
/** Standalone Workforce read. It shares the Access lock with other readers, while configuration
 * writers still exclude it. This never returns the private HR detail payload to a new view grant. */
export function workforceRecord(ctx: SessionContext, employmentId: string): Promise<WorkforceRecord | null> {
  return withTenant(ctx, async tx => {
    await lockAccessConfigurationReadTx(tx, ctx.tenantId);
    const [row] = await tx.execute<{record: WorkforceRecord | null}>(sql`select app.access_workforce_record(${employmentId}::uuid) as record`);
    return row?.record ?? null;
  });
}
