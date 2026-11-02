/** AI Centre issue 13b — pay averages computed by the payroll service (packs/payroll/pay-averages.ts) and read by the
 * harness as `pay_aggregates`. Owner decision 3 November 2026: "Yes, averages only".
 *
 * Pure part: the statistics and every suppression rule, against expectations computed by hand from fictional cents
 * (rounding: averages half up to the cent, medians half up to the nearest 10). Database part: the real read as the
 * caller under RLS on fictional fixtures (test/review/review-actors.ts): the latest closed regular run only, the
 * Basic figure the payslip prints, suppression after those filters, payroll access only, company and tenant isolation,
 * and, through the harness with a scripted model, no individual or exact figure in the model input or the trace. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {figuresOf,payAverageCells,payAverages,suppressChildren,type PayAverageCompanyInput,type PayAverageRow,type PayAverages} from '../packs/payroll/service';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {scriptedModel,type ScriptStep} from './harness-ratchet/scripted-model';
import {buildMatrix,type Actor,type Matrix} from './review/review-actors';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,setModule,type Base} from './harness';

const C1='00000000-0000-4000-8000-0000000000c1',C2='00000000-0000-4000-8000-0000000000c2',C3='00000000-0000-4000-8000-0000000000c3';
const company=(companyId:string,name:string,currency='MYR',payPeriod:string|null='2026-09'):PayAverageCompanyInput=>({companyId,company:name,currency,payPeriod});
/** One row per value, each a different person. */
const people=(companyId:string,departmentKey:string|null,cents:readonly number[]):PayAverageRow[]=>cents.map(value=>({companyId,personId:randomUUID(),departmentKey,cents:value}));
const sized=(companyId:string,departmentKey:string|null,count:number,from=300_000)=>people(companyId,departmentKey,Array.from({length:count},(_,index)=>from+index*1_013+(index*index)%7));
const NAMES=new Map([['d-a','Fictional Assembly'],['d-b','Fictional Bindery'],['d-c','Fictional Coating'],['d-d','Fictional Dispatch']]);
type Row=PayAverages['companies'][number];
const departments=(row:Row|undefined)=>(row&&'departments' in row?row.departments??[]:[]).map(cell=>[cell.department,cell.status,'withheldBecause' in cell?cell.withheldBecause:null]);
const statusOf=(result:PayAverages)=>result.companies.map(row=>[row.company,row.status,'withheldBecause' in row?row.withheldBecause:null]);

// Fictional basic pay in cents. Expected figures below were computed by hand from these values.
const A=[310137,325042,298811,412590,356277,287903],B=[505011,498733,512399,487265,530146],C=[221055,234567,219821,240289,228734];

