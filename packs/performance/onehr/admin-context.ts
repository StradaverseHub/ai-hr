import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { actorOf, appendEvent } from '../../../db/events';
import { onehrCycle, reviewCycle } from '../../../db/schema';
import { policySchema } from './model';
export async function loadAssessmentAdminCycleTx(tx:Tx,cycleId:string){
 z.uuid().parse(cycleId);
 const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.onehr_cycle_admin(${cycleId}::uuid) as ok`);
 if(!allowed?.ok)throw Error('Performance administrator access is required.');
 const [cycle]=await tx.select().from(reviewCycle).where(eq(reviewCycle.id,cycleId)).for('update');
 const [config]=await tx.select().from(onehrCycle).where(eq(onehrCycle.cycleId,cycleId)).for('update');
 if(!cycle||!config)throw Error('Assessment cycle not found.');
 if(cycle.status==='closed')throw Error('An archived cycle is read-only.');
 return {cycle,config,policy:policySchema.parse(config.policy)};
}
export async function auditAssessmentAdminTx(tx:Tx,ctx:SessionContext,id:string,name:string,payload:Record<string,unknown>){
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'onehr',aggregateId:id,eventType:`onehr.${name}`,actor:actorOf(ctx),payload});
}
