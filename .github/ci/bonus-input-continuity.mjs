/** Verify two unchanged non-source input owners without changing the actual policy3 plan. */
import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {isDeepStrictEqual} from 'node:util';import {installHash,installJson} from './ci-install-grant.mjs';
export async function verifyBonusInputContinuity({repository,toolRepository,source,continuity,originalToolAuthentication,toolAuthentication}){
 const {proofSha256,...body}=continuity;assert.equal(proofSha256,installHash(installJson(body)));assert.equal(body.actualPlanSha256,installHash(installJson(source)));assert.equal(source.actualPolicy,3);
 assert.equal(installHash(installJson(originalToolAuthentication)),body.writerProofTool.authenticationSha256,'Original tool evidence changed');
 for(const key of ['origin','files','sourceBinding'])assert(isDeepStrictEqual(originalToolAuthentication[key],toolAuthentication[key]),'Freshly authenticated tool inputs/outcomes differ: '+key);
 assert(toolAuthentication.origin.runId===40511001942&&toolAuthentication.failedFiles===0&&toolAuthentication.originalFocusedExitCode===0&&toolAuthentication.origin.candidate===body.writerProofTool.candidate,'Actual tested IO predicate source differs');
 const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',maxBuffer:4*1024**2}).trim();
 assert.equal(git(repository,'rev-parse','HEAD'),source.head);assert.equal(git(repository,'status','--porcelain'),'');assert.equal(git(toolRepository,'rev-parse','HEAD'),toolAuthentication.origin.candidate);assert.equal(git(toolRepository,'status','--porcelain'),'');
 const modules=['packs/performance/onehr/evidence-extraction.ts','test/profile.ts'];assert.deepEqual(body.pins.map(p=>p.path),modules);
 for(const pin of body.pins)for(const [repo,ref] of [[repository,source.base],[repository,source.head],[toolRepository,toolAuthentication.origin.candidate]])assert.equal(git(repo,'rev-parse',ref+':'+pin.path),pin.blob,'Input module differs from the actually tested unchanged fixture');
 const actualModule=await import(pathToFileURL(join(repository,'scripts/gate-impact.ts')).href),toolModule=await import(pathToFileURL(join(toolRepository,'scripts/gate-impact.ts')).href),actual={...(actualModule.default??{}),...actualModule},tool={...(toolModule.default??{}),...toolModule};
 assert.equal(actual.IMPACT_POLICY_VERSION,3);assert.equal(tool.IMPACT_POLICY_VERSION,4);
 const sourceText=path=>execFileSync('git',['-C',repository,'show',source.head+':'+path],{encoding:'utf8'});
 assert.equal(actual.readsOnlyProcessStatus(modules[0],sourceText(modules[0])),true);assert.equal(tool.fsImportsAreWriteOnly(modules[1],sourceText(modules[1])),true);
 const reasons=modules.map(path=>'source reading or uncertain module reach through '+path),retained=source.plan.run.filter(path=>source.plan.selection[path]?.length&&source.plan.selection[path].every(reason=>reasons.includes(reason)));
 assert.equal(retained.length,913);assert.deepEqual(retained,body.retainedFiles);assert.deepEqual(source.plan.run.filter(p=>!retained.includes(p)),body.remainingRequiredFiles);assert(body.inputClosureVerified===true&&body.currentClassifierChanged===false&&body.browserCoverageRetained===false&&body.unknownConsumersRetained===false&&body.releaseAuthorized===false);
 return continuity;
}