describe('pay average statistics (pure)',()=>{
 it('computes headcount, average and median against hand-computed values',()=>{
  // A: sum 1990760 / 6 = 331793.33 -> 3317.93; middle pair (310137+325042)/2 = 3175.895 -> nearest 10 = 3180.00.
  expect(figuresOf(A)).toEqual({headcount:6,average:'3317.93',median:'3180.00'});
  // B: sum 2533554 / 5 = 506710.8 -> 5067.11; middle 5050.11 -> 5050.00, never the middle person's exact pay.
  expect(figuresOf(B)).toEqual({headcount:5,average:'5067.11',median:'5050.00'});
  expect(figuresOf([...A,...B])).toEqual({headcount:11,average:'4113.01',median:'4130.00'});
  // Half up at both roundings: 1.005 average and a 1005.00 median.
  expect(figuresOf([100,100,100,101,101,101,100,101])).toEqual({headcount:8,average:'1.01',median:'0.00'});
  expect(figuresOf([100_000,100_200,100_400,101_000,101_100])).toMatchObject({median:'1000.00'});
  expect(figuresOf([100_000,100_200,100_500,101_000,101_100])).toMatchObject({median:'1010.00'});
 });
 it('publishes groups of five and suppresses groups of four',()=>{
  const five=payAverageCells([company(C1,'Fictional One')],[...people(C1,'d-a',B),...sized(C1,'d-b',5),...sized(C1,'d-c',10)],NAMES,'department');
  expect(departments(five.companies[0])).toEqual([['Fictional Assembly','published',null],['Fictional Bindery','published',null],['Fictional Coating','published',null]]);
  const four=payAverageCells([company(C1,'Fictional One')],[...people(C1,'d-a',B),...sized(C1,'d-b',4),...sized(C1,'d-c',10)],NAMES,'department');
  // The four-person group is withheld; being the only one, the smallest published group (five) is withheld with it.
  expect(departments(four.companies[0])).toEqual([['Fictional Assembly','suppressed','protects_another_group'],['Fictional Bindery','suppressed','fewer_than_minimum'],['Fictional Coating','published',null]]);
  expect(four.companies[0]).toMatchObject({status:'published',headcount:19});
  const cell=four.companies[0] as unknown as {departments:readonly Record<string,unknown>[]};
  for(const hidden of cell.departments.filter(row=>row.status==='suppressed'))expect(Object.keys(hidden).sort()).toEqual(['department','status','withheldBecause']);
 });
 it('withholds a department whose complement in its company is one to four people',()=>{
  const two=payAverageCells([company(C1,'Fictional One')],[...sized(C1,'d-a',10),...sized(C1,'d-b',3)],NAMES,'department');
  expect(departments(two.companies[0])).toEqual([['Fictional Assembly','suppressed','complement_too_small'],['Fictional Bindery','suppressed','fewer_than_minimum']]);
  // The complement may be spread over several small departments.
  const spread=payAverageCells([company(C1,'Fictional One')],[...sized(C1,'d-a',10),...sized(C1,'d-b',2),...sized(C1,'d-c',2)],NAMES,'department');
  expect(departments(spread.companies[0]).map(row=>row[2])).toEqual(['complement_too_small','fewer_than_minimum','fewer_than_minimum']);
  // People with no single current department are a group like any other, listed last.
  const unassigned=payAverageCells([company(C1,'Fictional One')],[...sized(C1,'d-a',10),...sized(C1,null,2)],NAMES,'department');
  expect(departments(unassigned.companies[0])).toEqual([['Fictional Assembly','suppressed','complement_too_small'],[null,'suppressed','fewer_than_minimum']]);
 });
 it('never leaves exactly one withheld group, nor withheld groups holding fewer than five people together',()=>{
  const single=suppressChildren(29,[{key:'a',people:20},{key:'b',people:6},{key:'c',people:3}]);
  expect([...single]).toEqual([['c','fewer_than_minimum'],['b','protects_another_group']]);
  // Two withheld groups of 1 and 2 people would let the company total minus the rest describe 3 people.
  const union=suppressChildren(33,[{key:'a',people:20},{key:'b',people:10},{key:'c',people:1},{key:'d',people:2}]);
  expect([...union]).toEqual([['c','fewer_than_minimum'],['d','fewer_than_minimum'],['b','protects_another_group']]);
  expect([...suppressChildren(30,[{key:'a',people:10},{key:'b',people:10},{key:'c',people:10}])]).toEqual([]);
  // The published groups and the parent never let a withheld group be derived: what the parent minus the published
  // groups leaves is the withheld groups together, always at least two holding at least five people.
  for(const sizes of [[20,6,3],[5,5,4],[10,1,2,2],[7,7,7,1],[12,4],[30,5,1,1,1,1]]){
   const parent=sizes.reduce((sum,size)=>sum+size,0),out=suppressChildren(parent,sizes.map((people,index)=>({key:'k'+index,people})));
   const held=sizes.filter((_,index)=>out.has('k'+index));
   if(held.length)expect(held.length>=2&&held.reduce((sum,size)=>sum+size,0)>=5,String(sizes)).toBe(true);
  }
 });
 it('applies the same rules to companies within the combined total, and withholds every department of a withheld company',()=>{
  const companies=[company(C1,'Fictional One'),company(C2,'Fictional Two')];
  const small=payAverageCells(companies,[...people(C1,'d-a',A),...people(C1,'d-b',B),...sized(C2,'d-c',3)],NAMES,'department');
  expect(statusOf(small)).toEqual([['Fictional One','suppressed','complement_too_small'],['Fictional Two','suppressed','fewer_than_minimum']]);
  expect(small.overall).toMatchObject({status:'published',currency:'MYR',headcount:14});
  expect(departments(small.companies[0])).toEqual([['Fictional Assembly','suppressed','company_suppressed'],['Fictional Bindery','suppressed','company_suppressed']]);
  const three=payAverageCells([...companies,company(C3,'Fictional Three')],[...sized(C1,'d-a',12),...sized(C2,'d-b',6),...sized(C3,'d-c',2)],NAMES,'company');
  expect(statusOf(three)).toEqual([['Fictional One','published',null],['Fictional Two','suppressed','protects_another_group'],['Fictional Three','suppressed','fewer_than_minimum']]);
  // A combined total of four people publishes nothing.
  expect(payAverageCells(companies,[...sized(C1,'d-a',2),...sized(C2,'d-b',2)],NAMES,'company').overall).toEqual({currency:'MYR',status:'suppressed',withheldBecause:'fewer_than_minimum'});
 });
 it('does not combine currencies, and lists a company with no closed run without figures',()=>{
  const result=payAverageCells([company(C1,'Fictional One'),company(C2,'Fictional Two','SGD'),company(C3,'Fictional Three','MYR',null)],
   [...people(C1,'d-a',A),...people(C1,'d-b',B),...sized(C2,'d-c',3)],NAMES,'company');
  expect(result.overall).toEqual({status:'not_combined',withheldBecause:'mixed_currencies'});
  // With no published total there is nothing to difference against: only the small company is withheld.
  expect(statusOf(result)).toEqual([['Fictional One','published',null],['Fictional Two','suppressed','fewer_than_minimum'],['Fictional Three','no_closed_run',null]]);
  expect(result.companies[0]).toMatchObject({headcount:11,average:'4113.01',median:'4130.00'});
 });
 it('lets a filter select companies but never change a figure or a decision',()=>{
  const companies=[company(C1,'Fictional One'),company(C2,'Fictional Two')],rows=[...people(C1,'d-a',A),...people(C1,'d-b',B),...sized(C2,'d-c',3)];
  const whole=payAverageCells(companies,rows,NAMES,'department'),one=payAverageCells(companies,rows,NAMES,'department',new Set([C1]));
  expect(one.companies).toEqual([whole.companies[0]]);expect(one.companies[0]).toMatchObject({status:'suppressed',withheldBecause:'complement_too_small'});
  // The total stays every company in scope: a filtered total minus a published company would describe the withheld one.
  expect(one.overall).toEqual(whole.overall);
 });
 it('counts a person once per company, summing their payslips, with a department only when all agree',()=>{
  const person=randomUUID(),rows:PayAverageRow[]=[...sized(C1,'d-a',5),{companyId:C1,personId:person,departmentKey:'d-a',cents:100_000},{companyId:C1,personId:person,departmentKey:'d-b',cents:50_000}];
  const result=payAverageCells([company(C1,'Fictional One')],rows,NAMES,'department');
  expect(result.companies[0]).toMatchObject({headcount:6});
  expect(departments(result.companies[0]).map(row=>row[0])).toEqual(['Fictional Assembly',null]);
 });
 it('returns no individual figure: an odd group\'s median is rounded and no figure equals one person\'s pay',()=>{
  const result=payAverageCells([company(C1,'Fictional One'),company(C2,'Fictional Two')],[...people(C1,'d-a',A),...people(C1,'d-b',B),...people(C2,'d-c',C)],NAMES,'department');
  const text=JSON.stringify(result);
  for(const value of [...A,...B,...C])for(const form of [String(value),(value/100).toFixed(2)])expect(text,form).not.toContain(form);
  expect(result.overall).toEqual({currency:'MYR',status:'published',headcount:16,average:'3542.99',median:'3180.00'});
  expect(result.companies[1]).toMatchObject({status:'published',headcount:5,average:'2288.93',median:'2290.00'});
 });
});

