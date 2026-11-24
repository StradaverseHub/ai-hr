/** 7260 (ADR 0181 employment-visibility addendum, step (d)): app.delegated_decision_employment_ids() is exactly
 * { s : app.can_decide_via_delegation(s) } (the 0109 predicate) for every user, and the five leave read policies ask
 * it once per statement. Fixture (fictional): a delegator with three current reports, one terminated report, one
 * report through an ended line and one through a superseded line; delegate lines that are current, expired,
 * future-dated and superseded; a delegator who is terminated; a delegate whose person has two users; a functional
 * line (not a delegation); and another tenant's delegation. Row-level equivalence of the five policies against the
 * original per-row predicate, over 24 contexts with rows in every table, is test/r395-visibility-equivalence.test.ts
 * (iii-b). */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {day} from './access-effective-company-fixture';

let b:Base,other:Base;
const users:{tenant:string;id:string}[]=[];

async function hire(t:Base,name:string,terminated:string|null=null){
 const[p]=await owner.client<{id:string}[]>`insert into person(tenant_id,full_name,primary_email) values(${t.tenantId}::uuid,${'Fictional '+name},${name+'-'+randomUUID()+'@example.test'}) returning id::text`;
 const[e]=await owner.client<{id:string}[]>`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on,terminated_on) values(${t.tenantId}::uuid,${p.id}::uuid,${t.companyId}::uuid,${'DL-'+name},'2024-01-01',${terminated}::date) returning id::text`;
 return{person:p.id,employment:e.id};
}
async function line(t:Base,manager:string,subordinate:string,type:string,extra:{from?:string;to?:string|null;superseded?:boolean}={}){
 await owner.client`insert into reporting_line(tenant_id,manager_employment_id,subordinate_employment_id,line_type,valid_from,valid_to,superseded_at)
  values(${t.tenantId}::uuid,${manager}::uuid,${subordinate}::uuid,${type},${extra.from??'2024-01-01'}::date,${extra.to??null}::date,${extra.superseded?new Date().toISOString():null}::timestamptz)`;
}
async function userFor(t:Base,person:string){
 const[u]=await owner.client<{id:string}[]>`insert into app_user(tenant_id,workos_user_id,person_id) values(${t.tenantId}::uuid,${'fixture_'+randomUUID()},${person}::uuid) returning id::text`;
 users.push({tenant:t.tenantId,id:u.id});return u.id;
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 b=await seedBase();other=await seedBase();
 const delegator=await hire(b,'delegator'),leaver=await hire(b,'leaver-delegator',day(-10));
 const reports=await Promise.all(['r1','r2','r3'].map(n=>hire(b,n)));
 const terminatedReport=await hire(b,'r-terminated',day(-5)),ended=await hire(b,'r-ended'),superseded=await hire(b,'r-superseded');
 for(const r of [...reports,terminatedReport])await line(b,delegator.employment,r.employment,'administrative');
 await line(b,delegator.employment,ended.employment,'administrative',{to:day(-1)});
 await line(b,delegator.employment,superseded.employment,'administrative',{superseded:true});
 const leaverReport=await hire(b,'leaver-report');await line(b,leaver.employment,leaverReport.employment,'administrative');
 // Delegates: current, expired, future, superseded; the leaver's delegate; a functional line; two users on one person.
 const current=await hire(b,'delegate-current'),expired=await hire(b,'delegate-expired'),future=await hire(b,'delegate-future'),
  gone=await hire(b,'delegate-superseded'),leaverDelegate=await hire(b,'delegate-of-leaver'),functional=await hire(b,'functional-manager');
 await line(b,current.employment,delegator.employment,'delegate');
 await line(b,expired.employment,delegator.employment,'delegate',{to:day(0)});
 await line(b,future.employment,delegator.employment,'delegate',{from:day(1)});
 await line(b,gone.employment,delegator.employment,'delegate',{superseded:true});
 await line(b,leaverDelegate.employment,leaver.employment,'delegate');
 await line(b,functional.employment,delegator.employment,'functional');
 for(const x of [delegator,current,expired,future,gone,leaverDelegate,functional,...reports])await userFor(b,x.person);
 await userFor(b,current.person);
 // Another tenant's delegation with the same shape.
 const od=await hire(other,'delegator'),or=await hire(other,'r1'),odel=await hire(other,'delegate-current');
 await line(other,od.employment,or.employment,'administrative');await line(other,odel.employment,od.employment,'delegate');
 await userFor(other,odel.person);
},300_000);
afterAll(closeAll);

it('equals the per-row delegation predicate for every user, and is not vacuous',async()=>{
 let nonEmpty=0;
 for(const u of users){
  const r=await owner.client.begin(async tx=>{
   await tx`select set_config('app.tenant_id',${u.tenant},true),set_config('app.user_id',${u.id},true)`;
   const[x]=await tx<{set:string[];rows:string[]}[]>`select app.delegated_decision_employment_ids()::text[] as set,
    array(select e.id::text from employment e where app.can_decide_via_delegation(e.id) order by e.id) as rows`;
   return x;
  });
  expect(r.set,u.id).toEqual(r.rows);
  if(r.set.length)nonEmpty++;
 }
 // The current delegate (two users on one person) and the other tenant's delegate decide for someone; nobody else does.
 expect(nonEmpty).toBe(3);
},300_000);

it('the five leave read policies ask it once per statement and no longer per row',async()=>{
 const rows=await owner.client<{tbl:string;qual:string}[]>`select c.relname::text as tbl,pg_get_expr(p.polqual,p.polrelid) as qual from pg_policy p join pg_class c on c.oid=p.polrelid
  where p.polname in ('leave_request_rls','leave_approval_step_rls','leave_request_date_rls','replacement_leave_request_rls','replacement_leave_request_date_rls') order by 1`;
 expect(rows.map(r=>r.tbl)).toEqual(['leave_approval_step','leave_request','leave_request_date','replacement_leave_request','replacement_leave_request_date']);
 for(const r of rows){expect(r.qual,r.tbl).toContain('delegated_decision_employment_ids');expect(r.qual,r.tbl).not.toContain('can_decide_via_delegation');}
 const[fn]=await owner.client<{app:boolean}[]>`select has_function_privilege('ai_hr_app','app.delegated_decision_employment_ids()','execute') as app`;expect(fn.app).toBe(true);
 const plan=(await withTenant(adminCtx(b),tx=>tx.execute<{'QUERY PLAN':string}>(sql`explain (costs off) select id from leave_request`))).map(r=>r['QUERY PLAN']).join('\n');
 expect(plan).toMatch(/InitPlan/);expect(plan).not.toContain('can_decide_via_delegation');
},120_000);
