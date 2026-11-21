/** Server-only custody proof. The DB still adjudicates actor, revision and state. Never accept claims from a request. */
import {sql} from 'drizzle-orm';
import type {Tx,SessionContext} from '../db/client';
import {internalConfig} from '../lib/internal-auth/config';
import {signResignationRuntime,type ResignationRuntimeClaim} from '../lib/resignation-runtime-proof';
export {signResignationRuntime,resignationRuntimeKey} from '../lib/resignation-runtime-proof';
export async function prepareResignationProofTx(tx:Tx,ctx:SessionContext,claim:ResignationRuntimeClaim):Promise<void>{
 const[row]=await tx.execute<{id:string}>(sql`select txid_current()::text as id`);
 const proof=signResignationRuntime(claim,{tenantId:ctx.tenantId,userId:ctx.userId??null,personId:ctx.personId??null,transactionId:row.id},internalConfig().key);
 await tx.execute(sql`select app.resignation_journey_admit(${proof.payload},${proof.signature})`);
}
