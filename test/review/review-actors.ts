/** REVIEW draft helper (would live at test/review/_actors.ts). Builds the eight actors of the security role matrix on
 * fictional fixtures. Static draft: not run locally (verification runs on GitHub Actions).
 *
 * Actors: employee (the applicant), manager (direct manager of the applicant), covering delegate (a whole-scope
 * `delegate` reporting line from the manager's employment), company-scoped HR admin (hr_admin grant with companyId),
 * group admin (hr_admin grant with companyId null), payroll partner, another company's HR admin in the same tenant,
 * and a group admin of another tenant. */
import {randomUUID} from 'node:crypto';
import * as schema from '../../db/schema';
import type {SessionContext} from '../../db/client';
import {hireEmployee,setReportingLine} from '../../core/org';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,entitledCtx,owner,seedBase,type Base} from '../harness';

export type Actor=Readonly<{name:string;ctx:SessionContext;employmentId:string;personId:string}>;
export type Matrix=Readonly<{b:Base;b2:Base;company2:string;dept2:string;
 employee:Actor;manager:Actor;delegate:Actor;companyAdmin:Actor;groupAdmin:Actor;payroll:Actor;otherCompanyAdmin:Actor;otherTenant:Actor;
 colleague:Actor}>;
type GrantRow=Readonly<{role:'employee'|'manager'|'hr_admin'|'super_admin'|'payroll_partner';companyId:string|null}>;

async function actor(base:Base,companyId:string,departmentId:string,name:string,grants:readonly GrantRow[],leaveDays=10):Promise<Actor>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:hired.personId}).returning({id:schema.appUser.id});
 for(const grant of grants)await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:grant.companyId,role:grant.role});
 if(leaveDays>0&&companyId===base.companyId)await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,
  entryType:'accrual',days:String(leaveDays),effectiveOn:todayInKualaLumpur()});
 const roles=[...new Set(grants.map(grant=>grant.role))];
 return Object.freeze({name,employmentId:hired.employmentId,personId:hired.personId,
  ctx:{...await entitledCtx(base,roles),userId:user.id,personId:hired.personId,roles,grants:grants.map(grant=>({...grant}))} as SessionContext});
}

export async function buildMatrix():Promise<Matrix>{
 const b=await seedBase(),b2=await seedBase();
 const [company2]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second Company Sdn Bhd'}).returning({id:schema.company.id});
 const [dept2]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:company2.id,name:'Fictional Second Department'}).returning({id:schema.department.id});
 const manager=await actor(b,b.companyId,b.deptA,'Fictional Matrix Manager',[{role:'manager',companyId:null}]);
 const employee=await actor(b,b.companyId,b.deptA,'Fictional Matrix Employee',[{role:'employee',companyId:null}]);
 const colleague=await actor(b,b.companyId,b.deptA,'Fictional Matrix Colleague',[{role:'employee',companyId:null}]);
 const delegate=await actor(b,b.companyId,b.deptA,'Fictional Matrix Covering Delegate',[{role:'employee',companyId:null}]);
 const companyAdmin=await actor(b,b.companyId,b.deptB,'Fictional Matrix Company Administrator',[{role:'hr_admin',companyId:b.companyId}]);
 const groupAdmin=await actor(b,b.companyId,b.deptB,'Fictional Matrix Group Administrator',[{role:'hr_admin',companyId:null}]);
 const payroll=await actor(b,b.companyId,b.deptB,'Fictional Matrix Payroll Partner',[{role:'payroll_partner',companyId:null}]);
 const otherCompanyAdmin=await actor(b,company2.id,dept2.id,'Fictional Matrix Other Company Administrator',[{role:'hr_admin',companyId:company2.id}]);
 const otherTenant=await actor(b2,b2.companyId,b2.deptA,'Fictional Matrix Other Tenant Administrator',[{role:'hr_admin',companyId:null}]);
 for(const report of [employee.employmentId,colleague.employmentId])
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:report,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 // Approval delegation is a `delegate` reporting line: subordinate = the delegator, manager = the stand-in.
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:manager.employmentId,managerEmploymentId:delegate.employmentId,lineType:'delegate',
  validFrom:'2020-01-01',validTo:'2099-12-31',reason:'Fictional covering delegation'});
 return Object.freeze({b,b2,company2:company2.id,dept2:dept2.id,employee,manager,delegate,companyAdmin,groupAdmin,payroll,otherCompanyAdmin,otherTenant,colleague});
}

/** The next weekday after today (HR date), so a fixture request is in the future. */
export function nextWorkday(offset=1):string{
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');let n=0;
 while(n<offset){next.setUTCDate(next.getUTCDate()+1);if(![0,6].includes(next.getUTCDay()))n++;}
 return next.toISOString().slice(0,10);
}
