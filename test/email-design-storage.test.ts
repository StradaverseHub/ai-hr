/** Native database authority and immutable history. Run only after the allocated migration is journaled. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,entitledCtx,adminCtx,createAppUser,harnessSnapshot,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as schema from '../db/schema';
import {listEmailDesigns,saveEmailDesign,emailDesignHistory,uploadEmailAsset} from '../core/email-design/service';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {dispatchNotifications} from '../core/notifications';
import {defaultEmailDocument} from '../lib/email-design/model';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();admin=await entitledCtx(b);});afterAll(closeAll);
describe('email design native ownership',()=>{
 it('records immutable versions and restores by appending, never rewriting an earlier version',async()=>{
  const first={...defaultEmailDocument('invitation'),subject:'Fictional subject one'},second={...first,subject:'Fictional subject two'};
  expect(await saveEmailDesign(admin,'invitation','en',first,0)).toBe(1);
  expect(await saveEmailDesign(admin,'invitation','en',second,1)).toBe(2);
  const history=await emailDesignHistory(admin,'invitation','en');expect(history.map(row=>row.revision)).toEqual([2,1]);expect(history[1].document).toEqual(first);
  expect(await saveEmailDesign(admin,'invitation','en',history[1].document,2)).toBe(3);
  expect((await listEmailDesigns(admin))[0]).toMatchObject({revision:3,document:first,updatedBy:admin.userId});
  await expect(owner.db.execute(sql`update email_design_version set document=null where tenant_id=${b.tenantId}::uuid`)).rejects.toThrow();
  await expect(saveEmailDesign(admin,'invitation','en',second,1)).rejects.toThrow();
  expect((await emailDesignHistory(admin,'invitation','en')).map(row=>row.revision)).toEqual([3,2,1]);
 });
 it('keeps tenants separate, refuses ordinary users and denies direct execution of the private delivery reader',async()=>{
  await saveEmailDesign(admin,'invitation','en',defaultEmailDocument('invitation'),0);
  const foreign=await seedBase(),foreignAdmin=await entitledCtx(foreign);expect(await listEmailDesigns(foreignAdmin)).toEqual([]);
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'fictional_email_'+randomUUID()}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'employee',companyId:b.companyId});
  const employee={...admin,userId:user.id,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  await expect(listEmailDesigns(employee)).rejects.toThrow();await expect(saveEmailDesign(employee,'invitation','en',null,1)).rejects.toThrow();
  await expect(withTenant(employee,tx=>tx.execute(sql`select app.email_design_delivery(${foreign.tenantId}::uuid,'invitation','en')`))).rejects.toThrow();
  expect(await withTenant(foreignAdmin,tx=>tx.execute(sql`select * from email_design where tenant_id=${b.tenantId}::uuid`))).toEqual([]);
 });
 it('refuses a revoked grant even if the caller still carries an administrator snapshot',async()=>{
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'fictional_email_admin_'+randomUUID()}).returning({id:schema.appUser.id});
  const [grant]=await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:null}).returning({id:schema.roleAssignment.id});
  const actor={...admin,userId:user.id};await saveEmailDesign(actor,'invitation','en',defaultEmailDocument('invitation'),0);
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.id,grant.id));
  await expect(saveEmailDesign(actor,'invitation','en',null,1)).rejects.toThrow();await expect(listEmailDesigns(actor)).rejects.toThrow();
 });
 it('refuses fabricated design audit events from an ordinary application actor',async()=>{
  await saveEmailDesign(admin,'invitation','en',defaultEmailDocument('invitation'),0);
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'fictional_email_audit_'+randomUUID()}).returning({id:schema.appUser.id});
  const employee={...admin,userId:user.id,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  await expect(withTenant(employee,tx=>tx.insert(schema.domainEvent).values({tenantId:b.tenantId,aggregateType:'email-design',aggregateId:user.id,eventType:'email-design.saved',actorType:'user',actorId:user.id,payload:{revision:999}}))).rejects.toThrow();
 });
 it('a real ordinary workflow lease cannot read an assessment design through the compatibility adapter',async()=>{
  await setModule(b.tenantId,'notifications','active');
  await saveEmailDesign(admin,'assessment_reminder','en',{...defaultEmailDocument('assessment_reminder'),subject:'Fictional private assessment design'},0);
  const e=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional email recipient',primaryEmail:'recipient@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const userId=await createAppUser(b.tenantId,e.personId,'employee'),issuer='https://hr.test/identity/realms/ai-hr',subject=randomUUID();
  await owner.db.insert(schema.appExternalIdentity).values({issuer,subject,appUserId:userId});
  await saveNotificationEmailPolicy(adminCtx(b),['leave']);
  await saveNotificationEmailPreferences({tenantId:b.tenantId,userId,personId:e.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)},e.employmentId,['leave'],'en',{issuer,subject,email:'recipient@example.test',emailVerified:true});
  await owner.db.insert(schema.domainEvent).values({tenantId:b.tenantId,aggregateType:'test',aggregateId:randomUUID(),eventType:'leave-request.approved',actorType:'system',subjectEmploymentId:e.employmentId,payload:{}});
  await dispatchNotifications(adminCtx(b));const jobs=await owner.db.select().from(schema.notificationDelivery);expect(jobs).toHaveLength(1);
  const token=randomUUID();await owner.db.update(schema.notificationDelivery).set({leaseToken:token,leaseUntil:new Date(Date.now()+30000)}).where(eq(schema.notificationDelivery.id,jobs[0].id));
  const [right]=await owner.client`select identity_email.delivery_design(${jobs[0].id}::uuid,${token}::uuid,${issuer},'workflow.leave','en',false) as design`;expect(right.design).toMatchObject({kind:'workflow.leave',locale:'en'});
  const [wrong]=await owner.client`select identity_email.delivery_design(${jobs[0].id}::uuid,${token}::uuid,${issuer},'assessment_reminder','en',false) as design`;expect(wrong.design).toBeNull();
 });
 it('restoring default does not copy another language’s customized wording',async()=>{
  await saveEmailDesign(admin,'invitation','en',{...defaultEmailDocument('invitation'),subject:'Fictional English design'},0);
  await saveEmailDesign(admin,'invitation','ms',defaultEmailDocument('invitation'),0);
  await saveEmailDesign(admin,'invitation','ms',null,1);
  const rows=await listEmailDesigns(admin);expect(rows.find(row=>row.locale==='en')?.document?.subject).toBe('Fictional English design');expect(rows.find(row=>row.locale==='ms')?.document).toBeNull();
 });
 it('stores validated image bytes behind an opaque token while table access stays tenant-scoped',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=','base64'),token=await uploadEmailAsset(admin,'image/png',png);
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  const rows=await withTenant(admin,tx=>tx.execute<{mime:string;bytes:Buffer}>(sql`select * from app.email_asset_read(${token})`));expect(rows).toHaveLength(1);expect(rows[0].mime).toBe('image/png');expect(Buffer.from(rows[0].bytes)).toEqual(png);
 });
});
