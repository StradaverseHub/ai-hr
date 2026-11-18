/** Native correctness/work qualification. Timing observations are diagnostic, not flaky pass thresholds.
 * Every case executes in ordinary gates; there are no hosted-only skips or local runtime changes. */
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {availableParallelism,totalmem,cpus} from 'node:os';
import {eq,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi,type TestContext} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as choice from '../core/employee-choice';
import {AiGatewayError} from '../lib/ai/types';
import {bulkEmployeePicker} from '../core/bulk-employee-picker';
import {listCompanies,listEmployeesTx} from '../core/read';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import * as schema from '../db/schema';
import {assessUnicodeCost} from './performance/bulk-unicode-cost-contract';
import {adminCtx,owner,resetDb,seedBase,createAppUser,migrateTestDb,closeAll} from './harness';
import type {EmployeePickOption} from '../lib/employment-selection';

beforeAll(migrateTestDb);afterAll(closeAll);
const dialect=new PgDialect(),digest=(text:string)=>createHash('sha256').update(text).digest('hex');
type Row={id:string;n:number;name:string;employeeCode:string;companyId:string};
type State={pid:number;role:string;bypass:boolean;ro:string;isolation:string;jit:string;access:string|null;workMem:string;version:string};
type Event={sqlHash:string;kind:string;rows:number;ms:number;bytes?:number;keys?:string[];principalAllowed?:boolean};
type Plan={kind:string;sqlHash:string;parameterCount:number;raw:unknown;rootRows:number;tempWritten:number};
type Observation={label:string;trace:boolean;events:Event[];planInputs:{kind:string;query:SQL}[];plans:Plan[];bodyMs?:number;wallMs?:number;state?:State;error?:string};
const report:Record<string,unknown>={kind:'BULK_UNICODE_NATIVE_COST_QUALIFICATION',releaseAuthorized:false,installationAcceptance:false,
 source:process.env.AIHR_CI_HEAD??null,controller:process.env.AIHR_CI_CONTROL_HEAD??null,run:process.env.GITHUB_RUN_ID??null,
 runtime:{node:process.version,versions:process.versions,cpuCount:availableParallelism(),memoryBytes:totalmem(),models:[...new Set(cpus().map(cpu=>cpu.model))]},
 method:'Actual public bulk reader; matched-carrier legacy projection at1000 only. Timings include a post-read state probe; body timings exclude probe/EXPLAIN. Trace/plan passes are not latency samples.',
 budgets:{1000:500,10000:1000,50000:1500},phases:[]};
