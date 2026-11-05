import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {personnelListPage} from '../core/read';
import * as schema from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {installPersonnelSearchProbe,readWithPersonnelSearchProbe} from './performance/personnel-bounded-search-prototype';
beforeAll(migrateTestDb);afterAll(closeAll);
it('preserves canonical native DTOs and snapshot while bounded and overflow search branches execute',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const people=Array.from({length:50},(_,n)=>({id:randomUUID(),employmentId:randomUUID(),name:n===0?'DUPMARK':n===1?'Literal %_ marker':n===2?'Escape END%':n===3?'Backslash\\middle':'Common Needle '+n}));
 await owner.db.insert(schema.person).values(people.map(p=>({id:p.id,tenantId:b.tenantId,fullName:p.name,primaryEmail:p===people[0]?'dupmark@example.invalid':p.id+'@example.invalid'})));
 await owner.db.insert(schema.employment).values(people.map((p,n)=>({id:p.employmentId,tenantId:b.tenantId,personId:p.id,companyId:b.companyId,hiredOn:'2020-01-01',employeeCode:n===0?'DUPMARK':'CODE-'+n,blacklistedAt:n===0?'2025-01-01':null,terminatedOn:n%5===0?'2024-01-01':null})));
 await owner.db.insert(schema.assignment).values(people.map(p=>({tenantId:b.tenantId,employmentId:p.employmentId,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
 const [isolation]=await withTenant(ctx,tx=>tx.execute<{level:string}>(sql`select current_setting('transaction_isolation')as level`));expect(isolation.level).toBe('read committed');
 const probe=await installPersonnelSearchProbe(true);
 try{
  for(const q of ['DUPMARK',' \nDUPMARK\t ','\\%\\_','END\\','\\\\','not-found','Common Needle','%']){
   const filters={companyIds:[b.companyId],q},page={...filters,limit:25,offset:0};
   const reference=await personnelListPage(ctx,page,filters),actual=await readWithPersonnelSearchProbe(ctx,page,filters,probe,undefined,true);
   expect(actual.dto).toEqual(reference);
   expect(actual.usedSampleOverflow).toBe(q==='Common Needle'||q==='%');
   if(q==='DUPMARK'){expect(actual.rawHits).toBe(2);expect(actual.usedBounded).toBe(true);expect(actual.dto.total).toBe(1);}
   if(q==='Common Needle'){expect(actual.rawHits).toBe(26);expect(actual.usedBounded).toBe(false);expect(actual.dto.total).toBe(46);}
   const functionScans:Record<string,unknown>[]=[];
   const visit=(value:unknown)=>{if(Array.isArray(value))for(const item of value)visit(item);else if(value&&typeof value==='object'){const row=value as Record<string,unknown>;if(row['Function Name']==='access_workforce_list_facts')functionScans.push(row);for(const nested of Object.values(row))visit(nested);}};
   visit(actual.plans?.page);
   expect(functionScans.length).toBeGreaterThan(0);
   expect(functionScans.every(scan=>Number(scan['Actual Loops'])===(actual.usedBounded?0:1))).toBe(true);
  }
  const base={companyIds:[b.companyId],q:'DUPMARK'},independent={companyIds:[b.companyId],q:'Common Needle'};
  expect((await readWithPersonnelSearchProbe(ctx,{...base,limit:0,offset:1},independent,probe)).dto).toEqual(await personnelListPage(ctx,{...base,limit:0,offset:1},independent));
 }finally{await probe.drop();}
});
