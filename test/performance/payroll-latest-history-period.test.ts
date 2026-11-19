import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withPayrollTenant} from '../../core/module-gate';
import {latestProcessedPayslipPeriod} from '../../core/payroll-view';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';
import type {SessionContext} from '../../db/client';

beforeAll(migrateTestDb);
afterAll(closeAll);

it('finds the same latest visible Payroll history period without joining the history of every employee', async () => {
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
  const evidence=[];
  for(const {label,ctx,scope,employmentId,expected} of cases){
    const companyList=sql`ARRAY[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
    const start=performance.now();
    const previous=await withPayrollTenant(ctx,async tx=>{
      const [row]=await tx.execute<{period:string}>(sql`select b.pay_period as period
        from payslip s
        join payroll_batch b on b.id=s.batch_id
        join company c on c.id=b.company_id
        join employment e on e.id=s.employment_id
        join person p on p.id=e.person_id
        where b.company_id=any(${companyList}) ${employmentId?sql`and s.employment_id=${employmentId}::uuid`:sql``}
        order by b.pay_period desc limit 1`);
      return row?.period??null;
    });
    const baselineMs=Math.round(performance.now()-start), candidateStart=performance.now();
    const candidate=await latestProcessedPayslipPeriod(ctx,{companyIds:scope,employmentId});
    evidence.push({label,baselineMs,candidateMs:Math.round(performance.now()-candidateStart)});
    expect(previous,label).toBe(expected);
    expect(candidate,label).toBe(previous);
  }
  console.info(JSON.stringify({kind:'PAYROLL_LATEST_PERIOD_COMPONENT_ONLY',companies:72,employments:1440,evidence}));
},180_000);
