import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {hireEmployee,setReportingLine} from '../core/org';
import * as perf from '../packs/performance/service';
import {defaultPolicy} from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import {todayInKualaLumpur} from '../lib/hr-date';
import {saveEmailDesign} from '../core/email-design/service';
import {defaultEmailDocument,emailDesignEnvelope,emailLocale} from '../lib/email-design/model';
import {assessmentReminderMessage} from '../lib/assessment-reminder-message';
import {workflowEmailMessage} from '../deploy/identity-email/notification-message';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {dispatchNotificationsFromSweep} from '../core/notifications';

let b:Base,admin:SessionContext,recipient:SessionContext,employmentId:string,employeeCode:string,cycleId:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'performance','active');await setModule(b.tenantId,'notifications','active');admin=await entitledCtx(b);
 const year=Number(todayInKualaLumpur().slice(0,4));
 const hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
 const subject=await hire('Fictional preview recipient'),manager=await hire('Fictional preview manager');employmentId=subject.employmentId;
 await owner.db.update(schema.person).set({firstName:'Canonical <First>'}).where(eq(schema.person.id,subject.personId));
 const userId=await createAppUser(b.tenantId,subject.personId,'employee');recipient={...admin,userId,personId:subject.personId,roles:['employee'],grants:undefined};
 await createAppUser(b.tenantId,manager.personId,'manager');await setReportingLine(admin,{subordinateEmploymentId:employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});
 const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Fictional grade'}).returning();await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.id,employmentId));
 ({cycleId}=await perf.createCycle(admin,{name:'Fictional preview cycle',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`}));
 const policy=defaultPolicy(framework);policy.profiles=[{id:randomUUID(),companyId:b.companyId,grade:'12',name:'Fictional profile',competencies:[{id:'preview-skill',principle:'Technical',text:'Fictional competency',future:false}]}];
 await perf.configureOnehrCycle(admin,cycleId,null,policy);await perf.openCycle(admin,{cycleId});
 const [employee]=await owner.db.select({code:schema.employment.employeeCode}).from(schema.employment).where(eq(schema.employment.id,employmentId));employeeCode=employee.code!;
});
async function localeReader(ctx:SessionContext,selected=employmentId,languageEmployment=selected,cycle=cycleId){return withTenant(ctx,async tx=>{
 const [row]=await tx.execute<{locale:string}>(sql`select app.email_design_assessment_preview_locale(${cycle}::uuid,${selected}::uuid,${languageEmployment}::uuid) as locale`);
 const [actor]=await tx.execute<{tenant:string;user:string}>(sql`select app.current_tenant_id()::text as tenant,app.current_user_id()::text as "user"`);expect(actor).toEqual({tenant:ctx.tenantId,user:ctx.userId});return row.locale;
});}
async function readWitness(){return (await owner.client`select (select count(*)::int from domain_event) as events,(select count(*)::int from performance_assessment_reminder_run) as runs,(select count(*)::int from notification_delivery) as deliveries,(select count(*)::int from email_design_version) as versions,(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from notification_pref p) as preferences`)[0];}
describe('read-only assessment email preview authority',()=>{
 it('reads disabled recipient preference or English default without consent, queue, event or context changes',async()=>{
  expect(await localeReader(admin)).toBe('en');await saveNotificationEmailPreferences(recipient,employmentId,[],'ms');
  const before=await readWitness();expect(await localeReader(admin)).toBe('ms');const preview=await perf.previewAssessmentReminder(admin,cycleId,employeeCode);
  expect(preview).toMatchObject({mode:'full',locale:'ms',eligible:false,design:{kind:'assessment_reminder',locale:'ms',document:null,data:{first_name:'Canonical <First>'}}});expect(preview.mail.tasks.length).toBeGreaterThan(0);expect(await readWitness()).toEqual(before);
 });
 it('refuses ordinary, company-only, revoked and foreign contexts and a locale employment belonging to another actor',async()=>{
  await expect(localeReader(recipient)).rejects.toThrow();await expect(localeReader({...admin,userId:undefined})).rejects.toThrow();
  const companyAdmin={...admin,grants:[{role:'hr_admin',companyId:b.companyId}]};await expect(localeReader(companyAdmin)).rejects.toThrow();
  const [other]=await owner.db.select({id:schema.employment.id}).from(schema.employment).where(and(eq(schema.employment.tenantId,b.tenantId),sql`${schema.employment.id}<>${employmentId}::uuid`));await expect(localeReader(admin,employmentId,other.id)).rejects.toThrow();
  const foreign=await seedBase(),foreignAdmin=await entitledCtx(foreign);await expect(localeReader(foreignAdmin)).rejects.toThrow();await expect(localeReader(admin,randomUUID())).rejects.toThrow();await expect(localeReader(admin,employmentId,employmentId,randomUUID())).rejects.toThrow();
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,admin.userId!));await expect(localeReader(admin)).rejects.toThrow();
 });
 it('keeps a company administrator task summary available without reading templates or recipient language',async()=>{
  await saveNotificationEmailPreferences(recipient,employmentId,[],'ms');const before=await readWitness();
  const limited=await perf.previewAssessmentReminder({...admin,grants:[{role:'hr_admin',companyId:b.companyId}]},cycleId,employeeCode);
  expect(limited).toMatchObject({mode:'summary',locale:null,design:null,eligible:false,mail:{words:null}});expect(limited.mail.tasks.length).toBeGreaterThan(0);expect(await readWitness()).toEqual(before);
 });
 it('keeps a label-only Performance partner scoped without exposing a raw first name or custom template',async()=>{
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'preview-partner-'+randomUUID()}).returning();await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'performance_partner',companyId:b.companyId});
  const partner={...admin,userId:user.id,personId:undefined,roles:['performance_partner'],grants:[{role:'performance_partner',companyId:b.companyId}]};
  expect(await withTenant(partner,tx=>tx.select({firstName:schema.person.firstName}).from(schema.person).where(eq(schema.person.id,recipient.personId!)))).toEqual([]);
  const before=await readWitness(),limited=await perf.previewAssessmentReminder(partner,cycleId,employeeCode);
  expect(limited).toMatchObject({mode:'summary',locale:null,design:null,employee:'Fictional preview recipient',mail:{words:null}});expect(JSON.stringify(limited)).not.toContain('Canonical <First>');expect(await readWitness()).toEqual(before);await expect(localeReader(partner)).rejects.toThrow();
 });
 it.each(emailLocale.options)('uses exact recipient %s layout and details identically to the real leased delivery reader',async locale=>{
  const issuer='https://hr.example.test/identity/realms/fixture',subject=randomUUID();await owner.db.insert(schema.appExternalIdentity).values({issuer,subject,appUserId:recipient.userId!});
  const [person]=await owner.db.select().from(schema.person).where(eq(schema.person.id,recipient.personId!));await saveNotificationEmailPolicy(admin,['performance']);await saveNotificationEmailPreferences(recipient,employmentId,['performance'],locale,{issuer,subject,email:person.primaryEmail,emailVerified:true});
  const base=defaultEmailDocument('assessment_reminder');await saveEmailDesign(admin,'assessment_reminder',locale,{...base,subject:`${locale} {first_name}: {cycle}`,background:'#123456',blocks:[base.blocks[0],{id:'00000000-0000-4000-8000-000000000003',type:'text',heading:`${locale} custom`,runs:[{text:'{first_name} · {company_name} · {count} · {things}'}],style:{}},base.blocks[1]]},0);
  const before=await readWitness(),preview=await perf.previewAssessmentReminder(admin,cycleId,employeeCode);expect(preview.mode).toBe('full');expect(preview.locale).toBe(locale);expect(preview.eligible).toBe(true);expect(await readWitness()).toEqual(before);
  const queued=await perf.queueAssessmentReminders(admin,cycleId,'manual');expect(queued.queued).toBeGreaterThan(0);const system={...admin,userId:undefined,personId:undefined};await dispatchNotificationsFromSweep(system,owner);
  const [pending]=await owner.db.select().from(schema.assessmentReminderRecipient).where(and(eq(schema.assessmentReminderRecipient.runId,queued.runId!),eq(schema.assessmentReminderRecipient.userId,recipient.userId!)));await withTenant(system,tx=>perf.assessmentReminderRecipientsTx(tx,pending.id));
  const [delivery]=await owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.sourceEventId,pending.sourceEventId!)),token=randomUUID();expect(delivery).toBeTruthy();await owner.db.update(schema.notificationDelivery).set({leaseToken:token,leaseUntil:new Date(Date.now()+60000)}).where(eq(schema.notificationDelivery.id,delivery.id));
  const [actual]=await owner.client`select identity_email.delivery_design(${delivery.id}::uuid,${token}::uuid,${issuer},'assessment_reminder',${locale}) as design,identity_email.assessment_tasks(${delivery.id}::uuid,${token}::uuid,${issuer}) as summary`;
  const [notice]=await owner.db.select().from(schema.notification).where(eq(schema.notification.id,delivery.notificationId!));const link=new URL(notice.linkPath!,'https://hr.example.test').href;
  const rendered=assessmentReminderMessage(preview.mail,locale,link,preview.design),sent=workflowEmailMessage({category:'performance',locale,link,action:true,messageId:'fixture-only-no-smtp',assessmentTasks:actual.summary.tasks,assessmentWords:actual.summary.words,design:emailDesignEnvelope.parse(actual.design)});
  expect(preview.design).toEqual(actual.design);expect(rendered).toEqual(sent);expect(rendered.subject).toBe(`${locale} Canonical <First>: Fictional preview cycle`);expect(rendered.html).toContain('Canonical &lt;First&gt;');expect(rendered.html).toContain(`${locale} custom`);expect(rendered.text).toContain(link);
 });
});
