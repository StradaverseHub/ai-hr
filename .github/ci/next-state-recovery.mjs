/** Capture only missing application compiler state; retain the authenticated earlier successful build as its own origin. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,realpathSync,existsSync,rmSync,statfsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {hash,NEXT_RECOVERY_MEMBERS,assertNextCacheInvocation,assertNextAncestry} from './next-build-cache-policy.mjs';
import {nextBuildContext,assertNextBuildSource} from './next-build-cache.mjs';
import {measuredCommand} from './diagnostics/compiler-incremental.mjs';
const SEED={runId:40250429043,source:'b5a75d5ac09b3f2b01841609874a4e83eb405d54',artifactId:12620656229,digest:'f9adf4d8b60a9660ae37df67e0ee7edbb3095af661167ff8aae1270ec45d6ad8'};
const save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const json=p=>JSON.parse(readFileSync(p));
const api=p=>JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/'+p],{timeout:5000,maxBuffer:8*1024**2,encoding:'utf8'}));
export async function recoverNextApplicationState(root){
 const e=process.env;assertNextCacheInvocation(e);assert(e.AIHR_NEXT_BUILD_CACHE_MODE==='recover'&&!e.AIHR_NEXT_BUILD_ORIGIN&&e.AIHR_CI_CAPACITY_PROFILE==='bounded-next-build-diagnostic');
 const source=realpathSync(process.cwd()),temp=realpathSync(e.RUNNER_TEMP),out=join(temp,'diagnostic-next-build-cache'),packet=join(temp,'next-app-state-packet'),next=join(source,'.next'),recordDir=join(homedir(),'.aihr-system-testing-builds');
 assertNextBuildSource(source,e);assert(!existsSync(join(next,'BUILD_ID'))&&!existsSync(join(next,'cache/.tsbuildinfo'))&&!existsSync(recordDir),'Compiler-only recovery starts without a build, graph or records');
 mkdirSync(out,{mode:0o700});const nextStat=lstatSync(next);assert(nextStat.isDirectory()&&!nextStat.isSymbolicLink());
 const report={kind:'RECOVERED_NEXT_APPLICATION_COMPILER_STATE_NOT_BUILD_OR_RELEASE',source:e.AIHR_CI_HEAD,controller:e.AIHR_CI_CONTROL_HEAD,runId:e.GITHUB_RUN_ID,attempt:'1',mode:'recover',phases:[],diskSamples:[],exitCode:1,releaseAuthorized:false,
 runner:{name:e.RUNNER_NAME,sourcePath:source,bootSha256:hash(readFileSync('/proc/sys/kernel/random/boot_id'))},freshBuildExecuted:false};
 let state,envelope,logText,timer;
 const sample=label=>{const s=statfsSync(source),availableBytes=s.bavail*s.bsize;assert(Number.isSafeInteger(availableBytes));report.diskSamples.push({label,at:new Date().toISOString(),availableBytes});return availableBytes;};
 try{
  assert(sample('before')>=8*1024**3);timer=setInterval(()=>{try{sample('during');}catch(error){report.diskSamplingError=String(error);}},5000);
  const run=api('actions/runs/'+SEED.runId),jobs=api('actions/runs/'+SEED.runId+'/attempts/1/jobs?per_page=100'),artifact=api('actions/artifacts/'+SEED.artifactId);
  assert(run.head_sha===SEED.source&&run.repository.id===run.head_repository.id&&run.repository.id===1333414856&&run.path==='.github/workflows/alpha-staging-diagnostics.yml'&&run.run_attempt===1&&run.event==='workflow_dispatch'&&run.conclusion==='failure');
  assert(jobs.total_count===jobs.jobs.length&&jobs.jobs.length<100);const originals=jobs.jobs.filter(j=>j.name==='next-build-cache');assert(originals.length===1);const job=originals[0];
  assert(job.conclusion==='failure'&&job.head_sha===SEED.source&&job.run_id===SEED.runId&&job.run_attempt===1);
  assert(artifact.id===SEED.artifactId&&artifact.name==='diagnostic-next-build-cache'&&!artifact.expired&&artifact.workflow_run.id===SEED.runId&&artifact.workflow_run.head_sha===SEED.source
   &&artifact.workflow_run.repository_id===artifact.workflow_run.head_repository_id&&artifact.workflow_run.repository_id===1333414856&&artifact.digest==='sha256:'+SEED.digest);
  const zip=execFileSync('gh',['api','repos/StradaverseHub/ai-hr/actions/artifacts/'+SEED.artifactId+'/zip'],{timeout:10000,maxBuffer:16*1024**2});assert(zip.length===artifact.size_in_bytes&&hash(zip)===SEED.digest);
  const origin=join(out,'retained-original');mkdirSync(origin,{mode:0o700});writeFileSync(join(origin,'authenticated.zip'),zip,{flag:'wx',mode:0o600});
  // The immutable diagnostic ZIP has only six exact known members. This helper reads, never extracts executable content.
  const proof=JSON.parse(execFileSync('python3',['-c',
   'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);names=set(z.namelist());assert len(names)==len(z.namelist());assert names==set(["canonical-build/build-provenance.json","canonical-build/bytes/build-bundle-files.json","canonical-build/successful-build.json","canonical-build/system-testing.json","canonical-build.log","comparison.json"]);assert sum(i.file_size for i in z.infolist())<32*1024**2;print(json.dumps({n:(z.read(n).decode() if n.endswith(".log") else json.loads(z.read(n))) for n in names}))',
   join(origin,'authenticated.zip')],{timeout:10000,maxBuffer:32*1024**2,encoding:'utf8'}));
  for(const [name,v]of Object.entries({run,jobs,artifact}))save(join(origin,name+'.json'),v);
  const old=proof['comparison.json'],build=proof['canonical-build/build-provenance.json'],prepared=proof['canonical-build/system-testing.json'],successful=proof['canonical-build/successful-build.json'],oldLog=proof['canonical-build.log'];
  assert(old.source===old.controller&&old.source===SEED.source&&old.runId===String(SEED.runId)&&old.exitCode===1
   &&old.error==='TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for /home/runner/work/ai-hr/ai-hr/source/scripts/improve/system-testing-manifest.ts'
   &&old.actualCanonicalBuild.code===0&&old.actualCanonicalBuild.signal===null&&!old.actualCanonicalBuild.timedOut&&old.sourceRestored&&old.controllerRestored&&old.ownedBuildRemoved&&old.ownedRecordsRemoved,'Only the exact known post-build collector failure may be retained');
  assert(Date.parse(old.actualCanonicalBuild.startedAt)>=Date.parse(job.started_at)&&Date.parse(old.actualCanonicalBuild.endedAt)<=Date.parse(job.completed_at)&&hash(Buffer.from(oldLog))===old.buildLogSha256
   &&oldLog.includes('Compiled successfully in ')&&oldLog.includes('Finished TypeScript in ')&&!/Skipping validation of types|Finished TypeScript config validation|\berror TS\d+:/.test(oldLog));
  assert(build.source===build.controller&&build.source===SEED.source&&build.runId===SEED.runId&&build.runAttempt===1&&build.kind==='diagnostic-system-testing-build-not-release'&&build.releaseAuthorized===false);
  assert(isDeepStrictEqual(successful.identity,prepared.identity)&&prepared.identity.sourceRef===SEED.source&&prepared.identity.buildRecordId===build.buildRecordId&&successful.nextBuildId===build.nextBuildId&&successful.preparedRecordSha256===build.preparedSha256);
  const comparison=api('compare/'+SEED.source+'...'+e.AIHR_CI_HEAD+'?per_page=100');const changed=assertNextAncestry(SEED.source,e.AIHR_CI_HEAD,comparison);
  const allowed=p=>p.startsWith('.github/')||p.startsWith('docs/');
  assert(changed.every(allowed)&&comparison.files.every(f=>!f.previous_filename||allowed(f.previous_filename)),'Compiler-state repair cannot change application/configuration/dependencies');save(join(origin,'source-comparison.json'),comparison);
  const c=nextBuildContext(source);assert(isDeepStrictEqual(c,old.context),'Exact retained application compiler inputs required');report.context=c;
  report.retainedBuild={kind:'RETAINED_SUCCESSFUL_BUILD_PHASE_FROM_FAILED_COLLECTOR_NOT_GATE',originalRunId:SEED.runId,originalSource:SEED.source,originalController:SEED.source,originalJobId:job.id,originalJobConclusion:'failure',originalArtifactId:SEED.artifactId,originalArtifactDigest:'sha256:'+SEED.digest,
   canonicalCommandExit:0,canonicalCommandElapsedMs:old.actualCanonicalBuild.elapsedMs,canonicalBuildMs:build.diagnosticDurations.canonicalBuildMs,bundlePackMs:build.diagnosticDurations.packMs,buildId:build.nextBuildId,buildRecordId:build.buildRecordId,freshBuildExecuted:false,releaseAuthorized:false};
  const cache=join(next,'cache');if(!existsSync(cache))mkdirSync(cache,{mode:0o700});assert(!lstatSync(cache).isSymbolicLink());
  const phase={name:'recover-missing-application-state',startedAt:new Date().toISOString()};report.phases.push(phase);
  const log=join(out,'application-check.log');Object.assign(phase,await measuredCommand('/usr/bin/time',['-v','/usr/bin/prlimit','--fsize=67108864','--',process.execPath,join(root,'.github/ci/next-app-typecheck-probe.mjs')],{cwd:source,env:e,log,timeoutMs:420000}),{endedAt:new Date().toISOString()});report.actualApplicationCompiler=phase;
  logText=readFileSync(log,'utf8');assert(phase.code===0&&phase.signal===null&&!phase.timedOut&&logText.includes('ACTUAL_NEXT_APPLICATION_TYPECHECK_COMPLETED')&&!/\berror TS\d+:/.test(logText),'Actual complete application compiler state capture required');
  state=readFileSync(join(cache,'.tsbuildinfo'));const parsed=JSON.parse(state);assert(parsed.version==='5.9.3'&&parsed.fileNames.length>0);
  report.compilerLogSha256=hash(Buffer.from(logText));report.graph={files:parsed.fileNames.length,bytes:state.length,sha256:hash(state)};
  envelope={kind:'NEXT_APPLICATION_COMPILER_STATE_BUILD_MUST_RUN',source:e.AIHR_CI_HEAD,controller:e.AIHR_CI_CONTROL_HEAD,runId:e.GITHUB_RUN_ID,attempt:'1',context:c,completedCommand:'application-compiler-recovery',completedCommandExit:0,completedAt:phase.endedAt,bytes:state.length,sha256:hash(state),files:parsed.fileNames.length,releaseAuthorized:false};
  assertNextBuildSource(source,e);report.exitCode=0;
 }catch(error){report.error=String(error);throw error;}
 finally{
  clearInterval(timer);sample('after');const current=lstatSync(next);assert(current.ino===nextStat.ino&&current.dev===nextStat.dev&&!current.isSymbolicLink());rmSync(next,{recursive:true});
  report.ownedNextOutputRemoved=!existsSync(next);report.ownedRecordsRemoved=!existsSync(recordDir);
  try{assertNextBuildSource(source,e);report.sourceRestored=true;report.controllerRestored=true;}catch(error){report.exitCode=1;report.cleanupError=String(error);}
  if(report.diskSamplingError||Math.min(...report.diskSamples.map(s=>s.availableBytes))<2*1024**3)report.exitCode=1;
  report.endedAt=new Date().toISOString();save(join(out,'comparison.json'),report);
 }
 assert(report.exitCode===0);mkdirSync(packet,{mode:0o700});writeFileSync(join(packet,'state.json'),state,{flag:'wx',mode:0o600});
 for(const [name,v]of Object.entries({'envelope.json':envelope,'producer.json':report,'next-check-log.json':{kind:'RAW_ACTUAL_NEXT_APPLICATION_CHECK',text:logText},'retained-build.json':report.retainedBuild}))save(join(packet,name),v);
 assert(isDeepStrictEqual(readdirSync(packet).sort(),NEXT_RECOVERY_MEMBERS));return report;
}
