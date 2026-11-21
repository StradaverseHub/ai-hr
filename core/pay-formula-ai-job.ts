/** Background AI Formula Generator (migration 5130). The request that starts a draft only admits it and returns; the
 * governed draft (core/pay-formula-ai.ts) runs afterwards with the longer background provider budget, and its outcome
 * is stored for the requesting login alone. Why here and not on the bulk-job worker: that worker serves every import
 * and payroll job one unit at a time on one owner connection, so a 90 s model wait there would stall all of them, and
 * its reviewed environment (deploy/systemd/bank_import_worker_installer_v2.py ENV_KEYS) holds no AI configuration
 * secret or provider egress. The provider wait holds no database connection; every transaction here and in the draft
 * path is short and runs in the background admission lane, so interactive work keeps priority.
 *
 * Models propose; the draft is the same adjudicated, validated suggestion as before. Nothing here saves, activates or
 * applies a formula, and no retry is made: a timed-out call may still be charged, so a second call is only ever the
 * author's explicit new request, admitted and accounted on its own. */
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {withBackgroundDatabaseWork} from '../db/workload';
import {assertPayFormulaDraftAuthorTx} from '../packs/payroll/service';
import {draftPayFormulaInBackground,payFormulaDraftFailureReason,PAY_FORMULA_BACKGROUND_TIMEOUT_MS} from './pay-formula-ai';
import {payFormulaDraftRequest,type PayFormulaDraft} from '../lib/pay-formula-ai';
import {PAY_FORMULA_DRAFT_FAILURE_REASONS,type PayFormulaDraftFailureReason,type PayFormulaDraftJobReason,type PayFormulaDraftJobStart,type PayFormulaDraftJobView} from '../lib/pay-formula-draft-job';
export type {PayFormulaDraftJobReason,PayFormulaDraftJobStart,PayFormulaDraftJobView} from '../lib/pay-formula-draft-job';

/** Admission, validation and the background lane's waits on top of the provider budget. Past it, a running row is
 *  reported as interrupted (the web process stopped) and a new start may replace it. */
export const PAY_FORMULA_DRAFT_GRACE_MS=60_000;
/** How long a finished draft stays readable by its author. */
export const PAY_FORMULA_DRAFT_RETENTION_MINUTES=30;
/** Below migration 5130's 262,144-byte CHECK, with room for jsonb's own text spacing. */
const RESULT_BYTES=200_000;

export type PayFormulaDraftSchedule=(work:()=>Promise<void>)=>void;

type Row={id:string;requirement_digest:string;state:'running'|'succeeded'|'failed';reason:string|null;result:unknown;timeout_ms:number;started_at:Date|string;overdue:boolean};
const reasons=new Set<string>(PAY_FORMULA_DRAFT_FAILURE_REASONS);
function view(row:Row):PayFormulaDraftJobView{
 const interrupted=row.state==='running'&&row.overdue===true;
 const reason=interrupted?'interrupted':row.state==='failed'?(reasons.has(row.reason??'')?row.reason as PayFormulaDraftFailureReason:'failed'):null;
 return Object.freeze({id:row.id,state:interrupted?'failed':row.state,reason,timeoutSeconds:Math.round(row.timeout_ms/1000),
  startedAt:new Date(row.started_at).toISOString(),result:row.state==='succeeded'?row.result as PayFormulaDraft:null});
}
const columns=sql`id,requirement_digest,state,reason,result,timeout_ms,started_at,(state='running' and deadline_at<=now()) as overdue`;
const digestOf=(requirement:string)=>createHash('sha256').update(requirement,'utf8').digest('hex');
function login(ctx:SessionContext):string{if(!ctx.userId)throw new Error('Sign in again to generate a formula.');return ctx.userId;}

/** The author's current generation: one primary-key read (tenant_id, user_id) under row security, nothing else. */
export function payFormulaDraftJobReadSql(ctx:SessionContext){
 return sql`select ${columns} from pay_formula_ai_draft_job where tenant_id=${ctx.tenantId}::uuid and user_id=${login(ctx)}::uuid and expires_at>now()`;
}
export async function readPayFormulaDraftJobTx(tx:Tx,ctx:SessionContext):Promise<PayFormulaDraftJobView|null>{
 const [row]=await tx.execute<Row>(payFormulaDraftJobReadSql(ctx));
 return row?view(row):null;
}
/** Poll and reload read. Row security limits it to the requesting login in its tenant while its roles are current. */
export async function readPayFormulaDraftJob(ctx:SessionContext):Promise<PayFormulaDraftJobView|null>{
 login(ctx);
 return withTenant(ctx,tx=>readPayFormulaDraftJobTx(tx,ctx));
}
/** The author removes a finished draft (Clear). A running generation stays until it ends. */
export async function discardPayFormulaDraftJob(ctx:SessionContext):Promise<void>{
 const user=login(ctx);
 await withTenant(ctx,tx=>tx.execute(sql`delete from pay_formula_ai_draft_job where tenant_id=${ctx.tenantId}::uuid and user_id=${user}::uuid`));
}

