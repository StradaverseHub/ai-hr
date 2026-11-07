import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';

it('qualifies the root generation controller with real Linux systemd and Nginx',()=>{
 expect(process.platform).toBe('linux');
 expect(process.env.GITHUB_ACTIONS).toBe('true');
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
 expect(process.env.GITHUB_REPOSITORY).toBe('StradaverseHub/ai-hr');
 expect(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()).toBe(process.env.AIHR_CI_HEAD);
 // This host-scoped native fixture is a dedicated unit, never an unnoticed
 // shared-process test or skipped capability requirement in a larger gate.
 expect(JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]')).toEqual(['test/runtime-ready-admission-native.test.ts']);
 const evidence=join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'runtime-ready-admission-native.json');
 const keys=['GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','AIHR_CI_HEAD','RUNNER_TEMP'] as const;
 execFileSync('sudo',['-n','env',...keys.map(key=>`${key}=${process.env[key]??''}`),'/usr/bin/python3','-I','deploy/admission/test_native.py',evidence],
  {encoding:'utf8',timeout:240000,stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024});
 const report=JSON.parse(readFileSync(evidence,'utf8'));
 expect(report.complete).toBe(true);
 expect(report.releaseEligible).toBe(false);
 expect(report.nextApplicationVerified).toBe(false);
 expect(report.coldBusinessRequests).toBe(0);
 expect(report.duplicatePostReceipts).toBe(0);
 expect(report.rootOwnedControllerAndProfile).toBe(true);
 expect(report.nonrootWriteBoundaryVerified).toBe(true);
 expect(report.checkOnlyRefusedUnsafeReleaseAndEnvironment).toBe(true);
 expect(report.concurrentAdmissionCallbacks).toBe(3);
 expect(report.endpointExhaustionRefusedStartup).toBe(true);
 expect(report.lostPostResponseNotReplayed).toBe(true);
 expect(report.restartBeginsDown).toBe(true);
 expect(report.unrelatedVhostPreserved).toBe(true);
},260000);
