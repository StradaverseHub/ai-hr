/** Fixed real producer packet transport diagnostic; never a test or release PASS. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {verifyArtifactBytes,REPOSITORY} from './release-policy.mjs';
import {validateRepairFocusedMetadata} from './fixture-browser-recovery-policy.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',timeout:60000,maxBuffer:8*1024**2}));
const runId=41037358067,artifactId=12968866354,controller='d6cb83d620d8d4380c981a72fc41628780840b4e',source='6bdddf4f84b3ecb693d8fbf29409373e49c73ac9';
const run=api(`actions/runs/${runId}`),j=api(`actions/runs/${runId}/jobs?filter=all&per_page=100`),a=api(`actions/runs/${runId}/artifacts?per_page=100`),workflow=api('actions/workflows/alpha-focused-checks.yml');
assert(j.total_count===j.jobs.length&&a.total_count===a.artifacts.length,'Complete fixed producer metadata required');
validateRepairFocusedMetadata({run,jobs:j.jobs,artifacts:a.artifacts,expected:{runId,controller,workflowId:workflow.id,after:api('actions/runs/41028659062').updated_at}});
assert(a.artifacts.length===1&&a.artifacts[0].id===artifactId&&a.artifacts[0].digest==='sha256:50563b2fa76d896f57b8c4cf8fead6c56c0429eb294c3dde4590499563702b90','Exact original diagnostic ZIP required');
const bytes=execFileSync('gh',['api',`repos/${REPOSITORY}/actions/artifacts/${artifactId}/zip`],{timeout:60000,maxBuffer:8*1024**2});verifyArtifactBytes(a.artifacts[0],bytes);assert(bytes.length===24534&&bytes.length===a.artifacts[0].size_in_bytes);
const root=mkdtempSync(join(tmpdir(),'fixture-original-transport-')),archive=join(root,'original.zip'),destination=join(root,'extracted');
try{
 writeFileSync(archive,bytes);execFileSync('python3',[fileURLToPath(new URL('./fixture-repair-extract.py',import.meta.url)),archive,destination]);
 assert.deepEqual(readdirSync(destination).sort(),['focused.json','nodb.vitest.json']);
 for(const name of ['focused.json','nodb.vitest.json'])assert(readFileSync(join(destination,name)).equals(execFileSync('python3',['-c','import sys,zipfile;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))',archive,name],{maxBuffer:8*1024**2})),'Extracted coverage bytes changed');
 assert(JSON.parse(readFileSync(join(destination,'focused.json'))).sha===source);
 console.log(JSON.stringify({kind:'AUTHENTICATED_ORIGINAL_PACKET_TRANSPORT_DIAGNOSTIC',runId,artifactId,digest:a.artifacts[0].digest,source,controller,extractedMembers:readdirSync(destination).sort(),releaseAuthorized:false}));
}finally{rmSync(root,{recursive:true,force:true});}
