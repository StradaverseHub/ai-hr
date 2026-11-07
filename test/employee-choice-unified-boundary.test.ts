/** Actual native cursor/DTO parity across the512-row transfer boundary. */
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {SQL,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import * as database from '../db/client';
import {readEmployeeChoices,readEmployeeChoiceIdsTx} from '../core/employee-choice';
import * as baseline from './performance/employee-choice-unified-baseline';
import {createFacetRepresentationFixture} from './performance/employee-choice-facet-fixture';
import {closeAll,migrateTestDb,owner,resetDb} from './harness';
beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const stable=({contextId:_contextId,...page}:Awaited<ReturnType<typeof readEmployeeChoices>>)=>page;
it('pins the exact c2 facet reader independently of the unified candidate',()=>{
 expect(createHash('sha256').update(readFileSync('test/performance/employee-choice-unified-baseline.ts')).digest('hex')).toBe('7e570d816d3ac9533de176ae85b26ed96948994ecff92554f946404cc1ec0879');
});
it('streams exact Unicode matches across batches, keeps deep/independent selection and projects only retained identities',async()=>{
 const f=await createFacetRepresentationFixture(),personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);
 await owner.client.begin(async tx=>{
  await tx`insert into person(id,tenant_id,full_name,primary_email)
   select (${personPrefix}||lpad(n::text,12,'0'))::uuid,${f.b.tenantId}::uuid,'人員 choice '||lpad(n::text,4,'0'),(${personPrefix}||n)||'@example.invalid' from generate_series(1,613)n`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on)
   select (${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${f.b.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,${f.b.companyId}::uuid,'BOUND'||lpad(n::text,4,'0'),'2020-01-01'::date from generate_series(1,613)n`;
  await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
   select ${f.b.tenantId}::uuid,(${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${f.b.companyId}::uuid,${f.b.deptA}::uuid,'full_time','2020-01-01'::date from generate_series(1,613)n`;
 });
 const native=database.withTenant,dialect=new PgDialect(),batches:number[]=[],candidateCounts:number[]=[],queryTexts:string[]=[];
 let candidates=0;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:database.SessionContext,read:(tx:database.Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(ctx,async tx=>{
  await tx.execute(sql`set local statement_timeout='20s'`);await tx.execute(sql`set local lock_timeout='300ms'`);
  return read(new Proxy(tx,{get(target,key,receiver){if(key==='execute')return async(query:SQL)=>{
   const text=dialect.sqlToQuery(query).sql;queryTexts.push(text);const result=await target.execute(query);
   if(/^fetch forward /.test(text)){batches.push(result.length);for(const row of result)if(row.kind==='candidate'){
    candidates++;expect(row.label).toBeNull();expect(row.code).toBeNull();expect(row).not.toHaveProperty('company');expect(row).not.toHaveProperty('department');
   }}
   return result;
  };const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;}}));
 },options));
 const input={companyIds:[],query:'人員',offset:590,limit:25,selectedId:f.unassigned.id,labelMode:'labels' as const};
 let actual:Awaited<ReturnType<typeof readEmployeeChoices>>;
 try{actual=await readEmployeeChoices(f.ctx,input);candidateCounts.push(candidates);}finally{spy.mockRestore();}
 expect(stable(actual!)).toEqual(stable(await baseline.readEmployeeChoices(f.ctx,input)));
 expect(actual!.total).toBe(613);expect(actual!.rows.map(row=>row.employmentId)).toEqual(Array.from({length:23},(_,i)=>employmentPrefix+String(i+591).padStart(12,'0')));
 expect(actual!.selected?.employmentId).toBe(f.unassigned.id);expect(actual!.selected?.departmentId).toBeNull();expect(candidateCounts).toEqual([613]);
 expect(batches.length).toBeGreaterThan(1);expect(batches.every(length=>length<=512)).toBe(true);
 expect(queryTexts.filter(text=>/^declare /.test(text))).toHaveLength(1);expect(queryTexts.filter(text=>/^close /.test(text))).toHaveLength(1);
 expect(queryTexts.some(text=>/^\s*select .*"employment"/s.test(text))).toBe(false);
 for(const query of ['absent','BOUND0613','人員','\0','%','_','\\']){
  const scope={...input,query,offset:0};expect(stable(await readEmployeeChoices(f.ctx,scope))).toEqual(stable(await baseline.readEmployeeChoices(f.ctx,scope)));
 }
 const out={companyIds:[],offset:619,selectedId:f.nullEmployment};
 const empty=await readEmployeeChoices(f.ctx,out);expect(empty.total).toBe(619);expect(empty.rows).toEqual([]);expect(empty.selected?.employmentId).toBe(f.nullEmployment);
 expect(stable(empty)).toEqual(stable(await baseline.readEmployeeChoices(f.ctx,out)));
 for(const reader of [readEmployeeChoiceIdsTx,baseline.readEmployeeChoiceIdsTx]){
  const ids=await database.withTenant(f.ctx,tx=>reader(tx,f.ctx,{companyIds:[],query:'人員'}),{readOnlySnapshot:true});
  expect(ids).toEqual(Array.from({length:613},(_,i)=>employmentPrefix+String(i+1).padStart(12,'0')));
 }
},60000);
