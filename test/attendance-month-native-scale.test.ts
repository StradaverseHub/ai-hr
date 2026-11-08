import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceMonthSummaryPage} from '../packs/attendance/service';
import {parsePageQuery} from '../lib/pagination';
import {observeNativeRead} from './helpers/native-read-observer';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {closeAll,migrateTestDb,owner,setModule} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);
it('measures an actual nonempty month page among50000 employees without loading their month matrix',async()=>{
 const report:Record<string,unknown>={kind:'NATIVE_ATTENDANCE_MONTH_PAGE_COMPONENT_ONLY',releaseEligible:false,employees:50000,complete:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'attendance-month-native-50k.json'),JSON.stringify(report,null,2));};
 const {b,ctx}=await seedPersonnelNativeFixture(50000,report,phase=>{report.phase=phase;save();},save);
 await setModule(b.tenantId,'attendance','active');
 // Every native current member has an actual recorded day. A zero-row fixture
 // cannot establish bounded hydration or any useful latency claim.
 await owner.client`insert into attendance(tenant_id,employment_id,attendance_date,status,day_type,worked_minutes,ot_minutes)
  select tenant_id,id,'2026-05-01'::date,'present','workday',480,60 from employment
  where tenant_id=${b.tenantId}::uuid and terminated_on is null`;
 const [counts]=await owner.client`select count(*)::int as rows,sum(worked_minutes)::bigint::text as worked from attendance where tenant_id=${b.tenantId}::uuid`;
 expect(counts).toEqual({rows:40000,worked:'19200000'});report.fixtureCounts=counts;report.phase='actual-page';save();
 const probe=observeNativeRead();const started=performance.now();let page:Awaited<ReturnType<typeof attendanceMonthSummaryPage>>;
 try{page=await attendanceMonthSummaryPage(ctx,{month:'2026-05',today:'2026-05-01',companyIds:[b.companyId],page:parsePageQuery()});}finally{probe.restore();}
 const elapsedMs=performance.now()-started;
 expect(page!.state).toMatchObject({total:40000,limit:25,from:1,to:25,hasNext:true,truncated:false});expect(page!.rows).toHaveLength(25);
 const expected=Array.from({length:32},(_,i)=>i+1).filter(n=>n%5!==0).slice(0,25);
 expect(page!.rows.map(row=>row.name)).toEqual(expected.map(n=>'Fictional retained Personnel '+String(n).padStart(9,'0')));
 for(const row of page!.rows)expect(row).toMatchObject({present:1,late:0,halfDay:0,absent:0,leaveDays:0,workedMinutes:480,otWorkday:60,otRestDay:0,otHoliday:0,otCapExceeded:false,over45hWeek:false,
  overtimeSummary:{knownMinutes:{unit:'minutes',numerator:'60',denominator:'1'},complete:true},overtimeCapState:'within'});
 expect(probe.properties).toHaveLength(1);expect(probe.properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});expect(probe.state.active).toBe(0);
 const attendanceQueries=probe.queries.filter(query=>query.sql.includes('from "attendance"'));
 expect(attendanceQueries.length).toBeGreaterThan(0);expect(attendanceQueries.every(query=>(query.rows??0)<=25)).toBe(true);
 expect(probe.queries.some(query=>query.sql.includes('attendance_month_population'))).toBe(true);
 const policy=probe.queries.filter(query=>query.sql==='set local jit=off');expect(policy).toHaveLength(1);
 expect(policy[0]).toMatchObject({params:[],rows:0});
 expect(probe.queries.indexOf(policy[0])).toBeGreaterThan(probe.queries.findIndex(query=>query.sql.includes('public.app_user u')));
 expect(probe.queries.indexOf(policy[0])).toBeLessThan(probe.queries.findIndex(query=>query.sql.includes('attendance_month_population')));
 const telemetry=probe.telemetry();expect(telemetry.detailComplete).toBe(true);expect(telemetry.totals.failed).toBe(0);
 expect(telemetry.totals).toMatchObject({statements:32,returnedRows:208,unknownRowCounts:0});
 report.complete=true;report.phase='complete';report.actualTotal=page!.state.total;report.returnedRows=page!.rows.length;report.elapsedMs=elapsedMs;
 report.attendanceQueryRows=attendanceQueries.map(query=>query.rows);report.queryTelemetry=telemetry;
 report.actualTransactions=probe.properties.length;report.knownFixtureFacts=true;save();
},300000);
