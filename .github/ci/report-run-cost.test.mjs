import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateRunCost,costAudit} from './report-run-cost.mjs';
const at='2026-10-25T10:10:00Z';
function run(){return {id:1,status:'completed',conclusion:'success',created_at:'2026-10-25T10:00:00Z',total_jobs:2,jobs:[
 {id:10,status:'completed',conclusion:'success',started_at:'2026-10-25T10:01:00Z',completed_at:'2026-10-25T10:02:01Z'},
 {id:11,status:'completed',conclusion:'success',started_at:'2026-10-25T10:01:00Z',completed_at:'2026-10-25T10:02:01Z'}]};}
test('Parallel elapsed time and aggregate minutes differ; round each occupied job separately',()=>{const r=estimateRunCost(run(),at);assert.equal(r.observedJobSeconds,122);assert.equal(r.elapsedSeconds,121);assert.equal(r.estimatedPerJobRoundedMinutes,4);assert.equal(r.complete,true);assert.equal(r.verifiedDeploymentSeconds,null);assert.equal(r.tenMinuteReleaseAchieved,false);});
test('Active runs include observed partial occupancy and full queue-to-observation time',()=>{const r=run();r.status='in_progress';r.jobs[1].status='in_progress';r.jobs[1].completed_at=null;const result=estimateRunCost(r,at);assert.equal(result.activeJobs,1);assert.equal(result.complete,false);assert.equal(result.observedJobSeconds,601);assert.equal(result.elapsedSeconds,600);});
test('Queued and skipped job timestamps do not count as occupied runner minutes',()=>{const r=run();r.jobs[0].conclusion='skipped';r.jobs[1].status='queued';const result=estimateRunCost(r,at);assert.equal(result.observedJobSeconds,0);assert.equal(result.complete,false);});
test('Incomplete, duplicate or impossible observations refuse instead of undercounting',()=>{for(const mutate of [r=>r.total_jobs=3,r=>r.jobs[1].id=10,r=>r.jobs[0].completed_at=null,r=>r.jobs[0].completed_at='2026-10-25T09:00:00Z',r=>r.jobs[0].completed_at='2026-10-25T11:00:00Z',r=>r.jobs[0].status='unknown']){const r=run();mutate(r);assert.throws(()=>estimateRunCost(r,at));}});
test('Cancelled failed work remains consumed time; duplicate run inventories refuse',()=>{const r=run();r.conclusion='cancelled';r.jobs[0].conclusion='cancelled';const a=costAudit({observed_at:at,runs:[r]});assert.equal(a.observedJobMinutes,122/60);assert.equal(a.runs[0].conclusion,'cancelled');assert.throws(()=>costAudit({observed_at:at,runs:[r,r]}));});
