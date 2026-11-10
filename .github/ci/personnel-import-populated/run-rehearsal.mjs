// Controller-owned, reviewed one-purpose diagnostic. No dispatch or publishing entry point.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.cwd();
const expected = '8b237feda2fcbcd28d00e793a3c21cd7afd0a49f';
const env = process.env;
const owner = dirname(fileURLToPath(import.meta.url));
const root = env.RUNNER_TEMP;
const git = (...args) => execFileSync('/usr/bin/git', args, {cwd: source, encoding:'utf8', timeout:10000}).trim();
assert.equal(process.platform, 'linux');
assert(process.getuid()>0 && env.GITHUB_ACTIONS==='true' && env.CI==='true' && env.RUNNER_ENVIRONMENT==='github-hosted');
assert.equal(env.GITHUB_REPOSITORY, 'StradaverseHub/ai-hr');
assert(env.GITHUB_EVENT_NAME==='workflow_dispatch' && env.GITHUB_RUN_ATTEMPT==='1' && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID));
assert(/^[0-9a-f]{40}$/.test(env.GITHUB_WORKFLOW_SHA??'') && env.GITHUB_WORKFLOW_SHA!==expected);
assert(env.AIHR_REHEARSAL_CONTROLLER_SHA===env.GITHUB_WORKFLOW_SHA && env.GITHUB_SHA===env.GITHUB_WORKFLOW_SHA);
assert(env.GITHUB_JOB==='selected-tests' && env.GITHUB_WORKFLOW==='alpha-focused-checks');
assert(realpathSync(root)===root && lstatSync(root).uid===process.getuid());
assert(realpathSync(source)===source && source!==owner);
assert.equal(git('rev-parse','HEAD'),expected);
assert.equal(git('rev-parse','HEAD^{tree}'),'3acd04b8ea004726af0526cfbe82378117f354c6');
assert.equal(git('status','--porcelain'),'');
assert.equal(git('config','--get','remote.origin.url'),'https://github.com/StradaverseHub/ai-hr');
for(const name of ['system-performance-evidence','system-performance-private','aihr-focused','aihr-import-rehearsal-public']){
 let present=false;try{lstatSync(join(root,name));present=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 assert(!present);
}
const original = readFileSync(join(source,'scripts/performance/system-runner.mjs'),'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'),'3285cb01c39a327d70374a70ea9dc7a1b7d85eab95f4ae9a18160cb8e901787f');
process.umask(0o077);
const dir=mkdtempSync(join(root,'personnel-import-controller-'));
const ownedFile=join(owner,'rehearsal.mjs');
assert(realpathSync(ownedFile)===ownedFile && lstatSync(ownedFile).isFile());
function replaceOnce(text, from, to){assert.equal(text.split(from).length,2);return text.replace(from,to);}
let runner=original.replace(/(from '\.\/)([^']+)(?=')/g,(_,prefix,suffix)=>`from '${join(source,'scripts/performance',suffix)}`);
runner=replaceOnce(runner,"'scripts/performance/system-fixture.mjs'",`${JSON.stringify(ownedFile)},'seed'`);
runner=replaceOnce(runner,"'scripts/performance/system-load.mjs'",`${JSON.stringify(ownedFile)},'measure'`);
// Preserve the native birth, bracketed 100ms lock log, and exact volume removal.
// The custom import course has its own closed driver report, rather than standard browser IPC.
runner=replaceOnce(runner,"const measureDevelopment=['workflow-preflight','whole-system'].includes(env.PERF_HTTP_SUITE);",
 "const measureDevelopment=true;");
runner=replaceOnce(runner,`const measurement=measureDevelopment?report.developmentMeasurement={kind:'DEVELOPMENT_BROWSER_RUNNER_MEASUREMENT_V1',complete:false,
 driver:null,driverReceipt:'absent',settlement:{driver:'unknown',proxy:'unknown',workers:'unknown',
  ...developmentPostgresSettlement('unknown','unknown',null)}}:null;`, 'const measurement=null;');
runner=replaceOnce(runner,"const capturingBirth=measurement!==null&&label==='postgres';",
 "const capturingBirth=measureDevelopment&&label==='postgres';");
runner=replaceOnce(runner,'  measurement.settlement.postgresReset=developmentReset.state;','');
runner=replaceOnce(runner," if(measurement&&label==='cleanup')"," if(measureDevelopment&&label==='cleanup')");
runner=replaceOnce(runner,' if(measurement&&developmentReset.admitted){',' if(measureDevelopment&&developmentReset.admitted){');
runner=replaceOnce(runner,'  Object.assign(measurement.settlement,developmentPostgresSettlement(developmentReset.state,developmentRemoveApi,physicalAbsent));',
 '  report.importPostgresSettlement=developmentPostgresSettlement(developmentReset.state,developmentRemoveApi,physicalAbsent);');
runner=replaceOnce(runner," if(code!==0&&!comparison){const text=readFileSync(join(privateDir,label+'.log'),'utf8').slice(-12000).replace(/[A-Za-z0-9_-]{32,}/g,'<REDACTED>');writeFileSync(join(out,label+'-failure.txt'),text);}",'');
runner=replaceOnce(runner,"TEST_MIGRATION_DATABASE_URL:env.MIGRATION_DATABASE_URL},600000);",
 "TEST_MIGRATION_DATABASE_URL:env.MIGRATION_DATABASE_URL},720000);");
runner=replaceOnce(runner,"'--','pnpm','build'],buildEnv);","'--','pnpm','build'],buildEnv,720000);");
runner=replaceOnce(runner,'const driverTimeoutMs=600000+Math.max(0,Number(env.PERF_HTTP_HOLD_MS??30000)-30000);','const driverTimeoutMs=540000;');
const privateRunner=join(dir,'runner.mjs');
writeFileSync(privateRunner,runner,{flag:'wx',mode:0o600});
const allowed=['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TZ','PNPM_HOME','COREPACK_HOME','GITHUB_ACTIONS','CI','RUNNER_ENVIRONMENT',
 'RUNNER_OS','RUNNER_ARCH','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_WORKFLOW','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA',
 'GITHUB_REPOSITORY','GITHUB_REPOSITORY_ID','GITHUB_JOB','GITHUB_EVENT_NAME','GITHUB_SHA','RUNNER_TEMP'];
const clean=Object.fromEntries(allowed.filter(key=>env[key]!==undefined).map(key=>[key,env[key]]));
const result=spawnSync(process.execPath,[privateRunner],{cwd:source,env:{...clean,AIHR_CI_HEAD:expected,AIHR_CI_CONTROL_HEAD:env.GITHUB_WORKFLOW_SHA,
 AIHR_CI_UNIT:'db-1',AIHR_CI_PG_PROFILE:'2',AIHR_CI_PG_CONFIGURED_CAP_BYTES:'2113929216',AIHR_CI_PG_PEAK_BUDGET_BYTES:'2147483648',
 AIHR_CI_PG_JIT:'on',AIHR_CI_PG_DURABLE:'1',AIHR_CI_PG_STATEMENTS_OWNER:'system-http-profile',
 PERF_HTTP_SUITE:'personnel-import-populated',PERF_APP_WORKERS:'1',PERF_APP_POOL_CONNECTIONS:'10',PERF_APP_TOTAL_HEAP_MIB:'4096',
 NEXT_TELEMETRY_DISABLED:'1',PLAYWRIGHT_CHROMIUM_EXECUTABLE:'/usr/bin/google-chrome'},stdio:'inherit',timeout:50*60000,killSignal:'SIGTERM'});
assert.equal(git('status','--porcelain'),'');
assert.equal(createHash('sha256').update(readFileSync('core/import.ts')).digest('hex'),
 '133c304e79341ffaf0378d1fcb1adb582d597ae078879d7351af7fbabf8855e7');
assert(!result.error && result.signal===null && [0,1].includes(result.status));
const out=join(root,'system-performance-evidence');
function readReceipt(name,max){
 const path=join(out,name),st=lstatSync(path);
 assert(st.isFile()&&st.uid===process.getuid()&&st.nlink===1&&st.size>0&&st.size<=max);
 return JSON.parse(readFileSync(path,'utf8'));
}
const runnerReceipt=readReceipt('runner.json',256*1024);
assert.equal(runnerReceipt.sha,expected);
assert.equal(runnerReceipt.controller,env.GITHUB_WORKFLOW_SHA);
const cleanup=runnerReceipt.phases.filter(phase=>phase.label==='cleanup');
const pg=runnerReceipt.importPostgresSettlement;
const settled=cleanup.length===1&&cleanup[0].exitCode===0&&cleanup[0].timedOut===false
 &&pg?.postgres==='settled'&&pg.postgresReset==='settled'&&pg.postgresRemoveApi==='settled'&&pg.postgresAbsent===true;
const postgres=spawnSync('/usr/bin/docker',['ps','-aq','--filter',`name=^/aihr-ci-${env.GITHUB_RUN_ID}-1-db-1$`],
 {encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin',HOME:env.HOME}});
const absent=postgres.status===0&&!postgres.error&&postgres.stdout.trim()==='';
const observed=runnerReceipt.poolBudgetEvidence?.observedPoolSizes;
const poolVerified=runnerReceipt.topology?.workers===1&&runnerReceipt.topology.poolPerWorker===10&&runnerReceipt.topology.totalApplicationPool===10
 &&runnerReceipt.poolBudgetEvidence?.verified===true&&Array.isArray(observed)&&observed.length===1&&Array.isArray(observed[0])&&observed[0].length===1&&observed[0][0]===10;
const nativeLockWindow=runnerReceipt.postgresWaitLogCoverage;
const waitLogQualified=nativeLockWindow?.kind==='development-heavyweight-lock-log'&&nativeLockWindow.thresholdMs===100
 &&nativeLockWindow.databaseBackendsSettled===true&&Number.isSafeInteger(nativeLockWindow.retainedFailures);
const terminal={kind:'personnel-import-runner-terminal',source:expected,controller:env.GITHUB_WORKFLOW_SHA,run:Number(env.GITHUB_RUN_ID),
 sourceRestored:true,runtimeSourceOverlay:false,status:result.status,fixtureExit:runnerReceipt.phases.find(phase=>phase.label==='fixture')?.exitCode??null,
 driverExit:runnerReceipt.phases.find(phase=>phase.label==='http-and-browser')?.exitCode??null,
 effectiveApplicationPool:poolVerified?10:null,poolVerified,workerClean:runnerReceipt.profileShutdown?.length===1&&runnerReceipt.profileShutdown[0].code===0&&runnerReceipt.profileShutdown[0].forced===false,
 nativeRuntimeAccepted:runnerReceipt.runtimeAcceptance?.pass===true,postgresLockSignals:runnerReceipt.runtimeAcceptance?.failures.includes('postgres-lock-failure')??null,
 postgresWaitLogQualified:waitLogQualified,postgresRetainedWaits:waitLogQualified?nativeLockWindow.retainedFailures:null,
 postgresCleanupSettled:settled,postgresAbsent:absent,releaseEligible:false};
console.log(JSON.stringify(terminal));
let course;
try{course=readReceipt('personnel-import-rehearsal.json',16*1024);}catch(error){if(error.code!=='ENOENT'||result.status===0)throw error;}
if(course){
assert(course.kind==='personnel-import-integrated-overlap'&&course.source===expected&&course.controller===env.GITHUB_WORKFLOW_SHA
 &&course.run===Number(env.GITHUB_RUN_ID)&&course.fictional===true&&course.releaseEligible===false);
console.log(JSON.stringify(course));
}
const artifact=join(root,'aihr-import-rehearsal-public');
mkdirSync(artifact,{mode:0o700});
writeFileSync(join(artifact,'rehearsal.json'),JSON.stringify({terminal,course:course??null})+'\n',{flag:'wx',mode:0o600});
assert(settled&&absent);
if(result.status===0)assert(poolVerified&&course.passed===true&&runnerReceipt.runtimeAcceptance?.pass===true
 &&waitLogQualified&&nativeLockWindow.retainedFailures===0);
process.exitCode=result.status;
