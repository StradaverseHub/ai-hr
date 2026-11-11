/** Temporary measurement probe (11 November 2026): the exclusive Access hold of one approved review creation after the
 * set-wise entry write, at 200 and 1,000 employees. It records the numbers and asserts only completion; removed once read. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import postgres from 'postgres';
import {businessUnit,jobGrade} from '../db/schema';
import {hireEmployee} from '../core/org';
import {createApprovedRewardUnit} from './rewards-setup-fixture';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
let raw:postgres.Sql;
beforeAll(async()=>{await migrateTestDb();raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:2,onnotice:()=>{}});});
beforeEach(resetDb);
afterAll(async()=>{await raw.end({timeout:5});await closeAll();});

function exclusiveSampler(tenantId:string){
 const holds=new Map<string,{first:number;last:number}>();let sampling=true;
 const loop=(async()=>{while(sampling){
  const rows=await raw<{pid:number;xact:string}[]>`select l.pid,a.xact_start::text as xact from pg_catalog.pg_locks l join pg_catalog.pg_stat_activity a on a.pid=l.pid
   cross join (select hashtextextended(${'access-configuration:'+tenantId},0) as k) target
   where l.locktype='advisory' and l.granted and l.objsubid=1 and l.mode='ExclusiveLock' and a.xact_start is not null
    and l.database=(select oid from pg_catalog.pg_database where datname=current_database())
    and l.classid::bigint=((target.k>>32)&4294967295) and l.objid::bigint=(target.k&4294967295)`;
  const now=performance.now();for(const r of rows){const id=r.pid+'|'+r.xact;const h=holds.get(id)??{first:now,last:now};h.last=now;holds.set(id,h);}
  await pause(10);
 }})();
 return async()=>{sampling=false;await loop;return Math.max(0,...[...holds.values()].map(h=>Math.round(h.last-h.first)));};
}

it.each([200,1000])('measures one approved review creation (createRewardUnitTx) with %i employees',async employees=>{
 const b=await seedBase();await setModule(b.tenantId,'rewards','active');
 const [unit]=await owner.db.insert(businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'PROBE-BU',name:'Probe Business unit'}).returning();
 const [grade]=await owner.db.insert(jobGrade).values({tenantId:b.tenantId,code:'12',name:'Probe grade 12',rank:12}).returning();
 for(let n=0;n<employees;n++)await hireEmployee(adminCtx(b),{person:{fullName:`Fictional reviewed employee ${n+1}`,primaryEmail:randomUUID()+'@example.invalid'},
  companyId:b.companyId,departmentId:b.deptA,businessUnitId:unit!.id,gradeId:grade!.id,employeeCode:'PROBE-'+(n+1),employmentType:'full_time',hiredOn:'2025-01-01'});
 const stop=exclusiveSampler(b.tenantId),started=performance.now();
 const id=await createApprovedRewardUnit(adminCtx(b),{name:'Probe annual',year:2026,companyId:b.companyId,businessUnitId:unit!.id,snapshotDate:'2026-01-01'});
 const elapsed=Math.round(performance.now()-started),maxExclusiveMs=await stop();
 const [entries]=await raw<{count:number}[]>`select count(*)::int as count from reward_entry where unit_id=${id}::uuid`;
 console.log('[rewards-long-write]',JSON.stringify({command:'createRewardUnitTx',employees,entries:entries?.count,elapsedMs:elapsed,maxExclusiveMs}));
 expect(entries?.count).toBeGreaterThan(0);
},600_000);