// ─── Database: the real read, as the caller ───────────────────────────────────────────────────────────────────────
let m:Matrix;
const RUN='2026-09',OLDER='2026-08',DRAFT='2026-10';
type Hired={employmentId:string;personId:string};
async function hire(base:Base,companyId:string,departmentId:string,label:string):Promise<Hired>{
 return hireEmployee(adminCtx(base),{person:{fullName:'Fictional Pay '+label,primaryEmail:randomUUID()+'@pay-averages.test'},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
}
/** Hired one after another: employee codes are allocated per company. */
async function hireAll(base:Base,companyId:string,departmentId:string,prefix:string,count:number):Promise<Hired[]>{
 const out:Hired[]=[];for(let index=0;index<count;index++)out.push(await hire(base,companyId,departmentId,prefix+index));return out;
}
async function period(base:Base,companyId:string,value:string){
 const [found]=await owner.db.select({id:schema.payPeriod.id}).from(schema.payPeriod).where(and(eq(schema.payPeriod.companyId,companyId),eq(schema.payPeriod.period,value)));
 if(found)return found.id;
 const [row]=await owner.db.insert(schema.payPeriod).values({tenantId:base.tenantId,companyId,period:value,status:'closed'}).returning({id:schema.payPeriod.id});return row.id;
}
type Slip=Readonly<{employmentId:string;basic:string;display?:number}>;
async function run(base:Base,companyId:string,value:string,slips:readonly Slip[],options:Readonly<{status?:'draft'|'processed'|'closed';runType?:'regular'|'off_cycle';runSeq?:number}>={}){
 const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:base.tenantId,companyId,payPeriodId:await period(base,companyId,value),payPeriod:value,batchDate:value+'-25',
  status:options.status??'closed',runType:options.runType??'regular',runSeq:options.runSeq??1}).returning({id:schema.payrollBatch.id});
 for(const slip of slips)await owner.db.insert(schema.payslip).values({tenantId:base.tenantId,batchId:batch.id,employmentId:slip.employmentId,basicSalary:slip.basic,grossPay:slip.basic,
  statutory:slip.display===undefined?{}:{displayEarnings:{basic:slip.display,allowance:0,overtime:0,bonus:0,claim:0}},totalDeductions:'0',netPay:slip.basic,employerCost:slip.basic});
 return batch.id;
}
const money=(cents:number)=>(cents/100).toFixed(2);
type Fixture={deptA:Hired[];deptB:Hired[];c2:Hired[];all:readonly number[]};
/** Company 1: six people in department A and six in B, of whom five are on the latest closed regular run; company 2:
 * five people. Older, draft and off-cycle runs carry figures that must never be read. Another tenant has its own run. */
