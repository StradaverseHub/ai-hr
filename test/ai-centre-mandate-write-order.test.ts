/** Real product setters and raw app statements; no patched guards, providers or effect bodies. */
import {sql} from 'drizzle-orm';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {client,withTenant,type SessionContext,type Tx} from '../db/client';
import {setMandateStopSwitch,setManagerRevocationPolicy} from '../core/mandates/mandates';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();base=await seedBase();ctx=adminCtx(base);});
const facts=(tenantId:string)=>owner.client`select tenant_id,stopped,version,manager_may_revoke,changed_by_user_id from teras_mandate_control where tenant_id=${tenantId}`;
const events=(tenantId:string)=>owner.client`select tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload from domain_event where tenant_id=${tenantId}and aggregate_type='teras-mandate-control' order by sequence`;
async function boundedReady(ready:Promise<void>,running:Promise<unknown>){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([ready,running.then(()=>{throw Error('Native transaction finished before expected entry');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Native transaction never entered')),2500);})]);}finally{clearTimeout(timer);}
}
function watched<T>(promise:Promise<T>){void promise.catch(()=>{});return promise;}
const limits=(tx:Tx)=>tx.execute(sql`select set_config('lock_timeout','5s',true),set_config('statement_timeout','10s',true)`);

it('retains initialization, exact stop generations, policy updates while stopped, native authority and transactional audit',async()=>{
 const initialized=await setManagerRevocationPolicy(ctx,true);
 expect(initialized).toMatchObject({tenantId:base.tenantId,stopped:false,version:1,managerMayRevoke:true,changedByUserId:ctx.userId});
 expect(await setMandateStopSwitch(ctx,true,{expectedGeneration:1,reason:'Fictional stop'})).toMatchObject({stopped:true,version:2,managerMayRevoke:true});
 expect(await setManagerRevocationPolicy(ctx,false)).toMatchObject({stopped:true,version:3,managerMayRevoke:false});
 expect(await setMandateStopSwitch(ctx,false,{expectedGeneration:3})).toMatchObject({stopped:false,version:4});
 expect(await setMandateStopSwitch(ctx,false,{expectedGeneration:4})).toMatchObject({stopped:false,version:4});
 const before=await facts(base.tenantId),audit=await events(base.tenantId);
 expect(Array.from(audit)).toEqual([
  ['teras-mandate.manager-revocation-allowed',{version:1}],['teras-mandate.stopped',{version:2,reason:'Fictional stop'}],
  ['teras-mandate.manager-revocation-disallowed',{version:3}],['teras-mandate.resumed',{version:4}],['teras-mandate.resumed',{version:4}],
 ].map(([event_type,payload])=>({tenant_id:base.tenantId,aggregate_type:'teras-mandate-control',aggregate_id:base.tenantId,event_type,actor_type:'user',actor_id:ctx.userId,payload})));
 await expect(setMandateStopSwitch(ctx,true,{expectedGeneration:3})).rejects.toMatchObject({reason:'invalid'});
 const ordinary=await createAppUser(base.tenantId,null,'employee');
 const stale:SessionContext={...ctx,userId:ordinary,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 // TypeScript sees an administrator, but the real native current-principal/RLS owner refuses.
 await expect(setMandateStopSwitch(stale,true)).rejects.toMatchObject({reason:'not_administrator'});
 await expect(setManagerRevocationPolicy(stale,true)).rejects.toMatchObject({cause:{code:'42501'}});
 await expect(withTenant(stale,tx=>tx.execute(sql`insert into teras_mandate_control(tenant_id,changed_by_user_id)values(${base.tenantId},${ordinary})`))).rejects.toMatchObject({cause:{code:'42501'}});
 await expect(withTenant({...ctx,userId:ordinary,roles:['employee'],grants:[{role:'employee',companyId:null}]},tx=>tx.execute(sql`insert into teras_mandate_control(tenant_id,changed_by_user_id)values(${base.tenantId},${ordinary})`))).rejects.toMatchObject({cause:{code:'42501'}});
 await expect(withTenant(ctx,async tx=>{await tx.execute(sql`update teras_mandate_control set stopped=true,changed_by_user_id=${ctx.userId}where tenant_id=${base.tenantId}`);throw Error('Fictional rollback');})).rejects.toThrow('Fictional rollback');
 expect(await facts(base.tenantId)).toEqual(before);expect(await events(base.tenantId)).toEqual(audit);
 const other=await seedBase(),otherCtx=adminCtx(other);expect(await setMandateStopSwitch(otherCtx,true,{expectedGeneration:0})).toMatchObject({stopped:true,version:1,managerMayRevoke:false});
 expect(await setMandateStopSwitch(otherCtx,false,{expectedGeneration:1})).toMatchObject({stopped:false,version:2});
 const third=await seedBase(),thirdCtx=adminCtx(third);
 await withTenant(thirdCtx,tx=>tx.execute(sql`insert into teras_mandate_control(tenant_id,changed_by_user_id)values(${third.tenantId},${thirdCtx.userId})`));
 expect((await facts(third.tenantId))[0]).toEqual({tenant_id:third.tenantId,stopped:false,version:1,manager_may_revoke:false,changed_by_user_id:thirdCtx.userId});
},60000);

it('orders real raw UPDATE and the unchanged stop setter before rows in both genuine competing courses',async()=>{
 const report:Record<string,unknown>={kind:'NATIVE_AI_CENTRE_MANDATE_COMPETING_WRITERS_COMPONENT_ONLY',releaseAuthorized:false,complete:false,
  resourceBound:{caseMs:60000,newPools:0,baselineOwnerPoolMax:owner.client.options.max,baselineAppPoolMax:client.options.max,maximumConcurrentFixtureConnections:4,
   lockTimeoutMs:5000,statementTimeoutMs:10000,entryWaitMs:2500,observerPolls:100,observerPollMs:20},courses:[]};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'ai-centre-mandate-competing-writers.json'),JSON.stringify(report,null,2));};
 expect(client.options.max).toBeGreaterThanOrEqual(2);expect(owner.client.options.max).toBeGreaterThanOrEqual(2);
 const[identity]=await client`select current_user as role,session_user as login,current_database()as database`;expect(identity.role).toBe('ai_hr_app');expect(identity.login).toBe('ai_hr_app');report.applicationLogin=identity;
 const foreign=await seedBase();await setMandateStopSwitch(adminCtx(foreign),true);const foreignBefore=await facts(foreign.tenantId);
 await setManagerRevocationPolicy(ctx,false);let version=1;
 const courses:unknown[]=[];
 try{for(const first of ['raw','stop']as const){
  let release=()=>{},entered=()=>{},rawEntered=()=>{},rawPid:number|undefined,holderPid:number|undefined,stopPid:number|undefined;
  const hold=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;}),rawReady=new Promise<void>(resolve=>{rawEntered=resolve;});
  let holder:Promise<unknown>|undefined,stop:Promise<unknown>|undefined,raw:Promise<unknown>|undefined,blocked=false;
  const before=await facts(base.tenantId),auditBefore=await events(base.tenantId);
  try{
   if(first==='raw'){
    raw=withTenant(ctx,async tx=>{await limits(tx);const[pid]=await tx.execute<{pid:number}>(sql`select pg_backend_pid()as pid`);rawPid=pid.pid;holderPid=pid.pid;
     await tx.execute(sql`update teras_mandate_control set manager_may_revoke=not manager_may_revoke,changed_by_user_id=${ctx.userId}where tenant_id=${base.tenantId}`);entered();await hold;
    });await boundedReady(ready,raw);
    stop=watched(setMandateStopSwitch(ctx,true,{expectedGeneration:version+1,reason:'Fictional ordered raw first'}));
    for(let poll=0;poll<100;poll++){
     const rows=await owner.client`select l.pid,${holderPid}::integer=any(pg_blocking_pids(l.pid))as blocked,
      not exists(select 1 from pg_locks ai where ai.pid=l.pid and ai.locktype='advisory'and ai.granted and ai.objsubid=2
       and ai.classid::bigint=(hashtext('ai-control')::bigint+4294967296)%4294967296
       and ai.objid::bigint=(hashtext(${base.tenantId})::bigint+4294967296)%4294967296)as ai_not_acquired from pg_locks l join pg_stat_activity a on a.pid=l.pid
      where l.locktype='advisory'and not l.granted and l.objsubid=1
       and l.classid::bigint=((hashtextextended(${'access-configuration:'+base.tenantId},0)>>32)&4294967295)
       and l.objid::bigint=(hashtextextended(${'access-configuration:'+base.tenantId},0)&4294967295) and a.datname=current_database()and a.usename='ai_hr_app'and l.pid<>${rawPid}`;
     const waiting=rows.find(row=>row.blocked);if(waiting){expect(waiting.ai_not_acquired).toBe(true);stopPid=waiting.pid as number;blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
    }
   }else{
    // Hold the real audit-table effect barrier. The unchanged setter has already
    // taken Access→AI and changed its row before its native event INSERT waits here.
    holder=owner.client.begin(async tx=>{await tx`set local lock_timeout='5s'`;await tx`set local statement_timeout='10s'`;const[pid]=await tx`select pg_backend_pid()as pid`;holderPid=pid.pid as number;
     await tx`lock table domain_event in share mode`;entered();await hold;
    });await boundedReady(ready,holder);
    stop=watched(setMandateStopSwitch(ctx,false,{expectedGeneration:version,reason:'Fictional ordered stop first'}));
    for(let poll=0;poll<100;poll++){
     const rows=await owner.client`select a.pid from pg_stat_activity a where a.datname=current_database()and a.usename='ai_hr_app'and ${holderPid}::integer=any(pg_blocking_pids(a.pid))`;
     if(rows.length){expect(rows).toHaveLength(1);stopPid=rows[0].pid as number;break;}await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(stopPid,'real setter must wait at its actual audit INSERT').toBeTypeOf('number');
    raw=withTenant(ctx,async tx=>{await limits(tx);const[pid]=await tx.execute<{pid:number}>(sql`select pg_backend_pid()as pid`);rawPid=pid.pid;rawEntered();
     return tx.execute(sql`update teras_mandate_control set manager_may_revoke=not manager_may_revoke,changed_by_user_id=${ctx.userId}where tenant_id=${base.tenantId}`);
    });await boundedReady(rawReady,raw);
    for(let poll=0;poll<100;poll++){
     const[state]=await owner.client`select ${stopPid}::integer=any(pg_blocking_pids(${rawPid}::integer))as blocked,
      exists(select 1 from pg_locks where pid=${rawPid}and locktype='advisory'and not granted and objsubid=1
       and classid::bigint=((hashtextextended(${'access-configuration:'+base.tenantId},0)>>32)&4294967295)
       and objid::bigint=(hashtextextended(${'access-configuration:'+base.tenantId},0)&4294967295))as access_wait,
      exists(select 1 from pg_locks where pid=${rawPid}and locktype='tuple')as tuple_lock`;
     if(state.blocked){expect(state.access_wait).toBe(true);expect(state.tuple_lock).toBe(false);blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
    }
   }
   courses.push({first,rawPid,stopPid,holderPid,blocked});report.courses=courses;save();expect(blocked,first+' course must have actual native blocking PIDs').toBe(true);
  }finally{release();await Promise.allSettled([...(raw?[raw]:[]),...(stop?[stop]:[]),...(holder?[holder]:[])]).then(results=>{for(const result of results)if(result.status==='rejected')throw result.reason;});}
  version+=2;
  expect(await facts(base.tenantId)).toEqual([{tenant_id:base.tenantId,stopped:first==='raw',version,manager_may_revoke:first==='raw',changed_by_user_id:ctx.userId}]);
  expect(before[0].version).toBe(version-2);expect(await facts(foreign.tenantId)).toEqual(foreignBefore);
  const audit=await events(base.tenantId);expect(audit.slice(0,-1)).toEqual(auditBefore);
  expect(audit.at(-1)).toEqual({tenant_id:base.tenantId,aggregate_type:'teras-mandate-control',aggregate_id:base.tenantId,
   event_type:first==='raw'?'teras-mandate.stopped':'teras-mandate.resumed',actor_type:'user',actor_id:ctx.userId,
   payload:{version:first==='raw'?version:version-1,reason:first==='raw'?'Fictional ordered raw first':'Fictional ordered stop first'}});
 }
 report.complete=true;save();}finally{save();}
},60000);
