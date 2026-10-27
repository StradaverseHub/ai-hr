/** Exact email test-contract repair and original Node-pinned controller. No release authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {installHash,installJson} from './ci-install-grant.mjs';
export const EMAIL=Object.freeze({original:'6592316c4828b836ebd74d7cc9ec5e7442462f0c',candidate:'fffabc90922c3d43b2570dc29a33ce8b70b69aca',controller:'3a162973333dd9ccb70eb23b6741de72571a0169',controllerParent:'dc74b804fcecb4bab3207e82c9b9f099b9bf13be',controllerBranch:'claude/alpha-node22-pinned-controller-20261027',ciBaseline:'2127b1a7ebd40e5b9ee7d010e72e75d4b1cb3e9f',staging:'e07a86340d1ced979868bf4359d73597301d0f15',bonus:'d52563c666d39074217ed42191866add4a2793a0',buildController:'bab210d1eabe79d4da2b76f50a31e0070ac0711f',fullRun:40516309446,repairRun:40519008699,buildRun:40522515822,compilerRun:40524864238,compilerController:'67fb9724103d62238515cd77e630e26cb5b0b2ea'});
export const EMAIL_REPAIRED_FILES=['test/board-eight-populated-upgrade.test.ts','test/identity-email-settings.dom.test.tsx'];
const pins=Object.freeze([{path:'.github/actions/setup-alpha/action.yml',sha256:'bdb06e99ea367d99421413061f8eb5acb67d179fec8eb010ce19bcbb148932d4'},{path:'.github/workflows/alpha-staging.yml',sha256:'cf34cd1461388b8266dede84dfb1548637dd173466a4497f4af5d5008cd3c249'}].map(Object.freeze));
export function validateEmailControllerProof(proof,{controller,branch}){
 const {proofSha256,...body}=proof??{};
 const wanted={format:1,kind:'EXACT_EMAIL_NORMAL_NODE_PIN_SOURCE_NOT_RELEASE',controller:EMAIL.controller,parent:EMAIL.controllerParent,branch:EMAIL.controllerBranch,pins,releaseAuthorized:false};
 assert(controller===EMAIL.controller&&branch===EMAIL.controllerBranch&&isDeepStrictEqual(body,wanted)&&proofSha256===installHash(installJson(wanted)),'Exact reconstructed email controller proof required');return proof;
}
export function proveEmailController({repository,controller=EMAIL.controller,branch=EMAIL.controllerBranch}){
 assert(controller===EMAIL.controller&&branch===EMAIL.controllerBranch,'Unreviewed email controller');
 const git=(...a)=>execFileSync('git',['-C',repository,...a],{encoding:'utf8',maxBuffer:2*1024**2,timeout:10000});
 assert(['https://github.com/stradaversehub/ai-hr.git','https://github.com/stradaversehub/ai-hr'].includes(git('remote','get-url','origin').trim().toLowerCase()),'Foreign repository origin');
 assert.equal(git('rev-parse',controller+'^').trim(),EMAIL.controllerParent);
 assert.deepEqual(git('diff','--name-only',EMAIL.controllerParent,controller).trim().split('\n').sort(),pins.map(p=>p.path));
 for(const p of pins){
  for(const ref of [EMAIL.controllerParent,controller])assert(/^100644 blob [a-f0-9]{40}\t/.test(git('ls-tree',ref,'--',p.path)),'Regular immutable controller source required');
  const before=git('show',EMAIL.controllerParent+':'+p.path),after=git('show',controller+':'+p.path);
  const old=p.path===pins[0].path?"default: '22'":"node-version: '22'",replacement=old.replace("'22'","'22.23.3'");
  assert.equal(before.split(old).length,p.path===pins[0].path?2:3,'Exact runtime pin anchors required');
  assert.equal(before.replaceAll(old,replacement),after,'Controller changes beyond exact runtime pins');assert.equal(installHash(after),p.sha256);
 }
 const body={format:1,kind:'EXACT_EMAIL_NORMAL_NODE_PIN_SOURCE_NOT_RELEASE',controller,parent:EMAIL.controllerParent,branch,pins,releaseAuthorized:false};
 return validateEmailControllerProof({...body,proofSha256:installHash(installJson(body))},{controller,branch});
}
export function proveEmailRepairSource({repository,candidate=EMAIL.candidate}){
 assert.equal(candidate,EMAIL.candidate,'Only the reviewed test-contract repair is allowed');
 const git=(...a)=>execFileSync('git',['-C',repository,...a],{encoding:'utf8',maxBuffer:2*1024**2,timeout:10000}).trim();
 assert.equal(git('rev-parse',candidate+'^'),EMAIL.original);
 assert.deepEqual(git('diff','--name-only',EMAIL.original,candidate).split('\n').sort(),EMAIL_REPAIRED_FILES);
 for(const base of [EMAIL.ciBaseline,EMAIL.staging,EMAIL.bonus])execFileSync('git',['-C',repository,'merge-base','--is-ancestor',base,candidate],{stdio:'pipe'});
 const files=EMAIL_REPAIRED_FILES.map(path=>{assert(/^100644 blob [a-f0-9]{40}\t/.test(git('ls-tree',candidate,'--',path)));return {path,before:git('rev-parse',EMAIL.original+':'+path),after:git('rev-parse',candidate+':'+path)};});
 const body={format:1,kind:'EXACT_EMAIL_TEST_CONTRACT_REPAIR_NOT_RELEASE',original:EMAIL.original,candidate,files,applicationSqlAndJournalUnchanged:true,releaseAuthorized:false};
 return {...body,proofSha256:installHash(installJson(body))};
}
export function proveEmailCompilerSource({repository}){
 const git=(...a)=>execFileSync('git',['-C',repository,...a],{encoding:'utf8',maxBuffer:2*1024**2,timeout:10000});
 const path='.github/ci/typecheck.sh',before=git('show',EMAIL.controller+':'+path),after=git('show',EMAIL.compilerController+':'+path);
 assert.equal(before,after,'The actual strict compiler script must remain unchanged');
 const workflow=git('show',EMAIL.compilerController+':.github/workflows/alpha-staging.yml'),start=workflow.indexOf('\n  typecheck:\n');assert(start>0,'Exact compiler job required');const job=workflow.slice(start);
 for(const needle of ["if: inputs.control_scope == 'email-compiler'",'ref: '+EMAIL.candidate,"node: '22.23.3'",'run: pnpm exec next typegen','bash ../automation/.github/ci/typecheck.sh 2>&1 | tee'])assert(job.includes(needle),'Actual whole compiler source missing: '+needle);
 assert(!job.includes('tsconfig.build')&&!job.includes('continue-on-error'),'Do not replace strict whole compilation with build roots or ignored errors');
 const body={kind:'EXACT_EMAIL_WHOLE_COMPILER_SOURCE_NOT_RELEASE',controller:EMAIL.compilerController,candidate:EMAIL.candidate,compilerScriptSha256:installHash(after),jobSha256:installHash(job),releaseAuthorized:false};return {...body,proofSha256:installHash(installJson(body))};
}
