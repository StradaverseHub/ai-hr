/** Development-only graph experiment. No release receipt or compiler-cache authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const BOUNDARY_SOURCE='f2b1ae1a9af20bdb30f28ed9b537aa08994dfc10';
export const BOUNDARY_REF='codex/compiler-rewards-fixture-principal-20261108';
export const BOUNDARY_LIMITS=Object.freeze({heapMiB:12288,inventoryMs:120000,compilerMs:720000,
 fileBytes:512*1024**2,totalBytes:1024**3,logBytes:16*1024**2,consumerRoots:400,consumerClosure:600});
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export function admitBoundaryInputs(inputs){
 assert.equal(inputs.installer_fixture_phase,'compiler-boundary');assert.equal(inputs.compiler_probe,true);
 assert.equal(inputs.expected_sha,BOUNDARY_SOURCE);assert.equal(inputs.next_build_cache_phase,'disabled');
 assert.equal(inputs.candidate_ref,BOUNDARY_REF);
 for(const [key,value]of Object.entries(inputs))if(typeof value==='boolean'&&key!=='compiler_probe')assert.equal(value,false,key);
 for(const key of ['transport_origin_run','transport_origin_sha','transport_origin_artifact','transport_origin_digest',
  'compiler_origin_run','compiler_origin_sha','compiler_origin_artifact','compiler_origin_digest','next_build_cache_origin'])
  assert(inputs[key]===undefined||inputs[key]==='',key);
}
export function remainingCompilerMs(phases){
 const used=phases.filter(phase=>phase.mode!=='inventory').reduce((sum,phase)=>sum+phase.elapsedMs,0);
 assert(Number.isFinite(used)&&used>=0);return Math.max(0,BOUNDARY_LIMITS.compilerMs-used);
}
export function stronglyConnected(vertices,edges){
 const known=new Set(vertices),adj=new Map(vertices.map(id=>[id,[]])),reverse=new Map(vertices.map(id=>[id,[]]));
 for(const {from,to}of edges)if(known.has(from)&&known.has(to)){adj.get(from).push(to);reverse.get(to).push(from);}
 // Iterative Kosaraju: the real graph can exceed the JavaScript recursion limit.
 const visited=new Set(),order=[];
 for(const root of vertices){
  if(visited.has(root))continue;const stack=[[root,false]];
  while(stack.length){const [id,exit]=stack.pop();if(exit){order.push(id);continue;}if(visited.has(id))continue;
   visited.add(id);stack.push([id,true]);for(const to of adj.get(id))if(!visited.has(to))stack.push([to,false]);}
 }
 visited.clear();const groups=[];
 for(const root of order.reverse()){
  if(visited.has(root))continue;const group=[],stack=[root];
  while(stack.length){const id=stack.pop();if(visited.has(id))continue;visited.add(id);group.push(id);for(const from of reverse.get(id))if(!visited.has(from))stack.push(from);}
  groups.push(group.sort());
 }
 return groups;
}
export function transitiveClosure(seeds,edges){
 const adj=new Map();for(const {from,to}of edges){if(!to)continue;const list=adj.get(from)??[];list.push(to);adj.set(from,list);}
 const seen=new Set(),stack=[...seeds];while(stack.length){const id=stack.pop();if(seen.has(id))continue;seen.add(id);for(const next of adj.get(id)??[])stack.push(next);}return seen;
}
/** Native first-entry modules preserve dependency-cycle traversal; ambient leaves
 * cannot safely be rooted individually. Default libraries remain compiler-owned. */
export function ambientEntries(inventory){
 const files=new Map(inventory.files.map(file=>[file.id,file])),adj=new Map();
 for(const {from,to}of inventory.edges)if(to&&files.has(to)){const next=adj.get(from)??[];next.push(to);adj.set(from,next);}
 const firstRoot=new Map();for(const root of inventory.roots){const pending=[root];while(pending.length){const key=pending.pop();if(firstRoot.has(key))continue;
  firstRoot.set(key,root);for(const next of adj.get(key)??[])pending.push(next);}}
 const firstLoad=new Map((inventory.firstLoads??inventory.files.map(file=>file.id)).map((key,index)=>[key,index]));
 const candidates=new Map();
 for(const edge of inventory.edges){const from=files.get(edge.from),to=files.get(edge.to),root=firstRoot.get(edge.from);
  if(!root||!from||from.external||!to?.external||to.defaultLibrary)continue;
  const targets=candidates.get(root)??new Set();targets.add(to.id);candidates.set(root,targets);}
 const closures=new Map();const closure=key=>{
  if(closures.has(key))return closures.get(key);const seen=new Set(),pending=[key];while(pending.length){const id=pending.pop();if(seen.has(id))continue;seen.add(id);for(const next of adj.get(id)??[])pending.push(next);}
  // A dependency-context sidecar must never import an application implementation.
  assert([...seen].every(id=>files.get(id)?.external||files.get(id)?.declaration||files.get(id)?.json),'External context crosses an implementation boundary');
  closures.set(key,seen);return seen;
 };
 const entries=[];
 for(const root of inventory.roots){
  const required=inventory.files.filter(file=>file.ambient&&file.external&&!file.defaultLibrary&&firstRoot.get(file.id)===root).map(file=>file.id);
  if(!required.length)continue;const missing=new Set(required),targets=[];
  for(const target of [...(candidates.get(root)??[])].sort((a,b)=>(firstLoad.get(a)??Infinity)-(firstLoad.get(b)??Infinity))){
   const reachable=closure(target);if(![...missing].some(id=>reachable.has(id)))continue;
   targets.push(target);for(const id of reachable)missing.delete(id);
  }
  assert.equal(missing.size,0,'No native entry anchor for original ambient context at '+root);
  entries.push({root,targets,ambient:required});
 }
 return entries;
}
/** Keep original configured-root order. Sidecars only import context; omitted
 * implementation roots remain owned and checked by their original partition. */
