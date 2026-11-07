/** Native sparse multi-company representation; no policy or visibility substitutes. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {assignment,businessUnit,company,department,employment,person} from '../../db/schema';
import {owner} from '../harness';
import {createAssignmentAuthorityFixture} from './employee-choice-assignment-authority';
export async function createFacetRepresentationFixture(){
 const f=await createAssignmentAuthorityFixture(),emptyCompany=randomUUID(),endedDepartment=randomUUID(),endedUnit=randomUUID();
 await owner.db.insert(company).values({id:emptyCompany,tenantId:f.b.tenantId,legalName:'Fictional company with unassigned identities'});
 await owner.db.update(department).set({name:'D-A',label:'Shared department'}).where(eq(department.id,f.b.deptA));
 await owner.db.update(department).set({name:'D-B',label:'Shared department'}).where(eq(department.id,f.b.deptB));
 await owner.db.insert(department).values({id:endedDepartment,tenantId:f.b.tenantId,companyId:f.b.companyId,name:'D-END',label:'Shared department'});
 await owner.db.update(businessUnit).set({code:'U-A',name:'Unit native',label:'Shared unit'}).where(eq(businessUnit.id,f.unit));
 await owner.db.insert(businessUnit).values({id:endedUnit,tenantId:f.b.tenantId,companyId:f.b.companyId,code:'U-END',name:'Unit historical',label:'Shared unit'});
 await owner.db.update(employment).set({terminatedOn:'2024-01-01'}).where(eq(employment.id,f.gamma.id));
 await owner.db.update(assignment).set({departmentId:endedDepartment,businessUnitId:endedUnit}).where(eq(assignment.id,f.gamma.assignmentId!));
 await owner.db.update(assignment).set({businessUnitId:f.unit}).where(eq(assignment.id,f.transferred.assignmentId!));
 const companyIds=[f.b.companyId,f.otherCompany,emptyCompany];
 const emptyDepartments=Array.from({length:160},(_,i)=>({id:randomUUID(),tenantId:f.b.tenantId,companyId:companyIds[i%3],name:'EMPTY-D-'+String(i).padStart(3,'0'),label:'Shared department'}));
 const emptyUnits=Array.from({length:64},(_,i)=>({id:randomUUID(),tenantId:f.b.tenantId,companyId:companyIds[i%3],code:'EMPTY-U-'+String(i).padStart(3,'0'),name:'Unrepresented unit '+i,label:'Shared unit'}));
 await owner.db.insert(department).values(emptyDepartments);await owner.db.insert(businessUnit).values(emptyUnits);
 const nullPerson=randomUUID(),nullEmployment=randomUUID(),hiddenPerson=randomUUID(),hiddenEmployment=randomUUID();
 await owner.db.insert(person).values([{id:nullPerson,tenantId:f.b.tenantId,fullName:'E fictional NULL-ended empty organisation',primaryEmail:nullPerson+'@example.invalid'},{id:hiddenPerson,tenantId:f.b.tenantId,fullName:'PRIVATE fictional voided Person',primaryEmail:hiddenPerson+'@example.invalid'}]);
 await owner.db.insert(employment).values([{id:nullEmployment,tenantId:f.b.tenantId,personId:nullPerson,companyId:emptyCompany,hiredOn:'2020-01-01'},{id:hiddenEmployment,tenantId:f.b.tenantId,personId:hiddenPerson,companyId:emptyCompany,hiredOn:'2020-01-01'}]);
 await owner.db.insert(assignment).values([
  // NULL organisation is a read projection of no current Assignment. Native
  // Assignment.department_id is required; retain its real closed history below.
  {tenantId:f.b.tenantId,employmentId:nullEmployment,companyId:emptyCompany,departmentId:emptyDepartments[2].id,businessUnitId:emptyUnits[2].id,validFrom:'2010-01-01',validTo:'2011-01-01',employmentType:'full_time'},
  {tenantId:f.b.tenantId,employmentId:nullEmployment,companyId:emptyCompany,departmentId:emptyDepartments[1].id,businessUnitId:emptyUnits[1].id,validFrom:'2020-01-01',supersededAt:new Date('2021-01-01T00:00:00Z'),employmentType:'full_time'},
  {tenantId:f.b.tenantId,employmentId:hiddenEmployment,companyId:emptyCompany,departmentId:emptyDepartments[2].id,businessUnitId:emptyUnits[2].id,validFrom:'2020-01-01',employmentType:'full_time'},
 ]);
 await owner.db.update(person).set({voidedAt:new Date()}).where(eq(person.id,hiddenPerson));
 // Expected current-company tuples are fixture facts, independent of candidate SQL.
 const members=[
  {id:f.alpha.id,companyId:f.b.companyId,departmentId:f.b.deptA,unitId:f.unit,ended:null},
  {id:f.beta.id,companyId:f.b.companyId,departmentId:f.b.deptB,unitId:null,ended:null},
  {id:f.gamma.id,companyId:f.b.companyId,departmentId:endedDepartment,unitId:endedUnit,ended:'2024-01-01'},
  {id:f.unassigned.id,companyId:f.b.companyId,departmentId:null,unitId:null,ended:null},
  {id:f.transferred.id,companyId:f.otherCompany,departmentId:f.b.deptB,unitId:f.unit,ended:null},
  {id:nullEmployment,companyId:emptyCompany,departmentId:null,unitId:null,ended:null},
 ];
 return {...f,emptyCompany,endedDepartment,endedUnit,companyIds,emptyDepartments,emptyUnits,nullEmployment,hiddenEmployment,members};
}
