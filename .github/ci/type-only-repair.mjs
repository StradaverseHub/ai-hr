/** Exact erased fixture cast compatibility. Source proof only, never release authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {installHash,installJson} from './ci-install-grant.mjs';
import {withBuildOnlyMode} from './build-only-mode.mjs';
export const FIXTURE_PATH='test/r387-customer-env-preflight.test.ts';
export const ERASED_CAST=' as unknown as NodeJS.ProcessEnv';
export function proveErasedFixtureCast({before,after,typescript:ts}){
 assert(typeof before==='string'&&typeof after==='string'&&before.length>0&&after.length<=1024*1024,'Bounded complete fixture source required');
 assert(ts&&typeof ts.transpileModule==='function'&&typeof ts.createSourceFile==='function'&&/^5\./.test(ts.version),'Trusted pinned TypeScript 5 parser required');
 const additions=[];let cursor=0;
 while((cursor=after.indexOf(ERASED_CAST,cursor))!==-1){if(after.slice(0,cursor)+after.slice(cursor+ERASED_CAST.length)===before)additions.push(cursor);cursor+=ERASED_CAST.length;}
 assert(additions.length===1,'Exactly one erased fixture cast insertion and no other bytes may change');
 const source=ts.createSourceFile(FIXTURE_PATH,after,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);assert(source.parseDiagnostics.length===0,'Repair source must parse');
 let matched=0;
 const visit=node=>{if(ts.isAsExpression(node)&&node.end===additions[0]+ERASED_CAST.length&&node.type.getText(source)==='NodeJS.ProcessEnv'&&ts.isAsExpression(node.expression)&&node.expression.type.kind===ts.SyntaxKind.UnknownKeyword&&ts.isObjectLiteralExpression(node.expression.expression)&&ts.isPropertyAssignment(node.parent)&&node.parent.name.getText(source)==='env')matched++;ts.forEachChild(node,visit);};visit(source);
 assert(matched===1,'Only a subprocess env object may receive this erased type assertion');
 const compile=text=>{const r=ts.transpileModule(text,{fileName:FIXTURE_PATH,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,sourceMap:false,inlineSourceMap:false,removeComments:false}});assert(!(r.diagnostics??[]).some(d=>d.category===ts.DiagnosticCategory.Error),'Fixture emit refused');return r.outputText;};
 const previous=compile(before),repaired=compile(after);assert(previous===repaired,'Emitted runtime JavaScript must be byte identical');
 return {path:FIXTURE_PATH,typescriptVersion:ts.version,originalSourceSha256:installHash(before),repairedSourceSha256:installHash(after),identicalRuntimeJavaScriptSha256:installHash(previous),insertion:ERASED_CAST};
}
export function typeOnlyRepairSource({repository,original,candidate,compilerCandidate=candidate,typescript}){
 for(const sha of [original,candidate,compilerCandidate])assert(/^[a-f0-9]{40}$/.test(sha??''),'Exact source commits required');assert(original!==candidate,'A new repair commit required');
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{maxBuffer:8*1024**2,timeout:10000});git('merge-base','--is-ancestor',original,candidate);
 const changed=(a,b)=>git('diff','--name-only','-z',a,b).toString().split('\0').filter(Boolean);const paths=changed(original,candidate),workflowPath='.github/workflows/alpha-staging.yml';assert(paths.includes(FIXTURE_PATH)&&paths.length<=2&&paths.every(p=>[FIXTURE_PATH,workflowPath].includes(p)),'Only the existing fixture and reviewed workflow mode may change');
 git('merge-base','--is-ancestor',original,compilerCandidate);git('merge-base','--is-ancestor',compilerCandidate,candidate);
 assert(JSON.stringify(changed(original,compilerCandidate))===JSON.stringify([FIXTURE_PATH]),'Whole compiler candidate must have only the erased fixture repair');
 let workflowCompatibility=null;
 if(paths.includes(workflowPath)){for(const ref of [original,candidate])assert(/^100644 blob [a-f0-9]{40}\t/.test(git('ls-tree',ref,'--',workflowPath).toString()),'Workflow must retain regular100644 mode');const before=git('show',original+':'+workflowPath),after=git('show',candidate+':'+workflowPath);assert(withBuildOnlyMode(before.toString('utf8'))===after.toString('utf8'),'Only the exact reviewed build-only workflow mode may change');assert(JSON.stringify(changed(compilerCandidate,candidate))===JSON.stringify([workflowPath]),'Compiler-to-release delta must be workflow only');workflowCompatibility={path:workflowPath,originalSha256:installHash(before),repairedSha256:installHash(after),fullGateDefaultsPreserved:true,actualBuildJobUnchanged:true};}else assert(compilerCandidate===candidate,'Without workflow publication the compiler and release candidate must match');
 for(const ref of [original,candidate])assert(/^100644 blob [a-f0-9]{40}\t/.test(git('ls-tree',ref,'--',FIXTURE_PATH).toString()),'Fixture must be a tracked regular file');
 const input=ref=>git('show',ref+':'+FIXTURE_PATH).toString('utf8'),fixture=proveErasedFixtureCast({before:input(original),after:input(candidate),typescript});
 const body={format:1,kind:'ERASED_FIXTURE_CAST_SOURCE_COMPATIBILITY_NOT_RELEASE',original,candidate,originalTree:git('rev-parse',original+'^{tree}').toString().trim(),candidateTree:git('rev-parse',candidate+'^{tree}').toString().trim(),fixture,compilerCandidate,workflowCompatibility,otherTrackedInputsByteIdentical:true,originalFailedCompilerPreserved:true,requiresFreshWholeCompiler:true,requiresAuthenticatedOriginalCoverage:true,requiresFinalBuildSourceBinding:true,releaseAuthorized:false};return {...body,proofSha256:installHash(installJson(body))};
}
