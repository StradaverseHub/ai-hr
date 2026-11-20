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

 const {companies,counts}=await owner.begin(async tx=>{
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
    returning id
   ), employments as (
    insert into employment (tenant_id,person_id,company_id,employee_code,hired_on)
    select ${tenantId}::uuid,people.id,workforce.company_id,'PERF-SCALE-' || lpad(n::text,3,'0'),date '2022-01-01'
    from workforce join people on people.id=workforce.person_id
    returning id,company_id
   )
   insert into assignment (tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
   select ${tenantId}::uuid,employments.id,employments.company_id,departments.id,'full_time',date '2022-01-01'
   from employments join departments on departments.company_id=employments.company_id
   returning id
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
  assert(counts.activeEmployments>=1000);
  assert.equal(counts.staffedCompanies,70);
  assert.equal(counts.otherTenantCompanies,5);
  return {companies,counts};
 });
 await owner`analyze public.company,public.person,public.employment,public.assignment,public.department`;
 return {counts,company:companies[0]};
}

export async function measureBrowserGroupScope({base,page,user,fixture,report,save}){
 assert.equal(user.role,'groupHR');
 assert(fixture.scaleCompany);
 report.groupScopeSteps=[];
 const timeout=15000;
 const switcher=page.locator('button[data-company-switcher]');
 const companies=page.locator('input[type="checkbox"][name="companyId"]');
 const workforce=page.locator('main table tbody');
 const groupRows=workforce.getByRole('link',{name:/^PERF Person /});
 const scaleRows=workforce.getByRole('link',{name:new RegExp('^'+workerPrefix)});
 const selectedScope=async()=>{
  const cookies=await page.context().cookies(base);
  return decodeURIComponent(cookies.find(cookie=>cookie.name==='company_scope')?.value??'');
 };

 report.groupScopeStage='group-open';
 const opened=performance.now();
 await page.goto(base+'/admin/personnel',{waitUntil:'commit',timeout});
 await switcher.waitFor({state:'visible',timeout});
 await groupRows.first().waitFor({state:'visible',timeout});
 report.groupScopeSteps.push({step:'all-companies-open',elapsedMs:Math.round(performance.now()-opened),usable:true});
 save();

 report.groupScopeStage='group-company-options';
 await switcher.click({timeout});
 assert.equal(await companies.count(),70);
 assert.equal(await companies.and(page.locator(':checked')).count(),70);
 const clear=page.getByRole('button',{name:'Choose a new selection',exact:true});
 await clear.click({timeout});
 assert.equal(await companies.and(page.locator(':checked')).count(),0);

 report.groupScopeStage='group-scope-narrowed';
 const selected=performance.now();
 const option=page.getByRole('checkbox',{name:fixture.scaleCompany.name,exact:true});
 const [response]=await Promise.all([
  page.waitForResponse(response=>response.request().method()==='POST'
   &&new URL(response.url()).pathname==='/admin/personnel',{timeout}),
  option.check({timeout}),
 ]);
 assert.equal(response.status(),200);
 await switcher.getByText(fixture.scaleCompany.name,{exact:true}).waitFor({state:'visible',timeout});
 await scaleRows.first().waitFor({state:'visible',timeout});
 assert.equal(await groupRows.count(),0);
 assert.equal(await selectedScope(),fixture.scaleCompany.id);
 report.groupScopeSteps.push({step:'select-one-company',elapsedMs:Math.round(performance.now()-selected),usable:true});
 save();

 report.groupScopeStage='group-scope-restored';
 if(await switcher.getAttribute('aria-expanded')!=='true')await switcher.click({timeout});
 const restored=performance.now();
 await page.getByRole('button',{name:'Select all',exact:true}).click({timeout});
 await switcher.getByText('All companies',{exact:true}).waitFor({state:'visible',timeout});
 await groupRows.first().waitFor({state:'visible',timeout});
 assert.equal(new Set((await selectedScope()).split(',')).size,70);
 report.groupScopeSteps.push({step:'restore-all-companies',elapsedMs:Math.round(performance.now()-restored),usable:true});
 save();
}
