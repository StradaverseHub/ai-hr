/** Compare indexed reads with the unchanged native RLS, including ended own employments. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {desc,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import * as s from '../db/schema';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {listNotifications,listNotificationsPage,unreadNotificationCount} from '../core/notifications';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('matches native recipient RLS and ordering without scanning unrelated notifications',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const hire=async(base:Base)=>hireEmployee(adminCtx(base),{person:{fullName:'Fictional notification recipient',primaryEmail:randomUUID()+'@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const own=await hire(b),peer=await hire(b),outside=await hire(foreign);
 const userId=await createAppUser(b.tenantId,own.personId,'employee');
 const ctx={...await entitledCtx(b,['employee']),userId,personId:own.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const endedId=randomUUID();await owner.db.insert(s.employment).values({id:endedId,tenantId:b.tenantId,personId:own.personId,companyId:b.companyId,employeeCode:'ENDED-NOTIFICATION',hiredOn:'2010-01-01',terminatedOn:'2015-01-01'});
 const expected=[randomUUID(),randomUUID(),randomUUID()];
 const make=(id:string,tenantId:string,recipientEmploymentId:string,severity:'info'|'action'='info')=>({id,tenantId,recipientEmploymentId,kind:'test.recipient-scope',title:'Fictional read scope',body:'Fictional notification',severity});
 await owner.db.insert(s.notification).values([
  make(expected[0],b.tenantId,own.employmentId),make(expected[1],b.tenantId,own.employmentId,'action'),make(expected[2],b.tenantId,endedId),
  ...Array.from({length:2500},()=>make(randomUUID(),b.tenantId,peer.employmentId)),
  make(randomUUID(),foreign.tenantId,outside.employmentId),
 ]);
 const started=performance.now();
 // This intentionally has no candidate predicate: the installed notification RLS is the independent oracle.
 const original=await withTenant(ctx,tx=>tx.select({id:s.notification.id}).from(s.notification).orderBy(desc(s.notification.createdAt),desc(s.notification.id)));
 const originalMs=performance.now()-started;
 expect(original.map(row=>row.id).sort()).toEqual([...expected].sort());
 const optimizedStarted=performance.now(),current=await listNotifications(ctx,undefined,{limit:100});
 const optimizedMs=performance.now()-optimizedStarted;
 expect(current.map(row=>row.id)).toEqual(original.map(row=>row.id));
 expect(await unreadNotificationCount(ctx)).toBe(3);
 expect(await unreadNotificationCount(ctx,undefined,{action:false})).toBe(2);
 expect(await unreadNotificationCount(ctx,undefined,{action:true})).toBe(1);
 expect((await listNotifications(ctx,endedId)).map(row=>row.id)).toEqual([expected[2]]);
 expect(await listNotifications(ctx,peer.employmentId)).toEqual([]);
 const first=await listNotificationsPage(ctx,{limit:2});expect(first).toHaveLength(2);
 const tail=first.at(-1)!;
 const rest=await listNotificationsPage(ctx,{limit:2,after:{at:tail.cursorAt,id:tail.id}});
 expect([...first,...rest].map(row=>row.id)).toEqual(original.map(row=>row.id));
 // Ownership is the live database account/person relationship, not the context's posted person field.
 expect((await listNotifications({...ctx,personId:peer.personId})).map(row=>row.id)).toEqual(original.map(row=>row.id));
 const [identity]=await withTenant(ctx,tx=>tx.execute<{role:string}>(sql`select current_user as role`));expect(identity.role).toBe('ai_hr_app');
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'notification-recipient-read.json'),JSON.stringify({kind:'NATIVE_RECIPIENT_QUERY_COMPONENT_ONLY',unrelatedNotifications:2501,ownNotifications:3,originalMs,optimizedMs,exactNativeRlsEquality:true,endedOwnEmployment:true,keysetOrder:true,foreignExcluded:true},null,2));
},180000);
