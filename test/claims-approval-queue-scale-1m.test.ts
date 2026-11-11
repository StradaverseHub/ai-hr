/** Scale rehearsal for the Claims approvals inbox at 1,000,000 pending claims (100,000 fictional employees,
 * ten claims each): first, next and deep pages, the name sorts, the "All" page and select-all, for group HR
 * and for a line manager over 1,000 reports. Real DB, standard GitHub runner. Run on its own. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {measureClaimQueue,seedClaimQueueScaleFixture} from './performance/claims-approval-queue-scale-fixture';
import {closeAll,migrateTestDb} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);

it('pages 1,000,000 pending claims for group HR and a manager',async()=>{
 const report:Record<string,unknown>={kind:'CLAIMS_APPROVAL_QUEUE_SCALE_V1',employees:100000,claimsPerEmployee:10,managerReports:1000,complete:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'claims-approval-queue-1m.json'),JSON.stringify(report,null,2));};
 const fixture=await seedClaimQueueScaleFixture({employees:100000,claimsPerEmployee:10,managerReports:1000},report,save);
 expect(fixture.counts).toEqual({claims:1000000,managerClaims:10010});
 const progress:Record<string,Record<string,unknown>>={groupHr:{},manager:{}};report.progress=progress;
 const record=(actor:'groupHr'|'manager')=>(name:string,timing:unknown)=>{progress[actor][name]=timing;save();};
 report.after={
  groupHr:await measureClaimQueue(fixture.groupHr,1000000,fixture.ownClaims,20000,2,record('groupHr')),
  manager:await measureClaimQueue(fixture.lineManager,10010,fixture.ownClaims,200,2,record('manager')),
 };
 report.complete=true;report.phase='complete';save();
 console.log('[claims-approval-queue-scale-1m] '+JSON.stringify({after:report.after}));
},900000);
