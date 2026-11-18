/** A checkpoint per held workflow step; no successful or uncertain delivery is replayed. */
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withTenant, type SessionContext } from '../db/client';
import { enqueueBulkJobTx } from './bulk-job';
import type { BulkJobHandler } from './bulk-job-worker';
import { lockAccessConfigurationReadTx } from './access-configuration-lock';
import { managerEmailRecoveryPage, recoverManagerEmailHoldTx, type ManagerEmailRecoveryTarget } from '../packs/lifecycle/v9/service';
const kind='lifecycle_manager_recovery';
const targetSchema=z.object({tenantId:z.uuid(),caseId:z.uuid(),companyId:z.uuid(),revision:z.number().int().min(1),runId:z.string().min(1).max(500),stepId:z.string().min(1).max(120),heldAt:z.string().min(1).max(100),dueOn:z.string().nullable(),classification:z.enum(['future','today','late','unknown'])}).strict();
const manifestSchema=z.array(targetSchema).min(1).max(1000);
export { managerEmailRecoveryPage };
/** Admission only. The protected worker performs the separately approved recovery later. */
export async function requestManagerEmailRecovery(ctx:SessionContext,manifest:ManagerEmailRecoveryTarget[]){
 if(!ctx.userId||ctx.agent)throw new Error('Sign in as authorised HR to admit recovery.');
 const targets=manifestSchema.parse(manifest);
 if(!targets.length||targets.some(t=>t.tenantId!==ctx.tenantId))throw new Error('A nonempty same-tenant recovery manifest is required.');
 const source=Buffer.from(JSON.stringify(targets)),token=createHash('sha256').update(source).digest('hex');
 return withTenant(ctx,async tx=>{
  // The held-register RLS is the case/company boundary; check the entire set in one statement.
  const ids=[...new Set(targets.map(t=>t.caseId))];
  const [allowed]=await tx.execute<{count:number}>(sql`select count(distinct case_id)::integer as count from lc_v9_email_hold where tenant_id=${ctx.tenantId}::uuid and released_at is null and case_id=any(ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`);
  if(allowed.count!==ids.length)throw new Error('Full lifecycle case access is required for every recovery target.');
  return enqueueBulkJobTx(tx,ctx,{kind,companyIds:[...new Set(targets.map(t=>t.companyId))],source:{name:'manager-email-recovery.json',content:source},input:{token}});
 });
}
export const lifecycleManagerRecoveryHandler:BulkJobHandler<ManagerEmailRecoveryTarget[]>={
 kind,mode:'per-step',maxStepsPerChunk:1,chunkBudgetMs:100,phaseOf:()=>'rechecking',
 async prepare(ctx,job){
  const bytes=Buffer.from(job.source_content??Buffer.alloc(0)),input=job.input as {token:string};
  if(createHash('sha256').update(bytes).digest('hex')!==input.token)return{refused:'Recovery manifest identity changed.'};
  const targets=manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if(targets.some(t=>t.tenantId!==ctx.tenantId))return{refused:'Recovery tenant changed.'};
  const grouped=new Map<string,ManagerEmailRecoveryTarget[]>();for(const target of targets)grouped.set(target.caseId,[...(grouped.get(target.caseId)??[]),target]);
  return{steps:[...grouped.values()].map(targets=>({kind:'hold',payload:targets})),counters:{total:targets.length}};
 },
 async beginChunkTx(tx,ctx){await lockAccessConfigurationReadTx(tx,ctx.tenantId);},
 async applyStepTx(tx,ctx,_job,step){
  let revision=step.payload[0].revision;const results:unknown[]=[],counters:Record<string,number>={};
  for(const target of step.payload){const result=await recoverManagerEmailHoldTx(tx,ctx,{...target,revision});results.push(result);counters[result.outcome]=(counters[result.outcome]??0)+1;if('revision' in result)revision=result.revision!;else if(result.outcome==='changed')break;}
  return{result:results,counters};
 },
 async finalize(_ctx,job){return{result:{...job.counters,failed:job.errors.length}};},
};
