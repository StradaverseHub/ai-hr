/** UNRUN native successor controls. Ordinary standard-hosted DB route only;
 * no timing qualification, singleton manifest imitation or production install. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import * as current from '../core/employee-choice';
import * as classic from './performance/employee-choice-native-purpose-reader';
import * as bounded from './performance/employee-choice-bounded-search-reader';
import {employeeChoiceNativePrototypeOwner,type EmployeeChoiceNativeInstallation} from './performance/employee-choice-native-purpose-owner-factory';
import {createAssignmentAuthorityFixture} from './performance/employee-choice-assignment-authority';
import {withTenant,type Tx} from '../db/client';
import {appUser,roleAssignment} from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
const custodies:EmployeeChoiceNativeInstallation[]=[];
let installation:EmployeeChoiceNativeInstallation|undefined,b:Base;
beforeAll(async()=>{
 await migrateTestDb();
 installation=await employeeChoiceNativePrototypeOwner(()=>owner.client).install(value=>{custodies.push(value);});
},300000);
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(async()=>{
 const failures:unknown[]=[];
 for(const value of [...custodies].reverse())try{await value.remove();await value.restoration();}catch(error){failures.push(error);}
 try{await closeAll();}catch(error){failures.push(error);}
 if(failures.length)throw new AggregateError(failures,'Bounded search native restoration refused');
});
const stable=({contextId:_contextId,...page}:Awaited<ReturnType<typeof current.readEmployeeChoices>>)=>page;
const actor=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
type Facts={employmentId:string;name:string;employeeCode:string|null};
type Spec={name:string;code?:string|null;personId?:string;terminatedOn?:string|null;assigned?:boolean};
async function seed(specs:Spec[]){
 const rows:Facts[]=[];
 await owner.client.begin(async tx=>{
  const people=new Set<string>();
  for(const spec of specs){
   const personId=spec.personId??randomUUID(),employmentId=randomUUID();
   if(!people.has(personId)){people.add(personId);await tx`insert into person(id,tenant_id,full_name,primary_email) values(${personId}::uuid,${b.tenantId}::uuid,${spec.name},${personId+'@example.invalid'})`;}
   await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on) values(${employmentId}::uuid,${b.tenantId}::uuid,${personId}::uuid,${b.companyId}::uuid,${spec.code??null},'2020-01-01'::date,${spec.terminatedOn??null}::date)`;
   if(spec.assigned!==false)await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,valid_from,employment_type) values(${b.tenantId}::uuid,${employmentId}::uuid,${b.companyId}::uuid,${b.deptA}::uuid,'2020-01-01'::date,'full_time')`;
   rows.push({employmentId,name:spec.name,employeeCode:spec.code??null});
  }
 });
 return rows;
}
/** Independent order oracle: actual base-column collation and UUID tuple order,
 * followed by the original ECMAScript predicate. No successor SQL/helper reuse. */
async function expected(raw:string){
 const rows=await owner.client<Facts[]>`select e.id as "employmentId",p.full_name as name,e.employee_code as "employeeCode" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id where e.tenant_id=${b.tenantId}::uuid and e.company_id=${b.companyId}::uuid order by p.full_name,e.id`;
 const q=raw.trim().toLowerCase();return rows.filter(row=>row.name.toLowerCase().includes(q)||(row.employeeCode??'').toLowerCase().includes(q));
}
const dialect=new PgDialect();
type Statement=ReturnType<typeof dialect.sqlToQuery>;
function observed(tx:Tx,statements:Statement[]):Tx{
 return new Proxy(tx,{get(target,key,receiver){
  if(key==='execute')return(query:SQL)=>{statements.push(dialect.sqlToQuery(query));return target.execute(query);};
  return Reflect.get(target,key,receiver);
 }});
}
function projectionIds(statements:Statement[]){
 return statements.filter(value=>value.sql.includes('/* employee-choice-native:project */')).map(value=>{
  expect(value.params).toHaveLength(20);expect(value.params[15]).toBe(0);expect(value.params[12]).toBe('none');expect(value.params[13]).toBeNull();
  const ids=value.params[19];expect(typeof ids).toBe('string');return (ids as string).slice(1,-1).split(',');
 });
}

