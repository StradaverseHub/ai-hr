/** ADR 0181, employment visibility (migration 7240): the scheduled fictional walkthrough that gives the staging
 * shadow period its manager and department-head reads (docs/adr/0181-addendum-precomputed-employment-visibility.md,
 * section 7 item 3 and section 10 decision 5: 20,000 `reason=compared` reader calls in seven days, of which at least
 * 2,000 have `relationship=1`).
 *
 * Why it exists: in `shadow`, every call of app.access_visible_employment_ids() logs one count line, and
 * `relationship=1` means the caller's relationship part (self, administrative walk, department-head walk) reached
 * somebody other than the caller. Staging traffic is mostly administrators, whose reads are answered by the unchanged
 * admin arm, so natural traffic does not reach the relationship minimum. This job reads as fictional line managers and
 * department heads of the seed's fictional "Demo Group" tenant, through the same row policies their screens use.
 *
 * What it guarantees:
 *  * OFF BY DEFAULT. It does nothing unless AIHR_VISIBILITY_WALKTHROUGH is exactly `on`.
 *  * ONE TENANT, FIXED IN CODE: the demo seed's tenant (db/seed-guard.ts DEMO_TENANT_ID). No setting names another
 *    tenant. If that tenant is absent (a customer or production database never holds it; db/seed.ts refuses to plant
 *    it there), or DEV_TENANT_ID names another tenant, the job refuses with exit 2.
 *  * SHADOW ONLY. It reads only while the installation's 7240 mode is `shadow`; in `legacy` or `precomputed` the reads
 *    would log nothing, so it stops before opening a tenant transaction.
 *  * READ ONLY. Every transaction opens with BEGIN READ ONLY and is checked to be read only before its statement, so
 *    the server refuses any write; the statements are a fixed catalogue of counts, so no person or HR value ever
 *    reaches this process, and its output carries counts only.
 *  * BOUNDED. At most WALKTHROUGH_BOUNDS.statementsPerRun.max statements per run, at least pauseMs.min between them, a
 *    per-statement timeout and a run budget well inside the ten-minute schedule. The cron line adds `flock -n`.
 *
 * Actors: current employments of the tenant's own users (not archived, not login-blocked) that manage at least one
 * current administrative line on the HR date. Such a manager who also holds a current department assignment is a
 * department head in app.heads_department_of's sense, so the department-head walk is exercised by the same reads. */
import type {Sql} from 'postgres';
import {DEMO_TENANT_ID} from '../db/seed-guard';

export const WALKTHROUGH_SWITCH='AIHR_VISIBILITY_WALKTHROUGH';

type Bound={fallback:number;min:number;max:number;env:string};
export const WALKTHROUGH_BOUNDS={
 statementsPerRun:{fallback:40,min:1,max:120,env:'AIHR_VISIBILITY_WALKTHROUGH_STATEMENTS'},
 pauseMs:{fallback:250,min:100,max:10_000,env:'AIHR_VISIBILITY_WALKTHROUGH_PAUSE_MS'},
 actorsPerRun:{fallback:6,min:1,max:12,env:'AIHR_VISIBILITY_WALKTHROUGH_ACTORS'},
} as const satisfies Record<string,Bound>;
/** Each statement is cancelled by the server after this long. */
export const WALKTHROUGH_STATEMENT_TIMEOUT_MS=5_000;
/** The run stops starting statements after this long: well inside the ten-minute schedule. */
export const WALKTHROUGH_RUN_BUDGET_MS=240_000;
/** Eligible actors read per discovery; the run rotates through them. */
export const WALKTHROUGH_ACTOR_POOL=200;

export type WalkthroughSettings=
 |{enabled:false;reason:string}
 |{enabled:true;tenantId:string;statementsPerRun:number;pauseMs:number;actorsPerRun:number;notes:string[]};

/** Decide from the environment alone whether the walkthrough may run, and at what rate. Nothing here can widen the
 * tenant: it is always the demo seed's. A refusal that means "enabled on the wrong installation" is `refused`. */
