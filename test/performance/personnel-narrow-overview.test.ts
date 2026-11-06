/** Independent hosted measurement. Earlier whole-projection timeout probes are not repeated. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {pgSqlState} from '../../lib/db-error';
import {closeAll,migrateTestDb} from '../harness';
import {seedPersonnelNativeFixture} from './personnel-native-fixture';
import {personnelDatedTagsPrototype} from './personnel-dated-tags-prototype';
import {personnelNarrowOverviewProbe} from './personnel-narrow-overview-probe';

const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&
 selected[0]==='test/performance/personnel-narrow-overview.test.ts';
beforeAll(migrateTestDb);afterAll(closeAll);

it.skipIf(!requested)('measures narrow dated Personnel facts and bounded native page DTOs at fifty thousand employees',async()=>{
 const count=50_000,started=performance.now();
 const report:Record<string,unknown>={
  kind:'PERSONNEL_NARROW_OVERVIEW_50K_COMPONENT_ONLY',releaseEligible:false,targetEmployees:count,concurrentUsers:1,
  queryTargetMs:1000,nativeTriggers:'unchanged',limitations:'Synthetic single tenant, no private search or quality filters, browser or 500-user claims.',
 };
 expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-narrow-overview.json'),JSON.stringify(report,null,2));
 const phase=(name:string)=>{report.phase=name;report.elapsedMs=performance.now()-started;save();};
 const failures:{mode:string;elapsedMs:number;errorType:string;sqlState:string|null}[]=[];
 try{
  const {b,ctx,expectedFirst,expectedLast}=await seedPersonnelNativeFixture(count,report,phase,save);
  report.fixturePreparationMs=performance.now()-started;
  const asOf=todayInKualaLumpur(),sample=expectedFirst;
  const liveOverviewCases=[
   {mode:'initial',offset:0,expectedIds:expectedFirst},
   {mode:'selective-search',q:'PERF000050000',offset:0,expectedIds:[expectedLast.at(-1)!]},
   {mode:'deep-page',offset:count-25,expectedIds:expectedLast},
  ];
  phase('install-prototype');
  const prototype=await personnelDatedTagsPrototype();
  try{
   const narrowParity=[
    {mode:'initial',limit:10,offset:0,ids:sample.slice(0,10),total:25},
    {mode:'independent-facets',limit:10,offset:0,pageQuery:'PERF000000025',companySort:true as const,ids:sample.slice(-1),total:1},
    {mode:'deep',limit:10,offset:20,ids:sample.slice(20),total:25},
    {mode:'empty',limit:10,offset:30,ids:[],total:25},
   ];
   for(const {mode,ids,total,...input} of narrowParity){
    phase('live-overview-narrow-parity-'+mode);
    const query={...input,date:asOf,scope:[b.companyId],subjects:sample};
    const baseline=await personnelNarrowOverviewProbe(ctx,prototype,'baseline',query);
    const candidate=await personnelNarrowOverviewProbe(ctx,prototype,'narrow',query);
    expect(candidate).toEqual(baseline);
    expect(candidate.pageIds).toEqual(ids);
    expect(candidate.rows.map(row=>row?.employmentId)).toEqual(ids);
    expect(candidate.total).toBe(total);
    expect(Object.values(candidate.byStatus).reduce((sum,value)=>sum+value,0)).toBe(25);
    expect(candidate.options).not.toHaveLength(0);
   }
   report.liveOverviewNarrowSampleParity=narrowParity.map(({mode})=>mode);save();
   const narrowMeasurements:{mode:string;elapsedMs:number;total:number;pageRows:number;targetMet:boolean}[]=[];
   for(const {mode,q,offset,expectedIds} of liveOverviewCases){
    phase('live-overview-narrow-'+mode);
    const began=performance.now();
    let result;
    try{result=await personnelNarrowOverviewProbe(ctx,prototype,'narrow',{
     date:asOf,scope:[b.companyId],subjects:null,pageQuery:q,facetQuery:q,limit:25,offset,
    });}
    catch(error){
     failures.push({mode,elapsedMs:performance.now()-began,errorType:error instanceof Error?error.name:typeof error,sqlState:pgSqlState(error)??null});
     report.liveOverviewNarrowFailures=failures;save();continue;
    }
    const elapsedMs=performance.now()-began,expectedTotal=q?1:count;
    expect(result.pageIds).toEqual(expectedIds);
    expect(result.rows.map(row=>row?.employmentId)).toEqual(expectedIds);
    expect(result.total).toBe(expectedTotal);
    expect(Object.values(result.byStatus).reduce((sum,value)=>sum+value,0)).toBe(expectedTotal);
    narrowMeasurements.push({mode,elapsedMs,total:result.total,pageRows:result.rows.length,targetMet:elapsedMs<1000});
    report.liveOverviewNarrow=narrowMeasurements;save();
   }
  }finally{await prototype.drop();}
  expect(failures,'Narrow Personnel observations').toEqual([]);
  phase('complete');
 }catch(error){
  report.errorType=error instanceof Error?error.name:typeof error;
  phase('failed');
  throw error;
 }
},600000);
