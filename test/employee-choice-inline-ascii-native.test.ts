/** Actual product imports, native RLS/order/count/window, frozen pre-change
 * reader and independent Node expectations. No latency or release acceptance. */
import {randomUUID} from 'node:crypto';
import {eq,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {readEmployeeChoices,readEmployeeChoicesTx,readEmployeeChoiceIdsTx,type EmployeeChoiceServerInput} from '../core/employee-choice';
import {employeeChoiceExactAsciiPredicate} from '../core/employee-choice-ascii';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {assignment,businessUnit,department,employment,person,reportingLine,roleAssignment} from '../db/schema';
import type {EmployeeChoicePage} from '../lib/employee-choice';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as frozen from './performance/employee-choice-native-current-baseline';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const stable=({contextId:_context,...page}:EmployeeChoicePage)=>page;
const nativeAscii=(query:string)=>expect(employeeChoiceExactAsciiPredicate(sql`null::text`,sql`null::text`,query)).toBeDefined();
async function members(b:Base,names:string[]){
 const rows=names.map((name,i)=>({employmentId:randomUUID(),personId:randomUUID(),name,code:i%7===0?null:'Fictional-code-'+i}));
 for(let start=0;start<rows.length;start+=500){const chunk=rows.slice(start,start+500);
  await owner.db.insert(person).values(chunk.map(row=>({id:row.personId,tenantId:b.tenantId,fullName:row.name,primaryEmail:row.personId+'@example.invalid'})));
  await owner.db.insert(employment).values(chunk.map((row,i)=>({id:row.employmentId,tenantId:b.tenantId,personId:row.personId,companyId:b.companyId,
   employeeCode:row.code,hiredOn:'2020-01-01',terminatedOn:start+i===1?'2024-01-01':start+i===2?'2099-01-01':null})));
  await owner.db.insert(assignment).values(chunk.map((row,i)=>({tenantId:b.tenantId,employmentId:row.employmentId,companyId:b.companyId,
   departmentId:(start+i)%2?b.deptB:b.deptA,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
 }
 return rows;
}
async function fixture(){const b=await seedBase();return {b,ctx:adminCtx(b),rows:await members(b,[
 'İA','KA','AÉB','AΣB','ΟΣ','Ος','Straße','STRASSE','ßſﬀ','😀A\u0307B','Percent %_\\ and quote\'','Control \u0001 DEL \u007f',
 'Duplicate ASCII','Duplicate ASCII',...Array.from({length:40},(_,i)=>'É fictional ASCII '+String(i).padStart(3,'0'))])};}
async function parity(ctx:SessionContext,input:EmployeeChoiceServerInput){
 const expected=await database.withTenant(ctx,tx=>frozen.readEmployeeChoicesTx(tx,ctx,input),{readOnlySnapshot:true});
 const actual=await database.withTenant(ctx,tx=>readEmployeeChoicesTx(tx,ctx,input),{readOnlySnapshot:true});
 expect(stable(actual)).toEqual(stable(expected));return actual;
}
type Query={sql:string;rows:number};
/** Observe the actual borrowed native transaction; no pool, identity or test
 * authority is substituted, and every started execute is awaited by its caller. */
async function observe<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>){
 const queries:Query[]=[],dialect=new PgDialect();
 return database.withTenant(ctx,async tx=>{
  const [facts]=await tx.execute<{role:string;isolation:string;readonly:string;jit:string;pid:number}>(sql`select current_user::text as role,
   current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as readonly,current_setting('jit') as jit,pg_backend_pid() as pid`);
  // Every tenant transaction starts with JIT off (db/client.ts bootstrapTenantTx, test/with-tenant-jit-off.test.ts).
  expect(facts).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readonly:'on',jit:'off'});expect(facts.pid).toBeGreaterThan(0);
  const observed=new Proxy(tx,{get(target,key,receiver){
   if(key==='execute')return async(query:SQL)=>{expect(queries.length).toBeLessThan(64);const rows=await target.execute(query);queries.push({sql:dialect.sqlToQuery(query).sql,rows:rows.length});return rows;};
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }});
  return {result:await read(observed),queries,facts};
 },{readOnlySnapshot:true});
}
const hasCursor=(queries:Query[])=>queries.some(row=>/^declare |^fetch /i.test(row.sql));

it('uses the actual inline product predicate with exact Node Unicode/literal matches and native duplicate-name UUID order',async()=>{
 const {b,ctx,rows}=await fixture();nativeAscii('ascii');
 const ordered=await owner.client<{employmentId:string;name:string;code:string|null}[]>`select e.id as "employmentId",p.full_name as name,e.employee_code as code
  from employment e join person p on p.id=e.person_id where e.tenant_id=${b.tenantId}::uuid order by p.full_name,e.id`;
 for(const raw of ['ASCII','i','ia','ka','K','strasse','%','_','\\',"'",'\u0001','\u007f','not present']){
  const q=raw.trim().toLowerCase(),expected=ordered.filter(row=>row.name.toLowerCase().includes(q)||(row.code??'').toLowerCase().includes(q));
  const input={companyIds:[b.companyId],query:raw,limit:25,selectedId:rows[4].employmentId};
  const actual=await parity(ctx,input);expect(actual.total,raw).toBe(expected.length);expect(actual.rows.map(row=>row.employmentId),raw).toEqual(expected.slice(0,25).map(row=>row.employmentId));
  const probe=await observe(ctx,tx=>readEmployeeChoicesTx(tx,ctx,input));expect(stable(probe.result)).toEqual(stable(actual));expect(hasCursor(probe.queries),raw).toBe(false);
  expect(probe.queries.some(row=>row.sql.includes('position(')&&row.sql.includes('convert_to(')),raw).toBe(true);
 }
 const nullCode=rows[0];expect(nullCode.code).toBeNull();expect((await parity(ctx,{companyIds:[],query:'i',limit:200})).rows.map(row=>row.employmentId)).toContain(nullCode.employmentId);
},120000);

it('preserves both native page branches, independent selection/facets, organisation labels and out-of-range exact totals',async()=>{
 const {b,ctx,rows}=await fixture(),unit=randomUUID();
 await owner.db.insert(businessUnit).values({id:unit,tenantId:b.tenantId,companyId:b.companyId,code:'OPS',name:'Operations',label:'Display Operations'});
 await owner.db.update(assignment).set({businessUnitId:unit}).where(eq(assignment.employmentId,rows[14].employmentId));
 await owner.db.update(department).set({label:'Display Finance'}).where(eq(department.id,b.deptA));
 await owner.db.delete(assignment).where(eq(assignment.employmentId,rows[15].employmentId));
 for(const filters of [{},{departmentId:b.deptA},{departmentId:b.deptB},{businessUnitId:unit},{status:'ended' as const},{status:'active' as const},{companyId:b.companyId}]){
  for(const offset of [0,25,1000]){
   const input={companyIds:[b.companyId],query:'ascii',labelMode:'labels' as const,selectedId:rows[0].employmentId,offset,limit:25,...filters};
   const actual=await parity(ctx,input),probe=await observe(ctx,tx=>readEmployeeChoicesTx(tx,ctx,input));
   expect(stable(probe.result)).toEqual(stable(actual));expect(hasCursor(probe.queries)).toBe(false);expect(actual.selected?.employmentId).toBe(rows[0].employmentId);
   expect(actual.allDepartmentOptions.map(row=>row.id).sort()).toEqual([b.deptA,b.deptB].sort());
   if(offset===1000){expect(actual.rows).toEqual([]);expect(probe.queries.some(row=>row.sql.startsWith('select count(*)::int as total')&&row.sql.includes('position('))).toBe(true);}
  }
 }
 const publicPage=await readEmployeeChoices(ctx,{companyIds:[],query:'ascii',limit:200});expect(publicPage.rows.length).toBeGreaterThan(25);
 await expect(readEmployeeChoices(ctx,{companyIds:[],query:'ascii',limit:2000})).rejects.toThrow('Invalid employee page');
},120000);

it('bounds the shared server page at2000 while retaining all matching IDs and exact server populations and effect dates',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),rows=await members(b,Array.from({length:2005},(_,i)=>'É native ASCII '+String(i).padStart(5,'0')));
 nativeAscii('ascii');const selected=rows.at(-1)!.employmentId,input={companyIds:[b.companyId],query:'ascii',limit:2000,selectedId:selected};
 const all=await parity(ctx,input),probe=await observe(ctx,tx=>readEmployeeChoicesTx(tx,ctx,input));
 expect(stable(probe.result)).toEqual(stable(all));expect(all.total).toBe(2005);expect(all.rows).toHaveLength(2000);expect(all.selected?.employmentId).toBe(selected);
 expect(hasCursor(probe.queries)).toBe(false);expect(probe.queries.filter(row=>row.sql.includes('employee_choice_page as materialized')).map(row=>row.rows)).toEqual([2000]);
 const complete=await observe(ctx,tx=>readEmployeeChoiceIdsTx(tx,ctx,{companyIds:[b.companyId],query:'ascii'}));
 expect(complete.result).toHaveLength(2005);expect(new Set(complete.result)).toEqual(new Set(rows.map(row=>row.employmentId)));
 expect(complete.result).toEqual(await database.withTenant(ctx,tx=>frozen.readEmployeeChoiceIdsTx(tx,ctx,{companyIds:[b.companyId],query:'ascii'}),{readOnlySnapshot:true}));
 expect(complete.result.slice(0,2000)).toEqual(all.rows.map(row=>row.employmentId));expect(hasCursor(complete.queries)).toBe(true);
 for(const request of [{...input,offset:2000},{...input,offset:Number.MAX_SAFE_INTEGER},{...input,employmentIds:[]},
  {...input,employmentIds:[rows[3].employmentId,rows[0].employmentId,rows[3].employmentId]},{...input,terminatedAfter:'2026-01-01'},
  {...input,terminatedAfter:'9999-12-31'},{...input,terminatedAfter:'0001-01-01'}])await parity(ctx,request);
 const cutoff=await parity(ctx,{...input,terminatedAfter:'2026-01-01'});expect(cutoff.total).toBe(2004);expect(cutoff.rows.map(row=>row.employmentId)).not.toContain(rows[1].employmentId);expect(cutoff.rows.map(row=>row.employmentId)).toContain(rows[2].employmentId);
 await expect(database.withTenant(ctx,tx=>readEmployeeChoicesTx(tx,ctx,{...input,limit:2001}),{readOnlySnapshot:true})).rejects.toThrow('Invalid employee page');
},120000);

