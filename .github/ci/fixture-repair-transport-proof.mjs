/** All fixed repair packets: authenticated transport diagnostics, never coverage or release PASS. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyArtifactBytes,REPOSITORY,digest} from './release-policy.mjs';
import {validateRepairFocusedMetadata} from './fixture-browser-recovery-policy.mjs';
const exec=promisify(execFile),controller='d6cb83d620d8d4380c981a72fc41628780840b4e',source='6bdddf4f84b3ecb693d8fbf29409373e49c73ac9';
const api=async path=>JSON.parse((await exec('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',timeout:60000,maxBuffer:8*1024**2})).stdout);
const runIds=JSON.parse(readFileSync(new URL('./fixture-repair-packet-runs.json',import.meta.url)));
assert(runIds.length===73&&new Set(runIds).size===73&&runIds.every(n=>Number.isSafeInteger(n)&&n>0),'Exact complete unique finite packet registry required');
const [workflow,original]=await Promise.all([api('actions/workflows/alpha-focused-checks.yml'),api('actions/runs/41028659062')]);
const root=resolve(process.env.RUNNER_TEMP??'/tmp','fixture-packet-transport-diagnostics');mkdirSync(root,{recursive:true,mode:0o700});
let next=0;const records=[];
const saveSummary=complete=>writeFileSync(join(root,'packet-summary.json'),JSON.stringify({kind:'FINITE_ALL_PACKET_TRANSPORT_DIAGNOSTIC_NOT_COVERAGE_OR_RELEASE',source,controller,releaseAuthorized:false,expectedPackets:73,complete,records:records.slice().sort((a,b)=>a.runId-b.runId)},null,2)+'\n');
saveSummary(false);
async function inspect(runId){
 let stage='METADATA',record={runId,releaseAuthorized:false};const directory=join(root,String(runId));mkdirSync(directory,{mode:0o700});
 try{
  const run=await api(`actions/runs/${runId}`),j=await api(`actions/runs/${runId}/jobs?filter=all&per_page=100`),a=await api(`actions/runs/${runId}/artifacts?per_page=100`);
  writeFileSync(join(directory,'metadata.json'),JSON.stringify({run,jobs:j.jobs,artifacts:a.artifacts}));
  assert(j.total_count===j.jobs.length&&a.total_count===a.artifacts.length,'Complete fixed producer metadata required');
  validateRepairFocusedMetadata({run,jobs:j.jobs,artifacts:a.artifacts,expected:{runId,controller,workflowId:workflow.id,after:original.updated_at}});
  assert(a.artifacts.length===1&&a.artifacts[0].name==='focused-development-evidence','Exact focused archive namespace required');
  const artifact=a.artifacts[0];record={...record,artifactId:artifact.id,digest:artifact.digest,archiveBytes:artifact.size_in_bytes};
  stage='ARCHIVE';const bytes=(await exec('gh',['api',`repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`],{encoding:'buffer',timeout:60000,maxBuffer:64*1024**2})).stdout;
  verifyArtifactBytes(artifact,bytes);assert(bytes.length===artifact.size_in_bytes);const archive=join(directory,'original.zip');writeFileSync(archive,bytes,{flag:'wx',mode:0o600});
  const names=JSON.parse((await exec('python3',['-c','import json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps([i.filename for i in z.infolist()]))',archive],{encoding:'utf8',timeout:10000,maxBuffer:128*1024})).stdout);
  record.members=names.map(n=>typeof n==='string'&&n.length<=200&&/^[A-Za-z0-9_./-]+$/.test(n)?n:'UNSAFE_OR_UNEXPECTED_MEMBER');
  stage='EXTRACTOR';const destination=join(directory,'extracted');await exec('python3',[fileURLToPath(new URL('./fixture-repair-extract.py',import.meta.url)),archive,destination],{timeout:10000,maxBuffer:1024*1024});
  stage='SOURCE_AND_BYTES';const report=JSON.parse(readFileSync(join(destination,'focused.json'))),database=report.groups?.DB?.length>0,result=database?'db.vitest.json':'nodb.vitest.json';
  assert.deepEqual(readdirSync(destination).sort(),['focused.json',result].sort());
  assert(report.kind==='FOCUSED_ONLY'&&report.sha===source&&report.controller===controller&&report.runId===String(runId)&&report.attempt==='1','Exact immutable source/run binding required');
  record.extracted=[];
  for(const name of ['focused.json',result]){const bytes=readFileSync(join(destination,name)),raw=(await exec('python3',['-c','import sys,zipfile;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))',archive,name],{encoding:'buffer',timeout:10000,maxBuffer:64*1024**2})).stdout;assert(bytes.equals(raw),'Extracted coverage bytes changed');record.extracted.push({name,digest:digest(bytes)});}
  if([41041082246,41041362860].includes(runId)){
   const tampered=join(directory,'tampered-profile.zip');writeFileSync(tampered,Buffer.concat([bytes,Buffer.from('\n')]),{flag:'wx',mode:0o600});
   await assert.rejects(()=>exec('python3',[fileURLToPath(new URL('./fixture-repair-extract.py',import.meta.url)),tampered,join(directory,'tampered-refused')],{timeout:10000,maxBuffer:1024*1024}),error=>String(error.stderr).includes('Repair member exceeds bound'),'Changed original ZIP bytes must refuse an oversize profile');
   record.immutableOversizeProfileTamperRefusal=true;
  }
  record.status='AUTHENTICATED_ORIGINAL_PACKET_TRANSPORT';
 }catch(error){record.status='REFUSED';record.stage=stage;record.errorClass=error?.name==='AssertionError'?'ASSERTION_REFUSAL':'TRANSPORT_OR_EXTRACTOR_REFUSAL';
  const stderr=Buffer.from(error?.stderr??'');record.stderrBytes=stderr.length;record.stderrDigest=digest(stderr);
  const text=stderr.toString('utf8'),known=['Repair member exceeds bound','Unsafe, duplicate or unknown repair member','Repair packet exceeds bounds','Incomplete letter diagnostic inventory','Incomplete duration diagnostic inventory','Database diagnostics differ'];
  record.reason=known.find(k=>text.includes(k))??(/HTTP (?:502|503|504)/.test(text)?'HTTP_RETRYABLE_SERVER':/unexpected EOF|connection reset|TLS handshake timeout|i\/o timeout/i.test(text)?'TRANSIENT_TRANSPORT':error?.code==='ETIMEDOUT'?'TIMEOUT':'UNCLASSIFIED_REFUSAL');}
 records.push(record);saveSummary(false);console.log(JSON.stringify(record));
}
await Promise.all(Array.from({length:3},async()=>{for(;;){const index=next++;if(index>=runIds.length)return;await inspect(runIds[index]);}}));
assert(records.length===73&&new Set(records.map(r=>r.runId)).size===73,'Packet diagnostic incomplete');
saveSummary(true);
assert(records.every(r=>r.status==='AUTHENTICATED_ORIGINAL_PACKET_TRANSPORT'),'One or more original packets refused; every refusal retained');
