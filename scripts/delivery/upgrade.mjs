/** Compatibility, preparation and cutover are different authorities and deadlines. */
import assert from 'node:assert/strict';
import {POLICY,exact,digest,sha,hash} from './protocol.mjs';
export const PHASES=Object.freeze(['authenticate','prepare','rehearse','lease','preflight','expand','drain','switch','observe','accept','handback']);
export function planUpgrade(manifest,target){
 exact(manifest,['policy','source','artifactDigest','configurationDigest','schema','webProtocol','workerProtocol','rollback','effects']);
 exact(target,['environment','source','artifactDigest','configurationDigest','ledger','webProtocol','workerProtocol','rollbackWindowClosed']);
 assert(manifest.policy===POLICY&&sha(manifest.source)&&digest(manifest.artifactDigest)&&digest(manifest.configurationDigest));
 assert(['staging','production'].includes(target.environment)&&sha(target.source)&&digest(target.artifactDigest)&&digest(target.configurationDigest));
 assert(manifest.configurationDigest===target.configurationDigest,'Compiled configuration differs; produce a separately identified artifact');
 assert(Array.isArray(manifest.schema)&&Array.isArray(target.ledger)&&manifest.schema.length>=target.ledger.length);
 assert.deepEqual(manifest.schema.slice(0,target.ledger.length).map(({tag,when,hash})=>({tag,when,hash})),target.ledger,'Applied SQL/order must be immutable');
 let watermark=Math.max(0,...target.ledger.map(x=>x.when));const tail=manifest.schema.slice(target.ledger.length);
 for(const row of manifest.schema){exact(row,['tag','when','hash','phase']);assert(typeof row.tag==='string'&&/^[0-9]+_[a-z0-9_]+$/.test(row.tag)&&Number.isSafeInteger(row.when)&&row.when>0&&digest(row.hash)&&['expand','backfill','contract'].includes(row.phase));}
 for(const row of tail){assert(row.when>watermark,'Pending migration would be silently skipped');watermark=row.when;if(row.phase==='contract')assert(target.rollbackWindowClosed,'Contract migration before old consumers retire');assert(row.phase!=='backfill','Backfill is a resumable bulk job, not a blocking installation transaction');}
 for(const name of ['webProtocol','workerProtocol']){
  exact(manifest[name],['writes','reads']);assert(Number.isSafeInteger(manifest[name].writes)&&Array.isArray(manifest[name].reads)&&manifest[name].reads.every(Number.isSafeInteger));
  exact(target[name],['writes','reads']);assert(Number.isSafeInteger(target[name].writes)&&Array.isArray(target[name].reads));
  assert(manifest[name].reads.includes(target[name].writes),'New reader cannot consume existing work');
  assert(target[name].reads.includes(manifest[name].writes),'Old reader cannot consume new work; rollback unsafe');
 }
 exact(manifest.rollback,['mode','rehearsalDigest']);assert(['switch-back','forward-repair'].includes(manifest.rollback.mode)&&digest(manifest.rollback.rehearsalDigest));
 exact(manifest.effects,['mode','ownership','idempotency']);assert(manifest.effects.mode==='existing-authorized-services','Deployment cannot grant new business effects');
 assert(manifest.effects.ownership==='fenced-single-owner'&&manifest.effects.idempotency==='business-operation-key','Web blue/green alone does not fence worker effects');
 if(tail.some(x=>x.phase==='contract'))assert(manifest.rollback.mode==='forward-repair','Destructive contraction cannot promise code-only rollback');
 const body={policy:POLICY,source:manifest.source,artifactDigest:manifest.artifactDigest,target:target.environment,baseline:target.source,baselineArtifact:target.artifactDigest,pending:tail,phases:PHASES,rollback:manifest.rollback.mode};return {...body,fingerprint:hash(body)};
}
/** The adapter is trusted operator configuration, never commands supplied in an issue/PR. */
export async function executeUpgrade(plan,adapter,journal){
 assert(plan.policy===POLICY&&plan.fingerprint===hash(Object.fromEntries(Object.entries(plan).filter(([k])=>k!=='fingerprint'))));
 assert(Array.isArray(journal.completed)&&journal.completed.every(x=>PHASES.includes(x)));
 assert(!journal.completed.some(x=>['expand','drain','switch','observe'].includes(x)),'A partly mutated installation requires explicit observed recovery, not blind replay');
 let leased=journal.completed.includes('lease')&&!journal.completed.includes('handback'),mutation=false;
 for(const phase of PHASES){
  if(journal.completed.includes(phase))continue;
  assert(typeof adapter[phase]==='function','Missing actual operator phase: '+phase);
  try{
   // Preparation receives no target lease. No extraction or recursive package verification belongs
   // in the live switch. Every phase must return its own exact artifact/baseline observation.
   if(phase==='lease')leased=true; // acquisition failure may be uncertain
   if(phase==='expand'||phase==='drain'||phase==='switch')mutation=true; // failure may follow a partial effect
   const receipt=await adapter[phase](plan);
   assert(receipt&&receipt.source===plan.source&&receipt.artifactDigest===plan.artifactDigest&&digest(receipt.proofDigest),'Phase returned a foreign or absent proof');
   if(phase==='lease')leased=true;
   if(phase==='preflight')assert(receipt.baseline===plan.baseline&&receipt.baselineArtifact===plan.baselineArtifact,'Target advanced; replan instead of overwriting it');
   if(phase==='expand'||phase==='drain'||phase==='switch')mutation=true;
   if(phase==='observe')assert(receipt.sourceArrived===true&&receipt.buildArrived===true&&receipt.ledgerVerified===true&&receipt.webHealthy===true&&receipt.workerHealthy===true&&receipt.acceptancePassed===true,'Health200 alone is not operational acceptance');
   await journal.append({phase,receipt});
   if(phase==='handback')leased=false;
  }catch(error){
   // Failure after mutation cannot be fixed by clearing a queue record or pretending rollback.
   await journal.failure({phase,source:plan.source,artifactDigest:plan.artifactDigest,leaseRetained:leased,mutation,state:mutation?'repair-required':'retryable',reason:String(error.message).slice(0,1000)});
   throw error;
  }
 }
 return {source:plan.source,artifactDigest:plan.artifactDigest,state:'accepted',leaseRetained:leased};
}
