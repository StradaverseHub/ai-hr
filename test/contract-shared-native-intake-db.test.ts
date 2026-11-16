/** Native custody fixtures use actual offboarding, P-file PDFs and independently verified roles. */
import {randomUUID} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {setCompensation} from '../core/comp';
import {addEmployeeDocument} from '../core/employee-documents';
import {v9Setup,v9Workspace,v9SaveConfig,v9CreateOffboarding,v9Command} from '../packs/lifecycle/service';
import {seedPayComponentCatalog,listPayComponents,setEmploymentPayComponent} from '../packs/payroll/service';
import * as C from '../packs/contracts/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
let b:Base,admin:SessionContext;
const year=Number(todayInKualaLumpur().slice(0,4)),start=`${year}-01-01`,end=`${year+1}-12-31`;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();for(const m of ['lifecycle','payroll','typed_pay_components'] as const)await setModule(b.tenantId,m,'active');admin=await entitledCtx(b);const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional verified Contract administrator',${randomUUID()+'@intake.test'}) returning id`);await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);admin={...admin,personId:person.id};});
async function account(name:string){const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,${name},${randomUUID()+'@intake.test'}) returning id`);const userId=await createAppUser(b.tenantId,person.id,'employee');return {...admin,userId,personId:person.id,roles:['employee'],grants:undefined} as SessionContext;}
async function document(employmentId:string,title:string){const pdf=await PDFDocument.create();pdf.addPage().drawText(title);return addEmployeeDocument(admin,{employmentId,title,fileName:'fictional.pdf',mimeType:'application/pdf',content:Buffer.from(await pdf.save())});}
async function fixture(){
 const pbp=await account('Fictional capturing PBP'),gbs=await account('Fictional independent verifier');
 await v9Setup(admin);const cfg=(await v9Workspace(admin)).config!,groupId=randomUUID();await v9SaveConfig(admin,cfg.revision,{...cfg,groups:[...cfg.groups,{id:groupId,name:'Actual native intake owners',members:[gbs.userId!],limit:10}],peopleOpsGroup:groupId,bpRules:[{rules:{company:[b.companyId]},userId:pbp.userId!}]});
 const previous=await hireEmployee(admin,{person:{fullName:'Fictional returning retiree',primaryEmail:randomUUID()+'@intake.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
 const retirementCaseId=await v9CreateOffboarding(admin,{employmentId:previous.employmentId,type:'Retirement',noticeDate:`${year-1}-11-01`,lastDay:`${year-1}-12-31`});await v9Command(admin,retirementCaseId,1,{type:'submit'});
 const manager=await hireEmployee(admin,{person:{fullName:'Fictional line manager',primaryEmail:randomUUID()+'@intake.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
 const subject=await hireEmployee(admin,{person:{id:previous.personId},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end,reportingManagerEmploymentId:manager.employmentId});
 await setEmploymentInfo(admin,{employmentId:subject.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:1});
 await setCompensation(admin,{employmentId:subject.employmentId,basicSalary:5000,monthlyAllowance:17,effectiveFrom:start});
 await seedPayComponentCatalog(admin);const component=(await listPayComponents(admin)).find(c=>c.code==='ALLOWANCE')!;
 await setEmploymentPayComponent(admin,{employmentId:subject.employmentId,componentId:component.id,amount:100,effectiveFrom:start,currency:'MYR',prorateOverride:false,runType:'regular',remarks:'Actual configured allowance for native source parity'});
 await C.setupContractManagement(admin,b.companyId,component.id);
 for(const [actor,role] of [[pbp,'pbp'],[gbs,'gbs']] as const)await C.assignContractRole(admin,{companyId:b.companyId,businessUnitId:null,userId:actor.userId,role,from:start,to:null,reason:'Actual independent native intake responsibility'});
 const source=await C.previewContractIntake(gbs,subject.employmentId),approval=await document(subject.employmentId,'Fictional signed retirement approval');
 const custody=await C.captureContractRetirementEvidence(pbp,{employmentId:subject.employmentId,retirementCaseId,approvalDocumentId:approval.id,healthDocumentId:null,sourceRevision:source.sourceRevision,reason:'Actual approval checked; separate completed health check has not arrived'});
 return {subject,pbp,gbs,custody};
}
async function privateHold(employmentId:string){return owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${b.tenantId},true)`;const [row]=await tx<{actual:string|null;projected:string|null}[]>`select app.contract_shared_native_intake_hold(${employmentId}::uuid) as actual,(select kind from app.contract_shared_native_intake_holds(array[${employmentId}::uuid])) as projected`;return row;});}
async function counts(){return [...await owner.db.execute<{counts:number[]}>(sql`select array[(select count(*)::int from contract_term where tenant_id=${b.tenantId}::uuid),(select count(*)::int from contract_case where tenant_id=${b.tenantId}::uuid),(select count(*)::int from contract_shared_event where tenant_id=${b.tenantId}::uuid),(select count(*)::int from bulk_job where tenant_id=${b.tenantId}::uuid)] as counts`)][0].counts;}
describe('shared Contract preserves the native first post-retirement intake',()=>{
 it('holds a no-case Personnel period and exposes only a coarse intake instruction; projection matches full pay and manager source',async()=>{
  const f=await fixture();expect(await privateHold(f.subject.employmentId)).toEqual({actual:'health_pending',projected:'health_pending'});
  const viewer=await account('Fictional view-only reader'),roleId=randomUUID();await C.saveContractSharedRole(admin,{id:roleId,name:'View native periods',permissions:['view'],expectedRevision:0});await C.saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:viewer.userId!,companyId:b.companyId,businessGroupId:null,validFrom:start,validTo:null,revoked:false});
  const before=await counts(),row=(await C.contractSharedTracker(viewer)).rows.find(r=>r.id===f.subject.employmentId)!;
  expect(row).toMatchObject({caseId:null,sourceIssue:'native_intake_required',canOpen:false});const period=await C.contractSharedPeriodContext(viewer,f.subject.employmentId);
  expect(period).toMatchObject({sourceIssue:'native_intake_required',canOpen:false,source:{nativeIntakeRequired:true}});expect(JSON.stringify(period)).not.toMatch(/health_pending|healthDocument|approvalDocument|salaryCents|500000/);
  await expect(C.openContractSharedPeriod(admin,{employmentId:f.subject.employmentId,sourceRevision:row.sourceRevision!})).rejects.toMatchObject({code:'conflict'});expect(await counts()).toEqual(before);
  await setCompensation(admin,{employmentId:f.subject.employmentId,basicSalary:5100,effectiveFrom:`${year}-02-01`,remarks:'Legitimate native pay correction changes the custody source'});
  expect(await privateHold(f.subject.employmentId)).toEqual({actual:null,projected:null});
 });
 it('keeps independently verified proof on the native intake path rather than inventing a generic first term',async()=>{
  const f=await fixture(),health=await document(f.subject.employmentId,'Fictional completed health check');
  await C.attachContractRetirementHealth(f.pbp,{custodyId:f.custody.id,healthDocumentId:health.id,reason:'Original capturing PBP checked the separate completed health PDF'});
  await C.verifyContractRetirementEvidence(f.gbs,{custodyId:f.custody.id,reason:'Independent check of actual retirement and current approved contract terms'});
  expect(await privateHold(f.subject.employmentId)).toEqual({actual:'intake_required',projected:'intake_required'});
  const row=(await C.contractSharedTracker(admin)).rows.find(r=>r.id===f.subject.employmentId)!;const before=await counts();
  await expect(C.openContractSharedPeriod(admin,{employmentId:f.subject.employmentId,sourceRevision:row.sourceRevision!})).rejects.toMatchObject({code:'conflict'});expect(await counts()).toEqual(before);
  expect(await C.previewContractIntake(f.gbs,f.subject.employmentId)).toMatchObject({retirementHealthPending:false,retirementProofRequired:true});
 });
});
