/** Offline ORIGINAL replay, launched only by the separately qualified fixed
 * kernel adapter. No API token, caller program or new native execution claim. */
import assert from 'node:assert/strict';
import {readSync,writeFileSync,lstatSync,realpathSync,readdirSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {CONTRACT,digest,originalReconstructionEnvironment,validatePublicComparison} from './policy.mjs';
const byteLimit=16*1024**2;
function bytes(path,limit=byteLimit){
 assert.equal(realpathSync(path),path);const info=lstatSync(path);assert(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size>0&&info.size<=limit);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=fstatSync(fd);for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(before[key],info[key]);
  const data=Buffer.allocUnsafe(before.size);let offset=0;
  while(offset<data.length){const n=readSync(fd,data,offset,data.length-offset,offset);assert(n>0,'Original member truncated');offset+=n;}
  assert.equal(readSync(fd,Buffer.alloc(1),0,1,offset),0,'Original member grew');const after=fstatSync(fd),current=lstatSync(path);
  for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert(before[key]===after[key]&&before[key]===current[key]);assert(!current.isSymbolicLink());return data;
 }finally{closeSync(fd);}
}
export {bytes as readOriginalMember};
export async function compareOriginalCatalogue(){
 assert.equal(process.argv.length,2);assert.equal(process.versions.node,'22.23.3');assert.equal(process.platform,'linux');
 const temp=realpathSync(process.env.RUNNER_TEMP),privateRoot=join(temp,'original-catalogue-replay-private');assert.equal(realpathSync(privateRoot),privateRoot);
 const input=JSON.parse(bytes(join(privateRoot,'worker-input.json'),1024*1024).toString('utf8'));assert.deepEqual(Object.keys(input).sort(),['artifacts','original']);
 const original=realpathSync(input.original);assert.equal(original,process.cwd());
 const git=(...args)=>execFileSync('/usr/bin/git',['-c','safe.directory='+original,'-c','core.hooksPath=/dev/null',...args],{cwd:original,env:originalReconstructionEnvironment(process.env),encoding:'utf8',timeout:10000,maxBuffer:4*1024**2}).trim();
 assert.equal(git('rev-parse','HEAD'),CONTRACT.originalCandidate);assert.equal(git('status','--porcelain'),'');
 // Scope only ORIGINAL plan reconstruction. Current workflow identity is never
 // rewritten to claim that this consumer ran the original native jobs.
 const expectedEnv=originalReconstructionEnvironment(process.env);assert.deepEqual(Object.fromEntries(Object.entries(process.env)),expectedEnv,'Only the tokenless fixed reconstruction environment is accepted');
 assert.equal(input.artifacts.length,4);assert.equal(new Set(input.artifacts.map(row=>row.id)).size,4);
 const dirs=new Map();for(const artifact of input.artifacts){const expected=CONTRACT.artifacts.find(row=>row.id===artifact.id);assert(expected);const directory=join(privateRoot,'artifact-'+expected.id);assert.equal(artifact.directory,directory);assert.equal(realpathSync(directory),directory);const info=lstatSync(directory);assert(info.isDirectory()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o700);assert.deepEqual(readdirSync(directory).sort(),expected.members);dirs.set(expected.id,directory);}
 const planPath=join(dirs.get(13600858881),'ci-plan.json'),originalPlanBytes=bytes(planPath);assert.equal(digest(originalPlanBytes),CONTRACT.originalPlanSha256);const originalPlan=JSON.parse(originalPlanBytes.toString('utf8'));
 const {createPlan}=await import(pathToFileURL(join(original,'.github/ci/plan.mjs')).href),local=createPlan(original);assert.deepEqual(local,originalPlan,'COMPLETE original source-owned plan reconstruction differs');
 assert.equal(local.fingerprint,CONTRACT.originalPlanFingerprint);assert.equal(local.migrationBase,CONTRACT.originalMigrationBase);assert.deepEqual(local.runtime,CONTRACT.originalPlanRuntime);assert.equal(local.policyVersion,CONTRACT.originalPolicyVersion);assert.equal(local.units.length,107);assert.equal(local.suite.length,3599);
 const {verifyUnitReport}=await import(pathToFileURL(join(original,'.github/ci/verify-shards.mjs')).href);
 const {compareCanonicalReplayMembers}=await import(pathToFileURL(join(original,'test/fixtures/notification-worker/final-catalogue-comparison.ts')).href);
 const modes=[],members=[],units=[];
 for(const pair of CONTRACT.pairs){const directory=dirs.get(pair.artifactId),unit=local.units.find(row=>row.id===pair.unit);assert(unit);assert.deepEqual(unit.files,[pair.file]);assert.equal(Object.keys(local.singletonSources[pair.unit]).length,pair.sourceMembers);
  const report=JSON.parse(bytes(join(directory,'unit-'+pair.unit+'.json')).toString('utf8'));const verified=verifyUnitReport(local,report,{runId:String(CONTRACT.run.id),attempt:'1'});assert.equal(verified.tests,1);units.push({...verified,sourceMembers:pair.sourceMembers});
  const files={source:'notification-canonical-source.json',raw:'notification-canonical-raw.json',normalized:'notification-canonical-normalized.json',report:'notification-canonical-report.json',prerequisite:`personnel-dd-full-role-${pair.unit}-offset-0.json`};const record={};
  for(const[key,name]of Object.entries(files)){const data=bytes(join(directory,name),key==='prerequisite'?32768:byteLimit);record[key]=data;members.push({mode:pair.mode,name,bytes:data.length,sha256:digest(data)});}
  const observed=JSON.parse(record.report.toString('utf8'));assert.equal(observed.normalization.functionCount,pair.observedNativeFunctions);assert.equal(observed.run,String(CONTRACT.run.id));assert.equal(observed.unit,pair.unit);assert.equal(observed.variation,pair.mode);modes.push(record);
 }
 const selected=CONTRACT.pairs.map(row=>row.unit).sort(),selection=JSON.parse(bytes(join(dirs.get(13600858881),'commission-selection.json')).toString('utf8')),summary=JSON.parse(bytes(join(dirs.get(13601807564),'singleton-commissioning.json')).toString('utf8'));
 for(const value of [selection,summary]){assert.equal(value.kind,'SELECTED_PROFILE_COMMISSIONING_ONLY');assert.equal(value.candidate,CONTRACT.originalCandidate);assert.equal(value.controller,CONTRACT.originalController);assert.equal(value.baseline,CONTRACT.originalMigrationBase);assert.equal(value.fingerprint,local.fingerprint);assert.deepEqual(value.selected,selected);assert.deepEqual(value.omitted,local.units.map(row=>row.id).filter(id=>!selected.includes(id)).sort());assert.equal(value.completeSuite,false);assert.equal(value.releaseAuthorized,false);}
 assert.equal(summary.selectedProfilesVerified,true);assert.equal(summary.runId,String(CONTRACT.run.id));assert.equal(summary.attempt,'1');assert.deepEqual(summary.outcomes.map(row=>({id:row.id,tests:row.tests,outcome:row.outcome})),selected.map(id=>({id,tests:1,outcome:'verified'})));
 const compared=compareCanonicalReplayMembers(modes[0],modes[1],{candidate:CONTRACT.originalCandidate,controller:CONTRACT.originalController});assert.equal(compared.expectedProfileAuthorized,false);assert.equal(compared.releaseAuthorized,false);
 const result={kind:'VERIFIED_ORIGINAL_CATALOGUE_PAIR_NOT_PROFILE',originalRun:String(CONTRACT.run.id),originalCandidate:CONTRACT.originalCandidate,originalController:CONTRACT.originalController,originalPlanFingerprint:local.fingerprint,originalPlanReconstructed:true,units,members,comparison:{functionCount:compared.functionCount,defaultFunctions:compared.defaultFunctions,shiftedFunctions:compared.shiftedFunctions,exactRawDefaultsEqual:compared.exactRawDefaultsEqual},expectedProfileAuthorized:false,releaseAuthorized:false,completeSuite:false};validatePublicComparison(result);
 assert.equal(git('status','--porcelain'),'');writeFileSync(join(privateRoot,'comparison-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{await compareOriginalCatalogue();}catch{process.stderr.write('Original catalogue comparison refused\n');process.exitCode=1;}}
