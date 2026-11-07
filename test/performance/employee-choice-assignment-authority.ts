/** Closed fictional native authority fixtures for the Assignment representation experiment. */
import {randomUUID} from 'node:crypto';
import {eq,inArray,sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import {appUser,assignment,businessUnit,company,employment,person,reportingLine,roleAssignment} from '../../db/schema';
import {assertAiPresentationPrincipalTx} from '../../core/ai-principal';
import {readEmployeeChoices} from '../../core/employee-choice';
import {addCalendarMonths,todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,createAppUser,owner,seedBase} from '../harness';

export async function createAssignmentAuthorityFixture(){
 const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b),otherCompany=randomUUID(),unit=randomUUID();
 await owner.db.insert(company).values({id:otherCompany,tenantId:b.tenantId,legalName:'Fictional current Assignment employer'});
 await owner.db.insert(businessUnit).values({id:unit,tenantId:b.tenantId,companyId:b.companyId,code:'AUTH-UNIT',name:'Fictional authority unit'});
 const add=async(name:string,dept:string|null,companyId=b.companyId,assignmentCompanyId=companyId)=>{
  const personId=randomUUID(),id=randomUUID(),assignmentId=dept?randomUUID():null;
  await owner.db.insert(person).values({id:personId,tenantId:b.tenantId,fullName:name,primaryEmail:personId+'@example.invalid'});
  await owner.db.insert(employment).values({id,tenantId:b.tenantId,personId,companyId,hiredOn:'2020-01-01'});
  if(dept!==null&&assignmentId)await owner.db.insert(assignment).values({id:assignmentId,tenantId:b.tenantId,employmentId:id,companyId:assignmentCompanyId,departmentId:dept,businessUnitId:dept===b.deptA?unit:null,validFrom:'2020-01-01',employmentType:'full_time'});
  return {id,personId,assignmentId};
 };
 const alpha=await add('A fictional Assignment employee',b.deptA),beta=await add('B fictional Assignment manager',b.deptB),gamma=await add('C fictional Assignment peer',b.deptA);
 const unassigned=await add('D fictional employee without current Assignment',null),transferred=await add('Z fictional transferred Assignment employee',b.deptB,otherCompany,b.companyId);
 const closedAlpha=randomUUID(),supersededAlpha=randomUUID(),closedUnassigned=randomUUID();
 // Current means valid_to NULL/superseded NULL in the canonical port, even when
 // its valid_from is future. Native policy must also retain closed/superseded history.
 const futureAssignmentDate=addCalendarMonths(todayInKualaLumpur(),1);
 await owner.db.update(assignment).set({validFrom:futureAssignmentDate}).where(eq(assignment.id,alpha.assignmentId!));
 await owner.db.insert(assignment).values([
  {id:closedAlpha,tenantId:b.tenantId,employmentId:alpha.id,companyId:b.companyId,departmentId:b.deptA,validFrom:'2020-01-01',validTo:'2021-01-01',employmentType:'full_time'},
  {id:supersededAlpha,tenantId:b.tenantId,employmentId:alpha.id,companyId:b.companyId,departmentId:b.deptB,validFrom:'2020-01-01',validTo:'2021-01-01',supersededAt:new Date('2022-01-01T00:00:00Z'),employmentType:'full_time'},
  {id:closedUnassigned,tenantId:b.tenantId,employmentId:unassigned.id,companyId:b.companyId,departmentId:b.deptA,validFrom:'2020-01-01',validTo:'2021-01-01',employmentType:'full_time'},
 ]);
 const employeeUser=await createAppUser(b.tenantId,alpha.personId,'employee'),managerUser=await createAppUser(b.tenantId,beta.personId,'manager');
 const unassignedUser=await createAppUser(b.tenantId,unassigned.personId,'employee'),selfUser=await createAppUser(b.tenantId,transferred.personId,'employee');
 const scopedUser=await createAppUser(b.tenantId,null,'hr_admin'),noAccessUser=await createAppUser(b.tenantId,null,'employee');
 await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,scopedUser));
 const [edge]=await owner.db.insert(reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:alpha.id,managerEmploymentId:beta.id,lineType:'administrative',validFrom:'2020-01-01'}).returning({id:reportingLine.id});
 const employeeCtx:SessionContext={tenantId:b.tenantId,userId:employeeUser,personId:alpha.personId,roles:['employee']};
 const managerCtx:SessionContext={tenantId:b.tenantId,userId:managerUser,personId:beta.personId,roles:['manager']};
 const unassignedCtx:SessionContext={tenantId:b.tenantId,userId:unassignedUser,personId:unassigned.personId,roles:['employee']};
 const selfCtx:SessionContext={tenantId:b.tenantId,userId:selfUser,personId:transferred.personId,roles:['employee']};
 const scopedCtx:SessionContext={tenantId:b.tenantId,userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const noAccessCtx:SessionContext={tenantId:b.tenantId,userId:noAccessUser,personId:null,roles:['employee']};
 const partners:SessionContext[]=[];
 for(const role of ['payroll_partner','performance_comp_partner']as const){
  const userId=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(roleAssignment).set({role,companyId:otherCompany}).where(eq(roleAssignment.appUserId,userId));partners.push({tenantId:b.tenantId,userId,grants:[{role,companyId:otherCompany}]});
 }
 return {b,foreign,ctx,otherCompany,unit,alpha,beta,gamma,unassigned,transferred,closedAlpha,supersededAlpha,closedUnassigned,futureAssignmentDate,
  employeeUser,edge,employeeCtx,managerCtx,unassignedCtx,selfCtx,scopedCtx,noAccessCtx,partners};
}
type Fixture=Awaited<ReturnType<typeof createAssignmentAuthorityFixture>>;
type Page=Awaited<ReturnType<typeof readEmployeeChoices>>;
const stable=({contextId:_contextId,...page}:Page)=>page;
const ids=(page:Page)=>page.rows.map(row=>row.employmentId);
async function history(ctx:SessionContext,employmentIds:string[]){
 return withTenant(ctx,async tx=>{
  await assertAiPresentationPrincipalTx(tx,ctx);
  return tx.select({id:assignment.id,employmentId:assignment.employmentId,companyId:assignment.companyId,validFrom:assignment.validFrom,validTo:assignment.validTo,supersededAt:assignment.supersededAt})
   .from(assignment).where(inArray(assignment.employmentId,employmentIds)).orderBy(assignment.id);
 },{readOnlySnapshot:true});
}
async function bankRows(ctx:SessionContext,on:boolean){
 return withTenant(ctx,async tx=>{
  await assertAiPresentationPrincipalTx(tx,ctx);await tx.execute(sql`select set_config('app.bank_import_point_read',${on?'on':'off'},true)`);
  return (await tx.select({id:employment.id}).from(employment).orderBy(employment.id)).map(row=>row.id);
 },{readOnlySnapshot:true});
}

