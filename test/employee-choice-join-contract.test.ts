/** Optimizing navigation must retain the legacy NULL-ended assignment relation. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {readEmployeeChoices} from '../core/employee-choice';
import {listEmployees} from '../core/read';
import {assignment,company,employment,person} from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(resetDb);
it('retains future NULL-ended rows, closed and superseded exclusions and unassigned employments',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),secondCompany=randomUUID();
 await owner.db.insert(company).values({id:secondCompany,tenantId:b.tenantId,legalName:'Unassigned company'});
 const ids:string[]=[];
 for(const [name,companyId]of [['Alpha',b.companyId],['Beta',b.companyId],['Gamma',secondCompany]]){
  const id=randomUUID(),pid=randomUUID();ids.push(id);
  await owner.db.insert(person).values({id:pid,tenantId:b.tenantId,fullName:name,primaryEmail:pid+'@example.invalid'});
  await owner.db.insert(employment).values({id,tenantId:b.tenantId,personId:pid,companyId,hiredOn:'2020-01-01'});
 }
 const earlier=randomUUID(),future=randomUUID();
 await owner.db.insert(assignment).values([
  {id:earlier,tenantId:b.tenantId,employmentId:ids[0],companyId:b.companyId,departmentId:b.deptA,validFrom:'2020-01-01',validTo:'2099-01-01',employmentType:'full_time'},
  {id:future,tenantId:b.tenantId,employmentId:ids[0],companyId:b.companyId,departmentId:b.deptB,validFrom:'2099-01-01',employmentType:'full_time'},
  {tenantId:b.tenantId,employmentId:ids[1],companyId:b.companyId,departmentId:b.deptA,validFrom:'2020-01-01',employmentType:'full_time',supersededAt:new Date('2021-01-01T00:00:00Z')},
 ]);
 const legacy=await listEmployees(ctx,[]),page=await readEmployeeChoices(ctx,{companyIds:[],limit:200});
 const tuples=(rows:typeof legacy|typeof page.rows)=>rows.map(row=>row.employmentId+':'+(row.departmentId??'none')).sort();
 const expected=[ids[0]+':'+b.deptB,ids[1]+':none',ids[2]+':none'].sort();
 expect(tuples(legacy)).toEqual(expected);expect(tuples(page.rows)).toEqual(expected);expect(page.total).toBe(3);
 const expectedAlpha=[b.deptB];
 const alpha=await readEmployeeChoices(ctx,{companyIds:[],query:'Alpha'});expect(alpha.total).toBe(1);expect(alpha.rows.map(row=>row.departmentId)).toEqual(expectedAlpha);
 const closedDepartment=await readEmployeeChoices(ctx,{companyIds:[],departmentId:b.deptA});expect(closedDepartment.total).toBe(0);expect(closedDepartment.rows).toEqual([]);
 const deep=await readEmployeeChoices(ctx,{companyIds:[],offset:2,limit:1,selectedId:ids[2]});expect(deep.total).toBe(3);expect(deep.rows.map(row=>row.employmentId)).toEqual([ids[2]]);expect(deep.selected?.employmentId).toBe(ids[2]);
 expect(page.companyOptions.map(row=>row.id).sort()).toEqual([b.companyId,secondCompany].sort());
 expect(page.allDepartmentOptions.map(row=>row.id).sort()).toEqual([b.deptB]);
 const onlyUnassigned=await readEmployeeChoices(ctx,{companyIds:[secondCompany],selectedId:ids[0]});expect(onlyUnassigned.selected).toBeNull();expect(onlyUnassigned.total).toBe(1);expect(onlyUnassigned.departmentOptions).toEqual([]);expect(onlyUnassigned.businessUnitOptions).toEqual([]);
 const independentlySelected=await readEmployeeChoices(ctx,{companyIds:[],companyId:secondCompany,selectedId:ids[0]});expect(independentlySelected.total).toBe(1);expect(independentlySelected.rows.map(row=>row.employmentId)).toEqual([ids[2]]);expect(independentlySelected.selected?.employmentId).toBe(ids[0]);
});
