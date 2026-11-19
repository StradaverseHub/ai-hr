import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {informationDocumentRow,informationPayslipDocuments,latestInformationPayslipPeriod} from '../../core/information-correction-history';
import {withPayrollTenant} from '../../core/module-gate';
import {latestProcessedPayslipPeriod,listProcessedPayslipsAcross} from '../../core/payroll-view';
import {client} from '../../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';
import type {SessionContext,Tx} from '../../db/client';

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

async function seedRetainedHistory(tenant:string,actor:string) {
  await owner.client`insert into information_payslip_snapshot
    (payslip_id,tenant_id,employment_id,company_id,hired_on,document_metadata,recorded_by)
    select p.id,p.tenant_id,p.employment_id,b.company_id,'2020-01-01',
      jsonb_build_object('employeeName','Fictional historical name'),${actor}::uuid
    from payslip p join payroll_batch b on b.id=p.batch_id
    where p.tenant_id=${tenant}::uuid and b.pay_period<>'2026-04'`;
}

type RetainedDocuments=Awaited<ReturnType<typeof informationPayslipDocuments>>;
async function legacyRetainedDocuments(tx:Tx,filters:{
  companyIds:string[];year?:number;month?:number;cycle?:string;employmentId?:string;
},limit:number):Promise<RetainedDocuments> {
  const companies=[...new Set(filters.companyIds)];
  const documents:RetainedDocuments=[];
  for(let offset=0;offset<companies.length;offset+=100) {
    const companyList=sql`ARRAY[${sql.join(companies.slice(offset,offset+100).map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
    const rows=await tx.execute<{document:RetainedDocuments[number]}>(sql`
      select d.document from app.information_payslip_documents(
        ${companyList}, ${filters.year??null}::integer, ${filters.month??null}::integer,
        ${filters.cycle??null}::text, ${filters.employmentId??null}::uuid, true
      ) with ordinality as d(document, ordinal)
      order by d.ordinal limit ${limit}
    `);
    documents.push(...rows.map(row=>row.document));
  }
  return documents;
}

async function revertEarlyRetainedDocument(tenant:string,actor:string,baseCompany:string) {
  return owner.client.begin(async tx=>{
    await tx`set local session_replication_role = replica`;
    const [target]=await tx<{id:string;company_id:string;employment_id:string}[]>`
      select p.id,b.company_id,p.employment_id
      from payslip p join payroll_batch b on b.id=p.batch_id
      where p.tenant_id=${tenant} and b.company_id<>${baseCompany} and b.pay_period='2026-03'
      order by b.run_seq,p.id limit 1`;
    const [cycle]=await tx<{id:string}[]>`
      insert into payroll_cycle(tenant_id,company_id,name,run_type)
      values(${tenant},${target.company_id},'Fictional retained month','regular') returning id`;
    const [record]=await tx<{id:string}[]>`
      insert into payroll_history_import_record(tenant_id,company_id,employment_id,period,cycle_id)
      values(${tenant},${target.company_id},${target.employment_id},'2026-03',${cycle.id}) returning id`;
    await tx`insert into payroll_history_import_snapshot(id,tenant_id,record_id,value_hash,"values")
      values(${target.id},${tenant},${record.id},repeat('a',64),'{}'::jsonb)`;
    const source=Buffer.from('Fictional payroll visibility test');
    const [attempt]=await tx<{id:string}[]>`
      insert into payroll_history_import_attempt(tenant_id,created_by,operation_key,source_name,mime_type,source_hash,source_content,company_ids,plan)
      values(${tenant},${actor},${randomUUID()},'fictional.csv','text/csv',encode(sha256(${source}),'hex'),${source},
        array[${target.company_id}::uuid],jsonb_build_object('sourceHash',encode(sha256(${source}),'hex'))) returning id`;
    const [imported]=await tx<{id:string}[]>`
      insert into payroll_history_import_revision(tenant_id,record_id,ordinal,attempt_id,snapshot_id,kind,cycle_name)
      values(${tenant},${record.id},1,${attempt.id},${target.id},'import','Fictional retained month') returning id`;
    await tx`insert into payroll_history_import_revision(tenant_id,record_id,ordinal,attempt_id,previous_revision_id,kind,cycle_name)
      values(${tenant},${record.id},2,${attempt.id},${imported.id},'revert','Fictional retained month')`;
    return target.id;
  });
}

it('selects the latest visible retained period before building document payloads',async()=>{
  const {base,tenant,cases}=await seedHistory();
  expect(await owner.client`select to_regprocedure('app.information_latest_retained_payslip_period(uuid[],integer,integer,text,uuid)') is not null as installed`)
    .toEqual([{installed:true}]);
  await seedRetainedHistory(tenant,base.adminUserId);
  const group=cases[1];
  const variants=[
    ...cases.map(({label,ctx,scope,employmentId,expected})=>({
      label,ctx,filters:{companyIds:scope,employmentId},expected:expected===null?null:'2026-03',
    })),
    {label:'month-and-cycle',ctx:group.ctx,filters:{companyIds:group.scope,year:2025,month:11,cycle:'regular'},expected:'2025-11'},
    {label:'out-of-period',ctx:group.ctx,filters:{companyIds:group.scope,year:2024},expected:null},
    {label:'scope-over-100',ctx:group.ctx,filters:{companyIds:[...Array.from({length:100},()=>randomUUID()),...group.scope]},expected:'2026-03'},
  ];
  const retainedEvidence=[];
  for(const {label,ctx,filters,expected} of variants){
    console.info('PAYROLL_RETAINED_PERIOD_STARTED',label);
    const outcome=await withPayrollTenant(ctx,async tx=>{
      const start=performance.now();
      const docs=await legacyRetainedDocuments(tx,filters,1);
      const baseline=docs.map(doc=>informationDocumentRow(doc).payPeriod).sort().at(-1)??null;
      const baselineMs=Math.round(performance.now()-start),candidateStart=performance.now();
      const candidate=await latestInformationPayslipPeriod(tx,filters);
      return {baseline,candidate,baselineMs,candidateMs:Math.round(performance.now()-candidateStart)};
    });
    expect(outcome.baseline,label).toBe(expected);
    expect(outcome.candidate,label).toBe(outcome.baseline);
    retainedEvidence.push({label,baselineMs:outcome.baselineMs,candidateMs:outcome.candidateMs});
  }
  console.info(JSON.stringify({kind:'PAYROLL_RETAINED_PERIOD_COMPONENT_ONLY',companies:72,employments:1440,evidence:retainedEvidence}));
},360_000);

it('bounds retained document projection to the requested page with identical order and visibility',async()=>{
  const {base,tenant,cases}=await seedHistory();
  await seedRetainedHistory(tenant,base.adminUserId);
  const revertedId=await revertEarlyRetainedDocument(tenant,base.adminUserId,base.companyId);
  expect(await owner.client`select to_regprocedure('app.information_retained_payslip_documents_page(uuid[],integer,integer,text,uuid,integer)') is not null as installed`)
    .toEqual([{installed:true}]);

  const expectedCounts:Record<string,number>={
    'group-all':201,'group-single':20,'single-employment':1,'company-hr':5,
    'payroll-partner':20,'employee-outside-scope':0,
  };
  const evidence=[];
  for(const {label,ctx,scope,employmentId} of cases) {
    const limit=label==='company-hr'?5:201;
    const cycle=label==='group-single'?'regular':undefined;
    const filters={companyIds:scope,employmentId,year:2026,month:3,cycle};
    const outcome=await withPayrollTenant(ctx,async tx=>{
      const baselineStarted=performance.now();
      const baseline=await legacyRetainedDocuments(tx,filters,limit);
      const baselineMs=Math.round(performance.now()-baselineStarted);
      const candidateStarted=performance.now();
      const candidate=await informationPayslipDocuments(tx,{...filters,intendedCycle:true,limit});
      return {baseline,candidate,baselineMs,
        candidateMs:Math.round(performance.now()-candidateStarted)};
    });
    expect(outcome.baseline,label).toHaveLength(expectedCounts[label]);
    expect(outcome.candidate,label).toEqual(outcome.baseline);
    expect(outcome.candidate.map(document=>informationDocumentRow(document).id),label).not.toContain(revertedId);
    evidence.push({label,rows:outcome.candidate.length,baselineMs:outcome.baselineMs,candidateMs:outcome.candidateMs});
  }
  console.info(JSON.stringify({kind:'PAYROLL_RETAINED_DOCUMENT_PAGE_COMPONENT_ONLY',companies:72,employments:1440,evidence}));
},360_000);

it('profiles the complete capped Transaction View table read after the period is known',async()=>{
  const {base,tenant,cases}=await seedHistory();
  const runs=cases.filter(row=>['group-all','group-single','company-hr','employee-outside-scope'].includes(row.label));
  const expectedCounts:Record<string,number>={
    'group-all':201,'group-single':20,'company-hr':20,'employee-outside-scope':0,
  };
  const evidence=[];
  for(const retained of [false,true]){
    if(retained)await seedRetainedHistory(tenant,base.adminUserId);
    for(const {label,ctx,scope} of runs){
      const events:{kind:string;started:number}[]=[];
      const originalDebug=client.options.debug;
      client.options.debug=(_connection:number,statement:string)=>{
        const kind=statement.includes('from "payslip"')?'live-rows':
          statement.includes('from app.information_retained_payslip_documents_page(')?'retained-rows':'other';
        events.push({kind,started:performance.now()});
      };
      const start=performance.now();
      try{
        const rows=await listProcessedPayslipsAcross(ctx,{companyIds:scope,year:2026,month:3,limit:201});
        const end=performance.now();
        expect(rows,label).toHaveLength(expectedCounts[label]);
        expect(rows.every(row=>row.payPeriod==='2026-03'),label).toBe(true);
        if(label==='group-single'||label==='company-hr')expect(rows.every(row=>row.companyId===base.companyId),label).toBe(true);
        const statementIntervals=events.flatMap((event,index)=>event.kind==='other'?[]:[{
          kind:event.kind,untilNextCommandMs:Math.round((events[index+1]?.started??end)-event.started),
        }]);
        evidence.push({label,retained,elapsedMs:Math.round(end-start),rows:rows.length,statementIntervals});
      }finally{client.options.debug=originalDebug;}
    }
  }
  console.info(JSON.stringify({kind:'PAYROLL_TRANSACTION_TABLE_COMPONENT_ONLY',companies:72,employments:1440,evidence}));
},480_000);
