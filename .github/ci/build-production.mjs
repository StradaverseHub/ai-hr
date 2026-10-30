/** Canonical System Testing build producer; byte output alone never authorizes deployment. */
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readFileSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const controllerRoot=fileURLToPath(new URL('../../',import.meta.url));
const SHA=/^[a-f0-9]{40}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw Error('Production build producer refused: '+message);};
// Closed format2 byte-capacity identity; never use manifest values as allowance.
export const BUILD_CAPACITY_PROFILE=Object.freeze({profileVersion:2,archiveMaxBytes:276824064,zipMaxBytes:293601280});
export function assertBuildCapacityProfile(profile){
 if(!isDeepStrictEqual(profile,BUILD_CAPACITY_PROFILE))fail('unknown or mixed build capacity profile');
 return profile;
}
export function assertBuildPacketAggregate(sizes){
 if(!Array.isArray(sizes)||sizes.length!==5||sizes.some(size=>!Number.isSafeInteger(size)||size<1)
  ||sizes.reduce((total,size)=>total+size,0)>BUILD_CAPACITY_PROFILE.zipMaxBytes)fail('five-member build packet aggregate exceeds bound');
 return true;
}
export const STAGING_BUILD_RUNTIME=Object.freeze({node:'22.23.3',abi:'127',platform:'linux',arch:'x64',glibc:'2.39',next:'16.3.8'});

export function assertBuildRuntime(runtime,environment){
 if(!isDeepStrictEqual(runtime,STAGING_BUILD_RUNTIME))fail('target runtime mismatch');
 for(const [key,value]of Object.entries(environment)){
  if((key.startsWith('NEXT_PUBLIC_')||key==='NEXT_SERVER_ACTIONS_ENCRYPTION_KEY')&&value!==undefined)fail('unreviewed compile environment '+key);
 }
 return true;
}

function assertBuildIdentity(environment){
 if(environment.GITHUB_ACTIONS!=='true'||environment.GITHUB_REPOSITORY!=='StradaverseHub/ai-hr'||environment.GITHUB_REPOSITORY_ID!=='1333414856'
  ||!SHA.test(environment.AIHR_CI_HEAD??'')||!SHA.test(environment.AIHR_CI_CONTROL_HEAD??'')
  ||environment.GITHUB_SHA!==environment.AIHR_CI_CONTROL_HEAD||environment.GITHUB_RUN_ATTEMPT!=='1'
  ||!/^\d{1,16}$/.test(environment.GITHUB_RUN_ID??'')||!Number.isSafeInteger(Number(environment.GITHUB_RUN_ID))||Number(environment.GITHUB_RUN_ID)<1)fail('workflow/candidate/controller identity');
}
export function assertBuildInvocation(environment){
 assertBuildIdentity(environment);
 if(!/^StradaverseHub\/ai-hr\/\.github\/workflows\/alpha-staging\.yml@refs\/heads\/(main|alpha)$/.test(environment.GITHUB_WORKFLOW_REF??''))fail('workflow/candidate/controller identity');
 return true;
}
// CI candidate builds include review dispatches and same-repository PR checks.
// This does not widen the release verifier trusted branch rules.
export function assertCiCandidateBuildInvocation(e){
 assertBuildIdentity(e);
 if(e.CI!=='true'||e.RUNNER_ENVIRONMENT!=='github-hosted'||e.GITHUB_JOB!=='build'
  ||!['workflow_dispatch','push','pull_request'].includes(e.GITHUB_EVENT_NAME)
  ||!/^StradaverseHub\/ai-hr\/\.github\/workflows\/alpha-staging\.yml@refs\/(?:heads\/[A-Za-z0-9_./-]+|pull\/[1-9][0-9]*\/merge)$/.test(e.GITHUB_WORKFLOW_REF??''))fail('CI candidate build identity');
 if(e.GITHUB_EVENT_NAME==='push'&&(e.GITHUB_REF!=='refs/heads/alpha'||e.AIHR_CI_HEAD!==e.AIHR_CI_CONTROL_HEAD))fail('CI candidate alpha push identity');
 for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])
  if(e[key]!=='postgres://nobody:nothing@127.0.0.1:1/no_database')fail('CI candidate build database must remain closed');
 return true;
}
export function assertDiagnosticBuildInvocation(environment){
 assertBuildIdentity(environment);
 const original=environment.GITHUB_WORKFLOW_REF==='StradaverseHub/ai-hr/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025'&&environment.AIHR_NEXT_BUILD_CACHE_MODE===undefined;
 const cache=environment.GITHUB_WORKFLOW_REF==='StradaverseHub/ai-hr/.github/workflows/alpha-staging-diagnostics.yml@refs/heads/codex/test-suite-efficiency-review-20261025'&&environment.GITHUB_JOB==='next-build-cache'&&['cold','warm','recover'].includes(environment.AIHR_NEXT_BUILD_CACHE_MODE);
 if(environment.CI!=='true'||environment.RUNNER_ENVIRONMENT!=='github-hosted'||environment.GITHUB_EVENT_NAME!=='workflow_dispatch'
  ||environment.AIHR_CI_HEAD!==environment.AIHR_CI_CONTROL_HEAD||environment.AIHR_BUILD_DIAGNOSTIC!=='transport-producer'
  ||typeof environment.RUNNER_NAME!=='string'||!environment.RUNNER_NAME.length||environment.RUNNER_NAME.length>200
  ||!(original||cache))fail('manual diagnostic producer identity');
 return true;
}

