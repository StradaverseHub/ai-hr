/** AP011: native per-company oracle, storage availability, and role/scope equivalence at group scale. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {countOfflineClaimsAwaitingReview,countOpenOfflineContexts,readOfflineClockingSettings,readOfflineClockingSettingsAcross,setOfflineClockingPolicy} from '../packs/attendance/service';
import {offlineClockingPolicyFromStored,OfflineAdjudicationError} from '../packs/attendance/mobile-offline-adjudicator';
import {createOfflineClaimService} from '../core/mobile-offline-claim';
import {offlineServiceFixture} from './helpers/mobile-offline-service-fixture';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
async function legacy(ctx:SessionContext,companyIds:readonly string[]){
 return new Map(await Promise.all(companyIds.map(async id=>[id,{...await readOfflineClockingSettings(ctx,id),waiting:await countOfflineClaimsAwaitingReview(ctx,[id]),phonesOffline:await countOpenOfflineContexts(ctx,id)}] as const)));
}
it('retains independent native permissions, counts and unavailable states with one group read-only transaction',async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-performance-fixture-secret');
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const rest=await owner.db.insert(s.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Fictional offline group '+i}))).returning({id:s.company.id});
 const companies=[b.companyId,...rest.map(row=>row.id)];
 const people=await owner.db.insert(s.person).values(Array.from({length:1000},(_,i)=>({tenantId:b.tenantId,fullName:'Fictional offline person '+i,primaryEmail:randomUUID()+'@fixture.invalid'}))).returning({id:s.person.id});
 await owner.db.insert(s.employment).values(people.map((p,i)=>({tenantId:b.tenantId,personId:p.id,companyId:companies[i%70],employeeCode:'OF-'+i,hiredOn:'2020-01-01'})));
 for(const [i,companyId] of companies.entries())if(i%3===0)await setOfflineClockingPolicy(ctx,{companyId,enabled:i%2===0,maxProvenWindowSeconds:i%2===0?1800:60});
 const fixture=await offlineServiceFixture(b);
 // A real signed claim through the canonical claim owner; synthetic adjudication holds it for review.
 const consumer=createOfflineClaimService({apiOrigin:'https://hr.example.com',photoRetentionMs:3600000},{prepare:async()=>({assertFresh:async()=>{}}),adjudicate:async()=>({outcome:'needs_review',reason:'mock_reported'}),beforeCommit:async()=>{}});
 const claim={...fixture.claim,time:{...fixture.claim.time,elapsed:{status:'unknown' as const,reason:'continuity_unknown' as const}}};
 expect(await consumer.consume(fixture.ctx,fixture.signed(claim))).toMatchObject({outcome:'needs_review'});
 const expected=await legacy(ctx,companies);expect(expected.get(b.companyId)).toMatchObject({waiting:1,phonesOffline:1});
 const native=database.withTenant,carriers:{readOnly:string;mode:string}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(who:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(who,async tx=>{
  const result=await read(tx);const [mode]=await tx.execute<{readOnly:string;mode:string}>(sql`select current_setting('transaction_read_only') as "readOnly",app.access_lock_mode_held(${who.tenantId}::uuid) as mode`);carriers.push(mode);return result;
 },options));
 try{expect(await readOfflineClockingSettingsAcross(ctx,companies)).toEqual(expected);expect(spy).toHaveBeenCalledTimes(1);expect(carriers).toEqual([{readOnly:'on',mode:'S'}]);}finally{spy.mockRestore();}
 for(const role of s.roleEnum.enumValues)for(const companyId of role==='super_admin'?[null]:[null,b.companyId]){
  const userId=await createAppUser(b.tenantId,people[0].id,'employee');await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const who={...ctx,userId,personId:people[0].id,roles:[role],grants:[{role,companyId}]};
  for(const ids of [companies,[b.companyId],[companies[1]]])expect(await readOfflineClockingSettingsAcross(who,ids)).toEqual(await legacy(who,ids));
 }
 expect(await readOfflineClockingSettingsAcross(ctx,[])).toEqual(new Map());
 expect(await readOfflineClockingSettingsAcross(ctx,[b.companyId.toUpperCase(),b.companyId])).toEqual(await legacy(ctx,[b.companyId.toUpperCase(),b.companyId]));
 const foreign=await seedBase();expect(await readOfflineClockingSettingsAcross(adminCtx(foreign),companies)).toEqual(await legacy(adminCtx(foreign),companies));
 await expect(readOfflineClockingSettingsAcross(ctx,['invalid'])).rejects.toMatchObject({reason:'invalid_input'});
 // Isolated hosted fixture temporarily hides optional names, restoring the same objects in finally.
 await owner.db.execute(sql`alter table attendance_policy rename column offline_clocking_enabled to fixture_offline_enabled`);
 await owner.db.execute(sql`alter table attendance_policy rename column offline_max_proven_window_seconds to fixture_offline_seconds`);
 await owner.db.execute(sql`alter table mobile_offline_claim_resolution rename to fixture_offline_resolution`);
 await owner.db.execute(sql`alter function app.mobile_offline_open_context_count(uuid) rename to fixture_offline_open_count`);
 try{
  const absent=await legacy(ctx,companies);expect(absent.get(b.companyId)).toMatchObject({columns:false,policy:{enabled:false,maxProvenWindowSeconds:900},waiting:null,phonesOffline:null});
  expect(await readOfflineClockingSettingsAcross(ctx,companies)).toEqual(absent);
 }finally{
  await owner.db.execute(sql`alter function app.fixture_offline_open_count(uuid) rename to mobile_offline_open_context_count`);
  await owner.db.execute(sql`alter table fixture_offline_resolution rename to mobile_offline_claim_resolution`);
  await owner.db.execute(sql`alter table attendance_policy rename column fixture_offline_seconds to offline_max_proven_window_seconds`);
  await owner.db.execute(sql`alter table attendance_policy rename column fixture_offline_enabled to offline_clocking_enabled`);
 }
 // Every-role70-company legacy oracle includes210transactions; fixture and native claim need headroom.
},300000);

it('preserves policy defaults and rejects malformed stored settings through the shared decoder',()=>{
 expect(offlineClockingPolicyFromStored(undefined)).toEqual({enabled:false,maxProvenWindowSeconds:900});
 expect(offlineClockingPolicyFromStored({enabled:null,seconds:null})).toEqual({enabled:false,maxProvenWindowSeconds:900});
 for(const seconds of ['60','86400'])expect(offlineClockingPolicyFromStored({enabled:'true',seconds})).toEqual({enabled:true,maxProvenWindowSeconds:Number(seconds)});
 for(const row of [{enabled:'TRUE',seconds:'900'},{enabled:'1',seconds:'900'},...['59','86401','90.5','NaN'].map(seconds=>({enabled:'false',seconds}))])expect(()=>offlineClockingPolicyFromStored(row)).toThrow(OfflineAdjudicationError);
});
