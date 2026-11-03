/** AI v2 Phase 2 P2-1 — the loop attribution of a transaction (migration 0963).
 *
 * A loop's owner write runs under the sponsor's session (or, for an undo HR asked for, HR's), so row-level security is a
 * person's; setLoopAttributionTx marks the transaction as the loop's, and the database then records the loop in the
 * owner's own records: the attendance correction's agent columns and every domain event's actor and payload. The database
 * refuses an attribution that does not name the loop's own action row or that runs under anyone else's session. */
import {eq,sql} from 'drizzle-orm';
import type {Tx} from '../../db/client';
import {appUser,person} from '../../db/schema';
import {loopAttribution,type LoopAskedBy,type LoopAttribution} from '../../lib/ai-centre/loop-attribution';

export async function setLoopAttributionTx(tx:Tx,attribution:LoopAttribution):Promise<void>{
 await tx.execute(sql`select set_config('app.teras_loop_attribution',${JSON.stringify(attribution)},true)`);
}

/** A login's own name through their person record, where the session may read it. */
export async function userNameTx(tx:Tx,userId:string|null):Promise<string|null>{
 if(!userId)return null;
 const [row]=await tx.select({name:person.fullName}).from(appUser).leftJoin(person,eq(person.id,appUser.personId)).where(eq(appUser.id,userId)).limit(1);
 return row?.name??null;
}

/** Builds the attribution of one action, reading the sponsor's (and the asker's) names in the caller's transaction. */
export async function attributionForTx(tx:Tx,p:Readonly<{workerId:string;principalId:string;actionId:string;employmentId:string;sponsorUserId:string;
 askedBy?:LoopAskedBy|null;askedByUserId?:string|null}>):Promise<LoopAttribution>{
 const askedBy=p.askedBy??null,askedByUserId=askedBy?p.askedByUserId??null:null;
 return loopAttribution({workerId:p.workerId,principalId:p.principalId,actionId:p.actionId,employmentId:p.employmentId,sponsorUserId:p.sponsorUserId,
  sponsorName:await userNameTx(tx,p.sponsorUserId),askedBy,askedByUserId,askedByName:askedBy?await userNameTx(tx,askedByUserId):null});
}