export function assertSuccessfulObservation(observation,prepared,preparedBytes,buildId,startedAt,endedAt){
 if(observation?.format!==1||observation.kind!=='successful-system-testing-build'||!isDeepStrictEqual(observation.identity,prepared.identity)
  ||observation.preparedRecordSha256!==hash(preparedBytes)||observation.nextBuildId!==buildId
  ||observation.platform!=='linux'||observation.arch!=='x64'||observation.activeServiceVerified!==false||observation.manualExecutionVerified!==false)fail('successful build observation mismatch');
 const started=Date.parse(observation.buildStartedAt),observed=Date.parse(observation.observedAt);
 if(!Number.isFinite(started)||!Number.isFinite(observed)||started<startedAt||observed<started||observed>endedAt)fail('successful observation time');
 return true;
}

function bytes(path,bound){
 const st=lstatSync(path);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<1||st.size>bound)fail('invalid bounded evidence file');
 return readFileSync(path);
}
function cleanHead(path){
 const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:path,encoding:'utf8'}).trim();
 if(!SHA.test(sha)||execFileSync('git',['status','--porcelain'],{cwd:path,encoding:'utf8'}).trim())fail('source must be clean');
 return sha;
}
function assertDotenvCompileKeys(source){
 // Next loads these four files in production. Refuse rather than silently compile a
 // different public configuration. Environment values are never returned or copied into evidence.
 for(const name of ['.env.production.local','.env.local','.env.production','.env']){
  let text;try{text=readFileSync(join(source,name),'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
  for(const line of text.split(/\r?\n/)){
   const key=line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=/)?.[1];
   if(key&&(key.startsWith('NEXT_PUBLIC_')||key==='NEXT_SERVER_ACTIONS_ENCRYPTION_KEY'))fail('unreviewed dotenv compile key '+key);
  }
 }
}

export {assertDotenvCompileKeys as assertBuildDotenvCompileKeys};

/** Invoke with the candidate's installed tsx loader; imports resolve from the real candidate. */
export async function produceBuild({source=process.cwd(),output,purpose='release'}){
 const environment=process.env;
 source=resolve(source);output=resolve(output);
 if(!['release','ci','diagnostic'].includes(purpose))fail('unknown build purpose');
 if(purpose==='release')assertBuildInvocation(environment);else if(purpose==='ci')assertCiCandidateBuildInvocation(environment);else assertDiagnosticBuildInvocation(environment);
 if(realpathSync(source)!==source)fail('source must be a real checkout');
 const load=async relative=>{const raw=await import(pathToFileURL(join(source,relative)).href);return {...(raw.default??{}),...raw};};
 const next=JSON.parse(readFileSync(join(source,'node_modules/next/package.json'),'utf8')).version;
 const runtime={node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime,next};
 assertBuildRuntime(runtime,environment);assertDotenvCompileKeys(source);
 if(cleanHead(source)!==environment.AIHR_CI_HEAD||cleanHead(controllerRoot)!==environment.AIHR_CI_CONTROL_HEAD)fail('source or controller changed');
 if(output===source||output.startsWith(source+'/')||realpathSync(dirname(output))!==dirname(output)||lstatSync(dirname(output)).isSymbolicLink())fail('output must be outside source under a real parent');
 // An existing output refuses and is never overwritten, merged or removed.
 mkdirSync(output,{mode:0o700});
 const testing=await load('scripts/improve/system-testing-manifest.ts');
 const builder=await load('scripts/improve/system-testing-build-cli.ts');
 const {stableTestingJson}=await load('lib/system-testing/hash.ts');
 const buildRecordId=randomUUID();
 const prepared=testing.prepareSystemTestingBuild({worktree:source,candidate:environment.AIHR_CI_HEAD,buildRecordId});
 const directory=testing.systemTestingBuildDirectory('remote');testing.ensurePrivateReleaseDirectory(directory);
 testing.publishSystemTestingBuild(prepared,directory);
 const selected=testing.readPublishedTestingBuild(directory,{sourceRef:environment.AIHR_CI_HEAD,buildRecordId});
 const preparedBytes=Buffer.from(stableTestingJson(prepared)+'\n');
 if(!selected.bytes.equals(preparedBytes))fail('published preparation changed');
 const startedAt=Date.now();
 // This API executes the actual canonical pnpm build, including compiler checks and
 // official owned-record environment. No injected/fake child seam is supplied here.
 const observationPath=builder.runTestingProductionBuild({worktree:source,directory,sourceRef:environment.AIHR_CI_HEAD,buildRecordId});
 const endedAt=Date.now(),observationBytes=bytes(observationPath,1024*1024),observation=JSON.parse(observationBytes);
 const buildId=testing.testingNextBuildId(source);
 assertSuccessfulObservation(observation,prepared,preparedBytes,buildId,startedAt,endedAt);
 testing.verifyInstalledTestingBuild(prepared,source);
 if(cleanHead(source)!==environment.AIHR_CI_HEAD||cleanHead(controllerRoot)!==environment.AIHR_CI_CONTROL_HEAD)fail('source changed during build');
 const packStartedAt=Date.now();
 execFileSync('python3',[join(controllerRoot,'.github/ci/build-bundle.py'),'pack',source,join(output,'bytes')],{stdio:'inherit'});
 const packEndedAt=Date.now();
 const manifestBytes=bytes(join(output,'bytes/build-bundle-files.json'),16*1024*1024),manifest=JSON.parse(manifestBytes);
 assertBuildCapacityProfile(manifest.capacityProfile);
 if(manifest.format!==2||manifest.platform!=='linux'||manifest.nextBuildId!==buildId)fail('bundle/build identity mismatch');
 testing.verifyInstalledTestingBuild(prepared,source);
 if(cleanHead(source)!==environment.AIHR_CI_HEAD||cleanHead(controllerRoot)!==environment.AIHR_CI_CONTROL_HEAD
  ||!testing.readPublishedTestingBuild(directory,{sourceRef:environment.AIHR_CI_HEAD,buildRecordId}).bytes.equals(preparedBytes)
  ||!bytes(observationPath,1024*1024).equals(observationBytes))fail('source or build evidence changed during packaging');
 const provenance={format:2,capacityProfile:BUILD_CAPACITY_PROFILE,kind:purpose==='diagnostic'?'diagnostic-system-testing-build-not-release':'ci-system-testing-build-candidate',source:environment.AIHR_CI_HEAD,controller:environment.AIHR_CI_CONTROL_HEAD,
  repository:'StradaverseHub/ai-hr',repositoryId:1333414856,runId:Number(environment.GITHUB_RUN_ID),runAttempt:1,
  workflowRef:environment.GITHUB_WORKFLOW_REF,runtime,buildRecordId,nextBuildId:buildId,
  lockSha256:hash(readFileSync(join(source,'pnpm-lock.yaml'))),packageSha256:hash(readFileSync(join(source,'package.json'))),
  preparedSha256:hash(preparedBytes),successfulObservationSha256:hash(observationBytes),manifestSha256:hash(manifestBytes),
  archiveSha256:manifest.archiveSha256,archiveBytes:manifest.archiveBytes,releaseAuthorized:false};
 if(purpose!=='diagnostic')provenance.buildSourcePath=source;
 if(purpose==='diagnostic'){
  provenance.diagnosticRunner={name:environment.RUNNER_NAME,sourcePath:source,bootSha256:hash(readFileSync('/proc/sys/kernel/random/boot_id'))};
  provenance.diagnosticDurations={canonicalBuildMs:endedAt-startedAt,packMs:packEndedAt-packStartedAt};
 }
 const records=[['system-testing.json',preparedBytes],['successful-build.json',observationBytes],['build-provenance.json',Buffer.from(JSON.stringify(provenance)+'\n')]];
 const archive=lstatSync(join(output,'bytes/build-bundle.tar.gz'));
 if(!archive.isFile()||archive.isSymbolicLink()||archive.nlink!==1||archive.size<1||archive.size>BUILD_CAPACITY_PROFILE.archiveMaxBytes||archive.size!==manifest.archiveBytes)fail('actual archive capacity differs');
 assertBuildPacketAggregate([...records.map(([,data])=>data.length),manifestBytes.length,archive.size]);
 for(const [name,data]of records)writeFileSync(join(output,name),data,{flag:'wx',mode:0o600});
 return provenance;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv[2],selected=['--diagnostic','--ci'].includes(mode);
 if(process.argv.length!==(selected?4:3))throw Error('Usage: pnpm exec tsx build-production.mjs [--diagnostic|--ci] NEW_OUTPUT_DIRECTORY');
 produceBuild({output:process.argv[selected?3:2],purpose:mode==='--diagnostic'?'diagnostic':mode==='--ci'?'ci':'release'}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});
}