export function walkthroughSettings(env:Record<string,string|undefined>):WalkthroughSettings&{refused?:boolean}{
 if(env[WALKTHROUGH_SWITCH]!=='on')return{enabled:false,reason:`${WALKTHROUGH_SWITCH} is not 'on'; nothing to do`};
 if(env.DEV_TENANT_ID!==undefined&&env.DEV_TENANT_ID!==DEMO_TENANT_ID)
  return{enabled:false,refused:true,reason:'DEV_TENANT_ID names another tenant than the demo seed; this is not the demo installation'};
 const notes:string[]=[];
 const read=(b:Bound)=>{
  const raw=env[b.env];
  if(raw===undefined||raw.trim()==='')return b.fallback;
  const n=Number(raw);
  if(!Number.isInteger(n)){notes.push(`${b.env} is not a whole number; using ${b.fallback}`);return b.fallback;}
  const clamped=Math.min(b.max,Math.max(b.min,n));
  if(clamped!==n)notes.push(`${b.env}=${n} is outside ${b.min}..${b.max}; using ${clamped}`);
  return clamped;
 };
 return{enabled:true,tenantId:DEMO_TENANT_ID,statementsPerRun:read(WALKTHROUGH_BOUNDS.statementsPerRun),
  pauseMs:read(WALKTHROUGH_BOUNDS.pauseMs),actorsPerRun:read(WALKTHROUGH_BOUNDS.actorsPerRun),notes};
}

/** The reads, one per transaction, each standing for a screen a line manager or department head opens. Each one
 * reads a table whose row policy calls app.visible_employment_ids() (directly, or through app.visible_person_ids()),
 * so each produces at least one shadow line. They return one count: no row value leaves the database. The shadow
 * line compares the caller's whole visible set, so which screen triggers the call does not change what is compared. */
export const WALKTHROUGH_READS=[
 {screen:'My Team list',sql:'select count(*)::int as n from (select e.id from employment e join person p on p.id = e.person_id where e.terminated_on is null order by p.full_name, e.id limit 200) x'},
 {screen:'Personnel as a manager',sql:'select count(*)::int as n from employment e where e.terminated_on is null'},
 {screen:'Team departments and positions',sql:'select count(*)::int as n from assignment a join employment e on e.id = a.employment_id where a.valid_to is null and a.superseded_at is null'},
 {screen:'Leave of reports',sql:'select count(*)::int as n from leave_request r'},
 {screen:'Leave approvals',sql:'select count(*)::int as n from leave_approval_step s'},
 {screen:'People directory',sql:'select count(*)::int as n from person p'},
 {screen:'Organisation chart',sql:"select count(*)::int as n from reporting_line l join employment s on s.id = l.subordinate_employment_id where l.line_type = 'administrative' and l.superseded_at is null"},
] as const;
export type WalkthroughRead=typeof WALKTHROUGH_READS[number];

export type WalkthroughActor={userId:string;departmentHead:boolean};
export type WalkthroughIdentity={tenantId:string;userId:string;roles:string;grants:string};
export type PlannedRead={actor:WalkthroughActor;read:WalkthroughRead};

/** The run's sequence: up to `actorsPerRun` actors from the pool, starting at `rotation` so successive runs cover
 * the whole pool, each actor taking the catalogue in turn, until `statementsPerRun` reads. Pure. */
export function walkthroughPlan(pool:readonly WalkthroughActor[],settings:{statementsPerRun:number;actorsPerRun:number},rotation:number):PlannedRead[]{
 if(pool.length===0)return[];
 const start=((rotation%pool.length)+pool.length)%pool.length;
 const actors=Array.from({length:Math.min(settings.actorsPerRun,pool.length)},(_,i)=>pool[(start+i)%pool.length]);
 const plan:PlannedRead[]=[];
 for(let i=0;plan.length<settings.statementsPerRun;i++){
  const actor=actors[i%actors.length];
  const read=WALKTHROUGH_READS[Math.floor(i/actors.length)%WALKTHROUGH_READS.length];
  plan.push({actor,read});
 }
 return plan;
}

export type WalkOutcome={statements:number;failed:number;stoppedByBudget:boolean;elapsedMs:number};

/** Execute a plan one statement at a time with `pauseMs` between statements, stopping at the run budget. Pure apart
 * from the injected executor, clock and sleep, so the rate bounds are testable without a database. */
