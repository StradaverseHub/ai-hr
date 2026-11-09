import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as schema from '../db/schema';
import {withModulePresentationRead} from '../core/module-presentation-read';
import {pgSqlState} from '../lib/db-error';
import {observeNativeRead} from './helpers/native-read-observer';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
async function fixture(){const b=await seedBase();await setModule(b.tenantId,'attendance','active');return {b,ctx:adminCtx(b)};}

it('owns one native RR/RO frame and fresh module snapshot without audit effects',async()=>{
 const {b,ctx}=await fixture();const [before]=await owner.client`select count(*)::int as n from domain_event where tenant_id=${b.tenantId}::uuid`;
 const probe=observeNativeRead();let rows:{id:string}[];
 try{rows=await withModulePresentationRead({...ctx,entitlementsError:'Earlier resolver attempt failed'},'attendance',async(tx,current)=>{
  expect(current.entitlements?.tenantId).toBe(b.tenantId);expect(current.entitlementsError).toBeUndefined();
  return tx.select({id:schema.company.id}).from(schema.company).where(eq(schema.company.id,b.companyId));
 });}finally{probe.restore();}
 expect(rows!).toEqual([{id:b.companyId}]);expect(probe.properties).toHaveLength(1);
 expect(probe.properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});expect(probe.state).toEqual({active:0,maxActive:1});
 const [after]=await owner.client`select count(*)::int as n from domain_event where tenant_id=${b.tenantId}::uuid`;expect(after).toEqual(before);
 let writeFailure:unknown;try{await withModulePresentationRead(ctx,'attendance',tx=>tx.update(schema.company).set({legalName:'Must not persist'}).where(eq(schema.company.id,b.companyId)));}catch(error){writeFailure=error;}
 expect(pgSqlState(writeFailure)).toBe('25006');
 expect((await owner.db.select({name:schema.company.legalName}).from(schema.company).where(eq(schema.company.id,b.companyId)))[0].name).toBe('Acme Sdn Bhd');
});

it('refuses synthetic markers and mismatched/revoked identities before the display callback',async()=>{
 const {b,ctx}=await fixture(),read=vi.fn(async()=>true);
 for(const refused of [
  {...ctx,userId:undefined}, {...ctx,personId:randomUUID()},
  {...ctx,entitlementsExempt:'seeding' as const}, {...ctx,statutoryOverride:'Synthetic fixture'},
 ])await expect(withModulePresentationRead(refused,'attendance',read)).rejects.toThrow('calling authority');
 expect(read).not.toHaveBeenCalled();
 await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,b.adminUserId));
 await expect(withModulePresentationRead(ctx,'attendance',read)).rejects.toThrow('calling authority');expect(read).not.toHaveBeenCalled();
});

it('uses actual current module rows despite stale caller snapshots and refuses a suspended tenant',async()=>{
 const {b,ctx}=await fixture();await setModule(b.tenantId,'attendance',null);
 await expect(withModulePresentationRead(ctx,'attendance',async()=>true)).rejects.toThrow();
 const staleDisabled=adminCtx(b);await setModule(b.tenantId,'attendance','active');
 expect(await withModulePresentationRead(staleDisabled,'attendance',async()=>true)).toBe(true);
 await owner.db.update(schema.tenant).set({status:'suspended'}).where(eq(schema.tenant.id,b.tenantId));
 await expect(withModulePresentationRead(ctx,'attendance',async()=>true)).rejects.toThrow();
});

it('captures claims and completes while a real Access writer remains open',async()=>{
 const {b,ctx}=await fixture();ctx.grants=[{role:'hr_admin',companyId:null}];
 const actual=database.withTenant;
 const bounds=vi.spyOn(database,'withTenant').mockImplementation(<T>(s:SessionContext,read:(tx:Tx)=>Promise<T>,opts?:Parameters<typeof database.withTenant>[2])=>actual(s,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);return read(tx);
 },opts));
 try{await owner.client.begin(async writer=>{
  await writer`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  const pending=withModulePresentationRead(ctx,'attendance',tx=>tx.select({id:schema.company.id}).from(schema.company).where(eq(schema.company.id,b.companyId)));
  ctx.roles![0]='employee';ctx.grants![0].role='employee';expect(await pending).toEqual([{id:b.companyId}]);
 });}finally{bounds.mockRestore();}
});
