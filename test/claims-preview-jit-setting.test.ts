/** Actual bounded Claims metadata must not pay OLTP JIT compilation or alter later transactions. */
import {randomUUID} from 'node:crypto';
import {PgDialect} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {claimRequest} from '../db/schema';
import {hireEmployee} from '../core/org';
import {createClaimType,pendingClaimTaskSummary} from '../packs/claims/service';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('uses transaction-local JIT off for real pending metadata and restores the application default',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const subject=await hireEmployee(ctx,{person:{fullName:'Fictional JIT preview',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const type=await createClaimType(ctx,{code:'JIT_PREVIEW',name:'Fictional JIT preview',requiresReceipt:false,defaultTaxable:false});
 const ids=Array.from({length:31},()=>randomUUID()).sort();
 await owner.db.insert(claimRequest).values(ids.map(id=>({id,tenantId:b.tenantId,employmentId:subject.employmentId,claimTypeId:type.id,amount:'1.00',incurredOn:'2026-01-01',status:'pending' as const,createdAt:new Date('2026-01-02T00:00:00Z')})));
 const actual=database.withTenant,[before]=await actual(ctx,tx=>tx.execute<{jit:string}>(sql`select current_setting('jit')as jit`));
 const states:{jit:string;readOnly:boolean;isolation:string;role:string}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>actual(context,async tx=>{
  // Controlled incoming transaction state, not a global database configuration change.
  await tx.execute(sql`set local jit=on`);
  return read(new Proxy(tx,{get(target,property,receiver){const value=Reflect.get(target,property,receiver);
   if(property==='execute')return async(query:Parameters<Tx['execute']>[0])=>{
    if((typeof query==='string'?query:new PgDialect().sqlToQuery(query.getSQL()).sql).includes('candidate_subjects as materialized')){
     const [state]=await tx.execute<{jit:string;readOnly:boolean;isolation:string;role:string}>(sql`select current_setting('jit')as jit,current_setting('transaction_read_only')='on'as "readOnly",current_setting('transaction_isolation')as isolation,current_user as role`);states.push(state);
    }
    return Reflect.apply(value,target,[query]);
   };
   return typeof value==='function'?value.bind(target):value;
  }}));
 },options));
 try{
  const result=await pendingClaimTaskSummary(ctx,[b.companyId]);expect(result.total).toBe(31);expect(result.items.map(row=>row.id)).toEqual(ids.slice(0,25));
  expect(states.length).toBeGreaterThan(0);expect(states).toEqual(states.map(()=>({jit:'off',readOnly:true,isolation:'repeatable read',role:'ai_hr_app'})));
 }finally{spy.mockRestore();}
 const [after]=await actual(ctx,tx=>tx.execute<{jit:string}>(sql`select current_setting('jit')as jit`));expect(after).toEqual(before);
});
