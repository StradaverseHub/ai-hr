/** The two transaction facts Home and AI read compositions prove before reading, each as ONE statement text, so a
 * request's shared read snapshot (db/shared-read.ts) answers every owner's proof with one statement. Each answer is
 * exactly the boolean the owner's own probe computed; a refusal is still the owner's own decision. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';

/** True only inside a REPEATABLE READ READ ONLY transaction. */
export async function isRepeatableReadOnlyTx(tx:Tx):Promise<boolean>{
 const [row]=await tx.execute<{snapshot:boolean}>(sql`select current_setting('transaction_isolation')='repeatable read' and current_setting('transaction_read_only')='on' as snapshot`);
 return row?.snapshot===true;
}
/** app.principal_snapshot_current(): the login's role and grant snapshot is still the transaction's identity. */
export async function isPrincipalSnapshotCurrentTx(tx:Tx):Promise<boolean>{
 const [row]=await tx.execute<{current:boolean}>(sql`select app.principal_snapshot_current() as current`);
 return row?.current===true;
}