it('retains native base-column collation/UUID ties and exact Unicode, null-code and literal needle semantics',async()=>{
 const personId=randomUUID();
 await seed([
  {name:'Same duplicate',personId},{name:'Same duplicate',personId},{name:'same duplicate'},
  {name:'AİB'},{name:'AKB'},{name:'AΣB'},{name:'AΣ'},{name:'AςB'},{name:'AßſﬀB'},
  {name:'😀A\u0307B'},{name:'AÉB'},{name:'A\u0301B'},{name:'人員 literal'},{name:'literal %_\\ marker'},
  {name:'ASCII control \u0001 \u007f'},{name:'Code-only match',code:'İK-%_\\'},
  {name:'Z null code',code:null,assigned:false},{name:'Å order'},{name:'A order'},{name:'a order'},{name:'É order'},
 ]);
 const rawQueries=['',' ','same','İ','i\u0307','K','k','Σ','ς','σ','ß','ss','ſ','ﬀ','😀','\u0307','É','é','A\u0301','人員','%','_','\\','%_\\','\u0001','\u007f','x\0y','\ud800','missing'];
 for(const query of rawQueries){
  const oracle=await expected(query),input={companyIds:[b.companyId],query,limit:7,offset:1};
  const original=await current.readEmployeeChoices(actor(),input),legacy=await classic.readEmployeeChoices(actor(),input),actual=await bounded.readEmployeeChoices(actor(),input);
  expect(stable(actual)).toEqual(stable(original));expect(stable(actual)).toEqual(stable(legacy));
  expect(actual.total).toBe(oracle.length);expect(actual.rows.map(row=>row.employmentId)).toEqual(oracle.slice(1,8).map(row=>row.employmentId));
  expect(actual.filters.query).toBe(query);
 }
 // Independent native catalogue check rules out a name-column/return-type
 // collation mismatch hidden by this particular fixture's sort coincidences.
 const [collation]=await owner.client`select a.attcollation=(select t.typcollation from pg_type t where t.oid='text'::regtype) as same from pg_attribute a where a.attrelid='person'::regclass and a.attname='full_name'`;
 expect(collation.same).toBe(true);await installation!.unchanged();
},120000);

