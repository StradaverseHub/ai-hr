/** Native retained-cycle list: preserve RLS/count semantics while bounding the management page. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {client,type SessionContext} from '../db/client';
import {reviewCycle,performanceReview} from '../db/schema';
import * as perf from '../core/performance';
import {hireEmployee} from '../core/org';
import {paginateRows,parsePageQuery,type PageState} from '../lib/pagination';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
type Query={page?:string;size?:string};
type Page={rows:perf.CycleSummary[];state:PageState};
// Before the new reader exists, exercise exactly the current production read-then-slice path.
const readPage=(ctx:SessionContext,query:Query):Promise<Page>=>{
 const proposed=(perf as unknown as {listCyclePage?: (ctx:SessionContext,query:Query)=>Promise<Page>}).listCyclePage;
 return proposed?proposed(ctx,query):perf.listCycles(ctx).then(rows=>paginateRows(rows,parsePageQuery(query)));
};
it('pages retained cycles before projecting details and aggregating review counts',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'performance','active');const ctx=await entitledCtx(b);
 const employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional cycle subject',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const rows=Array.from({length:2101},(_,index)=>({id:randomUUID(),tenantId:b.tenantId,companyId:index%2?b.companyId:null,name:'Fictional retained cycle '+index,periodStart:new Date(Date.UTC(2018,0,index+1)).toISOString().slice(0,10),periodEnd:'2030-12-31',ratingScale:[{value:1,label:'Fictional unused list configuration '.repeat(40)}],eligibilityRules:{statuses:['active']},stages:[{kind:'year_end',label:'Fictional configuration '.repeat(40)}]}));
 for(let offset=0;offset<rows.length;offset+=200)await owner.db.insert(reviewCycle).values(rows.slice(offset,offset+200));
 await owner.db.insert(performanceReview).values(rows.slice(-80).map((row,index)=>({tenantId:b.tenantId,cycleId:row.id,employmentId:employee.employmentId,status:index%3===0?'submitted' as const:index%3===1?'acknowledged' as const:'not_started' as const,compActionStatus:index%2?'recommended' as const:'none' as const})));
 const fullBegan=performance.now(),reference=await perf.listCycles(ctx),fullMs=performance.now()-fullBegan;
 const nativeBegin=client.begin.bind(client);let cycleReads:string[]=[],countParameterWidths:number[]=[];
 // Call-through only: SQL and parameters reach the real native role unmodified.
 vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{
  const index=args.findIndex(arg=>typeof arg==='function'),callback=args[index]as(native:typeof client)=>unknown;
  args[index]=(native:typeof client)=>callback(new Proxy(native,{get(target,key,receiver){
   if(key==='unsafe')return(...query:unknown[])=>{
    const text=query[0];if(typeof text==='string'){
     if(text.includes('from "review_cycle"')&&!text.includes('count(*)'))cycleReads.push(text);
     if(text.includes('from "performance_review"')&&text.includes('group by'))countParameterWidths.push(Array.isArray(query[1])?query[1].length:0);
    }
    return Reflect.apply(target.unsafe,target,query);
   };return Reflect.get(target,key,receiver);
  }}));return Reflect.apply(nativeBegin,client,args);
 })as typeof client.begin);
 const began=performance.now(),first=await readPage(ctx,{}),elapsedMs=performance.now()-began;
 const bounded=cycleReads.length===1&&cycleReads[0].includes(' limit ')&&!cycleReads[0].includes('"rating_scale"')&&!cycleReads[0].includes('"merit_budget"')&&!cycleReads[0].includes('"eligibility_rules"')&&!cycleReads[0].includes('"stages"');
 const evidence:Record<string,unknown>={kind:'NATIVE_PERFORMANCE_CYCLE_PAGE_COMPONENT_ONLY',releaseEligible:false,retainedCycles:rows.length,referenceRows:reference.length,shownRows:first.rows.length,fullMs,elapsedMs,cycleSelects:cycleReads.length,nativeBoundedProjection:bounded,aggregateParameterWidths:countParameterWidths,providerCalls:0,limitations:'Native component and retained fixture only; not browser or500-user acceptance.'};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'performance-cycle-paging.json'),JSON.stringify(evidence,null,2));};
 try{
  expect(first).toEqual(paginateRows(reference,parsePageQuery({})));
  expect(bounded,'The production page must bound the native cycle projection before reading configuration or review counts').toBe(true);
  expect(countParameterWidths).toEqual([25]);
  for(const query of [{page:'1'},{size:'50',page:'2'},{page:'9999'},{size:'all'},{page:'-1',size:'nonsense'}])expect(await readPage(ctx,query)).toEqual(paginateRows(reference,parsePageQuery(query)));
  const foreign=await seedBase();await setModule(foreign.tenantId,'performance','active');expect((await readPage(await entitledCtx(foreign),{})).state.total).toBe(0);
  await setModule(b.tenantId,'performance','disabled');await expect(readPage(await entitledCtx(b),{})).rejects.toThrow();
  evidence.exactRowsCountsAndPager=true;evidence.foreignTenantRefused=true;evidence.disabledModuleRefused=true;
 }finally{save();}
},300000);
