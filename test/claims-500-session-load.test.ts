/** Service burst probe, not an HTTP/browser capacity certificate. Uses the ordinary ten-connection
 * application pool and real distinct employee principals; no authorization bypass in measured work. */
import {setTimeout as pause} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {appUser,employment,person,roleAssignment} from '../db/schema';
import {createClaimType,deleteClaimDraft,listClaimHistoryPage,listClaimsForEmployment,saveClaimDraft} from '../packs/claims/service';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('measures burst and paced journeys for 500 employee sessions over one million distributed claims',async()=>{
 await resetDb();const b=await seedBase(),admin=adminCtx(b);
 const type=await createClaimType(admin,{code:'BURST',name:'Fictional burst',defaultTaxable:false,requiresReceipt:false});
 const users=Array.from({length:500},(_,i)=>({personId:randomUUID(),employmentId:randomUUID(),userId:randomUUID(),name:'Fictional '+i}));
 await owner.db.insert(person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:u.name,primaryEmail:u.userId+'@example.invalid'})));
 await owner.db.insert(employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2026-01-01'})));
 await owner.db.insert(appUser).values(users.map(u=>({id:u.userId,tenantId:b.tenantId,personId:u.personId,workosUserId:'fictional_load_'+u.userId})));
 await owner.db.insert(roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.userId,role:'employee' as const,companyId:b.companyId})));
 await owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
   select ${b.tenantId}::uuid,e.id,${type.id}::uuid,1,'2026-01-02'::date,'pending',
    '2026-01-03'::timestamptz+n*interval '1 second'
   from unnest(${users.map(u=>u.employmentId)}::uuid[]) e(id) cross join generate_series(1,2000) n`;
 await owner.client`analyze claim_request`;
 await owner.client`analyze person`;
 await owner.client`analyze employment`;
 await owner.client`analyze app_user`;
 await owner.client`analyze role_assignment`;
 await owner.client`analyze claim_type`;
 let samples:Record<string,number[]>={read:[],create:[],edit:[],delete:[]};
 let phase='burst';
 const started=performance.now();let checkpointAt=0;
 const checkpoint=()=>{
   if(performance.now()-checkpointAt<1000)return;checkpointAt=performance.now();
   if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/claims-500-progress.json',JSON.stringify({kind:'incomplete-service-load',phase,elapsedMs:performance.now()-started,completed:Object.fromEntries(Object.entries(samples).map(([key,values])=>{const sorted=[...values].sort((a,b)=>a-b);return [key,{samples:values.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],maxMs:sorted.at(-1)}];}))}));
 };
 checkpoint();
 const timed=async<T>(operation:string,run:()=>Promise<T>)=>{const start=performance.now();try{return await run();}finally{samples[operation].push(performance.now()-start);checkpoint();}};
 const warm=users[0],warmCtx={...admin,userId:warm.userId,personId:warm.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
 const warmInput={employmentId:warm.employmentId,claimTypeId:type.id,incurredOn:'2026-01-02',amount:1};
 const comparison:Record<string,number>={};
 for(const mode of ['default','off'] as const){
   const before=performance.now();
   const draft=mode==='default'?await withTenant(warmCtx,tx=>saveClaimDraft(warmCtx,warmInput,null,tx)):await saveClaimDraft(warmCtx,warmInput);
   comparison[mode+'CreateMs']=performance.now()-before;
   await deleteClaimDraft(warmCtx,draft.id,warm.employmentId);
 }
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/claims-jit-comparison.json',JSON.stringify(comparison));
 const phases:Record<string,unknown>={};
 for(phase of ['burst','paced']){
  samples={read:[],create:[],edit:[],delete:[]};const phaseStart=performance.now();
  const results=await Promise.allSettled(users.map(async(u,i)=>{
   if(phase==='paced')await pause(i*20);
   const think=()=>phase==='paced'?pause(750+(i%11)*50):Promise.resolve();
   const ctx={...admin,userId:u.userId,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
   const page=await timed('read',()=>listClaimHistoryPage(ctx,u.employmentId));
   expect(page.state.total).toBe(2000);expect(page.rows).toHaveLength(25);
   // A real different employee's id cannot be used to read their claim.
   if(i===0)expect(await listClaimsForEmployment(ctx,users[1].employmentId,{claimId:page.rows[0].id})).toEqual([]);
   if(i===0){const denied=await listClaimHistoryPage(ctx,users[1].employmentId);expect(denied.rows).toEqual([]);expect(denied.state.total).toBe(0);}
   await think();
   const input={employmentId:u.employmentId,claimTypeId:type.id,incurredOn:'2026-01-02',amount:1};
   const draft=await timed('create',()=>saveClaimDraft(ctx,input));
   await think();
   await timed('edit',()=>saveClaimDraft(ctx,{...input,id:draft.id,amount:2}));
   expect((await listClaimsForEmployment(ctx,u.employmentId,{claimId:draft.id}))[0]?.amount).toBe(2);
   await think();
   await timed('delete',()=>deleteClaimDraft(ctx,draft.id,u.employmentId));
   expect(await listClaimsForEmployment(ctx,u.employmentId,{claimId:draft.id})).toEqual([]);
  }));
  const failures=results.flatMap((r,i)=>r.status==='rejected'?[{session:i,message:String(r.reason)}]:[]);
  const operations=Object.fromEntries(Object.entries(samples).map(([k,values])=>{values.sort((a,b)=>a-b);return[k,{samples:values.length,p50Ms:values[Math.ceil(values.length*.5)-1],p95Ms:values[Math.ceil(values.length*.95)-1],p99Ms:values[Math.ceil(values.length*.99)-1],maxMs:values.at(-1)}];}));
  phases[phase]={elapsedMs:performance.now()-phaseStart,errors:failures.length,operations,failures};
  const report={kind:'service-burst-and-paced-only',fixtureStatistics:'all principal and claim fixture tables analyzed',sessions:500,records:1000000,applicationPool:10,pacedAssumption:'Warm after burst;500 starts over10seconds;750–1250ms pause between actions',auditHashChainFlag:process.env.AUDIT_HASH_CHAIN_ENABLED==='true',jitComparison:comparison,elapsedMs:performance.now()-started,phases};
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/claims-500-sessions.json',JSON.stringify(report,null,2));
  console.info('[claims-500-sessions]',JSON.stringify(report));
  expect(failures).toEqual([]);
 }
 const [remaining]=await owner.client`select count(*)::int as n from claim_request where tenant_id=${b.tenantId}::uuid`;
 expect(remaining.n).toBe(1000000);
},240000);
