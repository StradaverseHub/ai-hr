/** AI v2 W8 — pausing a loop for one company.
 *
 * A loop's own switch is the registry switch (core/agent-registry/controls.ts setWorkerSwitch, group administrators
 * only, for every company). An administrator of a company may pause a switched-on loop for that company, and resume
 * it: the loop then neither runs nor shows its cards there. The change is attributed to the administrator in the row
 * and audited as a domain event (who, when, which loop and company, before and after). The database refuses a pause
 * by anyone who does not administer the company (migration 0960). */
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {terasLoopPause,type TerasLoopWorker} from '../../db/teras-schema';
import {isAdmin} from '../../lib/authz-model';
import {isLoopId} from './types';

export class LoopControlRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'){super('Loop control refused: '+reason);this.name='LoopControlRefused';}}

export async function setLoopPause(supplied:SessionContext,input:Readonly<{workerId:unknown;companyId:unknown;paused:unknown}>){
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new LoopControlRefused('not_administrator');
 const companyId=z.guid().safeParse(input.companyId);
 // AI v2 P2-2b: the payroll Audit loop (migration 0965) is paused the same way.
 const known=isLoopId(input.workerId)||input.workerId==='loop_payroll_audit';
 if(!known||!companyId.success||typeof input.paused!=='boolean')throw new LoopControlRefused('invalid');
 const workerId=input.workerId as TerasLoopWorker,paused=input.paused;
 return withTenant(ctx,async tx=>{
  // The company must be this tenant's before the administrator check: app.is_admin_for answers from the grants alone,
  // so another tenant's group-wide grant would pass it for any company id (AI v2 P2-2a review).
  const [admin]=await tx.execute(sql`select exists(select 1 from public.company c where c.id=${companyId.data}::uuid and c.tenant_id=app.current_tenant_id()
   and app.is_admin_for(c.id)) as ok`) as unknown as {ok:boolean|null}[];
  if(admin?.ok!==true)throw new LoopControlRefused('not_administrator');
  const where=and(eq(terasLoopPause.tenantId,ctx.tenantId),eq(terasLoopPause.workerId,workerId),eq(terasLoopPause.companyId,companyId.data));
  const [before]=await tx.select({paused:terasLoopPause.paused}).from(terasLoopPause).where(where).limit(1).for('update');
  const [row]=before
   ?await tx.update(terasLoopPause).set({paused,changedByUserId:ctx.userId!,changedAt:sql`now()`}).where(where).returning()
   :await tx.insert(terasLoopPause).values({tenantId:ctx.tenantId,workerId,companyId:companyId.data,paused,changedByUserId:ctx.userId!}).returning();
  if(!row)throw new LoopControlRefused('not_administrator');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-loop',aggregateId:companyId.data,eventType:paused?'teras-loop.paused':'teras-loop.resumed',
   actor:actorOf(ctx),payload:{workerId,companyId:companyId.data,from:before?.paused===true,to:paused,version:row.version}});
  return Object.freeze(row);
 });
}
