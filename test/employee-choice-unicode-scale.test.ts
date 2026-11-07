/** Exact ECMAScript search must remain complete when every name is non-ASCII. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {availableParallelism,cpus,totalmem} from 'node:os';
import {sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {readEmployeeChoices} from '../core/employee-choice';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {closeAll,migrateTestDb} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
beforeAll(migrateTestDb);afterAll(closeAll);
it('measures exact full and missing searches over the real 50k Unicode population',async()=>{
 const report:Record<string,unknown>={kind:'NATIVE_UNICODE_EMPLOYEE_CHOICE_COMPONENT_ONLY',releaseEligible:false,employees:50000,namePrefix:'Fictional retained Personnel 人員 ',host:{node:process.version,logicalCpus:availableParallelism(),memoryBytes:totalmem(),cpuModels:[...new Set(cpus().map(cpu=>cpu.model))]}};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'employee-choice-unicode-50k.json'),JSON.stringify(report,null,2));};
 const {b,ctx,expectedFirst,expectedLast}=await seedPersonnelNativeFixture(50000,report,name=>{report.phase=name;save();},save,'Fictional retained Personnel 人員 ');
 report.fixtureReady=true;save();
 const statements:Record<string,unknown>[]=[],timings:Record<string,number>={};report.statements=statements;report.timings=timings;
 const actual=database.withTenant,dialect=new PgDialect();
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
  return read(new Proxy(tx,{get(target,key,receiver){
   if(key==='execute')return async(query:SQL)=>{
    const entry:Record<string,unknown>={sql:dialect.sqlToQuery(query).sql},started=performance.now();statements.push(entry);save();
    try{return await target.execute(query);}catch(error){entry.error=String(error);throw error;}finally{entry.ms=performance.now()-started;save();}
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }}));
 },options));
 try{
  let started=performance.now();const first=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'人員',selectedId:expectedLast.at(-1)});timings.firstMs=performance.now()-started;
  expect(first.total).toBe(50000);expect(first.rows.map(row=>row.employmentId)).toEqual(expectedFirst);expect(first.selected?.employmentId).toBe(expectedLast.at(-1));expect(first.rows.every(row=>row.name.includes('人員'))).toBe(true);
  started=performance.now();const deep=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'人員',offset:49975});timings.deepMs=performance.now()-started;
  expect(deep.total).toBe(50000);expect(deep.rows.map(row=>row.employmentId)).toEqual(expectedLast);
  started=performance.now();const missing=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'absent-unicode-choice',selectedId:expectedLast.at(-1)});timings.missingMs=performance.now()-started;
  expect(missing.total).toBe(0);expect(missing.rows).toEqual([]);expect(missing.selected?.employmentId).toBe(expectedLast.at(-1));
  report.maxPageRows=Math.max(first.rows.length,deep.rows.length,missing.rows.length);report.exactNativeIdsAndCounts=true;save();
 }finally{spy.mockRestore();save();}
},300000);