async function fixture(onLatestB=B.length):Promise<Fixture>{
 const {b,b2,company2,dept2}=m;
 const deptA=await hireAll(b,b.companyId,b.deptA,'A',A.length),deptB=await hireAll(b,b.companyId,b.deptB,'B',B.length+1),c2=await hireAll(b,company2,dept2,'C',C.length);
 // The first department A payslip prints a re-categorised Basic (displayEarnings) different from its stored column.
 await run(b,b.companyId,RUN,[...A.map((value,index)=>index===0?{employmentId:deptA[index].employmentId,basic:'3000.00',display:value/100}:{employmentId:deptA[index].employmentId,basic:money(value)}),
  ...B.slice(0,onLatestB).map((value,index)=>({employmentId:deptB[index].employmentId,basic:money(value)}))]);
 const ignored=(people:readonly Hired[])=>people.map(person=>({employmentId:person.employmentId,basic:'9876.54'}));
 await run(b,b.companyId,OLDER,ignored([...deptA,...deptB]));
 await run(b,b.companyId,DRAFT,ignored([...deptA,...deptB]),{status:'processed'});
 await run(b,b.companyId,RUN,ignored(deptA),{runType:'off_cycle',runSeq:2});
 await run(b,company2,RUN,C.map((value,index)=>({employmentId:c2[index].employmentId,basic:money(value)})));
 const other=await hireAll(b2,b2.companyId,b2.deptA,'Other',5);
 await run(b2,b2.companyId,RUN,other.map(person=>({employmentId:person.employmentId,basic:'4321.09'})));
 return{deptA,deptB,c2,all:[...A,...B,...C]};
}
const ok=(result:Awaited<ReturnType<typeof payAverages>>):PayAverages=>{if(!result.ok)throw Error('Refused: '+result.message);return result;};
/** The actor's session with the tenant's current modules (setModule after the matrix was built). */
const session=async(actor:Actor):Promise<SessionContext>=>({...actor.ctx,entitlements:(await entitledCtx(actor.ctx.tenantId===m.b.tenantId?m.b:m.b2)).entitlements});

