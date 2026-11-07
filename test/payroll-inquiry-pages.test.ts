/** Native count/page/filter parity. Fictional rows, unchanged Payroll history and company gates. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import * as moduleGate from '../core/module-gate';
import {lockPayrollHistoryWriteTx} from '../core/payroll-history-lock';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch,generatePayslips} from '../core/payroll';
import {createIndividualTxn} from '../core/payroll-individual-txn';
import {seedPayComponentCatalog,listPayComponents,setEmploymentPayComponent} from '../core/pay-components';
import {listFixedTransactionsAcross,listFixedTransactionsPage,listIndividualTxnsAcross,listIndividualTxnsPage} from '../core/payroll-view';
import {parsePageQuery} from '../lib/pagination';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const hire=(name:string,companyId=b.companyId,departmentId=b.deptA)=>hireEmployee(adminCtx(b),{
 person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId,departmentId,employmentType:'full_time',hiredOn:'2010-01-01',
});
async function secondCompany(){
 const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional excluded company'}).returning();
 const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Excluded department'}).returning();
 return {companyId:company.id,departmentId:department.id};
}

it('keeps both native page roots READ COMMITTED and READ ONLY after their normal Payroll gate',async()=>{
 const a=adminCtx(b),employee=await hire('Fictional read mode employee');
 await seedPayComponentCatalog(a);const component=(await listPayComponents(a)).find(row=>row.code==='ALLOWANCE')!;
 const fixed=await setEmploymentPayComponent(a,{employmentId:employee.employmentId,componentId:component.id,amount:123.45,effectiveFrom:'2026-01-01'});
 const batch=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'});
 const individual=await createIndividualTxn(a,{batchId:batch.batchId,employmentId:employee.employmentId,kind:'earning',txnDate:'2026-05-10',amount:12.25});
 const actual=moduleGate.withPayrollTenant,modes:{isolation:string;readonly:string;role:string}[]=[];
 const spy=vi.spyOn(moduleGate,'withPayrollTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof actual>[2])=>actual(ctx,async tx=>{
  const result=await read(tx);
  const [mode]=await tx.execute<{isolation:string;readonly:string;role:string}>(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as readonly,current_user as role`);
  modes.push(mode);return result;
 },options));
 try{
  expect((await listFixedTransactionsPage(a,{companyIds:[b.companyId]},parsePageQuery())).rows.map(row=>row.id)).toEqual([fixed.id]);
  expect((await listIndividualTxnsPage(a,{companyIds:[b.companyId]},parsePageQuery())).rows.map(row=>row.id)).toEqual([individual.id]);
  expect(modes).toEqual([{isolation:'read committed',readonly:'on',role:'ai_hr_app'},{isolation:'read committed',readonly:'on',role:'ai_hr_app'}]);
 }finally{spy.mockRestore();}
});

it('sees the committed correction after actually waiting for the native history writer barrier',async()=>{
 const a=adminCtx(b),employee=await hire('Fictional history barrier employee');
 const batch=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'});
 const initial=await createIndividualTxn(a,{batchId:batch.batchId,employmentId:employee.employmentId,kind:'earning',txnDate:'2026-05-10',amount:12.25});
 let entered!:()=>void,release!:()=>void,pid=0;
 const ready=new Promise<void>(yes=>{entered=yes;}),resume=new Promise<void>(yes=>{release=yes;});
 const writing=owner.db.transaction(async tx=>{
  await lockPayrollHistoryWriteTx(tx,b.tenantId);
  const [backend]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);pid=backend.pid;
  await tx.update(s.payrollIndividualTxn).set({amount:'13.50'}).where(eq(s.payrollIndividualTxn.id,initial.id));
  entered();await resume;
 });void writing.catch(()=>undefined);
 let reading:ReturnType<typeof listIndividualTxnsPage>|undefined;
 try{
  await Promise.race([ready,writing.then(()=>{throw Error('Writer did not hold the history barrier.');})]);
  reading=listIndividualTxnsPage(a,{companyIds:[b.companyId]},parsePageQuery());void reading.catch(()=>undefined);
  let waiting=false;
  for(let n=0;n<250&&!waiting;n++){
   const [state]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity q where ${pid}=any(pg_blocking_pids(q.pid)) and q.wait_event_type='Lock') as waiting`);
   waiting=state.waiting;if(!waiting)await new Promise(yes=>setTimeout(yes,10));
  }
  expect(waiting,'The real page reader must wait on the held history writer, not infer ordering from elapsed time.').toBe(true);
  release();await writing;
  const page=await reading;expect(page.total).toBe(1);expect(page.rows.map(row=>[row.id,row.amount])).toEqual([[initial.id,'13.50']]);
 }finally{release();await writing;await reading;}
});

it('pages Fixed rows in native order with exact strings, full counts, status and company filters',async()=>{
 const a=adminCtx(b),employee=await hire('Fictional fixed employee'),other=await secondCompany();
 const foreign=await hire('Fictional excluded fixed',other.companyId,other.departmentId);
 await seedPayComponentCatalog(a);const component=(await listPayComponents(a)).find(row=>row.code==='ALLOWANCE')!;
 const initial=await setEmploymentPayComponent(a,{employmentId:employee.employmentId,componentId:component.id,amount:123.45,effectiveFrom:'2020-01-01',effectiveTo:'2020-01-31'});
 const [prototype]=await owner.db.select().from(s.employmentPayComponent).where(eq(s.employmentPayComponent.id,initial.id));
 const ids=[initial.id,...Array.from({length:50},()=>randomUUID())];
 await owner.db.insert(s.employmentPayComponent).values(ids.slice(1).map((id,i)=>({...prototype,id,validFrom:`${2021+i}-01-01`,validTo:`${2021+i}-01-31`,amount:(i+1)+'.25'})));
 await setEmploymentPayComponent(a,{employmentId:foreign.employmentId,componentId:component.id,amount:999,effectiveFrom:'2020-01-01',effectiveTo:'2020-01-31'});
 const p={companyIds:[b.companyId]},all=await listFixedTransactionsAcross(a,p);
 expect(all.map(row=>row.id)).toEqual(ids);
 const first=await listFixedTransactionsPage(a,p,parsePageQuery()),second=await listFixedTransactionsPage(a,p,parsePageQuery({page:'1'}));
 expect(first.total).toBe(51);expect(second.total).toBe(51);
 expect(first.rows).toEqual(all.slice(0,25));expect(second.rows).toEqual(all.slice(25,50));
 expect(first.rows[0].amount).toBe('123.45');expect(typeof first.rows[0].amount).toBe('string');
 const ended=all.filter(row=>row.validTo!==null&&row.validTo<todayInKualaLumpur());
 expect(await listFixedTransactionsPage(a,{...p,status:'ended'},parsePageQuery({size:'all'}))).toEqual({total:ended.length,rows:ended});
 expect(await listFixedTransactionsPage(a,{companyIds:[]},parsePageQuery())).toEqual({rows:[],total:0});
 expect(await listFixedTransactionsPage(a,p,parsePageQuery({page:'100'}))).toEqual({rows:[],total:51});
 expect(await listFixedTransactionsPage(a,{...p,componentId:randomUUID()},parsePageQuery())).toEqual({rows:[],total:0});
});

it('transports a bounded Individual page from retained rows and keeps count, quantity and all-page truth',async()=>{
 const a=adminCtx(b),employee=await hire('Fictional individual employee'),other=await secondCompany();
 const foreign=await hire('Fictional excluded individual',other.companyId,other.departmentId);
 const batch=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'}),foreignBatch=await createBatch(a,{companyId:other.companyId,payPeriod:'2026-05'});
 const initial=await createIndividualTxn(a,{batchId:batch.batchId,employmentId:employee.employmentId,kind:'earning',txnDate:'2026-05-10',amount:12.25});
 const [prototype]=await owner.db.select().from(s.payrollIndividualTxn).where(eq(s.payrollIndividualTxn.id,initial.id));
 const retained=Array.from({length:2051},(_,i)=>({...prototype,id:randomUUID(),amount:(i+1)+'.25',quantity:'1.50',unit:'hours',notes:'Fictional retained transaction note. '.repeat(15)}));
 retained[0].amount='9999999999.99';retained[1].amount='9999999999.98';
 for(let i=0;i<retained.length;i+=200)await owner.db.insert(s.payrollIndividualTxn).values(retained.slice(i,i+200));
 await createIndividualTxn(a,{batchId:foreignBatch.batchId,employmentId:foreign.employmentId,kind:'earning',txnDate:'2026-05-10',amount:999});
 const p={companyIds:[b.companyId],year:2026,month:5},expectedIds=[initial.id,...retained.map(row=>row.id)].sort();
 const [{count:before}]=await owner.db.select({count:sql<number>`count(*)::int`}).from(s.domainEvent);
 const began=performance.now(),page=await listIndividualTxnsPage(a,p,parsePageQuery()),elapsedMs=performance.now()-began;
 expect(page.total).toBe(2052);expect(page.rows.map(row=>row.id)).toEqual(expectedIds.slice(0,25));
 const next=await listIndividualTxnsPage(a,p,parsePageQuery({page:'1'}));
 expect(next.rows.map(row=>row.id)).toEqual(expectedIds.slice(25,50));expect(next.total).toBe(2052);
 const maximum=await listIndividualTxnsPage(a,p,parsePageQuery(),{key:'amount',direction:'desc'});
 expect(maximum.rows.slice(0,2).map(row=>[row.id,row.amount])).toEqual([[retained[0].id,'9999999999.99'],[retained[1].id,'9999999999.98']]);
 // numeric(12,2)'s valid boundary cents are distinct even under the prior JS comparator.
 expect(Number(retained[0].amount)).toBeGreaterThan(Number(retained[1].amount));
 const amounts=new Map([[initial.id,'12.25'],...retained.map(row=>[row.id,row.amount] as [string,string])]);
 for(const row of page.rows){expect(row.amount).toBe(amounts.get(row.id));expect(typeof row.amount).toBe('string');if(row.id!==initial.id)expect(row.quantity).toBe('1.50');}
 const allPage=await listIndividualTxnsPage(a,p,parsePageQuery({size:'all'}));expect(allPage.rows).toHaveLength(2000);expect(allPage.total).toBe(2052);
 expect(await listIndividualTxnsPage(a,p,parsePageQuery({page:'10000'}))).toEqual({rows:[],total:2052});
 expect(await listIndividualTxnsPage(a,{...p,month:6},parsePageQuery())).toEqual({rows:[],total:0});
 expect(await listIndividualTxnsPage(a,{...p,departmentId:other.departmentId},parsePageQuery())).toEqual({rows:[],total:0});
 expect(await listIndividualTxnsPage(a,{companyIds:[]},parsePageQuery())).toEqual({rows:[],total:0});
 const creatorPage=await listIndividualTxnsPage(a,{...p,createdBy:b.adminUserId},parsePageQuery());expect(creatorPage.total).toBe(1);expect(creatorPage.rows[0].id).toBe(initial.id);
 const [{count:after}]=await owner.db.select({count:sql<number>`count(*)::int`}).from(s.domainEvent);expect(after).toBe(before);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-inquiry-native-page.json'),JSON.stringify({kind:'NATIVE_PAYROLL_INQUIRY_PAGE_COMPONENT_ONLY',releaseEligible:false,retainedRows:2052,transportedRows:page.rows.length,elapsedMs,scopeAndExactAmounts:true,allCeiling:2000,totalStill2052:true},null,2));
});

it('uses an explicit native full-set Unicode order while preserving row membership',async()=>{
 const a=adminCtx(b),names=['Fictional \uFF21','Fictional \u{10400}'];
 const employees=await Promise.all(names.map(name=>hire(name)));
 const batch=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'});
 const rows=[];
 for(const [i,employee]of employees.entries())rows.push(await createIndividualTxn(a,{batchId:batch.batchId,employmentId:employee.employmentId,kind:i===0?'earning':'deduction',txnDate:'2026-05-10',amount:i+1}));
 const p={companyIds:[b.companyId]},page=await listIndividualTxnsPage(a,p,parsePageQuery(),{key:'employeeName',direction:'asc'});
 expect(page.total).toBe(2);expect(page.rows.map(row=>row.id)).toEqual(rows.map(row=>row.id));
 // The original browser compared UTF-16 code units: a Deseret astral letter preceded the BMP fullwidth Latin letter.
 const legacy=[...page.rows].sort((x,y)=>x.employeeName.toLowerCase()<y.employeeName.toLowerCase()?-1:1);
 expect(legacy.map(row=>row.id)).toEqual([...rows].reverse().map(row=>row.id));
 expect(new Set(page.rows.map(row=>row.id))).toEqual(new Set(legacy.map(row=>row.id)));
 const kinds=await listIndividualTxnsPage(a,p,parsePageQuery(),{key:'kind',direction:'asc'});
 expect(kinds.rows.map(row=>row.kind)).toEqual(['deduction','earning']);
});

it('filters Processed and Pending reprocessing before LIMIT using the native payslip facts',async()=>{
 const a=adminCtx(b),employee=await hire('Fictional reprocess employee');
 await setCompensation(a,{employmentId:employee.employmentId,basicSalary:3000,monthlyAllowance:0,effectiveFrom:'2026-01-01'});
 await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234'});
 const batch=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'});
 const before=await createIndividualTxn(a,{batchId:batch.batchId,employmentId:employee.employmentId,kind:'earning',txnDate:'2026-05-10',amount:100});
 await generatePayslips(a,{batchId:batch.batchId});
 const after=await createIndividualTxn(a,{batchId:batch.batchId,employmentId:employee.employmentId,kind:'earning',txnDate:'2026-05-11',amount:200});
 const p={companyIds:[b.companyId],employmentId:employee.employmentId};
 const processed=await listIndividualTxnsPage(a,{...p,batchStatus:'processed'},parsePageQuery());
 const reprocess=await listIndividualTxnsPage(a,{...p,batchStatus:'reprocess'},parsePageQuery());
 expect(processed.total).toBe(1);expect(processed.rows.map(row=>[row.id,row.reprocessRequired])).toEqual([[before.id,false]]);
 expect(reprocess.total).toBe(1);expect(reprocess.rows.map(row=>[row.id,row.reprocessRequired])).toEqual([[after.id,true]]);
 const legacy=await listIndividualTxnsAcross(a,p);expect(new Map(legacy.map(row=>[row.id,row.reprocessRequired]))).toEqual(new Map([[before.id,false],[after.id,true]]));
});
