/** Closed hosted metadata only. Original classifier failures are retained. */
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
it('records the complete original CLI/profile work and actual resource observations without adopting classification',()=>{
 expect(process.platform).toBe('linux');expect(process.versions.node).toBe('22.23.3');
 const keys=['PATH','HOME','RUNNER_TEMP','GITHUB_WORKSPACE','GITHUB_ACTIONS','CI','RUNNER_ENVIRONMENT','RUNNER_OS','GITHUB_REPOSITORY','GITHUB_WORKFLOW','GITHUB_JOB','GITHUB_EVENT_NAME','GITHUB_RUN_ATTEMPT','GITHUB_RUN_ID','AIHR_CI_HEAD','AIHR_CI_CONTROL_HEAD','AIHR_FOCUSED_TESTS','AIHR_FOCUSED_EVIDENCE_DIR']as const;
 const env:NodeJS.ProcessEnv={};for(const key of keys)if(process.env[key]!==undefined)env[key]=process.env[key];
 const child=spawnSync('/usr/bin/python3',['-I','-B','.github/ci/diagnostics/db-classifier-timeout.py'],{env,encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
 expect(child.error).toBeUndefined();expect(child.signal).toBeNull();expect(child.status,(child.stdout??'')+(child.stderr??'')).toBe(0);
 const report=JSON.parse(readFileSync(join(process.env.RUNNER_TEMP!,'aihr-focused/db-classifier-timeout/report.json'),'utf8'));
 expect(report.kind).toBe('CLASSIFIER_TIMEOUT_CAUSAL_DIAGNOSTIC_NOT_ACCEPTANCE');expect(report.complete).toBe(true);expect(report.classificationAdopted).toBe(false);expect(report.workSecondsPerAttempt).toBe(15);expect(report.kernelSettlementSeconds).toBe(6);
 expect(report.attempts.map((attempt:{phase:string})=>attempt.phase)).toEqual(['inventory','baseline','profile']);
 for(const attempt of report.attempts){expect(attempt.native.reaped).toBe(true);expect(attempt.native.groupQuiescent).toBe(true);expect(attempt.native.escapedSession).toBe(false);expect(attempt.transportFailures).toEqual([]);expect(attempt.failures).toEqual([]);}
 // A classifier deadline is preserved as a deadline, not converted into a pass.
 expect(report.attempts[2].partialProgress.classificationAdopted).toBe(false);
},95000);