describe('pay averages over the payroll owner, as the caller',()=>{
 beforeAll(migrateTestDb);afterAll(closeAll);
 beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-pay-averages-passphrase');await resetDb();m=await buildMatrix();
  for(const tenant of [m.b.tenantId,m.b2.tenantId])for(const code of ['assistant','payroll'])await setModule(tenant,code,'active');});

 it('reads only the latest closed regular run, the Basic the payslip prints, by company and department',async()=>{
  await fixture();
  const result=ok(await payAverages(await session(m.groupAdmin),{breakdown:'department'}));
  expect(result.measure).toBe('basic_pay_paid');expect(result.measureLabel).toMatch(/latest closed regular payroll run/);
  expect(result.overall).toEqual({currency:'MYR',status:'published',headcount:16,average:'3542.99',median:'3180.00'});
  expect(result.companies).toEqual([
   {companyId:m.b.companyId,company:'Acme Sdn Bhd',currency:'MYR',payPeriod:RUN,status:'published',headcount:11,average:'4113.01',median:'4130.00',departments:[
    {department:'Finance',status:'published',headcount:6,average:'3317.93',median:'3180.00'},
    {department:'Operations',status:'published',headcount:5,average:'5067.11',median:'5050.00'}]},
   {companyId:m.company2,company:'Fictional Second Company Sdn Bhd',currency:'MYR',payPeriod:RUN,status:'published',headcount:5,average:'2288.93',median:'2290.00',departments:[
    {department:'Fictional Second Department',status:'published',headcount:5,average:'2288.93',median:'2290.00'}]},
  ]);
 });
 it('suppresses after those filters: four people on the latest run are withheld, with the department they would reveal',async()=>{
  // Closed payslips cannot be deleted (app.guard_closed_payslip), so this fixture puts only four of B on the latest run.
  await fixture(4);
  const result=ok(await payAverages(await session(m.groupAdmin),{breakdown:'department'}));
  // Department B keeps six employments and payslips on other runs; only four are on the latest closed regular run.
  const first=result.companies[0] as unknown as {departments:readonly Record<string,unknown>[]};
  expect(result.companies[0]).toMatchObject({status:'published',headcount:10,average:'3994.17',median:'3840.00'});
  expect(first.departments.map(row=>[row.status,row.withheldBecause]).sort()).toEqual([['suppressed','complement_too_small'],['suppressed','fewer_than_minimum']]);
  expect(JSON.stringify(first.departments)).not.toMatch(/headcount|average|median/);
 });
 it('refuses everyone without payroll access, and a session claiming access the database does not hold',async()=>{
  await fixture();
  for(const actor of [m.employee,m.manager,m.colleague,m.delegate])expect(await payAverages(await session(actor)),actor.name).toMatchObject({ok:false,refusal:'not_permitted'});
  const forged={...await session(m.employee),roles:['payroll_partner'],grants:[{role:'payroll_partner',companyId:null}]} as SessionContext;
  expect(await payAverages(forged)).toMatchObject({ok:false,refusal:'not_permitted'});
  const capability=TERAS_CAPABILITIES.find(row=>row.name==='pay_aggregates')!;
  expect(capability).toMatchObject({module:'payroll',admin:false,access:'payroll'});
  expect(await capability.run(await session(m.employee),{},{companyId:m.b.companyId})).toMatchObject({ok:false,refusal:'not_permitted'});
 });
 it('keeps each caller to the companies whose payroll they administer, and each tenant to its own',async()=>{
  await fixture();
  const names=async(actor:Actor)=>ok(await payAverages(await session(actor))).companies.map(row=>row.company);
  expect(await names(m.payroll)).toEqual(['Acme Sdn Bhd','Fictional Second Company Sdn Bhd']);
  expect(await names(m.companyAdmin)).toEqual(['Acme Sdn Bhd']);
  expect(await names(m.otherCompanyAdmin)).toEqual(['Fictional Second Company Sdn Bhd']);
  // A company-scoped administrator's total is their own scope; it is not the group's.
  expect(ok(await payAverages(await session(m.companyAdmin))).overall).toMatchObject({headcount:11,average:'4113.01'});
  // A company outside the scope is refused with the same words as no access at all, so it confirms nothing.
  const outside=await payAverages(await session(m.companyAdmin),{companyIds:[m.company2]}),none=await payAverages(await session(m.employee));
  expect(outside).toEqual(none);
  const other=ok(await payAverages(await session(m.otherTenant)));
  expect(other.companies).toEqual([expect.objectContaining({companyId:m.b2.companyId,status:'published',headcount:5,average:'4321.09'})]);
  for(const text of [m.b.companyId,m.company2,'Second Company','4113','3542','2288'])expect(JSON.stringify(other)).not.toContain(text);
  // A company whose payroll module is off is out of scope too.
  // Module rows only grant (core/entitlements.ts): payroll off tenant-wide, on for the first company alone.
  await setModule(m.b.tenantId,'payroll','disabled');await setModule(m.b.tenantId,'payroll','active',m.b.companyId);
  expect(await names(m.groupAdmin)).toEqual(['Acme Sdn Bhd']);
 });

 const turn=async(ctx:SessionContext,question:string,script:readonly ScriptStep[])=>{const model=scriptedModel(script);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question,scope:{companyId:m.b.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  return{result,model};};
 const lastToolResult=(request:ModelRequest):Record<string,unknown>=>{
  const tool=[...request.messages].reverse().find(message=>message.role==='tool');if(!tool)throw Error('No tool result sent.');
  return JSON.parse((tool.content as string).split('\n').slice(1,-1).join('\n'));
 };
 it('reaches the model only as placeholders and bands, and the person sees the exact figure',async()=>{
  const {deptA,deptB,c2,all}=await fixture();
  let placeholder='';
  const {result,model}=await turn(await session(m.payroll),'What is the average basic pay in each department?',[{calls:[{name:'pay_aggregates',args:{breakdown:'department'}}]},
   request=>{const sent=lastToolResult(request) as {companies:{company:string;average:string}[]};
    expect(sent.companies[0].company).toBe('Acme Sdn Bhd');placeholder=/\{\{F\d+\}\}/.exec(sent.companies[0].average)![0];
    return{final:{reply:`The average basic pay at Acme Sdn Bhd is ${placeholder}.`,mode:'answer'}};}]);
  expect(model.requests[0].tools.map(tool=>tool.name)).toContain('pay_aggregates');
  expect(result.trace.calls).toEqual([expect.objectContaining({tool:'pay_aggregates',status:'ok'})]);
  expect(result.trace.disclosure[0]).toMatchObject({tool:'pay_aggregates',entity:'pay_aggregate',undeclared:[],removed:[]});
  expect(result.trace.disclosure[0].banded.length).toBeGreaterThanOrEqual(12);
  expect(result.reply).toBe('The average basic pay at Acme Sdn Bhd is 4113.01.');
  const sent=JSON.stringify(model.requests.map(request=>request.messages)),trace=JSON.stringify(result.trace);
  const exact=['3542.99','4113.01','4130.00','3317.93','5067.11','2288.93','2290.00'];
  const ids=[m.b.companyId,m.company2,m.b.deptA,m.b.deptB,...[...deptA,...deptB,...c2].flatMap(person=>[person.employmentId,person.personId])];
  for(const text of [sent,trace]){
   for(const value of all)for(const form of [String(value),(value/100).toFixed(2),String(value/100)])expect(text,form).not.toContain(form);
   for(const value of exact)expect(text,value).not.toContain(value);
   for(const id of ids)expect(text).not.toContain(id);
   expect(text).not.toContain('Fictional Pay ');
  }
 });
 it('is not offered to an employee, so their turn reads nothing',async()=>{
  await fixture();
  const {result,model}=await turn(await session(m.employee),'What is the average basic pay in each department?',[{calls:[{name:'pay_aggregates'}]},{final:{reply:'I cannot see pay for others.',mode:'refuse'}}]);
  expect(model.requests[0].tools.map(tool=>tool.name)).not.toContain('pay_aggregates');
  expect(result.trace.calls).toEqual([expect.objectContaining({tool:'pay_aggregates',status:'not_offered'})]);expect(result.reads).toEqual([]);
 });
});
