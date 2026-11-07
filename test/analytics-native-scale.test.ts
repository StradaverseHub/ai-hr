import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {
 analyticsManagerSelection,carryForwardReportPage,changeJobTransactionsPage,headcountSummary,
 masterDataCount,masterDataExport,newHires,newHiresPage,terminationsPage,
} from '../core/analytics';
import {parsePageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';

beforeAll(migrateTestDb);afterAll(closeAll);
it('measures actual native 50k Analytics reads and complete-export baselines on the same runner',async()=>{
 const report:Record<string,unknown>={kind:'NATIVE_ANALYTICS_COMPONENT_ONLY',releaseEligible:false,employees:50000,
  machine:{logicalCpus:cpus().length,cpu:cpus()[0]?.model,totalMemoryBytes:totalmem()},timings:{},pageRows:{}};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'analytics-native-50k.json'),JSON.stringify(report,null,2));};
 const timed=async<T>(name:string,read:()=>Promise<T>)=>{
  report.phase=name;save();const start=performance.now();
  try{const result=await read();(report.timings as Record<string,number>)[name]=performance.now()-start;save();return result;}
  catch(error){report.failedPhase=name;report.failure=error instanceof Error?error.message:'Unknown failure';save();throw error;}
 };
 const {b,ctx,expectedLast}=await seedPersonnelNativeFixture(50000,report,()=>{},save);
 const page=parsePageQuery(),hired={from:'2020-01-01',to:'2020-12-31'},ended={from:'2024-01-01',to:'2024-12-31'};
 const manager=await timed('selectedManagerMs',()=>analyticsManagerSelection(ctx,[b.companyId],expectedLast.at(-1)));
 expect(manager).toEqual({employmentId:expectedLast.at(-1),name:'Fictional retained Personnel 000050000'});
 const hires=await timed('newHiresPageMs',()=>newHiresPage(ctx,[b.companyId],{...hired,page}));
 expect(hires.state.total).toBe(50000);expect(hires.rows).toHaveLength(25);
 expect(hires.rows.map(row=>row.name)).toEqual(Array.from({length:25},(_,i)=>'Fictional retained Personnel '+String(i+1).padStart(9,'0')));
 const deep=await timed('deepNewHiresPageMs',()=>newHiresPage(ctx,[b.companyId],{...hired,page:parsePageQuery({page:'1999'})}));
 expect(deep.state.total).toBe(50000);expect(deep.rows.at(-1)?.name).toBe('Fictional retained Personnel 000050000');
 const terms=await timed('terminationsPageMs',()=>terminationsPage(ctx,[b.companyId],{...ended,page}));
 expect(terms.state.total).toBe(10000);expect(terms.rows).toHaveLength(25);
 const changes=await timed('changeJobsPageMs',()=>changeJobTransactionsPage(ctx,[b.companyId],{...hired,page}));
 expect(changes.state.total).toBe(0);expect(changes.rows).toEqual([]);
 const carry=await timed('carryForwardPageMs',()=>carryForwardReportPage(ctx,[b.companyId],{year:2020,page}));
 expect(carry.state.total).toBe(50000);expect(carry.rows).toHaveLength(25);expect(carry.rows.every(row=>row.carried===0&&row.forfeitedAtOpen===0&&row.forfeitedAtExpiry===0)).toBe(true);
 const headcount=await timed('headcountAggregateMs',()=>headcountSummary(ctx,[b.companyId],{asOf:'2026-01-01'}));
 expect(headcount).toEqual({total:40000,byCompany:[{name:'Acme Sdn Bhd',count:40000}],byDepartment:[{name:'Finance',count:40000}],byPosition:[{name:'—',count:40000}]});
 const count=await timed('masterDataCountMs',()=>masterDataCount(ctx,[b.companyId]));expect(count).toBe(40000);
 const baseline=await timed('completeMasterExportThenCountMs',()=>masterDataExport(ctx,[b.companyId]));expect(baseline).toHaveLength(40000);
 const fullHires=await timed('completeNewHiresMs',()=>newHires(ctx,[b.companyId],hired));expect(fullHires).toHaveLength(50000);
 report.transportBytes={fullNewHires:Buffer.byteLength(JSON.stringify(fullHires)),pagedNewHires:Buffer.byteLength(JSON.stringify(hires)),
  fullMaster:Buffer.byteLength(JSON.stringify(baseline)),masterCount:Buffer.byteLength(JSON.stringify(count))};
 report.pageRows={hires:hires.rows.length,deep:deep.rows.length,terms:terms.rows.length,changes:changes.rows.length,carry:carry.rows.length};
 report.exactNativePopulationAndResults=true;report.complete=true;save();
},300000);
