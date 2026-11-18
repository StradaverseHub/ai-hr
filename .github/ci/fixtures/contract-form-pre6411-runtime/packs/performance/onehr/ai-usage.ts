import { and,eq,sql } from 'drizzle-orm';
import type { SessionContext,Tx } from '../../../db/client';
import { assessmentAiUse } from '../../../db/schema';

export const assessmentAiDailyLimit=5;
/** Business usage is recorded with the successful draft transaction, never inferred from AI telemetry. */
export async function assessmentAiQuotaTx(tx:Tx,ctx:SessionContext,fieldKey:string){
 if(!ctx.userId)throw Error('Sign in to request a suggestion.');
 const [row]=await tx.select({used:sql<number>`count(*)::integer`,resetSeconds:sql<number>`greatest(0,extract(epoch from (((now() at time zone 'Asia/Kuala_Lumpur')::date+1)::timestamp at time zone 'Asia/Kuala_Lumpur')-now()))::integer`}).from(assessmentAiUse).where(and(eq(assessmentAiUse.actorUserId,ctx.userId),eq(assessmentAiUse.fieldKey,fieldKey),sql`${assessmentAiUse.createdAt}>=((now() at time zone 'Asia/Kuala_Lumpur')::date::timestamp at time zone 'Asia/Kuala_Lumpur')`));
 const used=row?.used??0;return {used,remaining:Math.max(0,assessmentAiDailyLimit-used),limit:assessmentAiDailyLimit,resetSeconds:used>=assessmentAiDailyLimit?row?.resetSeconds??0:0};
}
export async function recordAssessmentAiUseTx(tx:Tx,ctx:SessionContext,reviewId:string,fieldKey:string,requestId:string){
 await tx.insert(assessmentAiUse).values({tenantId:ctx.tenantId,actorUserId:ctx.userId!,reviewId,fieldKey,requestId});
}
