/** Real retained configurations; TypeScript alone owns reference resolution. */
import assert from 'node:assert/strict';
import {isAbsolute,join,relative} from 'node:path';
import {writeFileSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {configuredNativeRoots,assertReferenceLimits,REFERENCE_LIMITS} from './graph.mjs';
export const NATIVE_REFERENCE_OVERRIDES=Object.freeze({noEmit:false,noEmitOnError:true,composite:true,declaration:true,emitDeclarationOnly:false,disableSourceOfProjectReferenceRedirect:true});
export function contained(root,path){assert(isAbsolute(root)&&isAbsolute(path));const rel=relative(root,path);assert(rel&&!rel.startsWith('../')&&!isAbsolute(rel),'Path outside private owner');return rel;}
/** The pinned native parser must see exactly the emitted files list, in order. */
export function assertNativeParsedConfig(parsed,names,limits=REFERENCE_LIMITS){assertReferenceLimits(limits);assert(Array.isArray(parsed.fileNames)&&new Set(parsed.fileNames).size===parsed.fileNames.length);assert(parsed.fileNames.length<=limits.roots,'Actual parsed configured roots exceed native budget');assert.deepEqual(parsed.fileNames,names,'Native parsed configured membership differs');}
export function writeNativeReferenceConfigs({base,source,output,plan,files}){
 assert.equal(realpathSync(base),base);assert.equal(realpathSync(source),source);assert.equal(realpathSync(output),output);assert(lstatSync(output).isDirectory());assert(relative(source,output).startsWith('../'),'Native output must be outside the immutable source tree');
 const byId=new Map(files.map(f=>[f.id,f]));
 assert.equal(byId.size,files.length,'Duplicate native source identity');assertReferenceLimits(plan.limits);
 plan.projects.forEach((p,i)=>assert(p.index===i&&p.id==='project-'+String(i).padStart(3,'0'),'Fixed project owner identity required'));
 // Independently recompute every actual files list and refuse BEFORE writing
 // any generated config/emitted directory. Original roots alone are not this budget.
 const memberships=plan.projects.map(p=>{
  const ordered=configuredNativeRoots(plan.originalRoots,p.owned,p.context,byId);assert.deepEqual(p.configuredRoots,ordered,'Planned/native configured membership differs');
  assert(p.owned.length<=plan.limits.ownedClosure&&ordered.length<=plan.limits.roots,'Actual configured project exceeds native budget');
  const names=ordered.map(id=>{const f=byId.get(id);assert(f&&isAbsolute(f.path));assert.equal(realpathSync(f.path),f.path);assert(!lstatSync(f.path).isSymbolicLink());assert.equal(contained(source,f.path).replaceAll('\\','/'),id,'Configured source identity differs');return f.path;});
  assert.equal(new Set(names).size,names.length,'Duplicate actual configured source path');return names;
 });
 const emitted=join(output,'emitted');mkdirSync(emitted,{mode:0o700});
 const configs=plan.projects.map(p=>join(output,p.id+'.json'));
 const rows=plan.projects.map(p=>{
  const names=memberships[p.index];
  const outDir=emitted,buildInfo=join(output,p.id+'.tsbuildinfo');
  const config={extends:base,files:names,include:[],references:p.dependencies.map(i=>({path:configs[i]})),compilerOptions:{...NATIVE_REFERENCE_OVERRIDES,rootDir:source,outDir,tsBuildInfoFile:buildInfo}};
  assert(!Object.hasOwn(config.compilerOptions,'paths'));writeFileSync(configs[p.index],JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});return{...p,config:configs[p.index],outDir,buildInfo,files:names};
 });
 const solution=join(output,'solution.json');writeFileSync(solution,JSON.stringify({files:[],references:rows.map(row=>({path:row.config}))},null,2)+'\n',{flag:'wx',mode:0o600});return{projects:rows,solution,emitted};
}
