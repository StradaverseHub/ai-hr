/** Diagnose only the existing finite producer-log API transport; never release evidence acceptance. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {publicRefusal} from './v9-hosted-refusal.mjs';
assert(process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&process.env.GITHUB_EVENT_NAME==='workflow_dispatch'&&process.env.GITHUB_RUN_ATTEMPT==='1','First-attempt canonical diagnostic only');
const output=join(process.env.RUNNER_TEMP,'v9-review-public');mkdirSync(output,{recursive:true,mode:0o700});
const result=spawnSync('gh',['api','repos/StradaverseHub/ai-hr/actions/jobs/124016969855/logs'],{encoding:'utf8',timeout:60000,maxBuffer:16*1024**2});
const proof={kind:'FINITE_JOB_LOG_TRANSPORT_DIAGNOSTIC_ONLY',producerJobId:124016969855,exitCode:result.status,signal:result.signal,errorCode:['ENOBUFS','ETIMEDOUT','ENOENT','ECONNRESET'].includes(result.error?.code)?result.error.code:null,bytes:Buffer.byteLength(result.stdout??''),installationEligible:false,releaseAuthorized:false,...publicRefusal(result.stderr??'')};
if(result.status===0){proof.reason='TRANSPORT_SUCCEEDED';proof.logSha256=createHash('sha256').update(result.stdout).digest('hex');}
writeFileSync(join(output,'log-transport.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(proof));
if(result.status!==0)process.exitCode=1;