export async function walkPlan(plan:readonly PlannedRead[],deps:{
 execute:(step:PlannedRead)=>Promise<void>;pauseMs:number;budgetMs?:number;now?:()=>number;sleep?:(ms:number)=>Promise<void>;
 onFailure?:(step:PlannedRead,error:unknown)=>void;
}):Promise<WalkOutcome>{
 const now=deps.now??Date.now,sleep=deps.sleep??(ms=>new Promise<void>(r=>setTimeout(r,ms)));
 const budget=Math.min(deps.budgetMs??WALKTHROUGH_RUN_BUDGET_MS,WALKTHROUGH_RUN_BUDGET_MS);
 const pause=Math.max(deps.pauseMs,WALKTHROUGH_BOUNDS.pauseMs.min);
 const started=now();
 const out:WalkOutcome={statements:0,failed:0,stoppedByBudget:false,elapsedMs:0};
 for(let i=0;i<plan.length&&i<WALKTHROUGH_BOUNDS.statementsPerRun.max;i++){
  if(i>0)await sleep(pause);
  if(now()-started>=budget){out.stoppedByBudget=true;break;}
  out.statements++;
  try{await deps.execute(plan[i]);}
  catch(error){out.failed++;deps.onFailure?.(plan[i],error);}
 }
 out.elapsedMs=now()-started;
 return out;
}

/** The checks that need the owner connection, in one read-only transaction: the tenant exists, the 7240 mode, and the
 * eligible actors. Counts and opaque user ids only; the ids stay in memory and are never printed. */
export async function walkthroughPreflight(owner:Sql,tenantId:string,hrDate:string):Promise<{tenantPresent:boolean;mode:string;pool:WalkthroughActor[]}>{
 return owner.begin('read only',async tx=>{
  const[t]=await tx<{present:boolean}[]>`select exists(select 1 from tenant where id=${tenantId}::uuid) as present`;
  if(!t.present)return{tenantPresent:false,mode:'unknown',pool:[]};
  const[m]=await tx<{mode:string|null}[]>`select (select c.mode from public.access_employment_precompute_control c where c.singleton) as mode`;
  const pool=await tx<{user_id:string;department_head:boolean}[]>`
   select u.id::text as user_id,
    bool_or(exists(select 1 from assignment a where a.employment_id=e.id and a.valid_to is null and a.superseded_at is null and a.department_id is not null)) as department_head
   from app_user u
   join employment e on e.person_id=u.person_id and e.tenant_id=u.tenant_id
   where u.tenant_id=${tenantId}::uuid and u.archived_at is null
    and e.terminated_on is null and e.voided_at is null
    and exists(select 1 from reporting_line l where l.tenant_id=e.tenant_id and l.manager_employment_id=e.id
     and l.line_type='administrative' and l.superseded_at is null
     and l.valid_from<=${hrDate}::date and (l.valid_to is null or l.valid_to>${hrDate}::date))
    and not app.login_blocked(u.id)
   group by u.id order by u.id limit ${WALKTHROUGH_ACTOR_POOL}`;
  return{tenantPresent:true,mode:m.mode??'legacy',pool:pool.map(r=>({userId:r.user_id,departmentHead:r.department_head}))};
 });
}

/** The session identity the application would build for this user (lib/session.ts toSession over app.principal),
 * or null when the principal does not resolve inside the walkthrough's tenant. */
export async function walkthroughIdentity(app:Sql,tenantId:string,userId:string):Promise<WalkthroughIdentity|null>{
 const p=await app.begin('read only',async tx=>{
  const[row]=await tx<{tenant_id:string;grants:{role:string;companyId:string|null}[]|null}[]>`
   select tenant_id::text as tenant_id,grants from app.principal(${userId}::uuid)`;
  return row??null;
 });
 if(!p||p.tenant_id!==tenantId)return null;
 const grants=(p.grants??[]).map(g=>({role:g.role,companyId:g.companyId??null}));
 return{tenantId,userId,roles:Array.from(new Set(grants.map(g=>g.role))).join(','),grants:JSON.stringify(grants)};
}

/** One read in its own READ ONLY transaction with the identity set transaction-locally, exactly as
 * db/client.ts bootstrapTenantTx sets it (PgBouncer transaction mode keeps nothing), JIT off, and a statement timeout.
 * Throws before the statement if the transaction is not read only. */
