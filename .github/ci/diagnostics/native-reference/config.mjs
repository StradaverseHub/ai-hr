/** Real retained configurations; TypeScript alone owns reference resolution. */
import assert from 'node:assert/strict';
import {isAbsolute,join,relative} from 'node:path';
import {writeFileSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
export const NATIVE_REFERENCE_OVERRIDES=Object.freeze({noEmit:false,noEmitOnError:true,composite:true,declaration:true,emitDeclarationOnly:false,disableSourceOfProjectReferenceRedirect:true});
export function contained(root,path){assert(isAbsolute(root)&&isAbsolute(path));const rel=relative(root,path);assert(rel&&!rel.startsWith('../')&&!isAbsolute(rel),'Path outside private owner');return rel;}
export function writeNativeReferenceConfigs({base,source,output,plan,files}){
 assert.equal(realpathSync(base),base);assert.equal(realpathSync(source),source);assert.equal(realpathSync(output),output);assert(lstatSync(output).isDirectory());assert(relative(source,output).startsWith('../'),'Native output must be outside the immutable source tree');
 const byId=new Map(files.map(f=>[f.id,f]));
 plan.projects.forEach((p,i)=>assert(p.index===i&&p.id==='project-'+String(i).padStart(3,'0'),'Fixed project owner identity required'));
 const emitted=join(output,'emitted');mkdirSync(emitted,{mode:0o700});
 const configs=plan.projects.map(p=>join(output,p.id+'.json'));
 const rows=plan.projects.map(p=>{
  const selected=[...p.owned,...p.context.filter(id=>['json','declaration'].includes(byId.get(id)?.kind))];
  assert.equal(new Set(selected).size,selected.length);
  const ordered=plan.originalRoots.filter(id=>selected.includes(id));for(const id of selected)if(!ordered.includes(id))ordered.push(id);
  const names=ordered.map(id=>{const f=byId.get(id);assert(f&&isAbsolute(f.path));assert.equal(realpathSync(f.path),f.path);assert(!lstatSync(f.path).isSymbolicLink());contained(source,f.path);return f.path;});
  const outDir=emitted,buildInfo=join(output,p.id+'.tsbuildinfo');
  const config={extends:base,files:names,include:[],references:p.dependencies.map(i=>({path:configs[i]})),compilerOptions:{...NATIVE_REFERENCE_OVERRIDES,rootDir:source,outDir,tsBuildInfoFile:buildInfo}};
  assert(!Object.hasOwn(config.compilerOptions,'paths'));writeFileSync(configs[p.index],JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});return{...p,config:configs[p.index],outDir,buildInfo,files:names};
 });
 const solution=join(output,'solution.json');writeFileSync(solution,JSON.stringify({files:[],references:rows.map(row=>({path:row.config}))},null,2)+'\n',{flag:'wx',mode:0o600});return{projects:rows,solution,emitted};
}
