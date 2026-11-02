/** Native application-role transaction accounting and recipient parity for the shared shell. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {hireEmployee} from '../core/org';
import {listNotifications,markNotificationRead,notificationBellState,unreadNotificationCount} from '../core/notifications';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('returns exactly the five existing recipient views while admitting one application transaction',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional bell owner',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,'employee');
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:hired.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 const other=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional other recipient',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const make=(i:number,severity:'info'|'warning'|'action',read=false)=>({id:randomUUID(),tenantId:b.tenantId,recipientEmploymentId:hired.employmentId,kind:'test.bell',title:'Fictional '+i,body:'Fictional body',severity,linkPath:'/me',createdAt:new Date(Date.UTC(2026,0,1,0,0,i)),readAt:read?new Date(Date.UTC(2026,0,2)):null});
 const infos=Array.from({length:17},(_,i)=>make(i,i%2?'info':'warning')),actions=[make(30,'action'),make(31,'action'),make(32,'action')],history=[make(40,'info',true),make(41,'action',true)];
 const secret={...make(50,'info'),recipientEmploymentId:other.employmentId,title:'Other recipient secret'};
 await owner.db.insert(s.notification).values([...infos,...actions,...history,secret]);
 const legacy=async(opts:{letterCompanyIds?:string[]}={})=>{
  const [unread,taskUnread,items,taskItems,read]=await Promise.all([
   unreadNotificationCount(ctx,undefined,{...opts,action:false}),unreadNotificationCount(ctx,undefined,{...opts,action:true}),
   listNotifications(ctx,undefined,{...opts,limit:12,read:false,action:false}),listNotifications(ctx,undefined,{...opts,limit:12,read:false,action:true}),listNotifications(ctx,undefined,{...opts,limit:12,read:true}),
  ]);return {unread,taskUnread,items,taskItems,history:read};
 };
 const expected=await legacy();expect(expected).toMatchObject({unread:17,taskUnread:3});expect(expected.items.map(row=>row.id)).toEqual([...infos].reverse().slice(0,12).map(row=>row.id));expect(expected.taskItems).toHaveLength(3);expect(expected.history).toHaveLength(2);
 await owner.client.unsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
 const begins=async()=>{const [row]=await owner.client`select coalesce(sum(calls),0)::int as n from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database())and userid=(select oid from pg_roles where rolname='ai_hr_app')and lower(query)~'^begin($| )'`;return row.n as number;};
 await owner.client`select pg_stat_statements_reset()`;expect(await legacy()).toEqual(expected);expect(await begins()).toBe(5);
 await owner.client`select pg_stat_statements_reset()`;expect(await notificationBellState(ctx)).toEqual(expected);const actualBegins=await begins();if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/notification-bell-transactions.json',JSON.stringify({legacyBegins:5,actualBegins,recipientParity:true}));expect(actualBegins).toBe(1);
 for(const opts of [{letterCompanyIds:[]},{letterCompanyIds:[b.companyId]},{letterCompanyIds:[foreign.companyId]}])expect(await notificationBellState(ctx,opts)).toEqual(await legacy(opts));
 await markNotificationRead(ctx,infos[16].id);const after=await notificationBellState(ctx);expect(after).toEqual(await legacy());expect(after.unread).toBe(16);expect(after.history).toHaveLength(3);
 expect([...after.items,...after.taskItems,...after.history].some(row=>row.id===secret.id)).toBe(false);
});
