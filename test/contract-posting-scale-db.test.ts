import {afterAll,beforeAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {migrateTestDb,closeAll,owner} from './harness';
import {contractPostingFixture,releaseContractPosting} from './helpers/contract-posting-fixture';
import {listContractSharedPostings,contractSharedPostingWorkPage} from '../packs/contracts/service';

beforeAll(migrateTestDb);afterAll(closeAll);
// Diagnostic execution headroom (SCALE rule 15): full gate M, job 135112006272, hit the 30 s
// default at 30,009.57 ms. This is a timeout lower bound, NOT a completed worst-case or request
// latency measurement. Keep every scale/authority assertion; the next hosted run must record
// completed duration and investigate any remaining fixture/oracle/request cost.
it('pages 1,000 source-bound postings across 70 companies with the same current group scope and no salary projection',async()=>{
 const f=await contractPostingFixture(),original=await releaseContractPosting(f);
 // Read-only scale records reuse the real fixture's released-letter identity; these clones are never submitted or approved.
 await owner.db.transaction(async tx=>{
 await tx.execute(sql`select set_config('app.tenant_id',${f.b.tenantId},true)`);
 await tx.execute(sql`with companies as (
  insert into company(tenant_id,legal_name) select ${f.b.tenantId}::uuid,'Posting scale company '||lpad(n::text,2,'0') from generate_series(1,70) n returning id,legal_name
 ), numbered as materialized(select id,row_number() over(order by legal_name) n from companies), fixture as materialized(
  select series.n,gen_random_uuid() person_id,gen_random_uuid() employment_id,gen_random_uuid() term_id,gen_random_uuid() case_id,gen_random_uuid() posting_id,c.id company_id
  from generate_series(1,1000) series(n) join numbered c on c.n=((series.n-1)%70)+1
 ), people as (
  insert into person(id,tenant_id,full_name,primary_email) select person_id,${f.b.tenantId}::uuid,'Fictional posting scale employee '||lpad(n::text,4,'0'),'posting-scale-'||n||'@contracts.test' from fixture
 ), employments as (
  insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code,contract_start_date,contract_end_date,contract_number)
  select employment_id,${f.b.tenantId}::uuid,person_id,company_id,${f.start}::date,'POSTSCALE-'||n,${f.start}::date,${f.end}::date,4 from fixture
 ), terms as (
  insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision)
  select term_id,${f.b.tenantId}::uuid,company_id,employment_id,1,'project',${f.start}::date,${f.end}::date,'scale-read-fixture' from fixture
 ), cases as (
  insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data)
  select x.case_id,${f.b.tenantId}::uuid,x.company_id,x.employment_id,x.term_id,'CT-POSTSCALE-'||lpad(x.n::text,4,'0'),1,c.data from fixture x cross join contract_case c where c.id=${f.caseId}::uuid
 ), flows as (
  insert into contract_shared_case(tenant_id,case_id,revision,data)
  select ${f.b.tenantId}::uuid,x.case_id,s.revision,s.data||jsonb_build_object('posting',jsonb_build_object('id',x.posting_id,'approvedBy',null,'approvedAt',null)) from fixture x cross join contract_shared_case s where s.case_id=${f.caseId}::uuid
 ), postings as (
  insert into personnel_posting(id,tenant_id,company_id,employment_id,number,source,source_ref,event_type,proposed,approver_group_id,idempotency_key,created_at)
  select x.posting_id,${f.b.tenantId}::uuid,x.company_id,x.employment_id,2000+x.n,'contract_staff',x.case_id,p.event_type,p.proposed,p.approver_group_id,'scale-read',now()+(x.n||' milliseconds')::interval from fixture x cross join personnel_posting p where p.id=${original.id}::uuid
 ) insert into contract_shared_posting(tenant_id,posting_id,case_id,decision_revision,letter_id,subject_person_id,source_revision)
 select ${f.b.tenantId}::uuid,x.posting_id,x.case_id,r.decision_revision,r.letter_id,x.person_id,'scale-read-fixture' from fixture x cross join contract_shared_posting r where r.posting_id=${original.id}::uuid`);
 });
 const[expected]=await withTenant(f.approver,tx=>tx.execute<{ids:string[];companies:number}>(sql`select array_agg(p.id order by p.created_at desc,p.number desc) ids,count(distinct p.company_id)::int companies from personnel_posting p where p.tenant_id=app.current_tenant_id() and p.source='contract_staff' and app.contract_shared_posting_approver(p.company_id)`));
 expect(expected.ids).toHaveLength(1001);expect(expected.companies).toBe(71);
 const first=await listContractSharedPostings(f.approver,{limit:50}),next=await listContractSharedPostings(f.approver,{limit:50,offset:50}),last=await listContractSharedPostings(f.approver,{limit:50,offset:1000});
 expect(first.total).toBe(1001);expect(first.rows.map(r=>r.id)).toEqual(expected.ids.slice(0,50));expect(next.rows.map(r=>r.id)).toEqual(expected.ids.slice(50,100));expect(last.rows.map(r=>r.id)).toEqual(expected.ids.slice(1000));
 const scoped=await listContractSharedPostings(f.approver,{companyId:first.rows[0].companyId,limit:100});expect(scoped.rows.length).toBeGreaterThan(0);expect(scoped.rows.every(r=>r.companyId===first.rows[0].companyId)).toBe(true);
 const tasks=await contractSharedPostingWorkPage(f.approver,{companyIds:[first.rows[0].companyId],limit:20});expect(tasks.total).toBe(scoped.total);expect(tasks.items.length).toBe(Math.min(20,scoped.total));expect(tasks.items.every(t=>t.kind==='contractPosting'&&t.linkPath.startsWith('/lifecycle/contracts/postings'))).toBe(true);
 const work=await contractSharedPostingWorkPage(f.approver,{limit:20}),nextWork=await contractSharedPostingWorkPage(f.approver,{offset:20,limit:20});
 expect(work.total).toBe(1001);expect(work.items).toHaveLength(20);expect(nextWork.items).toHaveLength(20);expect(new Set([...work.items,...nextWork.items].map(item=>item.id)).size).toBe(40);
 const linked=new URL(work.items[0].linkPath,'https://fixture.test');
 expect(linked.searchParams.get('postingId')).toBe(original.id);
 const exact=await listContractSharedPostings(f.approver,{postingId:original.id});expect(exact.rows.map(row=>row.id)).toEqual([original.id]);expect(exact.total).toBe(1);
 expect((await listContractSharedPostings(f.employeeActor,{limit:100})).rows).toEqual([]);
 const shape=JSON.stringify(first);expect(shape).not.toMatch(/salaryCents|basicSalary|signingPolicy|5200\.12|4976\.21/);
 await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{groups}',(select jsonb_agg(case when g->>'id'=${f.groupId} then jsonb_set(g,'{members}','[]'::jsonb) else g end) from jsonb_array_elements(data->'groups') g)) where tenant_id=${f.b.tenantId}::uuid`);
 expect((await listContractSharedPostings(f.approver)).rows).toEqual([]);expect(await contractSharedPostingWorkPage(f.approver)).toEqual({items:[],total:0});
},90_000);
