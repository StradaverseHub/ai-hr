/** Source-adapter delegation with mocked native reads/private-analysis boundary, no DB/provider.
 * Actual report/compensation/export authorization belongs to the native owner's independent suites. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SessionContext,Tx} from '../db/client';
import {employment,type CustomReportSpec} from '../db/schema';
import type {PayrollComparisonExecution} from '../core/report-payroll-comparison';
import {DEFAULT_PAYROLL_COMPARISON,PAYROLL_COMPARISON_DATASET,validatePayrollComparisonDefinition,payrollVariance,payrollAmountMinor} from '../lib/payroll-period-comparison';
import {PROVIDER_ANALYSIS_CONTRACT,fingerprintProviderAnalysisSource,prepareProviderAnalysis,inspectPreparedProviderAnalysis,retireProviderAnalysis} from '../lib/ai/provider-analysis-policy';
import {providerDataReviewStatus} from '../lib/ai/provider-data-reviews';
const state=vi.hoisted(()=>({native:vi.fn(),analysis:vi.fn(),config:vi.fn(),tenant:vi.fn()}));
vi.mock('../core/report-payroll-comparison',()=>({executePayrollComparisonTx:state.native}));
vi.mock('../core/ai-governance',()=>({generatePrivateAiAnalysis:state.analysis}));
vi.mock('../core/ai-config',()=>({resolveActiveAiConfig:state.config}));
vi.mock('../db/client',()=>({withTenant:state.tenant}));
import {generatePrivatePayrollComparisonAnalysis} from '../core/ai-payroll-comparison-analysis';
const companyId='20000000-0000-0000-0000-000000000001',departmentId='20000000-0000-0000-0000-000000000002';
const ctx:SessionContext={tenantId:'30000000-0000-0000-0000-000000000001',userId:'30000000-0000-0000-0000-000000000002',roles:['hr_admin'],grants:[{role:'hr_admin',companyId}]};
const scope=[companyId],raw={currentPeriod:'2026-10',previousPeriod:'2026-09',companyId,departmentId,runType:'regular' as const};
const spec=():CustomReportSpec=>({datasetId:PAYROLL_COMPARISON_DATASET,columns:['employeeName','previous','current'],payrollComparison:structuredClone(DEFAULT_PAYROLL_COMPARISON),layout:{permissions:{hr_admin:['view','export']}}});
const id=(prefix:string,index:number)=>`${prefix}0000000-0000-0000-0000-${String(index+1).padStart(12,'0')}`;
function fixture(count=30):PayrollComparisonExecution{
 const definition=validatePayrollComparisonDefinition(DEFAULT_PAYROLL_COMPARISON),rows=Array.from({length:count},(_,index)=>({employmentId:id('4',index),companyId,employeeCode:'PRIVATE-CODE-'+index,employeeName:'PRIVATE-NAME-'+index,
  departmentId,department:'PRIVATE-DEPARTMENT',grade:'PRIVATE-GRADE',company:'PRIVATE-COMPANY',costCentre:'PRIVATE-CENTRE',hireDate:'2000-01-01',exitDate:null,
  currency:'MYR',previous:'123456.78',current:'148148.14',variance:'24691.36',variancePct:'20.00',reason:{reason:'unexplained' as const,effectiveDate:null,evidenceIds:[],multipleChanges:false,prorated:false},
  previousPresent:true,currentPresent:true,sources:[{id:id('6',index),version:1,runId:'PRIVATE-RUN'}]}));
 return{definition,filters:{...raw,minVariance:'0.00',onlyVariances:false,reason:null,page:1,pageSize:200},companyIds:[companyId],sourceRevisions:rows.flatMap(row=>row.sources),contextUnavailable:false,
  result:{available:true,issues:[],provisional:false,runs:[],rows,displayedRows:count,comparisonRows:count,reasonCounts:{} as PayrollComparisonExecution['result']['reasonCounts'],reasonFilterCounts:{} as PayrollComparisonExecution['result']['reasonFilterCounts'],
   summary:{previousHeadcount:count,currentHeadcount:count,joiners:0,leavers:0,unexplained:count,totals:[{currency:'MYR',companyId:null,previous:'987654321.00',current:'1185185185.20',variance:'197530864.20',variancePct:'20.00'}]},page:1,pageSize:200}};
}
function transaction(identities:()=>{employmentId:string;personId:string}[]){
 const where=vi.fn(async(_query:unknown)=>identities()),from=vi.fn(()=>({where})),select=vi.fn((_columns:unknown)=>({from}));
 return{tx:{select} as unknown as Tx,select,from,where};
}
let source:PayrollComparisonExecution,people:{employmentId:string;personId:string}[],initial:ReturnType<typeof transaction>,replay:ReturnType<typeof transaction>,current:SessionContext;
type Aggregate={cohorts:{population:number;metrics:{support:number;changeBand:string}[]}[]};
const configuration={provider:'openai',model:'fictional-model',apiKey:'fictional-not-a-credential'};
beforeEach(()=>{
 for(const mock of Object.values(state))mock.mockReset();source=fixture();people=source.result.rows.map((row,index)=>({employmentId:row.employmentId,personId:id('5',index)}));
 initial=transaction(()=>[]);replay=transaction(()=>people);current={...ctx,roles:[...ctx.roles!]};
 state.tenant.mockImplementation(async(_ctx:SessionContext,call:(tx:Tx)=>unknown)=>call(initial.tx));state.config.mockResolvedValue(configuration);state.native.mockImplementation(async()=>structuredClone(source));
 state.analysis.mockImplementation(async(_configuration:unknown,read:(tx:Tx,ctx:SessionContext)=>Promise<unknown>)=>{await read(replay.tx,current);return 'Fictional untrusted explanation';});
});
const run=(filters:Record<string,unknown>=raw)=>generatePrivatePayrollComparisonAnalysis(ctx,spec(),scope,filters);
const summary=()=>source.result.summary!;

describe('native payroll BASIC private analysis source adapter',()=>{
 it('delegates current config and every complete replay to the same native export owner without broadening company/department scope',async()=>{
  state.analysis.mockImplementation(async(cfg:unknown,read:(tx:Tx,ctx:SessionContext)=>Promise<unknown>)=>{expect(cfg).toBe(configuration);const first=await read(replay.tx,current),second=await read(replay.tx,current);expect(second).toEqual(first);return 'Fictional untrusted explanation';});
  expect(await run({...raw,onlyVariances:true,minVariance:'999.00',reason:'increment',page:7,pageSize:1})).toBe('Fictional untrusted explanation');
  expect(state.config).toHaveBeenCalledWith(initial.tx,ctx,'payroll_explanation');expect(state.tenant).toHaveBeenCalledWith(ctx,expect.any(Function));
  expect(state.native).toHaveBeenCalledTimes(2);
  for(const call of state.native.mock.calls){expect(call[0]).toBe(replay.tx);expect(call[1]).toBe(current);expect(call[2]).toEqual(spec());expect(call[3]).toEqual(scope);expect(call[4]).toEqual({...raw,onlyVariances:false,minVariance:'0',reason:'',page:1,pageSize:200});expect(call[5]).toBe('export');}
  expect(replay.select).toHaveBeenCalledWith({employmentId:employment.id,personId:employment.personId});expect(replay.from).toHaveBeenCalledWith(employment);
  const query=new PgDialect().sqlToQuery(replay.where.mock.calls[0][0] as Parameters<PgDialect['sqlToQuery']>[0]);expect(query.params).toEqual([ctx.tenantId,...source.result.rows.map(row=>row.employmentId)]);
 });
 it('retains a useful native base-pay change band while the real closed projection removes labels, exact values and identity',async()=>{
  state.analysis.mockImplementation(async(_cfg:unknown,read:(tx:Tx,ctx:SessionContext)=>Promise<unknown>)=>{
   const aggregate=await read(replay.tx,current);expect(aggregate).toEqual({version:1,domain:'payroll',window:'calendar_month',cohorts:[{cohort:'cohort_a',population:30,metrics:[{metric:'base_pay_cost',support:30,changeBand:'increase_10_to_25_percent',drivers:[],slices:[]}]}]});
   const binding={feature:'payroll_explanation' as const,operation:'draft' as const,contractId:PROVIDER_ANALYSIS_CONTRACT,principalDigest:'1'.repeat(64),scopeDigest:'2'.repeat(64),providerSnapshotDigest:'3'.repeat(64),sourceFingerprint:fingerprintProviderAnalysisSource(aggregate),expiresAt:Date.now()+60000};
   const prepared=prepareProviderAnalysis(binding,aggregate);try{
    const projection=inspectPreparedProviderAnalysis(prepared,binding),out=JSON.parse(projection.json);expect(projection.reviewStatus).toBe('pending');expect(providerDataReviewStatus(PROVIDER_ANALYSIS_CONTRACT)).toBe('pending');
    expect(out.cohorts[0]).toMatchObject({cohort:'cohort_a',populationBand:'20_to_49',metrics:[{metric:'base_pay_cost',supportBand:'20_to_49',changeBand:'increase_10_to_25_percent',drivers:[],slices:[]}]});
    for(const secret of ['MYR','PRIVATE-','123456.78','987654321.00','2026-10','2026-09',companyId,departmentId,ctx.tenantId,...people.flatMap(person=>[person.employmentId,person.personId])])expect(projection.json).not.toContain(secret);
    expect(projection.json).not.toContain('payroll_cost');expect(out.cohorts[0]).not.toHaveProperty('population');expect(out.cohorts[0].metrics[0]).not.toHaveProperty('support');
   }finally{retireProviderAnalysis(prepared);}
   return 'Fictional protected explanation';
  });expect(await run()).toBe('Fictional protected explanation');
 });
 it('retains the shared percentage band for the native +7.25 percent result without recalculating pay',async()=>{
  Object.assign(summary().totals[0],{previous:'100000.00',current:'107250.00',variance:'7250.00',variancePct:'7.25'});state.analysis.mockImplementation(async(_cfg:unknown,read:(tx:Tx,ctx:SessionContext)=>Promise<unknown>)=>{const aggregate=await read(replay.tx,current) as Aggregate;expect(aggregate.cohorts[0].metrics[0].changeBand).toBe('increase_5_to_10_percent');return 'Explanation';});await run();
 });
 it.each(['0.00','-1.00','not-an-amount'])('refuses a zero/negative/unestablished native previous BASIC baseline: %s',async previous=>{
  summary().totals[0].previous=previous;await expect(run()).rejects.toThrow('private payroll comparison source');
 });
 it('refuses a negative current BASIC aggregate rather than reversing the meaning of its native percentage',async()=>{
  summary().totals[0].current='-1.00';await expect(run()).rejects.toThrow('private payroll comparison source');
 });
 it.each(['available','issues','provisional','context','page','displayed','filtered','minimum','reason','nullPct','invalidPct','unknownCurrency','mixedCurrency','rowCurrency','otherItem'] as const)('refuses incomplete or semantically unsupported native source: %s',kind=>{
  if(kind==='available')source.result.available=false;if(kind==='issues')source.result.issues.push({code:'missingPayroll',period:'2026-09',companyId});if(kind==='provisional')source.result.provisional=true;if(kind==='context')source.contextUnavailable=true;
  if(kind==='page')source.result.rows.pop();if(kind==='displayed')source.result.displayedRows--;if(kind==='filtered')source.filters.onlyVariances=true;if(kind==='minimum')source.filters.minVariance='1.00';if(kind==='reason')source.filters.reason='increment';
  if(kind==='nullPct')summary().totals[0].variancePct=null;if(kind==='invalidPct')summary().totals[0].variancePct='PRIVATE 20%';if(kind==='unknownCurrency')summary().totals[0].currency=null;if(kind==='mixedCurrency')summary().totals.push({...summary().totals[0],currency:'USD'});if(kind==='rowCurrency')source.result.rows[0].currency=null;if(kind==='otherItem')source.definition.payItemCode='BONUS';
  return expect(run()).rejects.toThrow('private payroll comparison source');
 });
 it('counts distinct persons rather than employments or source slices, and refuses small per-period support',async()=>{
  people=people.map((identity,index)=>({...identity,personId:id('5',index%10)}));await expect(run()).rejects.toThrow();
  people=source.result.rows.map((row,index)=>({employmentId:row.employmentId,personId:id('5',index)}));source.result.rows.slice(0,11).forEach(row=>{row.previousPresent=false;});summary().previousHeadcount=19;
  await expect(run()).rejects.toThrow();
 });
 it('derives union-person population and conservative per-period person support while keeping employment counts separate',async()=>{
  source=fixture(40);source.result.rows.slice(0,10).forEach(row=>{row.previousPresent=false;});source.result.rows.slice(30).forEach(row=>{row.currentPresent=false;});summary().previousHeadcount=30;summary().currentHeadcount=30;
  people=source.result.rows.map((row,index)=>({employmentId:row.employmentId,personId:id('5',index===39?38:index)}));
  state.analysis.mockImplementation(async(_cfg:unknown,read:(tx:Tx,ctx:SessionContext)=>Promise<unknown>)=>{const aggregate=await read(replay.tx,current) as Aggregate;expect(aggregate.cohorts[0].population).toBe(39);expect(aggregate.cohorts[0].metrics[0].support).toBe(29);return 'Explanation';});await run();
 });
 it('refuses missing person mapping, inconsistent native employment headcounts and changed replay source even within the same band',async()=>{
  people.pop();await expect(run()).rejects.toThrow();people=source.result.rows.map((row,index)=>({employmentId:row.employmentId,personId:id('5',index)}));summary().previousHeadcount=999;await expect(run()).rejects.toThrow();summary().previousHeadcount=30;
  state.analysis.mockImplementation(async(_cfg:unknown,read:(tx:Tx,ctx:SessionContext)=>Promise<unknown>)=>{await read(replay.tx,current);source.result.rows[0].current='148148.15';return read(replay.tx,current);});await expect(run()).rejects.toThrow('private payroll comparison source');
 });
 it('rechecks export permission on replay and propagates native refusal before requesting an explanation',async()=>{
  state.native.mockResolvedValueOnce(source).mockRejectedValueOnce(Error('Native export denied'));
  state.analysis.mockImplementation(async(_cfg:unknown,read:(tx:Tx,ctx:SessionContext)=>Promise<unknown>)=>{await read(replay.tx,current);await read(replay.tx,current);return 'Must not return';});await expect(run()).rejects.toThrow('Native export denied');expect(state.native).toHaveBeenCalledTimes(2);expect(state.native.mock.calls.every(call=>call[5]==='export')).toBe(true);
 });
 it('captures caller inputs before asynchronous work and never changes company/department scope on later mutation',async()=>{
  const ownSpec=spec(),ownScope=[...scope],ownRaw={...raw};state.config.mockImplementation(async()=>{ownScope.push('PRIVATE-OTHER-COMPANY');ownRaw.companyId='PRIVATE-OTHER-COMPANY';ownRaw.departmentId='PRIVATE-OTHER-DEPARTMENT';ownSpec.payrollComparison!.payItemCode='BONUS';return configuration;});
  await generatePrivatePayrollComparisonAnalysis(ctx,ownSpec,ownScope,ownRaw);expect(state.native.mock.calls[0][2].payrollComparison.payItemCode).toBe('BASIC');expect(state.native.mock.calls[0][3]).toEqual(scope);expect(state.native.mock.calls[0][4].companyId).toBe(companyId);expect(state.native.mock.calls[0][4].departmentId).toBe(departmentId);
 });
 it('refuses missing configuration and non-payroll reports without invoking private analysis',async()=>{
  state.config.mockResolvedValue(null);await expect(run()).rejects.toThrow();expect(state.analysis).not.toHaveBeenCalled();await expect(generatePrivatePayrollComparisonAnalysis(ctx,{...spec(),datasetId:'employees'},scope,raw)).rejects.toThrow();expect(state.analysis).not.toHaveBeenCalled();
 });
 it.each([['10000.00','10000.01','increase_up_to_5_percent'],['10000.00','9999.99','decrease_up_to_5_percent'],['10000.00','10500.01','increase_5_to_10_percent'],['10000.00','9499.99','decrease_5_to_10_percent']])('does not turn native rounded percentages into false unchanged or boundary claims: %s→%s',async(previous,current,expected)=>{
  const native=payrollVariance(payrollAmountMinor(previous),payrollAmountMinor(current));
  Object.assign(summary().totals[0],{previous,current,variance:native.difference,variancePct:native.percentage});
  if(expected.includes('up_to_5'))expect(native.percentage).toBe('0.00');else expect(native.percentage).toBe(expected.startsWith('increase')?'5.00':'-5.00');
  state.analysis.mockImplementation(async(_cfg:unknown,read:(tx:Tx,ctx:SessionContext)=>Promise<unknown>)=>{const aggregate=await read(replay.tx,currentCtx) as Aggregate;expect(aggregate.cohorts[0].metrics[0].changeBand).toBe(expected);return 'Protected comparison';});
  const currentCtx=ctx;await run();
 });

});
