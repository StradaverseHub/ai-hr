/** Real-principal conversion matrix; a new group catalogue must preserve legacy company floors. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {appUser,company,roleAssignment} from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {workforceCompanies} from '../core/workforce-access';
import {listEmployees} from '../core/read';
import {publishWorkforceCapabilities} from '../deploy/access/publish-workforce-capabilities';

let b:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain','profile.review')`);
});
afterAll(async()=>{try{
 await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain','profile.review')`);
}finally{await closeAll();}});
type Role='hr_admin'|'super_admin'|'manager'|'employee'|'payroll_partner'|'performance_comp_partner';
async function principal(role:Role,companyId:string|null,personId?:string):Promise<SessionContext>{
 const [user]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:`conversion_${randomUUID()}`,personId}).returning({id:appUser.id});
 await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role,companyId});
 return {...adminCtx(b),userId:user.id,personId,roles:[role],grants:[{role,companyId}]};
}
async function enabled(value:boolean){
 if(value)await publishWorkforceCapabilities(owner.client);
 else await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain','profile.review')`);
}
async function facts(ctx:SessionContext,companies:string[],employmentId:string){
 const result=[];
 for(const companyId of companies){
  const rows=await withTenant(ctx,tx=>tx.execute<{view:boolean;maintain:boolean;review:boolean}>(sql`select app.access_workforce_company(${companyId}::uuid,'workforce.view') as view,app.access_workforce_company(${companyId}::uuid,'workforce.maintain') as maintain,app.access_profile_review_permitted(${employmentId}::uuid) as review`));
  result.push({companyId,...rows[0]});
 }
 return {companies:await workforceCompanies(ctx),directory:(await listEmployees(ctx)).map(row=>row.employmentId).sort(),decisions:result};
}

it('keeps real global/scoped HR, managers, employees and specialist roles equivalent when default capabilities become available',async()=>{
 const admin={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 const [other]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional conversion second company'}).returning({id:company.id});
 const subject=await hireEmployee(admin,{person:{fullName:'Fictional conversion subject',primaryEmail:`${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const manager=await hireEmployee(admin,{person:{fullName:'Fictional actual structural manager',primaryEmail:`${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 await setReportingLine(admin,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});
 const actualManager=await principal('employee',null,manager.personId);
 const scopes=[b.companyId,other.id].sort();
 const contexts=[admin,await principal('super_admin',null),await principal('hr_admin',b.companyId),await principal('hr_admin',other.id),await principal('manager',b.companyId),await principal('employee',null),await principal('payroll_partner',b.companyId),await principal('performance_comp_partner',other.id),actualManager];
 const oldRoles=await owner.db.select().from(roleAssignment).orderBy(roleAssignment.id);
 const before=[];for(const ctx of contexts)before.push(await facts(ctx,scopes,subject.employmentId));
 await enabled(true);
 for(let i=0;i<contexts.length;i++)expect(await facts(contexts[i],scopes,subject.employmentId),`actual role ${contexts[i].roles?.[0]??'none'} scoped ${contexts[i].grants?.[0]?.companyId??'global'}`).toEqual(before[i]);
 // Positive and negative controls prevent two equally-empty matrices from establishing parity.
 expect(before[0].companies.sort()).toEqual(scopes);
 expect(before[2].companies).toEqual([b.companyId]);
 expect(before[3].companies).toEqual([other.id]);
 for(const index of [4,5,6,7])expect(before[index].companies).toEqual([]);
 expect(before[8].companies).toEqual([]);
 expect(before[8].directory).toContain(subject.employmentId);
 expect(before[0].decisions.every(row=>row.view&&row.maintain&&row.review)).toBe(true);
 expect(before[3].decisions.every(row=>!row.review)).toBe(true);
 expect(await owner.db.select().from(roleAssignment).orderBy(roleAssignment.id)).toEqual(oldRoles);
});

it('does not retain a role-derived default after the actual company role is revoked',async()=>{
 const ctx=await principal('hr_admin',b.companyId);await enabled(true);
 expect(await workforceCompanies(ctx)).toEqual([b.companyId]);
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,ctx.userId!));
 // Deliberately reuse the exact old context; no new cookie, principal or refreshed grant list.
 expect(await workforceCompanies(ctx)).toEqual([]);
});