export function orderedBoundaryRoots(inventory,plan,primary,naturalRoots,sidecarFor,redirect){
 const requested=new Set(primary),natural=new Set(naturalRoots),files=new Map(inventory.files.map(file=>[file.id,file]));
 const contextOwn=new Set(plan.ambient.filter(id=>!files.get(id).external)),entries=new Map(plan.contextEntries.map(entry=>[entry.root,entry]));
 const result=[];for(const root of inventory.roots){
  const entry=entries.get(root);
  if(entry&&!natural.has(root)&&!files.get(root).declaration)result.push(sidecarFor(entry));
  if(requested.has(root)||contextOwn.has(root))result.push(redirect(root));
 }
 // Unrooted declarations still get checked, after their original context is established.
 for(const file of inventory.files)if((requested.has(file.id)||contextOwn.has(file.id))&&!inventory.roots.includes(file.id))result.push(redirect(file.id));
 assert([...requested].every(id=>inventory.files.some(file=>file.id===id)),'Unknown primary source');
 return [...new Set(result)];
}
export function planBoundary(inventory){
 const {roots,files,edges,buildRoots}=inventory,byId=new Map(files.map(file=>[file.id,file])),all=new Set(roots);
 assert.equal(all.size,roots.length,'Duplicate original roots');assert(roots.every(id=>byId.has(id)),'Missing root identity');
 assert(buildRoots.length>0&&buildRoots.every(id=>all.has(id)),'Runtime seed must be actual baseline build-root subset');
 const ambient=files.filter(file=>file.ambient).map(file=>file.id);
 const external=files.filter(file=>file.external).map(file=>file.id);
 const producerSet=transitiveClosure([...buildRoots,...ambient.filter(id=>!byId.get(id).external)],edges);
 const owned=files.filter(file=>!file.external&&!file.json).map(file=>file.id),sccs=stronglyConnected(owned,edges);
 for(const group of sccs)if(group.some(id=>producerSet.has(id)))assert(group.every(id=>producerSet.has(id)),'Producer splits an actual SCC');
 const producerRoots=roots.filter(id=>producerSet.has(id)),left=roots.filter(id=>!producerSet.has(id));
 const rank=new Map(roots.map((id,index)=>[id,index])),groups=sccs.map(group=>group.filter(id=>all.has(id)&&!producerSet.has(id))).filter(group=>group.length);
 groups.sort((a,b)=>Math.min(...a.map(id=>rank.get(id)))-Math.min(...b.map(id=>rank.get(id))));
 const consumers=[];let current=[];
 for(const group of groups){assert(group.length<=BOUNDARY_LIMITS.consumerRoots,'Consumer SCC exceeds bounded root budget');
  if(current.length+group.length>BOUNDARY_LIMITS.consumerRoots){consumers.push(current);current=[];}current.push(...group);}
 if(current.length)consumers.push(current);
 assert.deepEqual([...consumers.flat()].sort(),[...left].sort(),'Every non-producer root must be assigned exactly once');
 const assigned=[...producerRoots,...consumers.flat()];assert.equal(new Set(assigned).size,roots.length);assert.equal(assigned.length,roots.length);
 const consumerPlans=consumers.map((rootIds,index)=>{
  const sourceIds=[...transitiveClosure(rootIds,edges)].filter(id=>byId.has(id)&&!byId.get(id).external&&!producerSet.has(id));
  assert(sourceIds.length<=BOUNDARY_LIMITS.consumerClosure,'Consumer source dependency closure exceeds bound');
  return {id:index,roots:rootIds.sort((a,b)=>rank.get(a)-rank.get(b)),sourceIds};
 });
 return {kind:'DIAGNOSTIC_BOUNDARY_PLAN_NOT_RELEASE',releaseAuthorized:false,roots,producerRoots,contextEntries:ambientEntries(inventory),
  producerSourceIds:owned.filter(id=>producerSet.has(id)),ambient,external,consumers:consumerPlans,sccs,
  seedPolicy:'Actual parsed tsconfig.build.json roots seed dependency closure only. All root tsconfig.json exclusions remain independently covered.'};
}
export function validateDeclarationCoverage(plan,inventory,declarations){
 const files=new Map(inventory.files.map(file=>[file.id,file])),bySource=new Map();for(const row of declarations){
  assert(!bySource.has(row.source),'Duplicate emitted source');bySource.set(row.source,row);
  const file=files.get(row.source);assert(file&&!file.declaration&&!file.external&&!file.json,'Only actual owned implementation sources may emit declarations');
  const virtual=row.source.replace(/\.(?:mts|mjs)$/,'.d.mts').replace(/\.(?:cts|cjs)$/,'.d.cts').replace(/\.(?:tsx?|jsx?)$/,'.d.ts');
  assert(virtual!==row.source&&!virtual.startsWith('/')&&!virtual.split('/').includes('..'),'Unsafe declaration source');
  assert.equal(row.virtual,virtual);assert.equal(row.output,'emitted/'+virtual);assert(/^[a-f0-9]{64}$/.test(row.sha256));
 }
 for(const id of plan.producerSourceIds){const file=files.get(id);assert(file,'Unknown producer source');if(!file.declaration)assert(bySource.has(id),'Missing actual declaration for '+id);}
 assert(declarations.every(row=>plan.producerSourceIds.includes(row.source)),'Foreign emitted declaration');
}
export function assertDeclarationBytes(row,bytes){assert.equal(sha256(bytes),row.sha256,'Stale or foreign generated declaration bytes');}
/** Resolved opaque targets are not necessarily checked SourceFiles (for example
 * vendor JS under maxNodeModuleJsDepth=0). Keep both inventories distinct. */
