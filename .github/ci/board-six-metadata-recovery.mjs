/** One immutable six-file repair. This is not a general SQL/test recovery allowlist. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {hash} from './manifest.mjs';
export const METADATA_RECOVERY_POLICY='aihr-cross-source-metadata-recovery/v2';
export const SIX_METADATA_PROFILE=JSON.parse(readFileSync(new URL('./board-six-metadata-profile.json',import.meta.url),'utf8'));
export const SIX_METADATA_BRANCH='codex/board-staging-integration-20261108';
export const SIX_METADATA_ALIASES=Array.from({length:15},(_,i)=>`codex/board-six-recovery-20261109-${i+1}`);
export const SIX_QUEUE_ONLY_IDS=[42515588088,42515590282,42515592438,42515594598,42515596570,42515598732];
const same=(a,b,m)=>assert(isDeepStrictEqual(a,b),m);
export function validateSixMetadataDelta(facts){
 const {seeds,...expected}=SIX_METADATA_PROFILE;
 same(facts,expected,'Repair is outside the exact reviewed six-file metadata/catalogue source pair');
 return {...SIX_METADATA_PROFILE,fingerprint:hash(SIX_METADATA_PROFILE)};
}
export function validateSixMetadataContext({profile,sourcePlan,plan,impactContext}){
 same(profile,{...SIX_METADATA_PROFILE,fingerprint:hash(SIX_METADATA_PROFILE)},'Metadata profile was altered');
 assert(sourcePlan.sha===profile.original&&plan.sha===profile.candidate,'Metadata repair source pair differs');
 assert(impactContext.base===profile.original&&impactContext.head===profile.candidate&&impactContext.baseTree===profile.baseTree&&impactContext.headTree===profile.headTree,'Metadata Git identity differs');
 same(impactContext.plan.changed.slice().sort(),profile.changed,'Metadata impact omitted or added a path');
 assert(profile.seeds.every(p=>plan.suite.includes(p)),'Missing native catalogue, guidance or populated-upgrade coverage');
 return profile.seeds;
}
/** Queue cancellation is an observation, never replacement PASS. Any started job still refuses. */
export function validateSixQueueOnlyCancellation({run,jobs}){
 assert(SIX_QUEUE_ONLY_IDS.includes(run.id)&&run.head_sha===SIX_METADATA_PROFILE.original&&run.head_branch==='alpha'&&run.event==='workflow_dispatch'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='cancelled','Foreign queue-only cancellation');
 assert(SIX_METADATA_ALIASES.some(b=>run.display_title===`Focused only · ${b}`),'Foreign cancelled selection title');
 assert(run.repository?.id===1333414856&&run.head_repository?.id===1333414856&&Array.isArray(jobs)&&jobs.length===0,'An executed or foreign failure cannot be classified as queue-only');
 return {runId:run.id,conclusion:'cancelled',executedJobs:0,metadataFingerprint:hash({run,jobs})};
}
export function validateSixMetadataCertificate(c){
 assert(c.recoveryPolicy===METADATA_RECOVERY_POLICY&&c.originalSha===SIX_METADATA_PROFILE.original&&c.sha===SIX_METADATA_PROFILE.candidate,'Foreign metadata recovery certificate');
 same(c.disposition.metadataProfile,{...SIX_METADATA_PROFILE,fingerprint:hash(SIX_METADATA_PROFILE)},'Missing exact metadata profile');
 assert(c.history?.queueOnlyCancellations?.length===SIX_QUEUE_ONLY_IDS.length,'Queue observations omitted');
 same(c.history.queueOnlyCancellations.map(x=>x.runId).sort((a,b)=>a-b),SIX_QUEUE_ONLY_IDS,'Queue observation identities changed');
 for(const x of c.history.queueOnlyCancellations)assert(x.conclusion==='cancelled'&&x.executedJobs===0&&/^[a-f0-9]{64}$/.test(x.metadataFingerprint),'Invalid queue observation');
 const mapped=c.units?.flatMap(u=>u.files??[]).filter(f=>f.recordedCaseIdentity)??[];assert(mapped.length===recordedCases.length&&new Set(mapped.map(f=>f.path)).size===recordedCases.length,'Recorded fixture identities omitted or duplicated');
 for(const f of mapped){const expected=recordedCases.find(r=>r.path===f.path);assert(expected&&f.runId===expected.replacementRunId&&hash(f.cases)===expected.replacementCasesHash,'Recorded fixture replacement differs');same(f.recordedCaseIdentity,{kind:'EXACT_RECORDED_FIXTURE_CASE_IDENTITY',record:expected,fingerprint:hash(expected)},'Recorded fixture mapping changed');}
}
const recordedCases=JSON.parse(readFileSync(new URL('./board-six-recorded-case-identities.json',import.meta.url),'utf8'));
/** Four observed fixture-valued names in two unchanged files; no wildcard normalization. */
export function validateSixRecordedCaseIdentity({path,originalCases,replacementCases,originalRunId,replacementRunId,originalSha,candidate}){
 const record=recordedCases.find(x=>x.path===path);
 assert(record&&originalSha===SIX_METADATA_PROFILE.original&&candidate===SIX_METADATA_PROFILE.candidate&&originalRunId===record.originalRunId&&replacementRunId===record.replacementRunId,'Foreign recorded dynamic-case identity');
 assert(originalCases.length===record.caseCount&&replacementCases.length===record.caseCount&&hash(originalCases)===record.originalCasesHash&&hash(replacementCases)===record.replacementCasesHash,'Dropped or altered original/replacement assertion inventory');
 const mapped=originalCases.map(name=>record.mappings.find(m=>m.original===name)?.replacement??name).sort();
 same(mapped,replacementCases,'Recorded fixture-name mapping omitted or altered an assertion');
 for(const m of record.mappings)assert(originalCases.filter(n=>n===m.original).length===1&&replacementCases.filter(n=>n===m.replacement).length===1,'Ambiguous recorded dynamic-case mapping');
 return {kind:'EXACT_RECORDED_FIXTURE_CASE_IDENTITY',record:structuredClone(record),fingerprint:hash(record)};
}
