/** Two real hosted VMs, one canonical build. Diagnostic only: no release receipt or service authority. */
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {createWriteStream,readFileSync,writeFileSync,mkdirSync,lstatSync,chmodSync,rmSync,realpathSync,openSync,closeSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {isDeepStrictEqual} from 'node:util';
import {brotliDecompressSync} from 'node:zlib';
import {assertBuildRuntime,assertDiagnosticBuildInvocation,assertSuccessfulObservation,BUILD_CAPACITY_PROFILE,assertBuildCapacityProfile,assertBuildPacketAggregate} from './build-production.mjs';

import {assertCiTransportInvocation,validateCiTransportRefs,validateCiTransportConsumerRun,validateCiTransportMetadata,validateCiTransportProvenance} from './ci-build-transport-policy.mjs';

const controller=fileURLToPath(new URL('../../',import.meta.url));
const REPO='StradaverseHub/ai-hr',WORKFLOW='.github/workflows/alpha-staging-diagnostics.yml';
const NAME='diagnostic-build-transport-producer';
const MAX_ZIP=BUILD_CAPACITY_PROFILE.zipMaxBytes;
const hash=data=>createHash('sha256').update(data).digest('hex');
const fail=message=>{throw Error('Build transport refused: '+message);};
const requireValue=(value,message)=>{if(!value)fail(message);};
const git=(source,args)=>execFileSync('git',args,{cwd:source,encoding:'utf8'}).trim();
const api=path=>JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/'+path],{encoding:'utf8',maxBuffer:2*1024**2,timeout:30000}));


export function assertTransportConsumerInvocation(e){
 if(e.AIHR_BUILD_DIAGNOSTIC!=='transport-consumer-repair')return assertDiagnosticBuildInvocation(e);
 requireValue(e.GITHUB_ACTIONS==='true'&&e.CI==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY===REPO
  &&e.GITHUB_REPOSITORY_ID==='1333414856'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_RUN_ATTEMPT==='1'
  &&/^[a-f0-9]{40}$/.test(e.AIHR_CI_HEAD??'')&&/^[a-f0-9]{40}$/.test(e.AIHR_CI_CONTROL_HEAD??'')&&e.GITHUB_SHA===e.AIHR_CI_CONTROL_HEAD
  &&/^[1-9][0-9]{0,15}$/.test(e.GITHUB_RUN_ID??'')&&Number.isSafeInteger(Number(e.GITHUB_RUN_ID))
  &&/^[1-9][0-9]{0,15}$/.test(e.AIHR_BUILD_PRODUCER_RUN_ID??'')&&Number.isSafeInteger(Number(e.AIHR_BUILD_PRODUCER_RUN_ID))
  &&e.AIHR_BUILD_PRODUCER_RUN_ID!==e.GITHUB_RUN_ID&&e.AIHR_BUILD_PRODUCER_CONTROL_HEAD===e.AIHR_CI_HEAD
  &&typeof e.RUNNER_NAME==='string'&&e.RUNNER_NAME.length>0&&e.RUNNER_NAME.length<=200
  &&e.GITHUB_WORKFLOW_REF==='StradaverseHub/ai-hr/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025','manual consumer repair identity');
 return true;
}
function originRunId(e){return e.AIHR_BUILD_DIAGNOSTIC==='transport-consumer-repair'?Number(e.AIHR_BUILD_PRODUCER_RUN_ID):Number(e.GITHUB_RUN_ID);}
function originController(e){return e.AIHR_BUILD_DIAGNOSTIC==='transport-consumer-repair'?e.AIHR_BUILD_PRODUCER_CONTROL_HEAD:e.AIHR_CI_CONTROL_HEAD;}

export function validateTransportMetadata({run,jobs,artifact},env){
 const runId=originRunId(env),artifactId=Number(env.AIHR_BUILD_ARTIFACT_ID);
 requireValue(Number.isSafeInteger(artifactId)&&artifactId>0,'artifact selector');
 requireValue(run.id===runId&&run.run_attempt===1&&run.event==='workflow_dispatch'&&run.head_sha===env.AIHR_CI_HEAD
  &&run.path===WORKFLOW&&run.head_branch==='codex/test-suite-efficiency-review-20261025'
  &&run.repository?.full_name===REPO&&run.repository.id===1333414856,'authenticated run identity');
 const producers=jobs.filter(j=>j.name==='build-transport-producer');
 requireValue(producers.length===1,'unique producer job');
 const producer=producers[0];
 requireValue(producer.run_id===runId&&producer.run_attempt===1&&producer.status==='completed'&&producer.conclusion==='success'
  &&producer.head_sha===env.AIHR_CI_HEAD&&Number.isFinite(Date.parse(producer.started_at))&&Number.isFinite(Date.parse(producer.completed_at)),'completed producer job');
 requireValue(artifact.id===artifactId&&artifact.name===NAME&&artifact.expired===false&&artifact.workflow_run?.id===runId
  &&artifact.workflow_run.head_sha===env.AIHR_CI_HEAD&&/^[a-f0-9]{64}$/.test(env.AIHR_BUILD_ARTIFACT_DIGEST??'')&&artifact.digest==='sha256:'+env.AIHR_BUILD_ARTIFACT_DIGEST
  &&/^sha256:[a-f0-9]{64}$/.test(artifact.digest)&&Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=MAX_ZIP,'authenticated artifact identity/bound');
 return producer;
}
export function validateTransportProvenance(p,env,runtime,localRunner){
 assertTransportConsumerInvocation(env);assertBuildRuntime(runtime,env);
 assertBuildCapacityProfile(p?.capacityProfile);
 requireValue(p?.format===2&&p.kind==='diagnostic-system-testing-build-not-release'&&p.releaseAuthorized===false
  &&p.source===env.AIHR_CI_HEAD&&p.controller===originController(env)&&p.repository===REPO&&p.repositoryId===1333414856
  &&p.runId===originRunId(env)&&p.runAttempt===1&&p.workflowRef===env.GITHUB_WORKFLOW_REF
  &&Number.isSafeInteger(p.archiveBytes)&&p.archiveBytes>0&&p.archiveBytes<=BUILD_CAPACITY_PROFILE.archiveMaxBytes
  &&isDeepStrictEqual(p.runtime,runtime)&&/^[a-f0-9-]{36}$/.test(p.buildRecordId)&&typeof p.nextBuildId==='string'&&p.nextBuildId.length>0,'producer provenance');
 for(const k of ['lockSha256','packageSha256','preparedSha256','successfulObservationSha256','manifestSha256','archiveSha256'])requireValue(/^[a-f0-9]{64}$/.test(p[k]),'provenance digest');
 requireValue(p.diagnosticRunner&&typeof p.diagnosticRunner.name==='string'&&p.diagnosticRunner.name.length
  &&/^[a-f0-9]{64}$/.test(p.diagnosticRunner.bootSha256)
  &&typeof p.diagnosticRunner.sourcePath==='string'&&p.diagnosticRunner.sourcePath.startsWith('/')
  &&typeof localRunner.sourcePath==='string'&&localRunner.sourcePath.startsWith('/')&&p.diagnosticRunner.sourcePath!==localRunner.sourcePath
  &&p.diagnosticRunner.name!==localRunner.name&&p.diagnosticRunner.bootSha256!==localRunner.bootSha256,'fresh independent VM and different source path required');
 return true;
}

async function download(id,destination,expectedDigest){
 const child=spawn('gh',['api','repos/'+REPO+'/actions/artifacts/'+id+'/zip'],{stdio:['ignore','pipe','pipe']});
 const exited=once(child,'close');let errors='';child.stderr.on('data',data=>{if(errors.length<2048)errors+=data.toString().slice(0,2048-errors.length);});
 let count=0;const h=createHash('sha256');
 const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
 try{
  await pipeline(child.stdout,new Transform({transform(chunk,encoding,callback){count+=chunk.length;if(count>MAX_ZIP)return callback(Error('ZIP transfer bound'));h.update(chunk);callback(null,chunk);}}),createWriteStream(destination,{flags:'wx',mode:0o600}));
  const [code,signal]=await exited;requireValue(code===0&&!signal,'artifact transfer command failed');requireValue(h.digest('hex')===expectedDigest,'download digest differs');
  return count;
 }catch(error){child.kill('SIGTERM');await exited.catch(()=>{});throw error;}finally{clearTimeout(timer);}
}

export function compareCjkRasters(subset,reference){
 requireValue(isDeepStrictEqual(subset.info,reference.info)&&subset.data.length===reference.data.length&&subset.data.length>0,'CJK raster dimensions');
 let different=0,totalDelta=0,ink=0;
 for(let i=0;i<subset.data.length;i++){const delta=Math.abs(subset.data[i]-reference.data[i]);if(delta>8)different++;totalDelta+=delta;if(subset.data[i]<200)ink++;}
 const ratio=different/subset.data.length,meanDelta=totalDelta/subset.data.length;
 requireValue(ink>1000&&ratio<0.005&&meanDelta<0.5,'subset glyph raster differs from full canonical font');
 return {width:subset.info.width,height:subset.info.height,inkChannels:ink,differentRatio:ratio,meanDelta};
}

async function nativeRuntime(source,manifest,directory){
 const require=createRequire(join(source,'package.json'));
 const alias=name=>join(source,'.next',manifest.aliases.find(a=>a.package===name).path);
 for(const name of ['sharp','fontkit'])requireValue(realpathSync(alias(name))===realpathSync(join(source,'node_modules',name)),'relocated alias target');
 const sharp=require(alias('sharp')),fontkit=require(alias('fontkit'));
 const input=Buffer.from([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]);
 const png=await sharp(input,{raw:{width:2,height:2,channels:4}}).png().toBuffer();
 const webp=await sharp(png).webp({lossless:true}).toBuffer();
 const decoded=await sharp(webp).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 requireValue(decoded.info.width===2&&decoded.info.height===2&&decoded.data.equals(input),'native Sharp codec roundtrip');
 const fontBytes=brotliDecompressSync(readFileSync(join(source,'assets/fonts/NotoSansSC-Regular.otf.br')));
 const text='实发工资 Aisyah Rahman 實發工資';
 const face=fontkit.create(fontBytes);
 for(const ch of text)if(ch!==' ')requireValue(face.glyphForCodePoint(ch.codePointAt(0)).id!==0,'CJK glyph missing');
 const raw=await import(pathToFileURL(join(source,'lib/payslip-pdf-fonts.ts')).href);
 const fonts={...(raw.default??{}),...raw};
 const {PDFDocument}=require('pdf-lib');
 for(const mode of ['subset','reference']){
  const doc=await PDFDocument.create();let font;
  if(mode==='subset'){const faces=await fonts.embedPayslipFaces(doc,['cjk']);requireValue(faces.length===1&&faces[0].script==='cjk','canonical CJK embedding');font=faces[0].regular;}
  else{doc.registerFontkit(fontkit);font=await doc.embedFont(fontBytes,{subset:false});}
  const page=doc.addPage([700,120]);page.drawText(text,{x:20,y:50,size:22,font});
  const pdf=join(directory,'cjk-'+mode+'.pdf');writeFileSync(pdf,await doc.save(),{flag:'wx',mode:0o600});
  execFileSync('pdftoppm',['-singlefile','-r','72','-png',pdf,join(directory,'cjk-'+mode)],{timeout:30000});
  const extracted=execFileSync('pdftotext',[pdf,'-'],{encoding:'utf8',timeout:30000});
  requireValue(extracted.replace(/\s/g,'')===text.replace(/\s/g,''),'CJK extracted text differs');
 }
 const subset=await sharp(join(directory,'cjk-subset.png')).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const reference=await sharp(join(directory,'cjk-reference.png')).removeAlpha().raw().toBuffer({resolveWithObject:true});
 requireValue(isDeepStrictEqual(subset.info,reference.info),'CJK raster dimensions');
 const raster=compareCjkRasters(subset,reference);
 // Deliberately discard the larger full-font PDF after recording the comparison.
 rmSync(join(directory,'cjk-reference.pdf'));
 return {sharp:{version:sharp.versions.sharp,vips:sharp.versions.vips,pngSha256:hash(png),webpSha256:hash(webp),losslessPixels:true},
  cjk:{text,fontSha256:hash(fontBytes),glyphsPresent:true,canonicalSubset:true,extractedText:true,raster}};
}
async function runtimeServer(source,manifest,directory){
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;
 await new Promise((ok,no)=>socket.close(error=>error?no(error):ok()));
 const asset=manifest.files.find(r=>r.path.startsWith('static/chunks/')&&r.path.endsWith('.js')&&r.size>0&&r.size<1024**2);
 requireValue(asset,'bounded static asset missing');
 const log=openSync(join(directory,'next-start.log'),'wx',0o600);
 const child=spawn(process.execPath,[join(source,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:source,env:{...process.env,NODE_ENV:'production',SHARE_PASSWORD:'owned-diagnostic-gate'},stdio:['ignore',log,log]});
 closeSync(log);const ended=once(child,'close');let endedValue;ended.then(value=>{endedValue=value;}).catch(()=>{});
 const start=Date.now();let response;
 try{
  while(Date.now()-start<30000&&!endedValue){
   try{response=await fetch('http://127.0.0.1:'+port+'/_next/'+asset.path,{signal:AbortSignal.timeout(2000)});break;}catch{}
   await new Promise(ok=>setTimeout(ok,200));
  }
  requireValue(response?.status===200,'transported Next server/static response');
  const body=Buffer.from(await response.arrayBuffer());requireValue(body.length===asset.size&&hash(body)===asset.sha256,'HTTP served build bytes differ');
  const root=await fetch('http://127.0.0.1:'+port+'/',{redirect:'manual',signal:AbortSignal.timeout(10000)});
  requireValue(root.status===401,'signed-out root gate');
  return {staticPath:asset.path,staticSha256:hash(body),status:response.status,rootStatus:root.status,readyElapsedMs:Date.now()-start,applicationDatabaseHealthVerified:false};
 }finally{
  if(!endedValue)child.kill('SIGTERM');
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
  try{await ended;}finally{clearTimeout(timer);}
  requireValue(endedValue!==undefined,'owned Next process cleanup');
 }
}

/** Re-authenticate before candidate dependency installation and again before byte transfer. */
export function authenticateCiTransportOrigin(env=process.env){
 assertCiTransportInvocation(env);
 const producerRunId=Number(env.AIHR_BUILD_PRODUCER_RUN_ID);
 const run=api('actions/runs/'+producerRunId),jobsResponse=api('actions/runs/'+producerRunId+'/attempts/1/jobs?per_page=100');
 const consumerRun=api('actions/runs/'+env.GITHUB_RUN_ID);validateCiTransportConsumerRun(consumerRun,env);
 requireValue(jobsResponse.total_count===jobsResponse.jobs.length&&jobsResponse.jobs.length<100,'bounded complete CI jobs inventory');
 const refs={source:api('git/ref/heads/'+env.AIHR_BUILD_SOURCE_BRANCH),producer:api('git/ref/heads/'+env.AIHR_BUILD_PRODUCER_BRANCH),consumer:api('git/ref/heads/'+env.GITHUB_REF_NAME)};
 validateCiTransportRefs(refs,env);
 const artifact=api('actions/artifacts/'+env.AIHR_BUILD_ARTIFACT_ID),inventory=api('actions/runs/'+producerRunId+'/artifacts?per_page=100');
 requireValue(inventory.total_count===inventory.artifacts.length&&inventory.artifacts.length<100,'bounded complete CI artifacts inventory');
 const producer=validateCiTransportMetadata({run,jobs:jobsResponse.jobs,artifact,artifacts:inventory.artifacts},env);
 return {run,jobsResponse,consumerRun,refs,artifact,inventory,producer};
}

export async function consumeBuild({source=process.cwd(),output=join(process.env.RUNNER_TEMP,'diagnostic-build-transport'),qualification='diagnostic'}={}){
 const env=process.env,started=Date.now();source=resolve(source);output=resolve(output);
 requireValue(['diagnostic','ci'].includes(qualification),'explicit transport qualification mode');
 const ci=qualification==='ci';
 if(ci)assertCiTransportInvocation(env);else assertTransportConsumerInvocation(env);
 requireValue(realpathSync(source)===source&&git(source,['rev-parse','HEAD'])===env.AIHR_CI_HEAD&&!git(source,['status','--porcelain'])
  &&git(controller,['rev-parse','HEAD'])===env.AIHR_CI_CONTROL_HEAD&&!git(controller,['status','--porcelain']),'clean exact source/controller');
 requireValue(!existsSync(join(source,'.next')),'consumer must start without a build');
 mkdirSync(output,{mode:0o700});
 const phases={};let built,originalMode;const cleanup={ownedNextStopped:false,ownedBuildRemoved:false,sourceModeRestored:false};
 try{
  let run,jobsResponse,consumerRun,artifact,producer;
  if(ci){
   const origin=authenticateCiTransportOrigin(env);
   ({run,jobsResponse,consumerRun,artifact,producer}=origin);
   writeFileSync(join(output,'origin-refs.json'),JSON.stringify(origin.refs)+'\n',{flag:'wx',mode:0o600});
   writeFileSync(join(output,'origin-artifacts.json'),JSON.stringify(origin.inventory)+'\n',{flag:'wx',mode:0o600});
  }else{
   run=api('actions/runs/'+originRunId(env));jobsResponse=api('actions/runs/'+originRunId(env)+'/attempts/1/jobs?per_page=100');
   consumerRun=api('actions/runs/'+env.GITHUB_RUN_ID);
   requireValue(consumerRun.id===Number(env.GITHUB_RUN_ID)&&consumerRun.run_attempt===1&&consumerRun.event==='workflow_dispatch'&&consumerRun.head_sha===env.AIHR_CI_CONTROL_HEAD&&consumerRun.path===WORKFLOW&&consumerRun.head_branch==='codex/test-suite-efficiency-review-20261025'&&consumerRun.repository?.full_name===REPO&&consumerRun.repository.id===1333414856,'authenticated consumer run identity');
   requireValue(jobsResponse.total_count===jobsResponse.jobs.length&&jobsResponse.jobs.length<100,'bounded complete jobs inventory');
   artifact=api('actions/artifacts/'+env.AIHR_BUILD_ARTIFACT_ID);
   producer=validateTransportMetadata({run,jobs:jobsResponse.jobs,artifact},env);
  }
  for(const [name,value]of Object.entries({run,consumerRun,jobs:jobsResponse,artifact}))writeFileSync(join(output,name+'.json'),JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
  const archive=join(output,'authenticated-build.zip'),digest=artifact.digest.slice(7),downloadStart=Date.now();
  const downloadedBytes=await download(artifact.id,archive,digest);requireValue(downloadedBytes===artifact.size_in_bytes,'authenticated ZIP size differs');phases.downloadMs=Date.now()-downloadStart;
  execFileSync('python3',[join(controller,'.github/ci/build-transport-extract.py'),archive,join(output,'packet'),digest],{stdio:'inherit'});
  const packet=join(output,'packet'),p=JSON.parse(readFileSync(join(packet,'build-provenance.json')));
  const runtime={node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime,next:JSON.parse(readFileSync(join(source,'node_modules/next/package.json'))).version};
  const runner={name:env.RUNNER_NAME,sourcePath:source,bootSha256:hash(readFileSync('/proc/sys/kernel/random/boot_id'))};
  if(ci)validateCiTransportProvenance(p,env,runtime,runner,producer,run);else validateTransportProvenance(p,env,runtime,runner);
  const producerRunner=ci?p.producerRunner:p.diagnosticRunner;
  const binding=[['pnpm-lock.yaml',p.lockSha256,source],['package.json',p.packageSha256,source],['system-testing.json',p.preparedSha256,packet],['successful-build.json',p.successfulObservationSha256,packet],['bytes/build-bundle-files.json',p.manifestSha256,packet]];
  for(const [name,digest,base]of binding)requireValue(hash(readFileSync(join(base,name)))===digest,'bound input changed: '+name);
  const load=async name=>{const value=await import(pathToFileURL(join(source,name)).href);return {...(value.default??{}),...value};};
  const testing=await load('scripts/improve/system-testing-manifest.ts');
  const preparedBytes=readFileSync(join(packet,'system-testing.json')),prepared=testing.parsePreparedTestingBuild(preparedBytes,{sourceRef:p.source,buildRecordId:p.buildRecordId});
  testing.verifyInstalledTestingBuild(prepared,source);
  const observation=JSON.parse(readFileSync(join(packet,'successful-build.json')));
  assertSuccessfulObservation(observation,prepared,preparedBytes,p.nextBuildId,Date.parse(ci?producer.started_at:run.run_started_at),Date.parse(producer.completed_at));
  const manifest=JSON.parse(readFileSync(join(packet,'bytes/build-bundle-files.json')));
  assertBuildCapacityProfile(manifest.capacityProfile);
  assertBuildPacketAggregate(['build-provenance.json','system-testing.json','successful-build.json','bytes/build-bundle-files.json','bytes/build-bundle.tar.gz'].map(name=>lstatSync(join(packet,name)).size));
  requireValue(manifest.format===2&&manifest.platform==='linux'&&manifest.nextBuildId===p.nextBuildId&&manifest.archiveBytes===p.archiveBytes&&manifest.archiveSha256===p.archiveSha256,'manifest provenance differs');
  const packageEvidence=execFileSync('python3',[join(controller,'.github/ci/build-package-diagnostic.py'),source,producerRunner.sourcePath],{maxBuffer:1024*1024});
  writeFileSync(join(output,'runtime-packages.json'),packageEvidence,{flag:'wx',mode:0o600});
  originalMode=lstatSync(source).mode&0o777;chmodSync(source,0o700);
  const unpackStart=Date.now();
  execFileSync('python3',[join(controller,'.github/ci/build-bundle.py'),'unpack-with-origin',join(packet,'bytes/build-bundle.tar.gz'),join(packet,'bytes/build-bundle-files.json'),join(source,'.next'),source,producerRunner.sourcePath],{stdio:'inherit'});
  built=lstatSync(join(source,'.next'));phases.unpackMs=Date.now()-unpackStart;
  requireValue(testing.testingNextBuildId(source)===p.nextBuildId,'installed BUILD_ID');
  const config=JSON.parse(readFileSync(join(source,'.next/required-server-files.json')));
  for(const [key,value]of Object.entries(testing.systemTestingCompileEnvironment(prepared)))requireValue(config.config?.env?.[key]===value,'compiled System Testing identity differs');
  const phaseEvidence=(kind,result)=>({format:1,kind,source:p.source,controller:env.AIHR_CI_CONTROL_HEAD,producerController:p.controller,runId:Number(env.GITHUB_RUN_ID),producerRunId:run.id,nextBuildId:p.nextBuildId,buildRecordId:p.buildRecordId,result,releaseAuthorized:false,sourceCleanVerified:false});
  const nativeStart=Date.now(),native=await nativeRuntime(source,manifest,output);phases.nativeMs=Date.now()-nativeStart;
  writeFileSync(join(output,'native-runtime.json'),JSON.stringify(phaseEvidence('completed-native-runtime-assertions-not-release',native),null,2)+'\n',{flag:'wx',mode:0o600});
  const server=await runtimeServer(source,manifest,output);cleanup.ownedNextStopped=true;
  writeFileSync(join(output,'server-runtime.json'),JSON.stringify(phaseEvidence('completed-next-runtime-assertions-not-release',server),null,2)+'\n',{flag:'wx',mode:0o600});
  const sourceStatus={source:git(source,['status','--porcelain','--untracked-files=all']),controller:git(controller,['status','--porcelain','--untracked-files=all'])};
  writeFileSync(join(output,'source-status.json'),JSON.stringify(sourceStatus)+'\n',{flag:'wx',mode:0o600});
  requireValue(!sourceStatus.source&&!sourceStatus.controller,'source/controller cleanliness changed during consumer');
  const result={format:2,capacityProfile:BUILD_CAPACITY_PROFILE,kind:ci?'ci-build-transport-qualified-not-release':'diagnostic-build-transport-verified-not-release',releaseAuthorized:false,source:p.source,controller:env.AIHR_CI_CONTROL_HEAD,producerController:p.controller,runId:consumerRun.id,producerRunId:run.id,runAttempt:1,artifact:{id:artifact.id,digest:artifact.digest,downloadedBytes},runtime,producerRunner,consumerRunner:runner,nextBuildId:p.nextBuildId,buildRecordId:p.buildRecordId,files:manifest.files.length,unpackedBytes:manifest.unpackedBytes,phases,native,server,elapsedMs:Date.now()-started,activeStagingServiceVerified:false,...(ci?{applicationDatabaseHealthVerified:false,authenticatedApplicationJourneysVerified:false,producerEvent:run.event}: {})};
  writeFileSync(join(output,'transport.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  // Keep only small audit/runtime evidence; the authenticated producer artifact retains build bytes.
  rmSync(archive);rmSync(join(packet,'bytes/build-bundle.tar.gz'));
  return result;
 }finally{
  for(const binary of [join(output,'authenticated-build.zip'),join(output,'packet/bytes/build-bundle.tar.gz')])if(existsSync(binary))rmSync(binary);
  if(built){const current=lstatSync(join(source,'.next'));requireValue(current.ino===built.ino&&current.dev===built.dev&&!current.isSymbolicLink(),'owned build cleanup identity');rmSync(join(source,'.next'),{recursive:true});cleanup.ownedBuildRemoved=!existsSync(join(source,'.next'));}
  if(originalMode!==undefined){chmodSync(source,originalMode);cleanup.sourceModeRestored=(lstatSync(source).mode&0o777)===originalMode;}
  writeFileSync(join(output,'cleanup.json'),JSON.stringify(cleanup)+'\n',{flag:'wx',mode:0o600});
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))consumeBuild().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
