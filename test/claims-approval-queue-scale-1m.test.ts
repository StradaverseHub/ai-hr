/** Scale rehearsal for the Claims approvals inbox at 1,000,000 pending claims (100,000 fictional employees,
 * ten claims each): first, next and deep pages, the name sorts, the "All" page and select-all, for group HR
 * and for a line manager over 1,000 reports. Real DB, standard GitHub runner. Run on its own. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {seedClaimQueueScaleFixture} from './performance/claims-approval-queue-scale-fixture';
import {closeAll,migrateTestDb} from './harness';
import {listPendingClaimsPage} from '../packs/claims/service';
import {explainStatements,isIdentityStatement,observeStatements} from './helpers/statement-observer';

beforeAll(migrateTestDb);afterAll(closeAll);

it('pages 1,000,000 pending claims for group HR and a manager',async()=>{
 const report:Record<string,unknown>={kind:'CLAIMS_APPROVAL_QUEUE_PLAN_V1',employees:100000,claimsPerEmployee:10,managerReports:1000,complete:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'claims-approval-queue-plan.json'),JSON.stringify(report,null,2));};
 const fixture=await seedClaimQueueScaleFixture({employees:100000,claimsPerEmployee:10,managerReports:1000},report,save);
 expect(fixture.counts).toEqual({claims:1000010,managerClaims:10010});
 const results:Record<string,unknown>={};
 report.results=results;
 for(const [label,context,total] of [
  ['groupHr',fixture.groupHr,1000010],
  ['manager',fixture.lineManager,10010],
 ] as const){
  const captured=await observeStatements(()=>listPendingClaimsPage(context));
  expect(captured.result.page.total).toBe(total);
  expect(captured.result.rows).toHaveLength(25);
  expect(captured.transactions).toBe(1);
  const identity=captured.statements.filter(entry=>isIdentityStatement(entry.sql));
  const queue=captured.statements.filter(entry=>/^with queue_request as materialized/i.test(entry.sql.trim()));
  expect(queue).toHaveLength(1);
  const [plan]=await explainStatements([...identity,...queue]);
  expect(plan.executionMs).toBeGreaterThan(0);
  results[label]={pageMs:Math.round(captured.ms),queueMs:plan.executionMs,planningMs:plan.planningMs,
   hotspots:plan.hotspots.map(({node,relation,subplan,rows,loops,totalMs,removed})=>({node,relation,subplan,rows,loops,totalMs,removed}))};
  save();
 }
 report.complete=true;report.phase='complete';save();
},900000);
