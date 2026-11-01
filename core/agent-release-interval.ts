import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { AiGatewayError } from '../lib/ai/types';
const fail = (): never => { throw new AiGatewayError('Agent review could not be confirmed.'); };

/** Unified typed/prompt owner interval: active execution shares it; publication/rollback owns it. */
export async function agentReleaseIntervalTx(tx:Tx,ctx:SessionContext,ownerId:string,exclusive=true,required=true){
 const key='agent-release:'+ctx.tenantId+':'+ownerId;const [row]=await tx.execute<{owned:boolean}>(exclusive?
  sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as owned`:sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0)) as owned`);
 if(row?.owned!==true&&required)return fail();return row?.owned===true;
}
