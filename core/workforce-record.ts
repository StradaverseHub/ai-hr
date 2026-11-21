import {sql} from 'drizzle-orm';
import {type SessionContext} from '../db/client';
import type {EmployeeListRow} from './read';
import type {WorkforceProfile} from '../lib/workforce-record-fields';
import {withPersonnelRead} from './personnel-read-bounds';

export type WorkforceRecord = {employment: EmployeeListRow; profile: WorkforceProfile};
/** Standalone Workforce snapshot. Permission and fields share one version of the database.
 * This never returns the private HR detail payload to a new view grant. */
export function workforceRecord(ctx: SessionContext, employmentId: string): Promise<WorkforceRecord | null> {
  return withPersonnelRead(ctx, async tx => {
    const [row] = await tx.execute<{record: WorkforceRecord | null}>(sql`select app.access_workforce_record(${employmentId}::uuid) as record`);
    return row?.record ?? null;
  });
}
