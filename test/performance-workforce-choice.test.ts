/** AP002: exact thin Workforce population with bounded transport at group scale. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {listWorkforcePickOptions} from '../core/read';
import {readWorkforceChoices} from '../core/workforce-choice';
import {workforceEmploymentAccess} from '../core/workforce-access';
import {workforceChoiceInput,WorkforceChoiceInputError,WorkforceChoiceAccessError} from '../lib/workforce-choice';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('pages the exact active native picker population across roles and scopes, retaining only authorized selected ids',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const companies=[b.companyId,...(await owner.db.insert(s.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Fictional Workforce '+i}))).returning({id:s.company.id})).map(r=>r.id)];
 const people=await owner.db.insert(s.person).values(Array.from({length:1000},(_,i)=>({tenantId:b.tenantId,fullName:i<3?['İpek %_\\','Σίσυφος','相同姓名'][i]:`Fictional Workforce ${String(i).padStart(4,'0')}`,primaryEmail:randomUUID()+'@fixture.invalid'}))).returning({id:s.person.id});
 const employees=await owner.db.insert(s.employment).values(people.map((p,i)=>({tenantId:b.tenantId,personId:p.id,companyId:companies[i%70],employeeCode:'WF-'+i,hiredOn:'2020-01-01',terminatedOn:i===999?'2099-01-01':null}))).returning({id:s.employment.id});
 const subjectId=employees[70].id,selectedId=employees[900].id;
 const native=await listWorkforcePickOptions(ctx),expected=native.filter(r=>r.employmentId!==subjectId&&!r.terminatedOn).map(({employmentId,name,employeeCode,companyId})=>({employmentId,name,employeeCode,companyId}));
 expect(expected).toHaveLength(998);
 const rows=[];for(let offset=0;offset<expected.length;offset+=25){const page=await readWorkforceChoices(ctx,{subjectId,offset,selectedIds:[selectedId]});expect(page.total).toBe(998);expect(page.rows).toHaveLength(Math.min(25,998-offset));rows.push(...page.rows);expect(page.selected).toEqual(expected.filter(r=>r.employmentId===selectedId));}
 expect(rows).toEqual(expected);
 expect(JSON.stringify((await readWorkforceChoices(ctx,{subjectId})).rows).length).toBeLessThan(JSON.stringify(expected).length/10);
 for(const role of s.roleEnum.enumValues)for(const companyId of role==='super_admin'?[null]:[null,b.companyId]){
  const userId=await createAppUser(b.tenantId,people[70].id,'employee');await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const who={...ctx,userId,personId:people[70].id,roles:[role],grants:[{role,companyId}]};
  if(!await workforceEmploymentAccess(who,subjectId,'view')){await expect(readWorkforceChoices(who,{subjectId})).rejects.toBeInstanceOf(WorkforceChoiceAccessError);continue;}
  for(const ids of [undefined,[b.companyId],[]]){
   const oracle=(await listWorkforcePickOptions(who,ids)).filter(r=>r.employmentId!==subjectId&&!r.terminatedOn).map(({employmentId,name,employeeCode,companyId})=>({employmentId,name,employeeCode,companyId}));
   const page=await readWorkforceChoices(who,{subjectId,selectedIds:[selectedId]},ids);
   expect(page.rows).toEqual(oracle.slice(0,25));expect(page.total).toBe(oracle.length);expect(page.selected).toEqual(oracle.filter(r=>r.employmentId===selectedId));
  }
 }
 for(const query of ['İpek %_\\','Σίσυφος','相同姓名'])expect((await readWorkforceChoices(ctx,{subjectId,query})).rows.map(r=>r.name)).toEqual([query]);
 expect((await readWorkforceChoices(ctx,{subjectId,query:'no match',selectedIds:[selectedId,subjectId,employees[999].id,randomUUID()]})).selected).toEqual(expected.filter(r=>r.employmentId===selectedId));
 const single=await readWorkforceChoices(ctx,{subjectId,companyId:companies[1],selectedIds:[selectedId]});expect(single.rows.every(r=>r.companyId===companies[1])).toBe(true);expect(single.total).toBe(expected.filter(r=>r.companyId===companies[1]).length);
 const foreign=await seedBase();await expect(readWorkforceChoices(adminCtx(foreign),{subjectId})).rejects.toBeInstanceOf(WorkforceChoiceAccessError);
 // Ordinary human presentation snapshot is RR/READ ONLY; no exclusive Access admission.
 await withTenant(ctx,async tx=>{const [mode]=await tx.execute<{ro:string;isolation:string}>(sql`select current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation`);expect(mode).toEqual({ro:'on',isolation:'repeatable read'});},{readOnlySnapshot:true});
},300000);
it('rejects invalid or excessive public picker inputs before a database operation',()=>{
 for(const input of [{subjectId:'bad'},{subjectId:randomUUID(),offset:2147483648},{subjectId:randomUUID(),offset:-1},{subjectId:randomUUID(),query:'a'.repeat(201)},{subjectId:randomUUID(),selectedIds:Array.from({length:9},()=>randomUUID())},{subjectId:randomUUID(),companyIds:[]}])expect(()=>workforceChoiceInput(input)).toThrow(WorkforceChoiceInputError);
});
