/** Diagnose only the existing finite producer-log API transport; never release evidence acceptance. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {publicRefusal,executionEnvelope,publicRateHeaders} from './v9-hosted-refusal.mjs';
import {request} from 'node:https';
assert(process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&process.env.GITHUB_EVENT_NAME==='workflow_dispatch'&&process.env.GITHUB_RUN_ATTEMPT==='1','First-attempt canonical diagnostic only');
const output=join(process.env.RUNNER_TEMP,'v9-review-public');mkdirSync(output,{recursive:true,mode:0o700});
function metadata(path){
 const r=spawnSync('gh',['api','repos/StradaverseHub/ai-hr/'+path],{encoding:'utf8',timeout:60000,maxBuffer:2*1024**2});
 if(r.status!==0){const refusal={kind:'FINITE_LOG_METADATA_TRANSPORT_REFUSED',exitCode:r.status,installationEligible:false,releaseAuthorized:false,...publicRefusal(r.stderr??'')};writeFileSync(join(output,'log-transport.json'),JSON.stringify(refusal,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(refusal));process.exit(1);}
 return JSON.parse(r.stdout);
}
const run=metadata('actions/runs/41042016086'),job=metadata('actions/jobs/124016969855');
assert(run.id===41042016086&&run.repository?.id===1333414856&&run.repository.full_name==='StradaverseHub/ai-hr'&&run.head_repository?.id===1333414856&&run.head_sha==='d6cb83d620d8d4380c981a72fc41628780840b4e'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success','Finite producer run identity differs');
assert(job.id===124016969855&&job.run_id===run.id&&job.head_sha===run.head_sha&&job.head_branch===run.head_branch&&job.name==='selected-tests'&&job.run_attempt===1&&job.status==='completed'&&job.conclusion==='success','Finite producer job identity differs');
const result=spawnSync('gh',['api','repos/StradaverseHub/ai-hr/actions/jobs/124016969855/logs'],{encoding:'utf8',timeout:60000,maxBuffer:16*1024**2});
const proof={kind:'FINITE_JOB_LOG_TRANSPORT_DIAGNOSTIC_ONLY',producerJobId:124016969855,exitCode:result.status,signal:result.signal,errorCode:['ENOBUFS','ETIMEDOUT','ENOENT','ECONNRESET'].includes(result.error?.code)?result.error.code:null,bytes:Buffer.byteLength(result.stdout??''),installationEligible:false,releaseAuthorized:false,...publicRefusal(result.stderr??'')};
if(result.status===0){proof.reason='TRANSPORT_SUCCEEDED';proof.logSha256=createHash('sha256').update(result.stdout).digest('hex');}
const version=spawnSync('gh',['--version'],{encoding:'utf8',timeout:10000,maxBuffer:4096});
proof.execution={...executionEnvelope({tokenPresent:typeof process.env.GH_TOKEN==='string'&&process.env.GH_TOKEN.length>0,versionText:version.stdout,stderr:result.stderr}),ghAvailable:version.status===0,apiHostnameExact:true};
// Node HTTPS never follows redirects. The Location/body are neither read into diagnostics nor published.
proof.directHttps=await new Promise(resolve=>{
 let timedOut=false,settled=false;
 const finish=value=>{if(settled)return;settled=true;clearTimeout(deadline);resolve(value);};
 const req=request({hostname:'api.github.com',path:'/repos/StradaverseHub/ai-hr/actions/jobs/124016969855/logs',method:'GET',headers:{Authorization:'Bearer '+process.env.GH_TOKEN,'User-Agent':'AIHR-V9-read-only-diagnostic',Accept:'application/vnd.github+json'}},res=>{const response={status:res.statusCode,rate:publicRateHeaders(res.headers),redirectsFollowed:false};res.destroy();finish(response);});
 const deadline=setTimeout(()=>{timedOut=true;req.destroy();finish({status:null,errorClass:'TIMEOUT',redirectsFollowed:false});},20000);
 req.on('error',error=>finish({status:null,errorClass:timedOut?'TIMEOUT':['ENOTFOUND','ETIMEDOUT','ECONNRESET','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID'].includes(error.code)?error.code:'UNCLASSIFIED_NETWORK_ERROR',redirectsFollowed:false}));req.end();
});
writeFileSync(join(output,'log-transport.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(proof));
if(result.status!==0)process.exitCode=1;