it('retains exact totals across every page boundary while sending only25 or2000 ordered match IDs to native projection',async()=>{
 const count=2105;
 await owner.client.begin(async tx=>{
  const personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);
  await tx`insert into person(id,tenant_id,full_name,primary_email) select (${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional bounded same '||lpad((n/3)::text,5,'0'),(${personPrefix}||lpad(n::text,12,'0'))||'@example.invalid' from generate_series(1,${count}::int)n`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,hired_on) select (${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,'2020-01-01'::date from generate_series(1,${count}::int)n`;
 });
 const oracle=await expected('fictional bounded');expect(oracle).toHaveLength(count);
 const ranges:readonly[number,number][]=[[0,25],[1,25],[1040,25],[2080,25],[2104,25],[2105,25],[Number.MAX_SAFE_INTEGER,25],[0,2000],[105,2000],[2104,2000]];
 for(const [offset,limit]of ranges){
  const statements:Statement[]=[],input={companyIds:[b.companyId],query:'fictional bounded',offset,limit,selectedId:oracle[0].employmentId};
  await withTenant(actor(),async tx=>{
   const [before]=await tx.execute(sql`select pg_backend_pid()as pid,txid_current_snapshot()::text as snapshot,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as mode`);
   const actual=await bounded.readEmployeeChoicesTx(observed(tx,statements),actor(),input);
   const legacy=await classic.readEmployeeChoicesTx(tx,actor(),input),original=await current.readEmployeeChoicesTx(tx,actor(),input);
   expect(stable(actual)).toEqual(stable(legacy));expect(stable(actual)).toEqual(stable(original));
   const page=oracle.slice(offset,offset+limit).map(row=>row.employmentId);expect(actual.rows.map(row=>row.employmentId)).toEqual(page);expect(actual.total).toBe(count);
   expect(projectionIds(statements)).toEqual(page.length?[page]:[]);expect(page.length).toBeLessThanOrEqual(limit);
   expect(statements.find(value=>value.sql.startsWith('declare '))?.sql).toContain('order by f.phase');
   expect((await tx.execute(sql`select pg_backend_pid()as pid,txid_current_snapshot()::text as snapshot,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as mode`))[0]).toEqual(before);
   expect(before).toMatchObject({isolation:'repeatable read',mode:'on'});
  },{readOnlySnapshot:true});
 }
 await installation!.unchanged();
},120000);

it('rechecks current actor/company/tenant/revocation and effective population with the original authority owners',async()=>{
 const f=await createAssignmentAuthorityFixture();
 const cases=[
  {ctx:f.ctx,input:{companyIds:[f.b.companyId],query:'fictional',departmentId:f.b.deptA,businessUnitId:f.unit,selectedId:f.unassigned.id}},
  {ctx:f.employeeCtx,input:{companyIds:[],query:'fictional',selectedId:f.gamma.id}},
  {ctx:f.managerCtx,input:{companyIds:[f.b.companyId],query:'fictional'}},
  {ctx:f.scopedCtx,input:{companyIds:[f.otherCompany],query:'fictional',selectedId:f.transferred.id}},
  {ctx:adminCtx(f.foreign),input:{companyIds:[f.b.companyId],query:'fictional'}},
  {ctx:f.noAccessCtx,input:{companyIds:[f.b.companyId],query:'fictional'}},
  ...f.partners.map(ctx=>({ctx,input:{companyIds:[f.otherCompany],query:'fictional',selectedId:f.transferred.id}})),
 ];
 for(const {ctx,input}of cases)expect(stable(await bounded.readEmployeeChoices(ctx,input))).toEqual(stable(await current.readEmployeeChoices(ctx,input)));
 await withTenant(f.ctx,async tx=>{
  for(const population of [{employmentIds:[]},{employmentIds:[f.alpha.id,f.gamma.id,f.alpha.id]},{terminatedAfter:'2020-01-01',employmentIds:[f.alpha.id]}]){
   const input={companyIds:[f.b.companyId],query:'fictional',...population,limit:2000};
   expect(stable(await bounded.readEmployeeChoicesTx(tx,f.ctx,input))).toEqual(stable(await current.readEmployeeChoicesTx(tx,f.ctx,input)));
  }
 },{readOnlySnapshot:true});
 await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,f.employeeUser));
 try{await expect(bounded.readEmployeeChoices(f.employeeCtx,{companyIds:[],query:'fictional'})).rejects.toThrow('calling authority');}
 finally{await owner.db.update(appUser).set({archivedAt:null}).where(eq(appUser.id,f.employeeUser));}
 const grants=await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,f.employeeUser)).returning();expect(grants.length).toBeGreaterThan(0);
 try{await expect(bounded.readEmployeeChoices(f.employeeCtx,{companyIds:[],query:'fictional'})).rejects.toThrow('calling authority');}
 finally{await owner.db.insert(roleAssignment).values(grants);}
 expect((await bounded.readEmployeeChoices(f.employeeCtx,{companyIds:[],query:'fictional'})).rows.map(row=>row.employmentId)).toEqual([f.alpha.id]);
 await installation!.unchanged();
},120000);

it('keeps complete-ID enumeration above2000 exact and unbounded with Unicode matching and duplicate names',async()=>{
 const count=2105,personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);
 await owner.client.begin(async tx=>{
  await tx`insert into person(id,tenant_id,full_name,primary_email) select (${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional 人員 same',(${personPrefix}||lpad(n::text,12,'0'))||'@example.invalid' from generate_series(1,${count}::int)n`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,hired_on,terminated_on) select (${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,'2020-01-01'::date,case n when 1 then '2024-01-01'::date when 2 then '2025-01-01'::date else null::date end from generate_series(1,${count}::int)n`;
 });
 await withTenant(actor(),async tx=>{
  for(const query of ['', '人員', 'fictional', 'missing', '\0']){
   const input={companyIds:[b.companyId],query},oracle=(await expected(query)).map(row=>row.employmentId);
   expect(await bounded.readEmployeeChoiceIdsTx(tx,actor(),input)).toEqual(oracle);
   expect(await bounded.readEmployeeChoiceIdsTx(tx,actor(),input)).toEqual(await classic.readEmployeeChoiceIdsTx(tx,actor(),input));
  }
  const population={companyIds:[b.companyId],query:'人員',terminatedAfter:'2024-01-01'};
  const page=await bounded.readEmployeeChoicesTx(tx,actor(),{...population,selectedId:employmentPrefix+'000000000001',limit:25});
  expect(stable(page)).toEqual(stable(await current.readEmployeeChoicesTx(tx,actor(),{...population,selectedId:employmentPrefix+'000000000001',limit:25})));
  expect(page.total).toBe(count-1);expect(page.selected).toBeNull();expect(page.rows[0].employmentId).toBe(employmentPrefix+'000000000002');
  expect(await bounded.readEmployeeChoiceIdsTx(tx,actor(),population)).toEqual(await current.readEmployeeChoiceIdsTx(tx,actor(),population));
  expect(await bounded.readEmployeeChoiceIdsTx(tx,actor(),{...population,employmentIds:[]})).toEqual([]);
  expect(await bounded.readEmployeeChoiceIdsTx(tx,actor(),{companyIds:[b.companyId],query:'人員'})).toHaveLength(count);
 },{readOnlySnapshot:true});await installation!.unchanged();
},120000);

it('retains native RRRO/current-person/label admission and public/server page validation',async()=>{
 const ctx=actor(),input={companyIds:[b.companyId],query:'fixture'};
 await expect(withTenant(ctx,tx=>bounded.readEmployeeChoicesTx(tx,ctx,input))).rejects.toThrow('calling authority');
 for(const altered of [{...ctx,userId:randomUUID()},{...ctx,tenantId:randomUUID()},{...ctx,personId:randomUUID()}])await expect(withTenant(ctx,tx=>bounded.readEmployeeChoicesTx(tx,altered,input),{readOnlySnapshot:true})).rejects.toThrow('calling authority');
 for(const invalid of [{offset:-1},{offset:1.5},{offset:Number.MAX_SAFE_INTEGER+1},{limit:0},{limit:201},{limit:1.5}])await expect(bounded.readEmployeeChoices(ctx,{...input,...invalid})).rejects.toThrow('Invalid employee page');
 for(const invalid of [{employmentIds:[]},{terminatedAfter:'2024-01-01'}])await expect(bounded.readEmployeeChoices(ctx,{...input,...invalid})).rejects.toThrow('Server population');
 const f=await createAssignmentAuthorityFixture();await expect(bounded.readEmployeeChoices(f.employeeCtx,{companyIds:[],query:'fictional',labelMode:'labels'})).rejects.toThrow('administration access');
 const cancelled=new AbortController(),reason=Error('Fixed pre-aborted lookup');cancelled.abort(reason);
 await withTenant(ctx,async tx=>{
  const statements:Statement[]=[],actual=observed(tx,statements);
  await expect(bounded.readEmployeeChoicesTx(actual,ctx,input,cancelled.signal)).rejects.toBe(reason);
  await expect(bounded.readEmployeeChoiceIdsTx(actual,ctx,input,cancelled.signal)).rejects.toBe(reason);expect(statements).toEqual([]);
 },{readOnlySnapshot:true});
 await withTenant(ctx,async tx=>{
  await expect(bounded.readEmployeeChoicesTx(tx,ctx,{...input,limit:2001})).rejects.toThrow('Invalid employee page');
  await expect(bounded.readEmployeeChoicesTx(tx,ctx,{...input,terminatedAfter:'2024-02-30'})).rejects.toThrow('Invalid population date');
 },{readOnlySnapshot:true});await installation!.unchanged();
});

it('retains empty/missing/overrun count, independent selected identity and full facets without an empty projection',async()=>{
 const rows=await seed([{name:'Fictional chosen',assigned:false},{name:'Other selected'},{name:'Fictional ended',terminatedOn:'2024-01-01'}]);
 for(const query of ['', 'missing', '\0', 'fictional'])for(const offset of [0,500]){
  const statements:Statement[]=[],input={companyIds:[b.companyId],query,offset,selectedId:rows[1].employmentId,status:'active' as const};
  await withTenant(actor(),async tx=>{
   const actual=await bounded.readEmployeeChoicesTx(observed(tx,statements),actor(),input),original=await current.readEmployeeChoicesTx(tx,actor(),input);
   expect(stable(actual)).toEqual(stable(original));expect(actual.selected?.employmentId).toBe(rows[1].employmentId);expect(actual.departmentOptions).toHaveLength(1);
   if(!query||!actual.rows.length)expect(projectionIds(statements)).toEqual([]);
  },{readOnlySnapshot:true});
 }
 await installation!.unchanged();
});