const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'bulk-unicode-native-cost.json'),JSON.stringify(report,null,2));};
const suffix=(n:number)=>['ΟΣ','Ος','İ','😀'][n%4];
async function fixture(count:number,progress:Record<string,unknown>){
 await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
 const companies=[b.companyId,...(await owner.db.insert(schema.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Fictional Unicode company '+i}))).returning({id:schema.company.id})).map(row=>row.id)];
 const departments=(await owner.db.insert(schema.department).values(companies.map((companyId,i)=>({tenantId:b.tenantId,companyId,name:'Unicode department '+i}))).returning({id:schema.department.id})).map(row=>row.id);
 const empty=(await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional empty Unicode company'}).returning({id:schema.company.id}))[0].id;
 const personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24),companyJson=JSON.stringify(companies),departmentJson=JSON.stringify(departments);
 const records:Row[]=Array.from({length:count},(_,index)=>{const n=index+1;return {n,id:employmentPrefix+String(n).padStart(12,'0'),companyId:companies[index%70],name:'Fictional 人員 '+String(n).padStart(9,'0')+' '+suffix(n)+(n===1||n===count?' 稀少':''),employeeCode:'U-'+String(n).padStart(9,'0')};});
 for(let start=1;start<=count;start+=10000){const end=Math.min(count,start+9999);await owner.client.begin(async tx=>{
  await tx`insert into person(id,tenant_id,full_name,primary_email)
   select (${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,
    'Fictional 人員 '||lpad(n::text,9,'0')||' '||case n%4 when 0 then'ΟΣ' when 1 then'Ος' when 2 then'İ' else'😀'end||case when n=1 or n=${count} then' 稀少'else''end,
    n::text||'@unicode-fixture.invalid' from generate_series(${start}::int,${end}::int)n`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on)
   select (${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,
    (${companyJson}::jsonb->>((n-1)%70))::uuid,'U-'||lpad(n::text,9,'0'),'2020-01-01'::date,case when n%17=0 then'2025-01-01'::date else null end
    from generate_series(${start}::int,${end}::int)n`;
  await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
   select ${b.tenantId}::uuid,(${employmentPrefix}||lpad(n::text,12,'0'))::uuid,(${companyJson}::jsonb->>((n-1)%70))::uuid,
    (${departmentJson}::jsonb->>((n-1)%70))::uuid,'full_time','2020-01-01'::date from generate_series(${start}::int,${end}::int)n`;
 });progress.committed=end;save();}
 async function scoped(companyId:string){const personId=(await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional Unicode operator '+randomUUID(),primaryEmail:randomUUID()+'@unicode-fixture.invalid'}).returning({id:schema.person.id}))[0].id;
  const userId=await createAppUser(b.tenantId,personId,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId}).where(eq(schema.roleAssignment.appUserId,userId));
  return {...ctx,userId,personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}]} satisfies SessionContext;
 }
 const single=await scoped(companies[0]),emptyCtx=await scoped(empty),revoked=await scoped(companies[0]);
 const foreignPerson=(await owner.db.insert(schema.person).values({tenantId:foreign.tenantId,fullName:'Fictional foreign 人員',primaryEmail:randomUUID()+'@unicode-fixture.invalid'}).returning({id:schema.person.id}))[0].id;
 const foreignId=(await owner.db.insert(schema.employment).values({tenantId:foreign.tenantId,personId:foreignPerson,companyId:foreign.companyId,hiredOn:'2020-01-01'}).returning({id:schema.employment.id}))[0].id;
 for(const table of ['person','employment','assignment','company','department','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
 const [totals]=await owner.client`select (select count(*)::int from employment where tenant_id=${b.tenantId}::uuid) employments,(select count(*)::int from assignment where tenant_id=${b.tenantId}::uuid) assignments`;
 expect(totals).toEqual({employments:count,assignments:count});
 return {ctx,single,emptyCtx,revoked,records,companies,foreignCtx:adminCtx(foreign),foreignId};
}
function planRoot(raw:unknown){
 if(!Array.isArray(raw)||raw.length!==1||!raw[0]||typeof raw[0]!=='object'||!('Plan'in raw[0]))throw Error('Missing actual native plan');
 const root=(raw[0] as {Plan:Record<string,unknown>}).Plan;
 if(!Number.isSafeInteger(root['Actual Rows'])||!Number.isSafeInteger(root['Actual Loops']))throw Error('Plan lacks actual work');
 return root;
}
async function legacy(ctx:SessionContext,signal:AbortSignal){return database.withTenant(ctx,async tx=>{
 await assertAiPresentationPrincipalTx(tx,ctx);const companies=await listCompanies(ctx,{},tx);
 return listEmployeesTx(tx,companies.map(row=>row.id));
},{readOnlySnapshot:true,readSignal:signal});}

for(const count of [1000,10000,50000])it('qualifies exact native Unicode work at '+count+' employments across70 companies',(context:TestContext)=>{
 const pending=(async()=>{
 const phase:Record<string,unknown>={count,stage:'fixture',developmentOnly:true,observations:[],cases:[]};(report.phases as unknown[]).push(phase);save();
 const f=await fixture(count,phase);phase.stage='native-calls';save();
 let active:Observation|undefined;
 const actual=database.withTenant,actualMatch=choice.exactEmployeeChoiceMatches;
 const observations=phase.observations as Observation[],cases=phase.cases as Record<string,unknown>[];
 const matchSpy=vi.spyOn(choice,'exactEmployeeChoiceMatches').mockImplementation((tx,query,...args)=>{
  return actualMatch(tx,query,...args);
 });
 const tenantSpy=vi.spyOn(database,'withTenant').mockImplementation(<T>(who:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>{
  const observation=active;if(!observation)return actual(who,read,options);
  return actual(who,async tx=>{
   const track=async(query:SQL,run:()=>Promise<unknown>)=>{
    const compiled=dialect.sqlToQuery(query),started=performance.now();const value=await run();
    const kind=/^fetch /i.test(compiled.sql.trim())?'fetch':/^declare /i.test(compiled.sql.trim())?'declare':/^close /i.test(compiled.sql.trim())?'close':'statement';
    const event:Event={sqlHash:digest(JSON.stringify(compiled)),kind,rows:Array.isArray(value)?value.length:0,ms:performance.now()-started};
    event.keys=Array.isArray(value)&&value.length?Object.keys(value[0]).sort():[];
    if(Array.isArray(value)&&value.length===1&&typeof value[0]?.allowed==='boolean')event.principalAllowed=value[0].allowed;
    if(kind==='fetch'&&Array.isArray(value))event.bytes=Buffer.byteLength(JSON.stringify(value));
    observation.events.push(event);
    if(kind==='declare')observation.planInputs.push({kind:'cursor-population',query});
    else if(/^select /i.test(compiled.sql.trim()))observation.planInputs.push({kind:event.keys?.includes('email')&&event.keys.includes('employmentId')?'legacy-full-projection':'native-select',query});
    return value;
   };
   const wrap=(builder:object):object=>new Proxy(builder,{get(target,key){
    const value=Reflect.get(target,key);
    if(key==='then'&&typeof value==='function')return (yes:unknown,no:unknown)=>track((target as {getSQL:()=>SQL}).getSQL(),()=>value.call(target)).then(yes as (v:unknown)=>unknown,no as (e:unknown)=>never);
    if(typeof value!=='function')return value;
    if(key==='getSQL')return value.bind(target);
    return (...args:unknown[])=>{const next=value.apply(target,args);return next&&typeof next==='object'&&('from'in next||'then'in next)?wrap(next):next;};
   }});
   const proxy=observation.trace?new Proxy(tx,{get(target,key,receiver){
    if(key==='execute')return (query:SQL)=>track(query,()=>target.execute(query));
    if(key==='select')return (...args:Parameters<Tx['select']>)=>wrap(Reflect.get(target,key).apply(target,args));
    const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
   }}):tx;
   const started=performance.now();
   try{return await read(proxy);}catch(error){observation.error=String(error).slice(0,300);throw error;}finally{
    observation.bodyMs=performance.now()-started;
    const [state]=await tx.execute<State>(sql`select pg_backend_pid() pid,current_user as role,
     (select rolsuper or rolbypassrls from pg_roles where rolname=current_user) bypass,
     current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation,current_setting('jit') jit,
     app.access_lock_mode_held(${who.tenantId}::uuid) access,current_setting('work_mem') as "workMem",version() version`);
    observation.state=state;expect(state).toMatchObject({role:'ai_hr_app',bypass:false,ro:'on',isolation:'repeatable read',jit:'off'});expect(state.access).not.toBe('X');
    if(observation.trace&&!observation.error){
     const unique=new Map(observation.planInputs.map(input=>[digest(JSON.stringify(dialect.sqlToQuery(input.query))),input]));
     for(const [sqlHash,input]of unique){const result=await tx.execute(sql`explain (analyze,buffers,verbose,settings,timing off,format json) ${input.query}`);
      const raw=(result[0] as Record<string,unknown>)['QUERY PLAN'],root=planRoot(raw);
      observation.plans.push({kind:input.kind,sqlHash,parameterCount:dialect.sqlToQuery(input.query).params.length,raw,rootRows:Number(root['Actual Rows']),tempWritten:Number(root['Temp Written Blocks']??0)});
     }
    }
    observation.planInputs=[];save();
   }
  },options);
 });
 async function observe<T>(label:string,trace:boolean,run:()=>Promise<T>){
  const observation:Observation={label,trace,events:[],planInputs:[],plans:[]};observations.push(observation);active=observation;save();
  const started=performance.now();try{return {value:await run(),observation};}finally{observation.wallMs=performance.now()-started;observation.planInputs=[];active=undefined;save();}
 }
 try{
  for(const [scope,ctx,visible]of [['group',f.ctx,f.records],['company',f.single,f.records.filter(row=>row.companyId===f.companies[0])]] as const){
   const trace=await observe(scope+':trace',true,()=>bulkEmployeePicker(ctx,{query:'人員',offset:0},context.signal));
   const queries=[{key:'dense-first',query:'人員',offset:0,expected:visible},{key:'dense-deep',query:'人員',offset:Math.max(0,visible.length-25),expected:visible},
    {key:'sparse',query:'稀少',offset:0,expected:visible.filter(row=>row.n===1||row.n===count)},
    {key:'missing',query:'不存在',offset:0,expected:[] as Row[]},{key:'final-sigma',query:'ος',offset:0,expected:visible.filter(row=>row.n%4===0||row.n%4===1)},
    {key:'complete-all',query:'人員',offset:0,all:true,expected:visible}];
   let reference:Awaited<ReturnType<typeof legacy>>|undefined;
   if(count===1000){
    const legacyWork=await observe(scope+':legacy-trace',true,()=>legacy(ctx,context.signal));
    expect(legacyWork.value.map(row=>row.employmentId)).toEqual(visible.map(row=>row.id));
    expect(legacyWork.observation.state!.pid).toBe(trace.observation.state!.pid);
    const legacyPlan=legacyWork.observation.plans.find(plan=>plan.kind==='legacy-full-projection');expect(legacyPlan).toBeDefined();expect(legacyPlan!.rootRows).toBe(visible.length);
   }
   for(const test of queries){const samples:Observation[]=[];
    const work=test.key==='dense-first'?trace:await observe(scope+':'+test.key+':trace',true,()=>bulkEmployeePicker(ctx,{query:test.query,offset:test.offset,all:'all'in test?test.all:undefined},context.signal));
    expect(work.value.total).toBe(test.expected.length);
    expect(work.value.rows.map(row=>row.id)).toEqual(test.expected.slice(test.offset,test.offset+25).map(row=>row.id));
    const population=work.observation.plans.find(plan=>plan.kind==='cursor-population');expect(population).toBeDefined();expect(population!.rootRows).toBe(visible.length);
    const fetches=work.observation.events.filter(event=>event.kind==='fetch');const fetched=fetches.reduce((n,event)=>n+event.rows,0);
    expect(fetched).toBe(visible.length);for(const event of fetches)if(event.rows)expect(event.keys).toEqual(['employeeCode','employmentId','name']);
    for(let repeat=0;repeat<3;repeat++){
     const current=await observe(scope+':'+test.key+':'+repeat,false,()=>bulkEmployeePicker(ctx,{query:test.query,offset:test.offset,all:'all'in test?test.all:undefined},context.signal));
     expect(current.value.rows).toEqual(test.expected.slice(test.offset,test.offset+25).map(({id,name,employeeCode})=>({id,name,employeeCode})));
     expect(current.value.total).toBe(test.expected.length);expect(current.value.rows.length).toBeLessThanOrEqual(25);
     if('all'in test)expect(current.value.ids).toEqual(test.expected.map(row=>row.id));else expect(current.value.ids).toBeUndefined();
     samples.push(current.observation);
     if(count===1000&&test.key==='dense-first'){
      const prior=await observe(scope+':legacy:'+repeat,false,()=>legacy(ctx,context.signal));reference=prior.value;
      expect(reference.map(row=>row.employmentId)).toEqual(visible.map(row=>row.id));expect(prior.observation.state!.pid).toBe(current.observation.state!.pid);
     }
    }
    const bodyMax=Math.max(...samples.map(sample=>sample.bodyMs!)),budget=count===1000?500:count===10000?1000:1500;
    const state=samples[0].state!;expect(samples.every(sample=>sample.state!.pid===trace.observation.state!.pid)).toBe(true);
    const assessment='all'in test?{qualified:false,gaps:['explicit-complete-ID-output-is-not-an-ordinary-page-claim']}:
     assessUnicodeCost({visible:visible.length,returned:Math.min(25,Math.max(0,test.expected.length-test.offset)),identityFetched:fetched,sqlPaged:false,exact:true,
      nativeRole:state.role,bypassRls:state.bypass,readOnly:state.ro,isolation:state.isolation,jit:state.jit,exclusive:state.access==='X',planRows:population!.rootRows,
      tempWrittenBlocks:work.observation.plans.reduce((n,plan)=>n+plan.tempWritten,0),bodyMaxMs:bodyMax,bodyBudgetMs:budget});
    cases.push({scope,key:test.key,query:test.query,total:test.expected.length,offset:test.offset,sampleLabels:samples.map(s=>s.label),bodyMaxMs:bodyMax,bodyBudgetMs:budget,
     visibleIdentities:fetched,serializedIdentityBytes:fetches.reduce((n,event)=>n+(event.bytes??0),0),fetchCalls:fetches.length,actualPlanHash:population!.sqlHash,assessment});save();
   }
   if(reference){expect(reference.length).toBe(visible.length);phase[scope+'LegacyFullRowKeys']=Object.keys(reference[0]).sort();}
  }
  for(const [scope,ctx,ids]of [['empty',f.emptyCtx,[]],['foreign-tenant',f.foreignCtx,[f.foreignId]]] as const){
   const result=await observe(scope,true,()=>bulkEmployeePicker(ctx,{query:'人員',offset:0},context.signal));expect(result.value.rows.map(row=>row.id)).toEqual(ids);expect(result.value.total).toBe(ids.length);
  }
  const denied={...f.ctx,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const rejected=await observe('forbidden',true,async()=>{await expect(bulkEmployeePicker(denied,{query:'人員',offset:0},context.signal)).rejects.toBeInstanceOf(choice.EmployeeChoiceAccessError);return null;});expect(rejected.observation.state).toBeUndefined();expect(rejected.observation.events).toEqual([]);
  await owner.db.update(schema.roleAssignment).set({role:'employee'}).where(eq(schema.roleAssignment.appUserId,f.revoked.userId!));
  const revoked=await observe('revoked-principal',true,async()=>{await expect(bulkEmployeePicker(f.revoked,{query:'人員',offset:0},context.signal)).rejects.toBeInstanceOf(AiGatewayError);return null;});
  expect(revoked.observation.events.some(event=>event.principalAllowed===false)).toBe(true);
  expect(revoked.observation.events.filter(event=>event.kind==='fetch')).toEqual([]);
  phase.stage='complete';phase.semanticEquivalence=true;phase.ordinarySearchQualified=false;save();
 }finally{tenantSpy.mockRestore();matchSpy.mockRestore();active=undefined;save();}
 })();
 context.onTestFinished(async()=>{await pending.catch(()=>{});});
 return pending;
 // Native full-call/EXPLAIN work at50k can exceed15s;300s gives the existing50k
 // employee-choice suite's measured300s headroom without changing database timeouts.
},300000);
