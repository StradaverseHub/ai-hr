/** Real DEFINER/worker boundaries, evaluated after coordinated0936+0937+0938 integration. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {publishWorkforceCapabilities,WORKFORCE_CAPABILITY_BINDINGS} from '../deploy/access/publish-workforce-capabilities';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {saveLetterField,saveLetterTemplate,decideLetterTemplate,saveLetterPolicy,createLetterDraftBatch} from '../core/letters';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {LetterPolicy} from '../lib/letter-workflow';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,shown:{employmentId:string;personId:string},hidden:typeof shown;
let publication:{id:string;supported:boolean;bindings:unknown}[]=[];
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(async()=>{vi.unstubAllEnvs();for(const row of publication)await owner.client`update access_capability set supported=${row.supported},bindings=${JSON.stringify(row.bindings)}::text::jsonb where id=${row.id}`;publication=[];});
beforeEach(async()=>{vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI','https://scope.fixture.test/callback');await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');ctx=await entitledCtx(b);publication=Array.from(await owner.client<{id:string;supported:boolean;bindings:unknown}[]>`select id,supported,bindings from access_capability where id=any(${WORKFORCE_CAPABILITY_BINDINGS.map(row=>row.id)}::text[])`);await withTenant(ctx,tx=>accessConfigurationStore.loadCurrent(tx,ctx));await publishWorkforceCapabilities(owner.client);const hire=(code:string)=>hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01',employeeCode:code,person:{fullName:'Fictional '+code,primaryEmail:randomUUID()+'@fixture.test'}});shown=await hire('SCOPE-SHOWN');hidden=await hire('SCOPE-HIDDEN');});
async function restrict(userId=ctx.userId!){
 const id=randomUUID(),revision=randomUUID(),rules={legacyCompany:false,predicates:[{field:'employeeId',values:['SCOPE-SHOWN']}]};
 await owner.client`insert into data_permission_profile(id,tenant_id,name) values(${id},${b.tenantId},${'Scope '+id})`;
 await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by) values(${revision},${b.tenantId},${id},${JSON.stringify(rules)}::text::jsonb,${ctx.userId!})`;
 await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${id}`;
 await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by) values(${b.tenantId},${userId},${id},${ctx.userId!})`;
 return id;
}
async function snapshotSlips(){
 const [period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:'2025-01',status:'closed'}).returning();
 const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:'2025-01',batchDate:'2025-01-25',status:'closed',releasedAt:new Date('2025-01-25T00:00:00Z')}).returning();
 const slips=[];for(const employee of [shown,hidden]){const [slip]=await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:employee.employmentId,basicSalary:'3000.00',grossPay:'3000.00',statutory:{},totalDeductions:'0.00',netPay:'3000.00',employerCost:'3000.00'}).returning();await owner.db.insert(s.informationPayslipSnapshot).values({payslipId:slip.id,tenantId:b.tenantId,employmentId:employee.employmentId,companyId:b.companyId,employmentType:'full_time',hiredOn:'2025-01-01',documentMetadata:{employeeName:employee===shown?'Fictional visible':'PRIVATE hidden',employeeCode:employee===shown?'SCOPE-SHOWN':'SCOPE-HIDDEN'},recordedBy:ctx.userId!});slips.push(slip);}
 return{batch,slips};
}
it('narrows role-bypassing card checks and staff name directories without changing legacy unassigned access',async()=>{
 const before=await withTenant(ctx,tx=>tx.execute<{ok:boolean}>(sql`select app.card_identifier_free(${hidden.employmentId}::uuid,'fictional-unused-card') as ok`));expect(before[0].ok).toBe(true);
 await createAppUser(b.tenantId,shown.personId,'employee');await createAppUser(b.tenantId,hidden.personId,'employee');await restrict();
 const result=await withTenant(ctx,async tx=>({cards:await tx.execute<{shown:boolean;hidden:boolean}>(sql`select app.card_identifier_free(${shown.employmentId}::uuid,'fictional-unused-card') as shown,app.card_identifier_free(${hidden.employmentId}::uuid,'fictional-unused-card') as hidden`),names:await tx.execute<{name:string}>(sql`select name from app.onboarding_directory()`)}));
 expect(result.cards[0]).toEqual({shown:true,hidden:false});expect(result.names.map(row=>row.name)).toContain('Fictional SCOPE-SHOWN');expect(result.names.map(row=>row.name)).not.toContain('Fictional SCOPE-HIDDEN');
});
it('filters direct payroll documents and frozen report records, rejects hidden close sources, and preserves released self access',async()=>{
 const {batch,slips}=await snapshotSlips();await restrict();
 const rows=await withTenant(ctx,async tx=>({docs:await tx.execute<{shown:unknown;hidden:unknown}>(sql`select app.information_payslip_document(${slips[0].id}::uuid) as shown,app.information_payslip_document(${slips[1].id}::uuid) as hidden`),people:await tx.execute<{row:Record<string,unknown>}>(sql`select r as row from app.information_report_records('person',${b.companyId}::uuid,'2025') r`)}));expect(rows.docs[0].shown).not.toBeNull();expect(rows.docs[0].hidden).toBeNull();expect(rows.people.map(row=>row.row.full_name)).toEqual(['Fictional visible']);
 await expect(withTenant(ctx,tx=>tx.execute(sql`select app.payroll_close_source_people(${batch.id}::uuid,null,'{}'::uuid[])`))).rejects.toThrow();
 const userId=await createAppUser(b.tenantId,hidden.personId,'employee');await restrict(userId);const self={...await entitledCtx(b,['employee']),userId,personId:hidden.personId};const [mine]=await withTenant(self,tx=>tx.execute<{document:unknown}>(sql`select app.information_payslip_document(${slips[1].id}::uuid) as document`));expect(mine.document).not.toBeNull();
});
it('invalidates managed report authorization on policy assignment and profile input changes',async()=>{
 const stamp=async()=>String((await owner.client`select identity_email.report_access_stamp(${b.tenantId}) as value`)[0].value),before=await stamp();const profile=await restrict();const assigned=await stamp();expect(assigned).not.toBe(before);await owner.db.update(s.person).set({nationality:'Singaporean'}).where(eq(s.person.id,shown.personId));const edited=await stamp();expect(edited).not.toBe(assigned);await owner.client`update data_permission_profile set enabled=false where id=${profile}`;expect(await stamp()).not.toBe(edited);
});
it('filters letter administrator and creator scope while preserving an actual configured approval responsibility',async()=>{
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional configured reviewer',primaryEmail:randomUUID()+'@fixture.test'}).returning(),userId=await createAppUser(b.tenantId,person.id,'hr_admin'),reviewer={...ctx,userId,personId:person.id};
 const field=await saveLetterField(ctx,{companyId:b.companyId,definition:{key:'employeeName',label:'Employee name',description:'Fixture',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},active:true});
 const template=await saveLetterTemplate(ctx,{companyId:b.companyId,code:'SCOPE',name:'Fictional scoped letter',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'field',key:'employeeName'}]}]},fieldVersionIds:[field.id]});await decideLetterTemplate(ctx,{versionId:template.versionId,expectedStatus:'draft',action:'submit'});await decideLetterTemplate(reviewer,{versionId:template.versionId,expectedStatus:'submitted',action:'approve'});
 const policy:LetterPolicy={version:1,stages:[{key:'review',label:'Review',userIds:[userId],allowDelegation:false}],signatoryUserId:userId,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'SCOPE/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'none',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:null,portalNotifications:true,emailNotifications:false};await saveLetterPolicy(ctx,{companyId:b.companyId,category:'confirmation',enabled:true,policy});
 const made=await createLetterDraftBatch(ctx,{companyId:b.companyId,templateVersionId:template.versionId,employmentIds:[shown.employmentId,hidden.employmentId],operationKey:randomUUID()}),records=await owner.db.select().from(s.letterRecord).where(eq(s.letterRecord.batchId,made.batchId));expect(records).toHaveLength(2);await restrict();await restrict(userId);
 const scope=(actor:SessionContext,record:typeof records[number])=>withTenant(actor,tx=>tx.execute<{allowed:boolean}>(sql`select app.letter_staff_scope(${b.companyId}::uuid,${record.createdBy}::uuid,${record.batchId}::uuid,${record.id}::uuid) as allowed`));
 expect((await scope(ctx,records.find(row=>row.employmentId===shown.employmentId)!))[0].allowed).toBe(true);expect((await scope(ctx,records.find(row=>row.employmentId===hidden.employmentId)!))[0].allowed).toBe(false);expect((await scope(reviewer,records.find(row=>row.employmentId===hidden.employmentId)!))[0].allowed).toBe(true);
});
