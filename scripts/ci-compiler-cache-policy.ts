/** Cache eligibility only. The caller must authenticate origin metadata/bytes and run the whole current compiler. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

type Runtime = {node:string;typescript:string;next:string;platform:string;arch:string};
type Invocation = {
 options:string[];nodeOptions:string;sourcePath:string;
 generatedTypes:{path:string;bytes:number;sha256:string}[];
 actualCompiler:Record<string,string>;sourceInvocation:string;mobileInputs:Record<string,string>;
};
export type CompilerCacheContext = {
 source:string;controller:string;runId:string;attempt:string;runtime:Runtime;
 inputs:Record<string,string>;invoked:Invocation;
};
type Comparison = {
 status:string;ahead_by:number;behind_by:number;total_commits:number;
 base_commit:{sha:string};merge_base_commit:{sha:string};commits:{sha:string}[];
 files:{filename:string;status:string;previous_filename?:string}[];
};
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function keys(v:object,expected:string[]){
 assert(v&&typeof v==='object'&&!Array.isArray(v)&&isDeepStrictEqual(Object.keys(v).sort(),expected.slice().sort()),'Compiler cache context fields differ');
}
function context(value:CompilerCacheContext){
 keys(value,['source','controller','runId','attempt','runtime','inputs','invoked']);
 assert(sha(value.source)&&sha(value.controller)&&/^[1-9][0-9]{0,15}$/.test(value.runId)&&value.attempt==='1','Exact original compiler context required');
 keys(value.runtime,['node','typescript','next','platform','arch']);
 assert(value.runtime.platform==='linux'&&value.runtime.arch==='x64'&&/^22\.\d+\.\d+$/.test(value.runtime.node),'Exact hosted compiler runtime required');
 assert(/^\d+\.\d+\.\d+$/.test(value.runtime.typescript)&&/^\d+\.\d+\.\d+$/.test(value.runtime.next),'Compiler packages must be pinned');
 keys(value.inputs,['tsconfig','lockfile','package','workspace','nextConfig','compilerCli']);
 assert(Object.values(value.inputs).every(digest),'Compiler input digest required');
 const invoked=value.invoked;
 keys(invoked,['options','nodeOptions','sourcePath','generatedTypes','actualCompiler','sourceInvocation','mobileInputs']);
 assert(isDeepStrictEqual(invoked.options,['--noEmit','--pretty','false','--extendedDiagnostics','--tsBuildInfoFile','.next/cache/compiler-transport/whole-project.tsbuildinfo']),'Full original compiler options required');
 assert(invoked.nodeOptions==='--max-old-space-size=12288'&&typeof invoked.sourcePath==='string'&&invoked.sourcePath.startsWith('/home/runner/work/'),'Actual hosted compiler path/heap required');
 assert(digest(invoked.sourceInvocation)&&value.inputs.compilerCli===hash(invoked),'Actual invocation context not bound');
 assert(Array.isArray(invoked.generatedTypes)&&invoked.generatedTypes.length>0&&invoked.generatedTypes.length<10000,'Fresh generated type inventory required');
 for(const row of invoked.generatedTypes)assert(typeof row.path==='string'&&row.path.length>0&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&digest(row.sha256),'Generated type member differs');
 keys(invoked.actualCompiler,['package.json','lib/tsc.js','lib/_tsc.js','lib/typescript.js']);
 keys(invoked.mobileInputs,['mobile/package.json','mobile/package-lock.json']);
 assert(Object.values(invoked.actualCompiler).every(digest)&&Object.values(invoked.mobileInputs).every(digest),'Actual compiler and mobile bytes required');
 return value;
}
function matchingInputs(origin:CompilerCacheContext,current:CompilerCacheContext){
 assert(isDeepStrictEqual(origin.runtime,current.runtime),'Compiler runtime/package changes require cold state');
 for(const key of ['tsconfig','lockfile','package','workspace','nextConfig'])assert(origin.inputs[key]===current.inputs[key],'Changed compiler configuration/dependencies require cold state');
 // The actual binary, flags, generated types and inputs remain bound. Resource-only shell changes may differ.
 const {sourceInvocation:oldWrapper,...oldInvocation}=origin.invoked;
 const {sourceInvocation:newWrapper,...newInvocation}=current.invoked;
 assert(digest(oldWrapper)&&digest(newWrapper)&&isDeepStrictEqual(oldInvocation,newInvocation),'Compiler invocation/generated inputs changed');
}
function descendantFiles(origin:CompilerCacheContext,current:CompilerCacheContext,comparison:Comparison){
 assert(comparison&&comparison.status==='ahead'&&comparison.behind_by===0
  &&Number.isSafeInteger(comparison.ahead_by)&&comparison.ahead_by>0&&comparison.ahead_by<=32
  &&comparison.total_commits===comparison.ahead_by&&comparison.base_commit?.sha===origin.source
  &&comparison.merge_base_commit?.sha===origin.source,'Authenticated origin must be a bounded ancestor of the actual candidate');
 assert(Array.isArray(comparison.commits)&&comparison.commits.length===comparison.total_commits
  &&comparison.commits.every(row=>sha(row.sha))&&new Set(comparison.commits.map(row=>row.sha)).size===comparison.commits.length
  &&comparison.commits.at(-1)?.sha===current.source,'Incomplete or foreign comparison head');
 assert(Array.isArray(comparison.files)&&comparison.files.length>0&&comparison.files.length<300,'Complete bounded changed-file inventory required');
 assert(new Set(comparison.files.map(row=>row.filename)).size===comparison.files.length,'Duplicate changed-file membership');
 for(const row of comparison.files)assert(typeof row.filename==='string'&&row.filename.length>0&&row.filename.length<=2048
  &&!row.filename.includes('\0')&&!row.filename.split('/').some(part=>part==='..'||part==='.')
  &&['modified','added','removed','renamed','copied','changed'].includes(row.status),'Changed-file inventory refused');
 return comparison.files.map(row=>({path:row.filename,status:row.status}));
}
/** Diagnostic boundary retains its original cache-context contract. */
export function compatibleCompilerState(originInput:CompilerCacheContext,currentInput:CompilerCacheContext,comparison:Comparison){
 const origin=context(originInput),current=context(currentInput);
 assert(origin.source===origin.controller&&origin.source!==current.source,'A distinct child source must retain its original producer');
 assert(origin.controller===current.controller&&origin.runId===current.runId,'Do not relabel original cache provenance');
 matchingInputs(origin,current);
 const changedFiles=descendantFiles(origin,current,comparison);
 return {
  kind:'COMPATIBLE_ANCESTOR_STATE_COMPILER_MUST_RUN',originSource:origin.source,candidateSource:current.source,
  originalRunId:origin.runId,changedFiles,mandatoryWholeCompiler:true,releaseAuthorized:false,
 };
}
/** Normal CI records actual producer/current controller and run identities independently. No PASS is reused. */
export function compilerStateApplicability(originInput:CompilerCacheContext,currentInput:CompilerCacheContext,comparison:Comparison|null){
 const origin=context(originInput),current=context(currentInput);
 matchingInputs(origin,current);
 const identicalSource=origin.source===current.source;
 if(identicalSource)assert(comparison===null,'Identical source requires no invented ancestry comparison');
 const changedFiles=identicalSource?[]:descendantFiles(origin,current,comparison as Comparison);
 return {
  kind:'ELIGIBLE_COMPILER_GRAPH_COMPILER_MUST_RUN',
  producer:{source:origin.source,controller:origin.controller,runId:origin.runId,attempt:origin.attempt},
  candidate:{source:current.source,controller:current.controller,runId:current.runId,attempt:current.attempt},
  identicalSource,changedFiles,mandatoryWholeCompiler:true,releaseAuthorized:false,
 };
}