export async function assertAssignmentAuthority(f:Fixture){
 const {b,ctx,alpha,beta,gamma,unassigned,transferred,employeeCtx,managerCtx,selfCtx,scopedCtx,partners}=f;
 const assertBaseline=async()=>{
  const [actual]=await owner.client`select
   (select department_id from assignment where id=${beta.assignmentId!}::uuid) as manager_department,
   (select valid_from::text from reporting_line where id=${f.edge.id}::uuid) as edge_from,
   (select archived_at from app_user where id=${f.employeeUser}::uuid) as archived,
   (select voided_at from employment where id=${transferred.id}::uuid) as employment_voided,
   (select voided_at from person where id=${transferred.personId}::uuid) as person_voided,
   (select count(*)::int from role_assignment where app_user_id=${f.employeeUser}::uuid and role='employee' and company_id is null) as employee_grants,
   (select count(*)::int from assignment where employment_id=${alpha.id}::uuid) as alpha_history,
   (select valid_from::text from assignment where id=${alpha.assignmentId!}::uuid) as alpha_current_from,
   (select count(*)::int from assignment where employment_id=${unassigned.id}::uuid and valid_to is null and superseded_at is null) as unassigned_current`;
  expect(actual).toEqual({manager_department:b.deptB,edge_from:'2020-01-01',archived:null,employment_voided:null,person_voided:null,employee_grants:1,alpha_history:3,alpha_current_from:f.futureAssignmentDate,unassigned_current:0});
 };
 await assertBaseline();
 try{
 const all=await readEmployeeChoices(ctx,{companyIds:[],selectedId:unassigned.id});expect(all.total).toBe(5);expect(ids(all)).toEqual([alpha.id,beta.id,gamma.id,unassigned.id,transferred.id]);expect(all.selected?.departmentId).toBeNull();
 const employee=await readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:gamma.id});expect(employee.total).toBe(1);expect(ids(employee)).toEqual([alpha.id]);expect(employee.selected).toBeNull();expect(employee.rows[0].departmentId).toBe(b.deptA);
 await expect(readEmployeeChoices(employeeCtx,{companyIds:[],labelMode:'labels'})).rejects.toThrow('administration access');
 const scoped=await readEmployeeChoices(ctx,{companyIds:[b.companyId],departmentId:b.deptA,businessUnitId:f.unit,status:'active',selectedId:unassigned.id});
 expect(scoped.total).toBe(2);expect(ids(scoped)).toEqual([alpha.id,gamma.id]);expect(scoped.selected?.employmentId).toBe(unassigned.id);expect(scoped.selected?.departmentId).toBeNull();
 expect(scoped.businessUnitOptions).toEqual([{id:f.unit,name:'Fictional authority unit'}]);expect(scoped.departmentOptions.map(row=>row.id)).toEqual([b.deptA,b.deptB]);
 const ownHistory=await history(employeeCtx,[alpha.id]);expect(ownHistory.map(row=>row.id)).toEqual([alpha.assignmentId!,f.closedAlpha,f.supersededAlpha].sort());
 expect(ownHistory.find(row=>row.id===alpha.assignmentId)?.validFrom).toBe(f.futureAssignmentDate);
 const unassignedPage=await readEmployeeChoices(f.unassignedCtx,{companyIds:[],selectedId:unassigned.id});expect(unassignedPage.total).toBe(1);expect(unassignedPage.rows[0].departmentId).toBeNull();
 const unassignedHistory=await history(f.unassignedCtx,[unassigned.id]);expect(unassignedHistory.map(row=>row.id)).toEqual([f.closedUnassigned]);
 const manager=await readEmployeeChoices(managerCtx,{companyIds:[b.companyId],selectedId:alpha.id});expect(manager.total).toBe(2);expect(ids(manager)).toEqual([alpha.id,beta.id]);
 await owner.db.update(assignment).set({departmentId:b.deptA}).where(eq(assignment.id,beta.assignmentId!));let hod:Page;
 try{hod=await readEmployeeChoices(managerCtx,{companyIds:[b.companyId],selectedId:transferred.id});expect(hod.total).toBe(3);expect(ids(hod)).toEqual([alpha.id,beta.id,gamma.id]);expect(hod.selected).toBeNull();}
 finally{await owner.db.update(assignment).set({departmentId:b.deptB}).where(eq(assignment.id,beta.assignmentId!));}
 await owner.db.update(reportingLine).set({validFrom:addCalendarMonths(todayInKualaLumpur(),1)}).where(eq(reportingLine.id,f.edge.id));let future:Page;
 try{future=await readEmployeeChoices(managerCtx,{companyIds:[b.companyId]});expect(future.total).toBe(1);expect(ids(future)).toEqual([beta.id]);}
 finally{await owner.db.update(reportingLine).set({validFrom:'2020-01-01'}).where(eq(reportingLine.id,f.edge.id));}
 const self=await readEmployeeChoices(selfCtx,{companyIds:[f.otherCompany],selectedId:transferred.id});expect(self.total).toBe(1);expect(self.rows[0].companyId).toBe(f.otherCompany);expect(self.rows[0].departmentId).toBe(b.deptB);
 const transferredHistory=await history(selfCtx,[transferred.id]);expect(transferredHistory.map(row=>row.companyId)).toEqual([b.companyId]);
 const deniedCompany=await readEmployeeChoices(scopedCtx,{companyIds:[f.otherCompany],selectedId:transferred.id});expect(deniedCompany.total).toBe(0);expect(deniedCompany.selected).toBeNull();expect(deniedCompany.companyOptions).toEqual([]);
 expect(await history(scopedCtx,[transferred.id])).toEqual([]);
 const deniedTenant=await readEmployeeChoices(adminCtx(f.foreign),{companyIds:[b.companyId],selectedId:alpha.id});expect(deniedTenant.total).toBe(0);expect(deniedTenant.selected).toBeNull();expect(await history(adminCtx(f.foreign),[alpha.id])).toEqual([]);
 const noAccess=await readEmployeeChoices(f.noAccessCtx,{companyIds:[b.companyId],selectedId:alpha.id});expect(noAccess.total).toBe(0);expect(noAccess.rows).toEqual([]);expect(noAccess.selected).toBeNull();expect(noAccess.companyOptions).toEqual([]);expect(await history(f.noAccessCtx,[alpha.id])).toEqual([]);
 const partnerPages:unknown[]=[];
 for(const partner of partners){
  const page=await readEmployeeChoices(partner,{companyIds:[f.otherCompany],selectedId:transferred.id});expect(page.total).toBe(1);expect(page.selected?.employmentId).toBe(transferred.id);expect(page.rows[0].departmentId).toBeNull();expect(await history(partner,[transferred.id])).toEqual([]);
  const denied=await readEmployeeChoices(partner,{companyIds:[b.companyId],selectedId:alpha.id});expect(denied.total).toBe(0);expect(denied.selected).toBeNull();partnerPages.push({page:stable(page),denied:stable(denied)});
 }
 await owner.db.update(employment).set({voidedAt:new Date(),voidedBy:b.adminUserId,voidReason:'Fictional Assignment membership control',voidedImportAttemptId:randomUUID()}).where(eq(employment.id,transferred.id));let voidedEmployment:Page,voidedPerson:Page;
 try{voidedEmployment=await readEmployeeChoices(partners[0],{companyIds:[f.otherCompany],selectedId:transferred.id});expect(voidedEmployment.total).toBe(0);expect(voidedEmployment.selected).toBeNull();}
 finally{await owner.db.update(employment).set({voidedAt:null,voidedBy:null,voidReason:null,voidedImportAttemptId:null}).where(eq(employment.id,transferred.id));}
 await owner.db.update(person).set({voidedAt:new Date()}).where(eq(person.id,transferred.personId));
 try{voidedPerson=await readEmployeeChoices(partners[0],{companyIds:[f.otherCompany],selectedId:transferred.id});expect(voidedPerson.total).toBe(0);expect(voidedPerson.selected).toBeNull();}
 finally{await owner.db.update(person).set({voidedAt:null}).where(eq(person.id,transferred.personId));}
 await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,f.employeeUser));
 try{await expect(readEmployeeChoices(employeeCtx,{companyIds:[]})).rejects.toThrow('calling authority');}finally{await owner.db.update(appUser).set({archivedAt:null}).where(eq(appUser.id,f.employeeUser));}
 const grants=await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,f.employeeUser)).returning();expect(grants).toHaveLength(1);
 try{await expect(readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:alpha.id})).rejects.toThrow('calling authority');}finally{await owner.db.insert(roleAssignment).values(grants);}
 const restored=await readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:alpha.id});expect(restored.total).toBe(1);expect(restored.selected?.employmentId).toBe(alpha.id);
 expect((await history(employeeCtx,[alpha.id])).map(row=>row.id)).toEqual(ownHistory.map(row=>row.id));
 await expect(readEmployeeChoices({...ctx,personId:randomUUID()},{companyIds:[b.companyId]})).rejects.toThrow('calling authority');
 const bank:unknown[]=[];
 for(const caller of [ctx,employeeCtx,managerCtx,scopedCtx,...partners]){const off=await bankRows(caller,false),on=await bankRows(caller,true);expect(on).toEqual(off);bank.push({off,on});}
 return {all:stable(all),employee:stable(employee),scoped:stable(scoped),ownHistory,unassigned:stable(unassignedPage),unassignedHistory,manager:stable(manager),hod:stable(hod!),future:stable(future!),self:stable(self),transferredHistory,
  deniedCompany:stable(deniedCompany),deniedTenant:stable(deniedTenant),noAccess:stable(noAccess),partnerPages,voidedEmployment:stable(voidedEmployment!),voidedPerson:stable(voidedPerson!),restored:stable(restored),bank};
 }finally{await assertBaseline();}
}
