import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withPayrollTenant} from '../../core/module-gate';
import {latestProcessedPayslipPeriod} from '../../core/payroll-view';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';
import type {SessionContext} from '../../db/client';

beforeAll(migrateTestDb);
afterAll(closeAll);

async function seedHistory() {
  await resetDb();
  const base = await seedBase(), tenant = base.tenantId;
  const groups = await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name)
    select ${tenant}::uuid,'Fictional Payroll History '||n from generate_series(2,72) n returning id`;
  const companies = [base.companyId,...groups.map(row=>row.id)];
  await owner.client.begin(async tx=>{
    // Synthetic bulk fixtures use valid IDs and dates. The read still runs as the application role.
    await tx`set local session_replication_role = replica`;
    await tx`with people as (
      insert into person(tenant_id, full_name, primary_email)
      select ${tenant}::uuid,'Fictional History '||c.n||' '||i,
        'history-'||c.n||'-'||i||'@example.invalid'
      from unnest(${companies}::uuid[]) with ordinality c(id,n) cross join generate_series(1,20) i
      returning id,primary_email
    ) insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
      select ${tenant}::uuid,id,(${companies}::uuid[])[split_part(primary_email,'-',2)::int],primary_email,'2020-01-01'
      from people`;
    await tx`insert into pay_period(tenant_id,company_id,period)
      select ${tenant}::uuid,c.id,to_char(m,'YYYY-MM')
      from unnest(${companies}::uuid[]) c(id)
      cross join generate_series(date '2025-05-01',date '2026-05-01',interval '1 month') m`;
    await tx`insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,batch_date,status)
      select tenant_id,company_id,id,period,(period||'-01')::date,
        case when period='2026-05' then 'draft'::payroll_status else 'processed'::payroll_status end
      from pay_period where tenant_id=${tenant}::uuid and company_id=any(${companies}::uuid[])`;
    await tx`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,statutory,total_deductions,net_pay,employer_cost)
      select b.tenant_id,b.id,e.id,3000,3000,'{}'::jsonb,200,2800,3300
      from payroll_batch b join employment e on e.tenant_id=b.tenant_id and e.company_id=b.company_id
      where b.tenant_id=${tenant}::uuid and e.employee_code like 'history-%'
        and b.status='processed' and (b.company_id<>${base.companyId}::uuid or b.pay_period<>'2026-04')`;
  });
  const [self] = await owner.client<{person_id:string;id:string}[]>`select person_id,id from employment
    where tenant_id=${tenant}::uuid and company_id=${base.companyId}::uuid and employee_code like 'history-%'
    order by employee_code limit 1`;
  const selfUser = await createAppUser(tenant,self.person_id,'employee');
  const scopedUser=randomUUID(), partnerUser=randomUUID();
  await owner.client`insert into app_user(id,tenant_id,workos_user_id) values
    (${scopedUser},${tenant},${`history-hr-${scopedUser}`}),(${partnerUser},${tenant},${`history-partner-${partnerUser}`})`;
  await owner.client`insert into role_assignment(tenant_id,app_user_id,company_id,role) values
    (${tenant},${scopedUser},${base.companyId},'hr_admin'),(${tenant},${partnerUser},${base.companyId},'payroll_partner')`;
  const admin=adminCtx(base);
  const scoped=(userId:string,role:string):SessionContext=>({...admin,userId,roles:[role],grants:[{role,companyId:base.companyId}]});
  const cases=[
    {label:'group-all',ctx:admin,scope:companies,expected:'2026-04'},
    {label:'group-single',ctx:admin,scope:[base.companyId],expected:'2026-03'},
    {label:'single-employment',ctx:admin,scope:companies,employmentId:self.id,expected:'2026-03'},
    {label:'company-hr',ctx:scoped(scopedUser,'hr_admin'),scope:companies,expected:'2026-03'},
    {label:'payroll-partner',ctx:scoped(partnerUser,'payroll_partner'),scope:companies,expected:'2026-03'},
    {label:'employee-outside-scope',ctx:{...admin,userId:selfUser,personId:self.person_id,roles:['employee'],grants:[{role:'employee',companyId:null}]},scope:[groups[0].id],expected:null},
  ];
  return {base,tenant,cases};
}

function isStatementTimeout(error:unknown):boolean {
  return typeof error==='object'&&error!==null&&(
    ('code' in error&&error.code==='57014')||('cause' in error&&isStatementTimeout(error.cause))
  );
}

it('finds the same latest visible Payroll history period without joining the history of every employee', async () => {
  const {cases}=await seedHistory();
  const evidence=[];
  for(const {label,ctx,scope,employmentId,expected} of cases){
    console.info('PAYROLL_LATEST_PERIOD_STARTED',label);
    const companyList=sql`ARRAY[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
    const candidateStart=performance.now();
    const candidate=await latestProcessedPayslipPeriod(ctx,{companyIds:scope,employmentId});
    const candidateMs=Math.round(performance.now()-candidateStart);
    console.info('PAYROLL_LATEST_PERIOD_CANDIDATE',label,candidateMs);
    expect(candidate,label).toBe(expected);
    const start=performance.now();
    const previous=await withPayrollTenant(ctx,async tx=>{
      await tx.execute(sql`set local statement_timeout='45s'`);
      const [row]=await tx.execute<{period:string}>(sql`select b.pay_period as period
        from payslip s
        join payroll_batch b on b.id=s.batch_id
        join company c on c.id=b.company_id
        join employment e on e.id=s.employment_id
        join person p on p.id=e.person_id
        where b.company_id=any(${companyList}) ${employmentId?sql`and s.employment_id=${employmentId}::uuid`:sql``}
        order by b.pay_period desc limit 1`);
      return row?.period??null;
    }).catch(error=>{if(isStatementTimeout(error))return 'statement-timeout';throw error;});
    const baselineMs=Math.round(performance.now()-start);
    evidence.push({label,baselineMs,candidateMs,baselineTimedOut:previous==='statement-timeout'});
    console.info('PAYROLL_LATEST_PERIOD_BASELINE',label,baselineMs,previous==='statement-timeout'?'timeout':'returned');
    if(previous!=='statement-timeout')expect(candidate,label).toBe(previous);
  }
  console.info(JSON.stringify({kind:'PAYROLL_LATEST_PERIOD_COMPONENT_ONLY',companies:72,employments:1440,evidence}));
},480_000);

