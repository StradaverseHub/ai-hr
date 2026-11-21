/** Actual native bootstrap tracing; audit history remains authoritative and transaction-local. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {client,withTenant} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {verifyTenantChain} from '../core/audit-chain';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it('piggybacks an already sticky audit-on fact without a second bootstrap round trip or an audit hole',async()=>{
 vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED','false');await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const read=()=>withTenant(ctx,async tx=>(await tx.execute<{tenant:string;user:string;roles:string;audit:string}>(sql`select app.current_tenant_id()::text as tenant,app.current_user_id()::text as "user",current_setting('app.roles',true) as roles,current_setting('app.audit_hash_chain',true) as audit`))[0]);
 vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED','true');expect((await read()).audit).toBe('on');
 // Call through the actual driver and SQL; no result, authority or callback is substituted.
 const nativeBegin=client.begin;let active=false,bootstrapStatements=0,callbackStatements=0;
 vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{
  const index=args.findIndex(arg=>typeof arg==='function'),callback=args[index] as(native:typeof client)=>unknown;
  args[index]=(native:typeof client)=>callback(new Proxy(native,{get(target,key,receiver){
   if(key==='unsafe')return(...query:unknown[])=>{
    if(active&&typeof query[0]==='string'){if(query[0].includes('set_config('))bootstrapStatements++;else callbackStatements++;}
    return Reflect.apply(target.unsafe,target,query);
   };return Reflect.get(target,key,receiver);
  }}));return Reflect.apply(nativeBegin,client,args);
 }) as typeof client.begin);
 const start=performance.now();active=true;
 try{for(let i=0;i<40;i++){const row=await read();expect(row).toEqual({tenant:b.tenantId,user:b.adminUserId,roles:(ctx.roles??[]).join(','),audit:'on'});}}finally{active=false;}
 const elapsedMs=performance.now()-start;
 const event=async(tx:Parameters<Parameters<typeof withTenant>[1]>[0],n:number)=>appendEvent(tx,{tenantId:b.tenantId,aggregateType:'test',aggregateId:randomUUID(),eventType:'test.audit.bootstrap',actor:actorOf(ctx),payload:{n}});
 await withTenant(ctx,async tx=>{for(let n=0;n<3;n++)await event(tx,n);});
 expect(await verifyTenantChain(ctx)).toMatchObject({valid:true,checked:3});
 // A settings/env flip cannot disarm the existing one-way sticky fact.
 vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED','false');expect((await read()).audit).toBe('on');
 await expect(withTenant(ctx,async tx=>{await event(tx,3);throw new Error('rollback-control');})).rejects.toThrow('rollback-control');
 expect(await verifyTenantChain(ctx)).toMatchObject({valid:true,checked:3});
 const other=await seedBase(),otherCtx=adminCtx(other);
 const [otherRow]=await withTenant(otherCtx,tx=>tx.execute<{audit:string}>(sql`select coalesce(current_setting('app.audit_hash_chain',true),'') as audit`));
 expect(otherRow.audit).not.toBe('on');
 const evidence={kind:'NATIVE_SHARED_AUDIT_BOOTSTRAP',releaseEligible:false,warmReads:40,bootstrapStatements,callbackStatements,elapsedMs,actualEventsChained:3,rollbackLeavesChainUnchanged:true,disarmRefused:true,otherTenantRemainsUnarmed:true,scope:'Callback SQL round trips only; BEGIN/COMMIT excluded; no HTTP/browser/500-user claim.'};
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'audit-bootstrap-roundtrips.json'),JSON.stringify(evidence,null,2));
 expect(callbackStatements).toBe(40);expect(bootstrapStatements,'A transaction with the existing sticky audit-on fact must use one bootstrap statement').toBe(40);
},300000);