it('keeps the original JS fallback for non-ASCII, NUL, lone-surrogate and unqualified external ICU configuration',async()=>{
 const {b,ctx}=await fixture();
 for(const query of ['i\u0307','ς','σ','😀','\ud83d','x\0y']){
  const input={companyIds:[b.companyId],query,limit:200};const expected=await parity(ctx,input),probe=await observe(ctx,tx=>readEmployeeChoicesTx(tx,ctx,input));
  expect(stable(probe.result)).toEqual(stable(expected));expect(hasCursor(probe.queries)).toBe(true);expect(probe.queries.some(row=>row.sql.includes('position('))).toBe(false);
 }
 const saved=process.env.NODE_ICU_DATA;
 try{
  process.env.NODE_ICU_DATA='unqualified-fictional-data-configuration';expect(employeeChoiceExactAsciiPredicate(sql`null::text`,sql`null::text`,'ascii')).toBeUndefined();
  const input={companyIds:[b.companyId],query:'ascii',limit:25};const expected=await parity(ctx,input),probe=await observe(ctx,tx=>readEmployeeChoicesTx(tx,ctx,input));
  expect(stable(probe.result)).toEqual(stable(expected));expect(hasCursor(probe.queries)).toBe(true);
 }finally{if(saved===undefined)delete process.env.NODE_ICU_DATA;else process.env.NODE_ICU_DATA=saved;}
 nativeAscii('ascii');await parity(ctx,{companyIds:[b.companyId],query:' \t\n',limit:25});
},120000);

