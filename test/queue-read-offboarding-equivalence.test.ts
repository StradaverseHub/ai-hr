/** ADR 0181 live work queues addendum, step Q1 (migration 7330): the offboarding posting queue access asked once per
 * statement returns exactly what the 6302 function returns, for every actor, in every configuration state, and the
 * dispatcher serves that answer in each mode.
 *
 * Fixture: the shared 70-company, 1,000-employment group (test/access-effective-company-fixture.ts) with its actors
 * (group, subtree, leaf and second-tree administrators, a super administrator, an employee, claims narrower and wider
 * than the grant, archived and login-blocked administrators, a holder of two roles), plus offboarding postings in
 * every status across the tree, a People Ops group, a configured posting approver group, the offboarding access
 * list, an approver who is the subject of a posting, and an employee approver. The other tenant has postings of its
 * own that must never count. Fictional people. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {owner} from './harness';
import {a1,actors,b,beta,buildFixture,leaf,level2,other,root,teardownFixture,user} from './access-effective-company-fixture';

const MODES=['legacy','shadow','v2'] as const;
const setMode=async(mode:string)=>{await owner.client`select app.queue_read_set_mode('offboarding_posting_queue_access',${mode})`;};
const both=async(ctx:SessionContext)=>owner.withTenant(ctx,async tx=>{
 const [row]=await tx.execute<{legacy:boolean;v2:boolean}>(sql`select app.offboarding_posting_queue_access_legacy() as legacy,app.offboarding_posting_queue_access_v2() as v2`);
 return row;
});
const served=async(ctx:SessionContext)=>withTenant(ctx,async tx=>{
 const [row]=await tx.execute<{ok:boolean}>(sql`select app.offboarding_posting_queue_access() as ok`);
 return row.ok;
});
const everyone=()=>Object.entries(actors);

let subjectApprover:SessionContext,employeeApprover:SessionContext,postingEmployments:{id:string;companyId:string;personId:string}[];
let groups:{id:string;name:string;members:string[];limit:number}[];
async function config(state:'none'|'approver'|'people ops fallback'|'v9 groups only'){
 await owner.db.execute(sql`delete from lc_onboarding_config where tenant_id=${b.tenantId}::uuid`);
 await owner.db.execute(sql`delete from lc_v9_config where tenant_id=${b.tenantId}::uuid`);
 if(state==='none')return;
 const access={offboarding:[actors['group administrator'].userId,actors['leaf administrator'].userId,actors['login-blocked administrator'].userId,actors['archived administrator'].userId,subjectApprover.userId]};
 const v9={version:9,peopleOpsGroup:'fictional-people-ops',groups,...(state==='approver'?{offboarding:{postingApproverGroupId:'fictional-posting-approvers'}}:{})};
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify(v9)}::jsonb)`);
 await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify(state==='v9 groups only'?{access}:{groups,access})}::jsonb)`);
}

beforeAll(async()=>{
 await buildFixture();
 // Postings across the tree: the root, A1's subtree, the leaf, Beta and its child, in each status the queue counts.
 postingEmployments=await owner.client<{id:string;companyId:string;personId:string}[]>`select distinct on (company_id) id::text as id,company_id::text as "companyId",person_id::text as "personId"
  from employment where tenant_id=${b.tenantId}::uuid and company_id = any(${[root,a1,leaf,beta,level2[8],level2[20]]}::uuid[]) order by company_id,id`;
 expect(postingEmployments).toHaveLength(6);
 subjectApprover=await user('hr_admin',null,postingEmployments[0].personId);
 employeeApprover=await user('employee',null,postingEmployments[1].personId);
 actors['posting subject who approves']=subjectApprover;
 actors['employee in the approver group']=employeeApprover;
 groups=[
  {id:'fictional-people-ops',name:'Fictional People Ops',members:[actors['group administrator'].userId!,actors['leaf administrator'].userId!,actors['login-blocked administrator'].userId!,actors['archived administrator'].userId!],limit:20},
  {id:'fictional-posting-approvers',name:'Fictional posting approvers',members:[actors['subtree administrator (A1)'].userId!,subjectApprover.userId!,employeeApprover.userId!,actors['claim wider than grant'].userId!],limit:20},
  {id:'fictional-other-approvers',name:'Fictional other approvers',members:[actors['second-tree administrator (Beta)'].userId!],limit:20},
 ];
 const statuses=['pending','rejected'] as const,approverGroups=['fictional-posting-approvers','fictional-other-approvers','fictional-people-ops'];
 let n=50000;
 for(const [i,e] of postingEmployments.entries())for(const status of statuses){
  n++;const rejected=status==='rejected';
  await owner.db.execute(sql`insert into personnel_posting(tenant_id,company_id,employment_id,number,source,source_ref,event_type,proposed,approver_group_id,status,idempotency_key,rejected_by,rejected_at,rejection_reason)
   values(${b.tenantId}::uuid,${e.companyId}::uuid,${e.id}::uuid,${n},'offboarding',${randomUUID()}::uuid,'promotion','{"effectiveDate":"2026-11-16","basicSalary":"5500.00"}'::jsonb,${approverGroups[i%3]},${status},${'q1-'+n},
    ${rejected?actors['group administrator'].userId!:null}::uuid,${rejected?new Date().toISOString():null}::timestamptz,${rejected?'Fictional rejection':null})`);
 }
 // The other tenant's posting, under a group name this tenant also uses.
 const [otherEmployment]=await owner.client<{id:string;companyId:string}[]>`select id::text as id,company_id::text as "companyId" from employment where tenant_id=${other.tenantId}::uuid order by id limit 1`;
 if(otherEmployment)await owner.db.execute(sql`insert into personnel_posting(tenant_id,company_id,employment_id,number,source,source_ref,event_type,proposed,approver_group_id,status,idempotency_key)
  values(${other.tenantId}::uuid,${otherEmployment.companyId}::uuid,${otherEmployment.id}::uuid,90001,'offboarding',${randomUUID()}::uuid,'promotion','{"effectiveDate":"2026-11-16","basicSalary":"5500.00"}'::jsonb,'fictional-posting-approvers','pending','q1-other')`);
},600_000);
afterAll(async()=>{try{await setMode('legacy');}finally{await teardownFixture();}});

describe('offboarding posting queue access once per statement (7330)',()=>{
 it('installs inert: legacy mode, the original name and grant, owner-only restated and operator functions',async()=>{
  expect(await owner.client`select function_name,mode from queue_read_control order by 1`).toEqual([{function_name:'offboarding_posting_queue_access',mode:'legacy'}]);
  const rows=await owner.client<{fn:string;lang:string;app:boolean}[]>`select p.oid::regprocedure::text as fn,l.lanname as lang,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app
   from pg_proc p join pg_language l on l.oid=p.prolang where p.oid in ('app.offboarding_posting_queue_access()'::regprocedure,'app.offboarding_posting_queue_access_legacy()'::regprocedure,
    'app.offboarding_posting_queue_access_v2()'::regprocedure,'app.queue_read_set_mode(text,text)'::regprocedure,'app.queue_read_compare_offboarding(uuid)'::regprocedure) order by 1`;
  expect(rows).toEqual([
   {fn:'app.offboarding_posting_queue_access()',lang:'plpgsql',app:true},
   {fn:'app.offboarding_posting_queue_access_legacy()',lang:'sql',app:false},
   {fn:'app.offboarding_posting_queue_access_v2()',lang:'plpgsql',app:false},
   {fn:'app.queue_read_compare_offboarding(uuid)',lang:'plpgsql',app:false},
   {fn:'app.queue_read_set_mode(text,text)',lang:'plpgsql',app:false},
  ]);
  await expect(withTenant(actors['group administrator'],tx=>tx.execute(sql`select app.queue_read_set_mode('offboarding_posting_queue_access','v2')`))).rejects.toThrow();
 });

 for(const state of ['none','approver','people ops fallback','v9 groups only'] as const){
  it(`answers exactly as 6302 for every actor, and serves that answer in every mode: ${state}`,async()=>{
   await config(state);
   const expected:Record<string,boolean>={};
   for(const [name,ctx] of everyone()){
    const row=await both(ctx);
    expect(row.v2,`${state}: ${name}`).toBe(row.legacy);
    expected[name]=row.legacy;
   }
   for(const mode of MODES){
    await setMode(mode);
    for(const [name,ctx] of everyone())expect(await served(ctx),`${state}/${mode}: ${name}`).toBe(expected[name]);
   }
   await setMode('legacy');
   const [compare]=await owner.client<{result:{users:number;granted:number;differs:number}}[]>`select app.queue_read_compare_offboarding(${b.tenantId}::uuid) as result`;
   expect(compare.result.differs).toBe(0);
   expect(compare.result.users).toBeGreaterThan(10);
   if(state!=='none'){
    // Real decisions on both sides: some actors may open the queue, others may not.
    expect(Object.values(expected).some(Boolean),state).toBe(true);
    expect(Object.values(expected).some(value=>!value),state).toBe(true);
   }else expect(Object.values(expected).every(value=>!value)).toBe(true);
  },300_000);
 }

 it('keeps the subject exclusion, the archived and login-blocked users and the other tenant out',async()=>{
  await config('approver');
  // Archived and login-blocked users are never group members. With the company arm closed (no configured approver
  // group, an absent People Ops group) and only the subject's own postings left, the subject approver sees nothing.
  const row=await both(actors['archived administrator']);expect(row).toEqual({legacy:false,v2:false});
  const blocked=await both(actors['login-blocked administrator']);expect(blocked).toEqual({legacy:false,v2:false});
  await owner.db.execute(sql`update lc_v9_config set data=data-'offboarding' where tenant_id=${b.tenantId}::uuid`);
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{peopleOpsGroup}','"fictional-absent-group"') where tenant_id=${b.tenantId}::uuid`);
  await owner.db.execute(sql`delete from personnel_posting where tenant_id=${b.tenantId}::uuid and employment_id<>${postingEmployments[0].id}::uuid and source='offboarding'`);
  const self=await both(subjectApprover);expect(self).toEqual({legacy:false,v2:false});
  for(const [name,ctx] of everyone()){const answer=await both(ctx);expect(answer.v2,name).toBe(answer.legacy);}
  const [compare]=await owner.client<{result:{differs:number}}[]>`select app.queue_read_compare_offboarding(${b.tenantId}::uuid) as result`;
  expect(compare.result.differs).toBe(0);
  const [another]=await owner.client<{result:{differs:number}}[]>`select app.queue_read_compare_offboarding(${other.tenantId}::uuid) as result`;
  expect(another.result.differs).toBe(0);
 },300_000);

 it('restores the caller\'s settings after the every-user comparison',async()=>{
  const ctx=actors['group administrator'];
  const settings=await owner.withTenant(ctx,async tx=>{
   const [before]=await tx.execute<{u:string}>(sql`select current_setting('app.user_id',true) as u`);
   await tx.execute(sql`select app.queue_read_compare_offboarding(${b.tenantId}::uuid)`);
   const [after]=await tx.execute<{u:string}>(sql`select current_setting('app.user_id',true) as u`);
   return [before.u,after.u];
  });
  expect(settings[1]).toBe(settings[0]);
 });
});
