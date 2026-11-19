/** Protected-controller planner. Candidate paths/risk labels never choose their own checks. */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeInputs} from './runtime-inputs';
import {classifyTestFiles} from '../gate-db-classify';
import {planImpact} from '../gate-impact';
import {collectChanges} from '../gate-tier-git';
import {sourceFiles} from '../gate-impact-git';
import {buildPlan,hash} from './protocol.mjs';
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:128*1024**2}).trim();
const SHA=/^[a-f0-9]{40}$/;
function entries(cwd:string,ref:string){
 return new Map(git(cwd,'ls-tree','-r','-z',ref).split('\0').filter(Boolean).map(row=>{const [meta,path]=row.split('\t');const [mode,type,oid]=meta.split(' ');if(type!=='blob'||!['100644','100755'].includes(mode))throw Error('Nonregular source input: '+path);return [path,oid];}));
}
export function createDeliveryPlan({candidatePath,controllerPath,base}:{candidatePath:string;controllerPath:string;base:string}){
 const candidate=git(candidatePath,'rev-parse','HEAD'),controller=git(controllerPath,'rev-parse','HEAD');
 if(!SHA.test(base)||!SHA.test(candidate)||!SHA.test(controller)||git(candidatePath,'status','--porcelain')||git(controllerPath,'status','--porcelain'))throw Error('Exact clean controller/candidate required');
 execFileSync('git',['merge-base','--is-ancestor',base,candidate],{cwd:candidatePath,stdio:'ignore'});
 const blobs=entries(candidatePath,candidate),policyBlobs=entries(controllerPath,controller);
 const policy=[...policyBlobs].filter(([p])=>p.startsWith('scripts/delivery/')||p.startsWith('.github/ci/')||p.startsWith('.github/workflows/delivery-')||/^scripts\/gate-(impact|tier|db|affected)/.test(p));
 const policyDigest=hash(policy.sort()),files=sourceFiles(candidatePath);let edges:ReadonlyMap<string,ReadonlySet<string>>=new Map();
 const impact=planImpact(collectChanges(base,candidate,candidatePath),files,[],graph=>{edges=graph;});
 const inventory=[...blobs.keys()].filter(p=>/^test\/.*(?:\.test\.ts|\.dom\.test\.tsx|\.browser\.test\.tsx)$/.test(p)).sort();
 const globals=[...blobs.keys()].filter(p=>/^package\.json$|^pnpm-lock\.yaml$|^tsconfig|^vitest/.test(p));
 const classified=classifyTestFiles(inventory.filter(p=>!p.endsWith('.browser.test.tsx')),p=>files.get(p)??null);const dbFiles=new Set(classified.db);
 const all=[...blobs].sort(),opaqueFiles=new Set<string>();
 const augmented=new Map([...edges].map(([p,deps])=>[p,new Set(deps)]));
 for(const [p,text] of files){const info=runtimeInputs(p,text,files);if(info.opaque)opaqueFiles.add(p);const deps=augmented.get(p)??new Set<string>();for(const d of info.dependencies)deps.add(d);augmented.set(p,deps);}
 edges=augmented;
 const closure=(root:string)=>{const setup=root.endsWith('.browser.test.tsx')?['test/browser-setup.ts']:root.endsWith('.dom.test.tsx')?['test/dom-setup.ts']:dbFiles.has(root)?['test/env.ts','test/global-setup.ts']:['test/env.ts'];const seen=new Set<string>(),queue=[root,...globals,...setup];while(queue.length){const p=queue.pop()!;if(seen.has(p))continue;seen.add(p);for(const dep of edges.get(p)??[])queue.push(dep);}return [...seen].sort();};
 const fullInputDigest=hash({policyDigest,inputs:all,runtime:{node:'22.23.3',postgres:16,platform:'linux-x64'},externalServices:'closed-fictional-fixtures'});
 const checks:any[]=inventory.flatMap(file=>{
  const reachable=closure(file),uncertain=reachable.some(p=>opaqueFiles.has(p));
  // Every DB test also binds all SQL/schema/kernel owners: runtime SQL edges are not import edges.
  const database=dbFiles.has(file);
  const inputs=uncertain?all:[...new Set([...reachable,...(database?[...blobs.keys()].filter(p=>p.startsWith('db/')||p.startsWith('core/')):[])])].sort().map(p=>[p,blobs.get(p)??'<absent>']);
  const kinds=file.endsWith('.browser.test.tsx')?['browser-chromium','browser-firefox','browser-webkit']:['test'];return kinds.map(kind=>({kind,files:[file],reuse:uncertain?'never':'exact-inputs',inputFiles:uncertain?'*':inputs.map(row=>row[0]),inputs:uncertain?fullInputDigest:hash({policyDigest,inputs,runtime:{node:'22.23.3',postgres:16,platform:'linux-x64'},externalServices:'closed-fictional-fixtures'})}));
 });
 const product=[...blobs].filter(([p])=>!p.startsWith('docs/')&&!p.startsWith('test/')&&!p.startsWith('.github/')).sort();
 for(const kind of ['compiler','build','migration','controller']){
  const owners=kind==='controller'?policy:kind==='compiler'?all:kind==='migration'?all.filter(([p])=>p.startsWith('db/')||p.startsWith('scripts/')||p.startsWith('test/helpers/')||p.includes('upgrade')||globals.includes(p)):product;
  checks.push({kind,reuse:kind==='build'?'never':'exact-inputs',files:[kind==='migration'?'db/migrations/meta/_journal.json':kind==='controller'?'scripts/delivery/protocol.mjs':'package.json'],inputFiles:owners.map(([p])=>p),inputs:hash({policyDigest,inputs:owners})});
 }
 const plan=buildPlan({candidate,base,controller,policyDigest,tree:git(candidatePath,'rev-parse','HEAD^{tree}'),profile:impact.tier==='full'?'broad':'scoped',reasons:impact.reasons,changed:impact.changed,checks,inventory:inventory.flatMap(p=>p.endsWith('.browser.test.tsx')?['chromium','firefox','webkit'].map(e=>p+'::'+e):[p])});
 if(git(candidatePath,'rev-parse','HEAD')!==candidate||git(candidatePath,'status','--porcelain'))throw Error('Candidate changed during planning');
 return plan;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [candidatePath,controllerPath,base,output]=process.argv.slice(2);const p=createDeliveryPlan({candidatePath:resolve(candidatePath),controllerPath:resolve(controllerPath),base});
 if(output)writeFileSync(output,JSON.stringify(p)+'\n',{flag:'wx'});else console.log(JSON.stringify(p));
}
