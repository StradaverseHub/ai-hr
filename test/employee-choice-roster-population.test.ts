/** A module may compose navigation and facts only in the same enforced read snapshot. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {readEmployeeChoices,readEmployeeChoicesTx,readEmployeeChoiceIdsTx,EmployeeChoiceInputError} from '../core/employee-choice';
import {assignment,company,employment,person} from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {ALL_ROW_CEILING} from '../lib/pagination';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(resetDb);
const cutoff=todayInKualaLumpur(new Date('2026-11-06T16:00:00Z'));
async function population(){
 const b=await seedBase(),ctx=adminCtx(b),secondCompany=randomUUID(),ids:string[]=[];
 await owner.db.insert(company).values({id:secondCompany,tenantId:b.tenantId,legalName:'Unassigned live company'});
 for(const [name,terminatedOn,companyId,departmentId]of [
  ['Alpha live',null,b.companyId,b.deptA],['Beta ended','2026-11-06',b.companyId,b.deptB],
  ['Gamma ending today','2026-11-07',b.companyId,b.deptB],['İnci future','2026-11-08',b.companyId,b.deptA],
  ['Omega unassigned',null,secondCompany,null],
 ] as const){
  const pid=randomUUID(),id=randomUUID();ids.push(id);
  await owner.db.insert(person).values({id:pid,tenantId:b.tenantId,fullName:name,primaryEmail:pid+'@example.invalid'});
  await owner.db.insert(employment).values({id,tenantId:b.tenantId,personId:pid,companyId,hiredOn:'2020-01-01',terminatedOn});
  if(departmentId)await owner.db.insert(assignment).values({tenantId:b.tenantId,employmentId:id,companyId,departmentId,employmentType:'full_time',validFrom:'2020-01-01'});
 }
 return {b,ctx,ids,secondCompany};
}
it('narrows rows, counts, facets, selected and complete IDs to the same trusted live population',async()=>{
 const {b,ctx,ids,secondCompany}=await population();
 await withTenant(ctx,async tx=>{
  const input={companyIds:[],terminatedAfter:cutoff};
  const page=await readEmployeeChoicesTx(tx,ctx,{...input,selectedId:ids[1]});
  expect(page.total).toBe(3);expect(page.rows.map(row=>row.employmentId).sort()).toEqual([ids[0],ids[3],ids[4]].sort());expect(page.selected).toBeNull();
  expect(page.companyOptions.map(row=>row.id).sort()).toEqual([b.companyId,secondCompany].sort());expect(page.allDepartmentOptions).toEqual([{id:b.deptA,name:'Finance'}]);
  const [matches,matchedIds]=await Promise.all([readEmployeeChoicesTx(tx,ctx,{...input,query:'i\u0307',selectedId:ids[0]}),readEmployeeChoiceIdsTx(tx,ctx,{...input,query:'i\u0307'})]);expect(matches.rows.map(row=>row.employmentId)).toEqual([ids[3]]);expect(matches.selected?.employmentId).toBe(ids[0]);
  expect(matchedIds).toEqual([ids[3]]);
  const restricted=await readEmployeeChoicesTx(tx,ctx,{...input,employmentIds:[ids[1],ids[3]],selectedId:ids[0]});expect(restricted.rows.map(row=>row.employmentId)).toEqual([ids[3]]);expect(restricted.total).toBe(1);expect(restricted.selected).toBeNull();
  const empty=await readEmployeeChoicesTx(tx,ctx,{...input,employmentIds:[],selectedId:ids[3]});expect(empty).toMatchObject({rows:[],total:0,selected:null,companyOptions:[],allDepartmentOptions:[]});
  expect(await readEmployeeChoiceIdsTx(tx,ctx,{...input,employmentIds:[]})).toEqual([]);
 },{readOnlySnapshot:true});
 await expect(readEmployeeChoices(ctx,{companyIds:[],limit:201})).rejects.toBeInstanceOf(EmployeeChoiceInputError);
 const serverOnly={companyIds:[],terminatedAfter:cutoff};await expect(readEmployeeChoices(ctx,serverOnly)).rejects.toBeInstanceOf(EmployeeChoiceInputError);
});
it('refuses writable or foreign carriers and snapshots caller-owned context and population arrays',async()=>{
 const {b,ctx,ids}=await population();
 await expect(withTenant(ctx,tx=>readEmployeeChoicesTx(tx,ctx,{companyIds:[],employmentIds:[]}))).rejects.toThrow('calling authority');
 await expect(withTenant(ctx,tx=>readEmployeeChoiceIdsTx(tx,{...ctx,userId:randomUUID()},{companyIds:[]}),{readOnlySnapshot:true})).rejects.toThrow('calling authority');
 await withTenant(ctx,async tx=>{
  const supplied:SessionContext={...ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  const input={companyIds:[b.companyId],employmentIds:[ids[0],ids[3]],terminatedAfter:cutoff,selectedId:ids[3],labelMode:'labels' as const};
  const pending=readEmployeeChoicesTx(tx,supplied,input);
  supplied.tenantId=randomUUID();supplied.roles![0]='employee';supplied.grants![0].role='employee';input.companyIds.length=0;input.employmentIds.length=0;input.terminatedAfter='2099-01-01';input.selectedId=ids[1];
  const page=await pending;expect(page.total).toBe(2);expect(page.rows.map(row=>row.employmentId).sort()).toEqual([ids[0],ids[3]].sort());expect(page.selected?.employmentId).toBe(ids[3]);expect(page.companyOptions).toEqual([{id:b.companyId,name:'Acme Sdn Bhd'}]);
  await expect(readEmployeeChoicesTx(tx,ctx,{companyIds:[],terminatedAfter:'2026-02-30'})).rejects.toBeInstanceOf(EmployeeChoiceInputError);
 },{readOnlySnapshot:true});
});
it('keeps choices, complete IDs and native source facts in one snapshot across a committed update',async()=>{
 const {ctx,ids}=await population(),input={companyIds:[],terminatedAfter:cutoff};
 await withTenant(ctx,async tx=>{
  const before=await readEmployeeChoicesTx(tx,ctx,input);expect(before.rows.map(row=>row.employmentId)).toContain(ids[0]);
  await owner.db.update(employment).set({terminatedOn:'2026-11-06'}).where(eq(employment.id,ids[0]));
  const [fact]=await tx.execute<{terminated:string|null}>(sql`select terminated_on::text as terminated from employment where id=${ids[0]}::uuid`);expect(fact).toEqual({terminated:null});
  expect(await readEmployeeChoiceIdsTx(tx,ctx,input)).toContain(ids[0]);
 },{readOnlySnapshot:true});
 const after=await withTenant(ctx,tx=>readEmployeeChoiceIdsTx(tx,ctx,input),{readOnlySnapshot:true});expect(after).not.toContain(ids[0]);expect(after.sort()).toEqual([ids[3],ids[4]].sort());
});
it('projects All once up to 2000 and resolves complete IDs beyond that stated display ceiling',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24),count=ALL_ROW_CEILING+51;
 await owner.client.begin(async tx=>{
  await tx`insert into person(id,tenant_id,full_name,primary_email) select (${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional All '||lpad(n::text,5,'0'),(${personPrefix}||n::text)||'@example.invalid' from generate_series(1,${count})n`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,hired_on) select (${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,'2020-01-01'::date from generate_series(1,${count})n`;
 });
 await withTenant(ctx,async tx=>{
  const page=await readEmployeeChoicesTx(tx,ctx,{companyIds:[b.companyId],terminatedAfter:cutoff,limit:ALL_ROW_CEILING});
  expect(page.total).toBe(count);expect(page.rows).toHaveLength(ALL_ROW_CEILING);expect(page.rows[0].employmentId).toBe(employmentPrefix+'000000000001');expect(page.rows.at(-1)?.employmentId).toBe(employmentPrefix+String(ALL_ROW_CEILING).padStart(12,'0'));
  const ids=await readEmployeeChoiceIdsTx(tx,ctx,{companyIds:[b.companyId],terminatedAfter:cutoff});expect(ids).toHaveLength(count);expect(ids.at(-1)).toBe(employmentPrefix+String(count).padStart(12,'0'));
  await expect(readEmployeeChoicesTx(tx,ctx,{companyIds:[],limit:ALL_ROW_CEILING+1})).rejects.toBeInstanceOf(EmployeeChoiceInputError);
 },{readOnlySnapshot:true});
},60000);