/** Admits a generation and returns at once; `schedule` runs the draft after the response (next/server `after` on the
 *  web). The same checks as the synchronous path refuse an unauthorised author before anything is stored. */
export async function startPayFormulaDraftJob(ctx:SessionContext,input:unknown,schedule:PayFormulaDraftSchedule,timeoutMs=PAY_FORMULA_BACKGROUND_TIMEOUT_MS):Promise<PayFormulaDraftJobStart>{
 const request=payFormulaDraftRequest.parse(input),user=login(ctx);
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>PAY_FORMULA_BACKGROUND_TIMEOUT_MS)throw new Error('Invalid formula draft budget.');
 const id=randomUUID(),digest=digestOf(request.requirement),deadlineMs=timeoutMs+PAY_FORMULA_DRAFT_GRACE_MS;
 const admitted=await withTenant(ctx,async tx=>{
  await assertPayFormulaDraftAuthorTx(tx,ctx);
  // No WHERE: the DELETE policies alone apply, removing this login's finished draft and the tenant's expired rows.
  await tx.execute(sql`delete from pay_formula_ai_draft_job`);
  const [started]=await tx.execute<Row>(sql`insert into pay_formula_ai_draft_job(tenant_id,user_id,id,requirement_digest,state,timeout_ms,started_at,deadline_at,expires_at)
   values(${ctx.tenantId}::uuid,${user}::uuid,${id}::uuid,${digest},'running',${timeoutMs}::int,now(),now()+make_interval(secs=>${deadlineMs/1000}::double precision),now()+interval '1 hour')
   on conflict(tenant_id,user_id) do update set id=excluded.id,requirement_digest=excluded.requirement_digest,state='running',reason=null,result=null,
    timeout_ms=excluded.timeout_ms,started_at=excluded.started_at,deadline_at=excluded.deadline_at,finished_at=null,expires_at=excluded.expires_at
   where pay_formula_ai_draft_job.state<>'running' or pay_formula_ai_draft_job.deadline_at<=now()
   returning ${columns}`);
  if(started)return{outcome:'started' as const,row:started};
  const [current]=await tx.execute<Row>(payFormulaDraftJobReadSql(ctx));
  if(!current)throw new Error('The formula draft could not be started.');
  return{outcome:current.requirement_digest===digest?'resumed' as const:'busy' as const,row:current};
 });
 if(admitted.outcome==='started'){
  const captured=structuredClone({ctx,request});
  schedule(()=>runPayFormulaDraftJob(captured.ctx,captured.request,id,timeoutMs).catch(()=>{
   console.error('[pay-formula] background draft outcome could not be recorded');
  }));
 }
 return Object.freeze({outcome:admitted.outcome,job:view(admitted.row)});
}

/** The background unit: the governed draft, then one fenced write of its outcome to this generation's row. A row that
 *  was replaced or discarded meanwhile is left alone (the write matches on id and state). */
export async function runPayFormulaDraftJob(ctx:SessionContext,input:unknown,id:string,timeoutMs=PAY_FORMULA_BACKGROUND_TIMEOUT_MS):Promise<void>{
 const user=login(ctx);
 await withBackgroundDatabaseWork(async()=>{
  let result:PayFormulaDraft|null=null,reason:PayFormulaDraftFailureReason|null=null,json:string|null=null;
  try{result=await draftPayFormulaInBackground(ctx,input,timeoutMs);json=JSON.stringify(result);if(Buffer.byteLength(json,'utf8')>RESULT_BYTES){result=null;json=null;reason='invalid_draft';}}
  catch(error){reason=payFormulaDraftFailureReason(error);}
  const state=result?'succeeded':'failed';
  for(let attempt=1;;attempt++){
   try{
    await withTenant(ctx,tx=>tx.execute(sql`update pay_formula_ai_draft_job set state=${state},reason=${state==='failed'?reason??'failed':null},
     result=${json}::jsonb,finished_at=now(),expires_at=now()+make_interval(mins=>${PAY_FORMULA_DRAFT_RETENTION_MINUTES}::int)
     where tenant_id=${ctx.tenantId}::uuid and user_id=${user}::uuid and id=${id}::uuid and state='running'`));
    return;
   }catch(error){
    if(attempt>=3)throw error;
    await new Promise(resolve=>setTimeout(resolve,500*attempt));
   }
  }
 });
}
