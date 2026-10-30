/** An authenticated operator grants one private staging installation; never a gate receipt. */
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {CI_POLICY} from './policy-version.mjs';
import {BUILD_ARTIFACT} from './build-artifact.mjs';
import {STAGING_BUILD_RUNTIME} from './build-production.mjs';
import {validateRecoveryGrantEvidence} from './focused-recovery-policy.mjs';
import {validateRepairGrantEvidence,REPAIR_RECOVERY_POLICY} from './repair-recovery-policy.mjs';
export const installHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function installJson(value){
 if(Array.isArray(value))return '['+value.map(installJson).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+installJson(value[key])).join(',')+'}';
 return JSON.stringify(value);
}
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const id=value=>Number.isSafeInteger(value)&&value>0;
const buildId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(value);
export const INSTALL_BUILD_FIELDS=['nextBuildId','buildRecordId','buildSourcePath','runtime','provenanceSha256','archiveSha256','archiveBytes','manifestSha256','preparedSha256','successfulObservationSha256','lockSha256','packageSha256'];
export function validateInstallGrant(g,{now=Date.now(),allowExpired=false}={}){
 const keys=['format','kind','policyVersion','target','installId','source','controller','controllerBranch','baseline','baselineBuildId','environmentSha256','runId','runAttempt','runCreatedAt','issuedAt','expiresAt','producerStartedAt','producerCompletedAt','witnessFingerprint','artifact','build'];
 assert(g&&isDeepStrictEqual(Object.keys(g).sort(),keys.sort()),'Exact staging grant shape required');
 assert(g.format===1&&g.kind==='OPERATOR_AUTHORIZED_STAGING_CI_BUILD_INSTALL'&&g.policyVersion===CI_POLICY&&g.target==='alpha-staging'
  &&uuid(g.installId)&&sha(g.source)&&sha(g.controller)&&sha(g.baseline)&&['main','alpha'].includes(g.controllerBranch)
  &&buildId(g.baselineBuildId)&&digest(g.environmentSha256)&&id(g.runId)&&g.runAttempt===1&&digest(g.witnessFingerprint),'Authenticated staging installation identity required');
 assert(isDeepStrictEqual(Object.keys(g.artifact??{}).sort(),['digest','id'])&&id(g.artifact.id)&&/^sha256:[a-f0-9]{64}$/.test(g.artifact.digest),'Exact original build artifact required');
 assert(isDeepStrictEqual(Object.keys(g.build??{}).sort(),INSTALL_BUILD_FIELDS.slice().sort())&&buildId(g.build.nextBuildId)&&uuid(g.build.buildRecordId)
  &&g.build.nextBuildId!==g.baselineBuildId&&isDeepStrictEqual(g.build.runtime,STAGING_BUILD_RUNTIME)
  &&typeof g.build.buildSourcePath==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(g.build.buildSourcePath)&&!g.build.buildSourcePath.split('/').some(p=>p==='.'||p==='..')
  &&id(g.build.archiveBytes)&&g.build.archiveBytes<=256*1024**2,'Exact distinct target build required');
 for(const key of INSTALL_BUILD_FIELDS.filter(k=>k.endsWith('Sha256')))assert(digest(g.build[key]),'Build digest required: '+key);
 const created=Date.parse(g.runCreatedAt),issued=Date.parse(g.issuedAt),expires=Date.parse(g.expiresAt),started=Date.parse(g.producerStartedAt),completed=Date.parse(g.producerCompletedAt);
 assert([created,issued,expires,started,completed,now].every(Number.isFinite)&&created<=started&&started<=completed&&completed<=issued
  &&issued<=now+60000&&expires>issued&&expires<=issued+30*60000&&expires<=created+86400000,'Bounded original CI/job/grant times required');
 if(!allowExpired)assert(expires>now&&now-created<=86400000,'Staging grant expired; independently revalidate original CI before a new attempt');
 return g;
}
export function createInstallGrant({evidence,run,producer,baselineBuildId,environmentSha256,now=Date.now()}){
 assert(evidence.policyVersion===CI_POLICY&&evidence.result==='PASS'&&evidence.tier==='ci'&&evidence.build?.canonicalCandidateInputsVerified===true
  &&evidence.build.source===evidence.sha&&evidence.build.controller===evidence.controller&&evidence.build.runId===evidence.runId,'Complete authenticated current CI evidence required');
 const recovered=evidence.recovery!==undefined;
 const repaired=evidence.recovery?.recoveryPolicy===REPAIR_RECOVERY_POLICY;
 if(recovered)(repaired?validateRepairGrantEvidence:validateRecoveryGrantEvidence)(evidence,run);
 assert(run.id===evidence.runId&&run.head_sha===evidence.controller&&run.status==='completed'&&run.conclusion===(recovered&&!repaired?'failure':'success')&&run.run_attempt===1
  &&run.repository?.id===1333414856&&run.head_repository?.id===1333414856
  &&producer.name==='build'&&producer.run_id===run.id&&producer.run_attempt===1&&producer.head_sha===run.head_sha&&producer.conclusion==='success','Original authenticated successful run/build required');
 const artifacts=evidence.artifacts.filter(a=>a.name===BUILD_ARTIFACT);assert(artifacts.length===1,'Unique authenticated build artifact required');
 const grant={format:1,kind:'OPERATOR_AUTHORIZED_STAGING_CI_BUILD_INSTALL',policyVersion:CI_POLICY,target:'alpha-staging',installId:randomUUID(),
  source:evidence.sha,controller:evidence.controller,controllerBranch:evidence.controllerBranch,baseline:evidence.baseline,baselineBuildId,environmentSha256,
  runId:evidence.runId,runAttempt:1,runCreatedAt:run.created_at,issuedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(now+30*60000,Date.parse(run.created_at)+86400000)).toISOString(),
  producerStartedAt:producer.started_at,producerCompletedAt:producer.completed_at,witnessFingerprint:evidence.fingerprint,artifact:{id:artifacts[0].id,digest:artifacts[0].digest},
  build:Object.fromEntries(INSTALL_BUILD_FIELDS.map(key=>[key,evidence.build[key]]))};
 return validateInstallGrant(grant,{now});
}
