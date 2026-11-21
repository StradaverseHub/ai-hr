// Scale overlay for the disposable hosted browser fixture. Its two tenant identities and
// 500 authenticated users stay in place. The extra workforce is only for read-path pressure.
import assert from 'node:assert/strict';

const newCompanies=65;
const newEmployments=750;
const companyPrefix='Z Fictional scale company ';
const workerPrefix='Z Fictional scale worker ';

export async function seedBrowserGroupShape(owner,fixture){
 const [group,companyAdmin]=fixture.users;
 assert.equal(group.role,'groupHR');
 assert.equal(companyAdmin.role,'companyHR');
 assert.equal(group.tenantId,fixture.tenants[0].tenantId);
 assert.equal(group.companyId,companyAdmin.companyId);
 assert.equal(fixture.tenants[0].companies.length,5);
 const tenantId=group.tenantId;

 const {companies,counts,workforce}=await owner.begin(async tx=>{
  // The mixed fixture has published organisation data. Its assignment guard
  // requires the same transaction-local tenant binding as a normal write.
  await tx`select set_config('app.tenant_id',${tenantId},true)`;
  const companies=await tx`
   insert into company (tenant_id,legal_name,country,parent_company_id)
   select ${tenantId}::uuid,${companyPrefix} || lpad(n::text,2,'0'),'MY',${group.companyId}::uuid
   from generate_series(1,${newCompanies}::int) as series(n)
   returning id,legal_name as name
  `;
  assert.equal(companies.length,newCompanies);
  const companyIds=companies.sort((a,b)=>a.name.localeCompare(b.name)).map(company=>company.id);
  const results=await tx`
   with workforce as materialized (
    select n,gen_random_uuid() as person_id,
     (${companyIds}::uuid[])[case when n<=125 then 1 else 2+(n-126)%${newCompanies-1}::int end] as company_id
    from generate_series(1,${newEmployments}::int) as series(n)
   ), departments as (
    insert into department (tenant_id,company_id,name)
    select ${tenantId}::uuid,id,'Fictional scale department'
    from unnest(${companyIds}::uuid[]) as company(id)
    returning id,company_id
   ), people as (
    insert into person (id,tenant_id,full_name,primary_email)
    select person_id,${tenantId}::uuid,${workerPrefix} || lpad(n::text,3,'0'),'scale-browser-' || n::text || '@example.invalid'
    from workforce
    returning id,full_name
   ), employments as (
    insert into employment (tenant_id,person_id,company_id,employee_code,hired_on)
    select ${tenantId}::uuid,people.id,workforce.company_id,'PERF-SCALE-' || lpad(n::text,3,'0'),date '2022-01-01'
    from workforce join people on people.id=workforce.person_id
    returning id,company_id,person_id
   ), assignments as (
   insert into assignment (tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
   select ${tenantId}::uuid,employments.id,employments.company_id,departments.id,'full_time',date '2022-01-01'
   from employments join departments on departments.company_id=employments.company_id
   returning employment_id
   )
   select employments.id as "employmentId",employments.company_id as "companyId",people.full_name as name
   from assignments join employments on employments.id=assignments.employment_id
   join people on people.id=employments.person_id
  `;
  assert.equal(results.length,newEmployments);
  const [counts]=await tx`
   select
    (select count(*)::int from company where tenant_id=${tenantId}::uuid) as companies,
    (select count(*)::int from employment where tenant_id=${tenantId}::uuid and terminated_on is null) as "activeEmployments",
    (select count(distinct company_id)::int from employment where tenant_id=${tenantId}::uuid and terminated_on is null) as "staffedCompanies",
    (select count(*)::int from company where tenant_id=${fixture.tenants[1].tenantId}::uuid) as "otherTenantCompanies"
  `;
  assert.equal(counts.companies,70);
  const baseWorkforce=fixture.users.filter(actor=>actor.tenantId===tenantId).length;
  const rewardWorkforce=fixture.tenants[group.tenant].rewardDraft?1:0;
  assert.equal(counts.activeEmployments,baseWorkforce+rewardWorkforce+results.length);
  assert(counts.activeEmployments>=1000);
  assert.equal(counts.staffedCompanies,70);
  assert.equal(counts.otherTenantCompanies,5);
  return {companies,counts,workforce:results.map(row=>({...row,tenant:group.tenant}))};
 });
 await owner`analyze public.company,public.person,public.employment,public.assignment,public.department`;
 return {counts,company:companies[0],workforce};
}
