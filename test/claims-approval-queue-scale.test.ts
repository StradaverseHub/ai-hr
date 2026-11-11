/** Scale rehearsal for the Claims approvals inbox at 100,000 pending claims (10,000 fictional employees,
 * ten claims each): first, next and deep pages, the name sorts, the "All" page and select-all, for group HR
 * and for a line manager over 1,000 reports. The former per-row queue is measured once on the same data
 * as the before figure. Real DB, standard GitHub runner. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {listPendingClaimsPage} from '../packs/claims/service';
import {pgSqlState} from '../lib/db-error';
import {legacyClaimQueue,sortLegacyClaimQueue} from './helpers/claims-legacy-queue';
import {observeNativeRead} from './helpers/native-read-observer';
import {measureClaimQueue,seedClaimQueueScaleFixture} from './performance/claims-approval-queue-scale-fixture';
import {closeAll,migrateTestDb} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);

it('pages 100,000 pending claims for group HR and a manager without reading the whole queue',async()=>{
 const report:Record<string,unknown>={kind:'CLAIMS_APPROVAL_QUEUE_SCALE_V1',employees:10000,claimsPerEmployee:10,managerReports:1000,complete:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'claims-approval-queue-100k.json'),JSON.stringify(report,null,2));};
 const fixture=await seedClaimQueueScaleFixture({employees:10000,claimsPerEmployee:10,managerReports:1000},report,save);
 expect(fixture.counts).toEqual({claims:100000,managerClaims:10010});

 // Only the requested page leaves the database: every statement of a newest-first page returns at most one
 // page of rows (the queue statement returns one jsonb row).
 const probe=observeNativeRead();const probeStarted=performance.now();
 try{await listPendingClaimsPage(fixture.groupHr,{page:'2000'});}finally{probe.restore();}
 report.probeMs=Math.round(performance.now()-probeStarted);save();
 expect(probe.queries.length).toBeGreaterThan(0);
 expect(probe.queries.every(query=>(query.rows??0)<=25)).toBe(true);
 report.pageStatementRows=probe.queries.map(query=>query.rows??null);

 const progress:Record<string,Record<string,unknown>>={groupHr:{},manager:{}};report.progress=progress;
 const record=(actor:'groupHr'|'manager')=>(name:string,timing:unknown)=>{progress[actor][name]=timing;save();};
 report.after={
  groupHr:await measureClaimQueue(fixture.groupHr,100000,fixture.ownClaims,2000,3,record('groupHr')),
  manager:await measureClaimQueue(fixture.lineManager,10010,fixture.ownClaims,200,3,record('manager')),
 };
 report.phase='before';save();

 // Before: the former queue on the same data (one read each; group HR bounded so a regression cannot hang CI).
 const before:Record<string,unknown>={};
 for(const [name,ctx,timeoutMs] of [['manager',fixture.lineManager,120000],['groupHr',fixture.groupHr,180000]] as const){
  const started=performance.now();
  try{
   const queue=await legacyClaimQueue(ctx,{statementTimeoutMs:timeoutMs});
   const ids=sortLegacyClaimQueue(queue,'latest').slice(0,25).map(row=>row.id);
   const elapsedMs=Math.round(performance.now()-started);
   expect(ids).toEqual((await listPendingClaimsPage(ctx)).rows.map(row=>row.id));
   before[name]={firstPageMs:elapsedMs,rows:queue.length,timedOut:false};
  }catch(error){
   if(pgSqlState(error)!=='57014')throw error;
   before[name]={firstPageMs:Math.round(performance.now()-started),timedOut:true,timeoutMs};
  }
  report.before=before;save();
 }
 report.complete=true;report.phase='complete';save();
 console.log('[claims-approval-queue-scale] '+JSON.stringify({after:report.after,before:report.before}));
 // A hard guard well above the target, so a return to the per-row shape (tens of seconds) cannot pass.
 const after=report.after as Record<string,Record<string,{medianMs:number}>>;
 for(const actor of Object.values(after))for(const [name,timing] of Object.entries(actor))if(name!=='selectAll')expect(timing.medianMs,name).toBeLessThan(5000);
},900000);
