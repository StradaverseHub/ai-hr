/** Hosted execution reports retain actual per-file assertions, never an invented gate PASS. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {POLICY,verifyPlan,hash} from './protocol.mjs';
import {runFocused,verifyFocusedResult} from '../../.github/ci/focused-checks.mjs';
export function reportsFromVitest(plan,checks,results,cwd){
 verifyPlan(plan);const reports=[];
 for(const c of checks){
  assert(c.kind==='test'&&c.files.length===1);
  const suites=results.flatMap(r=>r.testResults??[]).filter(s=>{const p=s.name.startsWith('/')?relative(cwd,s.name):s.name;return p===c.files[0];});
  assert(suites.length===1,'Exact producing suite required');const suite=suites[0];
  const result={success:true,testResults:[suite],numFailedTests:0,numFailedTestSuites:0,numTotalTests:suite.assertionResults.length,numPassedTests:suite.assertionResults.filter(a=>a.status==='passed').length};
  const assertions=verifyFocusedResult(result,c.files,cwd);
  reports.push({policy:POLICY,candidate:plan.candidate,controller:plan.controller,policyDigest:plan.policyDigest,check:c.id,key:c.key,inputDigest:c.inputs,result:'passed',files:c.files,assertions,skipped:0});
 }
 return reports;
}
export function runChecks({plan,ids,cwd=process.cwd(),destination}){
 assert(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'&&process.platform==='linux','Hosted execution only');
 verifyPlan(plan);assert(Array.isArray(ids)&&ids.length>0&&ids.length<=64&&new Set(ids).size===ids.length);
 const checks=ids.map(id=>{const c=plan.checks.find(c=>c.id===id);assert(c&&c.kind==='test');return c;});
 assert(execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim()===plan.candidate);
 process.env.AIHR_CI_HEAD=plan.candidate;process.env.AIHR_CI_CONTROL_HEAD=plan.controller;process.env.AIHR_FOCUSED_TESTS=JSON.stringify(checks.flatMap(c=>c.files));
 const dir=resolve(destination);mkdirSync(dir,{recursive:true});runFocused(dir);
 const resultPaths=readdirSync(dir).filter(p=>p.endsWith('.json')).map(p=>join(dir,p));
 const results=resultPaths.filter(Boolean).map(p=>JSON.parse(readFileSync(p))).filter(r=>Array.isArray(r.testResults));
 const reports=reportsFromVitest(plan,checks,results,cwd);
 const packet={policy:POLICY,candidate:plan.candidate,controller:plan.controller,policyDigest:plan.policyDigest,producerJobId:Number(process.env.AIHR_DELIVERY_JOB_ID),reports};
 assert(Number.isSafeInteger(packet.producerJobId)&&packet.producerJobId>0);writeFileSync(join(dir,'delivery-report.json'),JSON.stringify(packet)+'\n',{flag:'wx'});return packet;
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){const [planPath,ids,destination]=process.argv.slice(2);runChecks({plan:JSON.parse(readFileSync(planPath)),ids:JSON.parse(ids),destination});}