export function resolutionLeafTargets(files,edges,firstLoads){
 const sourceIds=new Set(files.map(file=>file.id)),parsed=new Set(firstLoads),leaves=new Map();
 for(const edge of edges){if(!edge.to||sourceIds.has(edge.to))continue;
  assert(!parsed.has(edge.to),'A resolution-only leaf was parsed by the original native program');
  const leaf=leaves.get(edge.to)??{id:edge.to,extensions:[],resolutionKinds:[],packageIds:[],checkedByOriginalProgram:false,nativeSourceParsed:false};
  if(!leaf.extensions.includes(edge.extension??null))leaf.extensions.push(edge.extension??null);
  if(!leaf.resolutionKinds.includes(edge.kind))leaf.resolutionKinds.push(edge.kind);
  if(!leaf.packageIds.some(value=>JSON.stringify(value)===JSON.stringify(edge.packageId??null)))leaf.packageIds.push(edge.packageId??null);
  leaves.set(edge.to,leaf);
 }
 return [...leaves.values()];
}
export function assertResolutionLeafBytes(row,bytes){assert.equal(sha256(bytes),row.sha256,'Original native resolution leaf bytes changed');}
export function contractSource(base='.'){
 return `import {withTenant,type SessionContext} from ${JSON.stringify(base+'/db/client')};
import {employment} from ${JSON.stringify(base+'/db/schema')};
import {readEmployeeChoices} from ${JSON.stringify(base+'/core/employee-choice')};
import {createTranslator} from 'next-intl';
import en from ${JSON.stringify(base+'/messages/en.json')};
declare const ctx:SessionContext;
type Page=Awaited<ReturnType<typeof readEmployeeChoices>>;
declare const page:Page;
const status:'active'|'ended'|undefined=page.rows[0]?.status;
const inferred:Promise<number>=withTenant(ctx,async tx=>{const rows=await tx.select({id:employment.id}).from(employment);const id:string|undefined=rows[0]?.id;return id?.length??0;});
const generic:Promise<{kind:'intact';value:number}>=withTenant(ctx,async()=>({kind:'intact' as const,value:1}));
const translate=createTranslator({locale:'en',messages:{rewards:{board:en.rewards.board}},namespace:'rewards.board'});
const translated:string=translate('title');
void [status,inferred,generic,translated];
`;
}
export const NEGATIVE_CONTRACTS=Object.freeze([
 {code:2322,line:"const badContext:SessionContext={tenantId:'fictional',entitlements:42};"},
 {code:2322,line:'const badGeneric:Promise<string>=withTenant(ctx,async()=>1);'},
 {code:2339,line:'withTenant(ctx,async tx=>tx.select({bad:employment.__aihr_missing_column__}).from(employment));'},
 {code:2322,line:"const badDiscriminant:Page['rows'][number]['status']='__aihr_invalid__';"},
 {code:2345,line:"translate('__aihr_missing_translation_key__');"},
]);
export function expectContractRefusals(diagnostics,text,file){
 const expected=NEGATIVE_CONTRACTS.map(({code,line})=>({code,line:text.slice(0,text.indexOf(line)).split('\n').length}));
 assert.equal(diagnostics.length,expected.length,'Every semantic refusal must be the expected native compiler diagnostic');
 const actual=diagnostics.map(row=>({code:row.code,line:row.line,file:row.file}));
 assert.deepEqual(actual.map(({code,line})=>({code,line})).sort((a,b)=>a.line-b.line),expected);
 assert(actual.every(row=>row.file===file),'Unrelated compiler error cannot stand in for API refusal');
}
