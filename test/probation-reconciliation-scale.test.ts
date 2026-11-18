/** New discrepancy reader at real-group shape: 71 companies and 1,000 employments, SQL paging/order/count,
 * module-role scope, and independent source expectations. Existing tracker parity is checked separately. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';
import {probationPersonnelDiscrepancies} from '../packs/probation/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
let fixture:ScaleFixture;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();const base=await seedBase();await setModule(base.tenantId,'lifecycle','active');fixture=await buildScaleFixture(base,{employments:1000,events:0});
 const grade=randomUUID();await owner.db.execute(sql`insert into job_grade(id,tenant_id,code,name) values(${grade}::uuid,${base.tenantId}::uuid,'JG17','Fictional scale seventeen')`);
 await owner.db.execute(sql`update employment set grade_id=${grade}::uuid,probation_value=6,probation_unit='month',probation_months=6,probation_end_date=${addDaysIso(todayInKualaLumpur(),150)}::date where tenant_id=${base.tenantId}::uuid and employee_code like 'FX-%'`);
 // Discrepancy permissions are their own facts, not inferred from Workforce HR grants.
 const role=randomUUID(),admin=adminCtx(base);
 await owner.db.execute(sql`insert into probation_access_role(id,tenant_id,name,permissions,created_by,updated_by) values(${role}::uuid,${base.tenantId}::uuid,'Fictional reconciliation viewer',array['cases.view'],${admin.userId}::uuid,${admin.userId}::uuid)`);
 for(const[name,ctx]of Object.entries(fixture.personas)){
  if(name==='multi')await owner.db.execute(sql`insert into probation_access_member(tenant_id,role_id,user_id,company_id,valid_from,created_by) select ${base.tenantId}::uuid,${role}::uuid,${ctx.userId}::uuid,c.id,'2020-01-01',${admin.userId}::uuid from company c where c.tenant_id=${base.tenantId}::uuid`);
  else await owner.db.execute(sql`insert into probation_access_member(tenant_id,role_id,user_id,company_id,valid_from,created_by) values(${base.tenantId}::uuid,${role}::uuid,${ctx.userId}::uuid,${name==='single'?fixture.singleCompanyId:null}::uuid,'2020-01-01',${admin.userId}::uuid)`);
 }
},300_000);
afterAll(closeAll);
describe('SQL-paged Personnel discrepancies at group scale',()=>{
 it('returns exactly the independent expected population, ordered and counted, under all/single company for every persona',async()=>{
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);expect(fixture.employmentIds).toHaveLength(1000);
  for(const[name,ctx]of Object.entries(fixture.personas))for(const companyId of [undefined,fixture.singleCompanyId]){
   const company=name==='single'?fixture.singleCompanyId:companyId;
   const expected=await owner.db.execute<{id:string}>(sql`select e.id from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id where e.tenant_id=${ctx.tenantId}::uuid and e.employee_code like 'FX-%' and e.terminated_on is null ${company?sql`and e.company_id=${company}::uuid`:sql``} order by p.full_name,e.employee_code,e.id`);
   expect(expected.length,name+': nonempty independent source').toBeGreaterThan(0);
   const actual:string[]=[];
   for(let offset=0;offset<expected.length;offset+=100){
    const observed=await observeStatements(()=>probationPersonnelDiscrepancies(ctx,{companyId,offset,limit:100}));
    expect(observed.result.total,name).toBe(expected.length);actual.push(...observed.result.rows.map(r=>r.employmentId));
    expect(observed.statements.filter(s=>s.sql.includes('app.probation_reconciliation_view'))).toHaveLength(1);
    for(const row of observed.result.rows){expect(row.grade).toBe('17');expect(row.reasons).toEqual(['settings','form','route','activation','assignment']);}
   }
   expect(actual,name+': exact row/order/count parity').toEqual(expected.map(e=>e.id));
  }
 },120_000); // More than 1,000 row-secured sources over 71 companies; hosted group-read budget.
});