it('retains native RLS behind a held Access writer and fresh role revocation before search SQL',async()=>{
 const {b,ctx,rows}=await fixture(),foreign=await seedBase(),outside=await members(foreign,['Foreign ASCII']);
 const [before]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${b.tenantId}::uuid`;
 await owner.client.begin(async writer=>{
  await writer`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  const page=await observe(ctx,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);
   return readEmployeeChoicesTx(tx,ctx,{companyIds:[b.companyId],query:'ascii'});
  });
  expect(page.result.total).toBe(42);expect(hasCursor(page.queries)).toBe(false);
 });
 const [after]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${b.tenantId}::uuid`;expect(after).toEqual(before);
 expect((await parity(ctx,{companyIds:[foreign.companyId],query:'ascii',selectedId:rows[0].employmentId})).total).toBe(0);
 expect((await parity(ctx,{companyIds:[],query:'ascii',selectedId:outside[0].employmentId})).selected).toBeNull();
 const userId=await createAppUser(b.tenantId,rows[14].personId,'employee');
 const employee:SessionContext={tenantId:b.tenantId,userId,personId:rows[14].personId,roles:['employee']};
 const own=await parity(employee,{companyIds:[],query:'ascii',limit:200});expect(own.rows.map(row=>row.employmentId)).toEqual([rows[14].employmentId]);
 await expect(readEmployeeChoices(employee,{companyIds:[],query:'ascii',labelMode:'labels'})).rejects.toThrow('administration access');
 const managerUser=await createAppUser(b.tenantId,rows[16].personId,'manager');
 await owner.db.insert(reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:rows[14].employmentId,managerEmploymentId:rows[16].employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const manager:SessionContext={tenantId:b.tenantId,userId:managerUser,personId:rows[16].personId,roles:['manager']};
 const managed=await parity(manager,{companyIds:[],query:'ascii',limit:200});expect(managed.rows.map(row=>row.employmentId)).toContain(rows[14].employmentId);
 await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,b.adminUserId));
 const scoped:SessionContext={...ctx,grants:[{role:'hr_admin',companyId:b.companyId}]};expect((await parity(scoped,{companyIds:[],query:'ascii'})).total).toBeGreaterThan(0);
 expect((await parity(scoped,{companyIds:[foreign.companyId],query:'ascii'})).total).toBe(0);
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,userId));
 await expect(readEmployeeChoices(employee,{companyIds:[],query:'ascii'})).rejects.toThrow('calling authority');
 await expect(readEmployeeChoices({...scoped,personId:randomUUID()},{companyIds:[],query:'ascii'})).rejects.toThrow('calling authority');
 await expect(database.withTenant(scoped,tx=>readEmployeeChoicesTx(tx,scoped,{companyIds:[],query:'ascii'}))).rejects.toThrow('calling authority');
},120000);
