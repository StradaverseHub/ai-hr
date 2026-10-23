/** Own-only consumers must bind the supplied Person to the actual transaction login.
 * Broad HR visibility is still valid for general readers, but cannot prove ownership. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';

export function ownPersonPredicate(ctx:SessionContext){
 return sql`app.is_self_person(${ctx.personId??null}::uuid)`;
}

export async function isOwnPersonTx(tx:Tx,ctx:SessionContext){
 if(!ctx.personId||!ctx.userId)return false;
 const [row]=await tx.execute<{own:boolean}>(sql`select ${ownPersonPredicate(ctx)} as own`);
 return row?.own===true;
}