export async function readAs(app:Sql,identity:WalkthroughIdentity,statement:string,work?:(tx:Sql)=>Promise<unknown>):Promise<void>{
 await app.begin('read only',async tx=>{
  const[s]=await tx<{ro:string}[]>`select set_config('app.tenant_id',${identity.tenantId},true),set_config('app.user_id',${identity.userId},true),
   set_config('app.roles',${identity.roles},true),set_config('app.grants',${identity.grants},true),set_config('app.agent_principal_id','',true),
   set_config('jit','off',true),set_config('statement_timeout',${String(WALKTHROUGH_STATEMENT_TIMEOUT_MS)},true),
   current_setting('transaction_read_only') as ro`;
  if(s.ro!=='on')throw new Error('The walkthrough transaction is not read only; refusing to read.');
  if(work)await work(tx as unknown as Sql);
  else await tx.unsafe(statement);
 });
}

export type WalkthroughRun=
 |{status:'disabled'|'not_shadow';mode?:string;message:string}
 |{status:'refused';message:string}
 |{status:'ran';mode:string;pool:number;departmentHeads:number;actors:number;identitiesMissing:number}&WalkOutcome;

/** One scheduled run. `owner` is the migration owner (preflight only), `app` the application role the screens use. */
export async function runVisibilityWalkthrough(clients:{owner:Sql;app:Sql},settings:WalkthroughSettings&{refused?:boolean},opts:{
 hrDate:string;rotation:number;now?:()=>number;sleep?:(ms:number)=>Promise<void>;log?:(line:string)=>void;
}):Promise<WalkthroughRun>{
 const log=opts.log??(()=>{});
 if(!settings.enabled)return settings.refused?{status:'refused',message:settings.reason}:{status:'disabled',message:settings.reason};
 for(const note of settings.notes)log(`visibility-walkthrough ${note}`);
 const pre=await walkthroughPreflight(clients.owner,settings.tenantId,opts.hrDate);
 if(!pre.tenantPresent)return{status:'refused',message:'the demo seed tenant is absent; this is not the demo installation'};
 if(pre.mode!=='shadow')return{status:'not_shadow',mode:pre.mode,message:`employment visibility mode is ${pre.mode}; the walkthrough reads only in shadow`+
  ` (pool=${pre.pool.length} department_heads=${pre.pool.filter(a=>a.departmentHead).length})`};
 if(pre.pool.length===0)return{status:'refused',message:'the demo tenant has no current line manager with a login; nothing to read as'};
 const plan=walkthroughPlan(pre.pool,settings,opts.rotation);
 const identities=new Map<string,WalkthroughIdentity|null>();
 for(const step of plan)if(!identities.has(step.actor.userId))identities.set(step.actor.userId,await walkthroughIdentity(clients.app,settings.tenantId,step.actor.userId));
 const missing=Array.from(identities.values()).filter(v=>v===null).length;
 const runnable=plan.filter(step=>identities.get(step.actor.userId));
 const outcome=await walkPlan(runnable,{
  pauseMs:settings.pauseMs,now:opts.now,sleep:opts.sleep,
  execute:step=>readAs(clients.app,identities.get(step.actor.userId)!,step.read.sql),
  onFailure:(step,error)=>log(`visibility-walkthrough read failed screen="${step.read.screen}" error=${(error as {code?:string}).code??(error as Error).name}`),
 });
 return{status:'ran',mode:pre.mode,pool:pre.pool.length,departmentHeads:pre.pool.filter(a=>a.departmentHead).length,
  actors:identities.size,identitiesMissing:missing,...outcome};
}

/** 0 ran cleanly, or nothing to do (switched off, or not in shadow) · 2 refused (wrong installation, no actors), or a
 * read failed, or no actor resolved. */
export function walkthroughExitCode(run:WalkthroughRun):number{
 if(run.status!=='ran')return run.status==='refused'?2:0;
 if(run.failed>0||run.statements===0)return 2;
 return 0;
}

export function walkthroughSummary(run:WalkthroughRun):string{
 if(run.status!=='ran')return`visibility-walkthrough ${run.status}: ${run.message}`;
 return`visibility-walkthrough mode=${run.mode} pool=${run.pool} department_heads=${run.departmentHeads} actors=${run.actors}`+
  ` unresolved=${run.identitiesMissing} statements=${run.statements} failed=${run.failed} budget_stop=${run.stoppedByBudget?1:0} elapsed_ms=${run.elapsedMs}`;
}