it('selects the latest visible retained period before building document payloads',async()=>{
  const {base,tenant,cases}=await seedHistory();
  // This is a disposable database proof. The existing retained-document reader compares
  // against the candidate through the same authorized caller and tenant transaction.
  await owner.client`insert into information_payslip_snapshot
    (payslip_id,tenant_id,employment_id,company_id,hired_on,document_metadata,recorded_by)
    select p.id,p.tenant_id,p.employment_id,b.company_id,'2020-01-01',
      jsonb_build_object('employeeName','Fictional historical name'),${base.adminUserId}::uuid
    from payslip p join payroll_batch b on b.id=p.batch_id
    where p.tenant_id=${tenant}::uuid and b.pay_period<>'2026-04'`;
  await owner.client.begin(async tx=>{
    await tx`create function app.test_latest_retained_payroll_period(p_companies uuid[],p_employment uuid)
      returns text language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
      select batches.pay_period
      from (
        select b.id,b.tenant_id,b.company_id,b.pay_period
        from public.payroll_batch b
        where b.tenant_id=app.current_tenant_id() and app.principal_snapshot_current()
          and cardinality(p_companies)<=100 and b.company_id=any(p_companies)
          and app.can_admin_payroll_for(b.company_id)
        order by b.pay_period desc
        offset 0
      ) batches
      where exists (
        select 1 from public.payslip p
        join public.information_payslip_snapshot f on f.payslip_id=p.id
          and f.tenant_id=p.tenant_id and f.employment_id=p.employment_id and f.company_id=batches.company_id
        join public.employment e on e.id=p.employment_id and e.tenant_id=f.tenant_id
        where p.tenant_id=batches.tenant_id and p.batch_id=batches.id
          and (p_employment is null or p.employment_id=p_employment)
          and (app.payroll_history_effective(p.id) or app.payroll_history_self_issued(p.id))
        offset 0
      )
      order by batches.pay_period desc limit 1
      $$`;
    await tx`revoke all on function app.test_latest_retained_payroll_period(uuid[],uuid) from public`;
    await tx`grant execute on function app.test_latest_retained_payroll_period(uuid[],uuid) to ai_hr_app`;
  });
  try {
    const retainedEvidence=[];
    for(const {label,ctx,scope,employmentId,expected} of cases){
      console.info('PAYROLL_RETAINED_PERIOD_STARTED',label);
      const companyList=sql`ARRAY[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
      const outcome=await withPayrollTenant(ctx,async tx=>{
        const start=performance.now();
        const [baseline]=await tx.execute<{period:string}>(sql`select d.doc->'batch'->>'pay_period' period
          from app.information_payslip_documents(${companyList},null,null,null,${employmentId??null}::uuid,true)
          with ordinality as d(doc,ordinal) order by d.ordinal limit 1`);
        const baselineMs=Math.round(performance.now()-start),candidateStart=performance.now();
        const [candidate]=await tx.execute<{period:string|null}>(sql`select
          app.test_latest_retained_payroll_period(${companyList},${employmentId??null}::uuid) period`);
        return {baseline:baseline?.period??null,candidate:candidate.period,baselineMs,candidateMs:Math.round(performance.now()-candidateStart)};
      });
      expect(outcome.baseline,label).toBe(expected===null?null:'2026-03');
      expect(outcome.candidate,label).toBe(outcome.baseline);
      retainedEvidence.push({label,baselineMs:outcome.baselineMs,candidateMs:outcome.candidateMs});
    }
    console.info(JSON.stringify({kind:'PAYROLL_RETAINED_PERIOD_COMPONENT_ONLY',companies:72,employments:1440,evidence:retainedEvidence}));
  } finally {
    await owner.client`drop function app.test_latest_retained_payroll_period(uuid[],uuid)`;
  }
},360_000);
