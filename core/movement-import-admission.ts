/** A short, scoped admission mutex: never held across the human preview review. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
export const EMPLOYMENT_TEST_RECORD_EVENT='employment.test-record.changed';
export async function lockMovementImportReferenceAdmissionTx(tx:Tx,tenantId:string){
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('movement-import-reference-admission:' || ${tenantId}::text,0))`);
}
