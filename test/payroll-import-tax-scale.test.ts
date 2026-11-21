/** Independent grouped shape fixture. Expected money/order is derived from fixture constants, never the projection. */
import {afterAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import {PgDialect} from 'drizzle-orm/pg-core';
import {sql,type SQL} from 'drizzle-orm';
import {owner,resetDb,seedBase,setModule,entitledCtx,closeAll} from './harness';
import {createBatch} from '../core/payroll';
import {createTaxBasisPreviewReadTx} from '../core/payroll-tax-basis-read';
import {previewTaxBasisRecalculation,taxBasisOptions} from '../core/payroll-tax-basis';
afterAll(closeAll);
it('pages 930 original-company sources within 70 companies and 1000 employments with exact ordered counts and no scope expansion',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'payroll','active');
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'PCB scope company '||n from generate_series(1,69)n returning id`;
 const companies=[b.companyId,...others.map(company=>company.id)];
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email) select ${b.tenantId}::uuid,'PCB shape person '||n,'pcb-shape-'||n||'@fixture.invalid' from generate_series(1,1000)n returning id),ranked as(select id,row_number()over(order by id)::int as n from people)
 insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${b.tenantId}::uuid,id,case when n<=930 then ${b.companyId}::uuid else (${companies}::uuid[])[2+((n-931)%69)] end,'PCB-SCALE-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 await owner.client`insert into pay_component(tenant_id,code,name,kind,display_category,included_in_pcb,pcb_remuneration_type) values(${b.tenantId}::uuid,'TRV','Shape travel','allowance','allowance',true,'normal')`;
 const ctx=await entitledCtx(b),batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-01'});
 const statutory={pcb:20,epfEmployee:0,lp:0,bases:{pcb:5000},componentLines:[{code:'TRV',name:'Shape travel',amount:500,buckets:[{bucket:'wage',amount:500}]}]};
 await owner.client`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,allowance,gross_pay,other_deductions,total_deductions,net_pay,employer_cost,statutory) select ${b.tenantId}::uuid,${batch.batchId}::uuid,id,5000,500,5500,0,20,5480,5500,${JSON.stringify(statutory)}::jsonb from employment where tenant_id=${b.tenantId}::uuid and company_id=${b.companyId}::uuid and employee_code like 'PCB-SCALE-%'`;
 await owner.client`update payroll_batch set status='processed',employee_count=930 where id=${batch.batchId}::uuid`;
 const expected=Array.from({length:930},(_,index)=>'PCB-SCALE-'+String(index+1).padStart(4,'0'));
 // Diagnostic records only fixed query categories/durations, never SQL parameters or Personnel values.
 const real=database.withTenant,dialect=new PgDialect(),queries:{phase:string;durationMs:number}[]=[];
 const measured:typeof real=(context,work,options)=>real(context,tx=>work(new Proxy(tx,{get(target,key,receiver){
  if(key!=='execute')return Reflect.get(target,key,receiver);
  return async(query:SQL)=>{const text=dialect.sqlToQuery(query).sql;const phase=text.includes('payroll_tax_basis_subjects')?'subjects':text.includes('pg_column_size')?'source-budget':text.includes('row_number() over')?'source-page':text.includes('to_jsonb(p)')?'source-identity':text.includes('native_tax_predecessors')?'native-predecessors':text.includes('payroll_tax_basis_revision')?'corrections':text.includes('statutory')?'statutory':'other';const started=performance.now();try{return await target.execute(query);}finally{queries.push({phase,durationMs:performance.now()-started});}};
 }})),options);
 const spy=vi.spyOn(database,'withTenant').mockImplementation(measured),started=performance.now();
 let preview:Awaited<ReturnType<typeof previewTaxBasisRecalculation>>;
 try{preview=await previewTaxBasisRecalculation(ctx,{companyId:b.companyId,year:2026,upToMonth:1,employmentIds:null});
  expect(queries.filter(query=>query.phase==='source-identity')).toHaveLength(1);
 }
 finally{spy.mockRestore();console.info('PCB_SCALE_PHASE_DIAGNOSTIC',JSON.stringify({elapsedMs:performance.now()-started,queryCount:queries.length,queries}));}

 expect(preview.employees.map(employee=>employee.employeeNo)).toEqual(expected);expect(preview.eligibleCount).toBe(930);expect(preview.blockedCount).toBe(0);expect(preview.recordCount).toBe(930);expect(preview.totals).toMatchObject({beforeTaxable:4650000,taxable:5115000,difference:465000});
 expect(preview.employees.every(employee=>employee.months.length===1&&employee.months[0].taxable===5500&&employee.months[0].items.find(item=>item.code==='TRV')?.taxable===500)).toBe(true);
 const options=await taxBasisOptions(ctx);expect(options.companies).toHaveLength(70);expect(options.employees.map(employee=>employee.employeeNo)).toEqual(expected);
 // The 930 fixture subjects all have one effective payslip in this company. Compare the full
 // second page with independently seeded employment rows, using the public picker as the app role.
 const scopedPage=await database.withTenant(ctx,tx=>tx.execute(sql`
  select * from app.payroll_tax_basis_subject_page(array[${b.companyId}::uuid,${b.companyId}::uuid],500,500)`));
 const fixturePage=await owner.client`
  select e.id,e.company_id as "companyId",e.employee_code as "employeeNo",p.full_name as name
  from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id
  where e.tenant_id=${b.tenantId}::uuid and e.company_id=${b.companyId}::uuid and e.employee_code like 'PCB-SCALE-%'
  order by e.employee_code,e.id limit 500 offset 500`;
 expect(scopedPage).toHaveLength(430);
 expect([...scopedPage]).toEqual([...fixturePage]);
 const selected=await previewTaxBasisRecalculation(ctx,{companyId:b.companyId,year:2026,upToMonth:1,employmentIds:preview.employees.slice(490,510).map(employee=>employee.id)});
 expect(selected.employees.map(employee=>employee.employeeNo)).toEqual(expected.slice(490,510));expect(selected.totals.taxable).toBe(110000);
 await expect(database.withTenant(ctx,tx=>createTaxBasisPreviewReadTx(tx,ctx,['00000000-0000-4000-8000-000000000000']))).rejects.toThrow(/Original payroll source is unavailable/);
 const foreign=await seedBase();await setModule(foreign.tenantId,'payroll','active');const foreignCtx=await entitledCtx(foreign);await expect(database.withTenant(foreignCtx,tx=>createTaxBasisPreviewReadTx(tx,foreignCtx,[preview.employees[0].months[0].payslipId]))).rejects.toThrow(/Original payroll source is unavailable/);await expect(previewTaxBasisRecalculation(await entitledCtx(foreign),{companyId:b.companyId,year:2026,upToMonth:1,employmentIds:null})).rejects.toThrow(/access|authority|unavailable/);
},180000);
