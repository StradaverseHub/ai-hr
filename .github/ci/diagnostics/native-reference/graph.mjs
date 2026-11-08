/** Pure graph ownership only. No compiler host, resolver or acceptance authority. */
import assert from 'node:assert/strict';
export const REFERENCE_LIMITS=Object.freeze({roots:400,ownedClosure:600,heapMiB:12288,aggregateMs:720000,fileBytes:512*1024**2,totalBytes:1024**3,logBytes:16*1024**2});
const id=value=>typeof value==='string'&&value.length>0&&value.length<4096&&!/[\\\u0000-\u001f]/.test(value)&&!value.startsWith('/')&&!value.split('/').some(part=>part==='.'||part==='..'||part==='');
export function assertReferenceLimits(limits){
 assert(limits&&Number.isSafeInteger(limits.roots)&&limits.roots>0&&limits.roots<=REFERENCE_LIMITS.roots);assert(Number.isSafeInteger(limits.ownedClosure)&&limits.ownedClosure>0&&limits.ownedClosure<=REFERENCE_LIMITS.ownedClosure);
}
/** The actual ordered native files list, not just original root ownership.
 * Cross-project implementations enter through native references, never context. */
export function configuredNativeRoots(originalRoots,owned,context,records){
 const files=records instanceof Map?records:new Map(records.map(file=>[file.id,file]));
 if(!(records instanceof Map))assert.equal(files.size,records.length,'Duplicate native source identity');
 for(const values of [originalRoots,owned,context])assert(Array.isArray(values)&&new Set(values).size===values.length&&values.every(value=>id(value)&&files.has(value)&&files.get(value).id===value&&['implementation','declaration','json','external','opaque'].includes(files.get(value).kind)),'Canonical complete configured identities required');
 assert(owned.length>0&&owned.every(value=>files.get(value).kind==='implementation'),'Complete owned implementation membership required');
 assert(context.every(value=>files.get(value).kind!=='implementation'),'Implementation cannot hide in declaration context');
 const selected=[...owned,...context.filter(value=>['json','declaration'].includes(files.get(value).kind))];assert.equal(new Set(selected).size,selected.length);
 const selectedSet=new Set(selected),ordered=originalRoots.filter(value=>selectedSet.has(value)),present=new Set(ordered);for(const value of selected)if(!present.has(value)){ordered.push(value);present.add(value);}return ordered;
}
export function stronglyConnected(vertices,edges){
 const set=new Set(vertices);assert.equal(set.size,vertices.length);const adj=new Map(vertices.map(v=>[v,[]])),reverse=new Map(vertices.map(v=>[v,[]]));
 for(const{from,to}of edges){assert(set.has(from)&&set.has(to),'Unknown implementation edge');adj.get(from).push(to);reverse.get(to).push(from);}
 const seen=new Set(),order=[];
 for(const root of vertices){const stack=[[root,false]];while(stack.length){const[v,exit]=stack.pop();if(exit){order.push(v);continue;}if(seen.has(v))continue;seen.add(v);stack.push([v,true]);for(const next of adj.get(v))if(!seen.has(next))stack.push([next,false]);}}
 seen.clear();const result=[];
 for(const root of order.reverse()){if(seen.has(root))continue;const stack=[root],group=[];while(stack.length){const v=stack.pop();if(seen.has(v))continue;seen.add(v);group.push(v);for(const next of reverse.get(v))if(!seen.has(next))stack.push(next);}result.push(group.sort());}
 return result;
}
export function dependencyOrder(groups,edges){
 const owner=new Map();groups.forEach((group,index)=>{assert(group.length>0);for(const v of group){assert(!owner.has(v),'Duplicate project member');owner.set(v,index);}});
 const deps=groups.map(()=>new Set()),users=groups.map(()=>new Set());
 for(const{from,to}of edges){assert(owner.has(from)&&owner.has(to),'Missing project owner');const a=owner.get(from),b=owner.get(to);if(a!==b){deps[a].add(b);users[b].add(a);}}
 const remaining=deps.map(set=>set.size),ready=remaining.flatMap((n,i)=>n===0?[i]:[]),result=[];
 while(ready.length){ready.sort((a,b)=>a-b);const next=ready.shift();result.push(next);for(const user of users[next])if(--remaining[user]===0)ready.push(user);}
 assert.equal(result.length,groups.length,'Contracted project graph is cyclic');return{order:result,dependencies:deps.map(set=>[...set].sort((a,b)=>a-b))};
}
export function planNativeReferences(inventory,limits={roots:REFERENCE_LIMITS.roots,ownedClosure:REFERENCE_LIMITS.ownedClosure}){
 assertReferenceLimits(limits);
 assert(inventory.files.length<=50000&&inventory.roots.length<=50000&&inventory.edges.length<=1000000,'Bounded complete native graph required');
 const files=new Map();for(const file of inventory.files){assert(id(file.id)&&!files.has(file.id));assert(['implementation','declaration','json','external','opaque'].includes(file.kind));files.set(file.id,file);}
 const roots=new Set(inventory.roots);assert.equal(roots.size,inventory.roots.length);assert([...roots].every(v=>files.has(v)),'Unknown original root');
 assert(Array.isArray(inventory.buildRoots)&&inventory.buildRoots.length>0&&inventory.buildRoots.every(v=>roots.has(v)),'Unknown runtime seed');
 const adjacency=new Map([...files.keys()].map(v=>[v,[]]));for(const edge of inventory.edges){assert(files.has(edge.from)&&files.has(edge.to),'Unresolved/unknown graph edge');adjacency.get(edge.from).push(edge.to);}
 const implementation=inventory.files.filter(f=>f.kind==='implementation').map(f=>f.id);assert(implementation.length>0,'No owned implementation');const implementationSet=new Set(implementation),effective=[];
 const contexts=inventory.files.filter(f=>f.kind==='declaration'&&(f.ambient||roots.has(f.id))).map(f=>f.id);
 assert(contexts.length<limits.roots,'Oversized native SCC or required context; no configured root may be dropped');
 // Precompute context reachability while stopping at every other implementation.
 // A group's union is complete because each of its implementations contributes
 // its own closure. No cross-owned implementation's private context is pulled in.
 const contextByImplementation=new Map();
 for(const from of implementation){const context=new Set(contexts),pending=[from,...contexts],seen=new Set();while(pending.length){const node=pending.pop();if(seen.has(node))continue;seen.add(node);for(const next of adjacency.get(node)){if(implementationSet.has(next))continue;context.add(next);pending.push(next);}}contextByImplementation.set(from,context);}
 const configuredFor=owned=>configuredNativeRoots(inventory.roots,owned,[...new Set(owned.flatMap(value=>[...contextByImplementation.get(value)]))],files);
 for(const from of implementation){const pending=[...adjacency.get(from),...contexts],seen=new Set();while(pending.length){const to=pending.pop();if(seen.has(to))continue;seen.add(to);if(implementationSet.has(to)){effective.push({from,to});continue;}for(const next of adjacency.get(to))pending.push(next);}}
 const components=stronglyConnected(implementation,effective),rank=new Map(inventory.roots.map((v,i)=>[v,i]));
 components.sort((a,b)=>Math.min(...a.map(v=>rank.get(v)??Infinity))-Math.min(...b.map(v=>rank.get(v)??Infinity))||a[0].localeCompare(b[0]));
 const ordered=dependencyOrder(components,effective).order.map(i=>components[i]);const groups=[];let current=[];
 for(const group of ordered){assert(group.length<=limits.ownedClosure&&configuredFor(group).length<=limits.roots,'Oversized native SCC or required context; no configured root may be dropped');
  if(current.length+group.length>limits.ownedClosure||configuredFor([...current,...group]).length>limits.roots){groups.push(current);current=[];}current.push(...group);}
 if(current.length)groups.push(current);const contracted=dependencyOrder(groups,effective);assert.deepEqual(contracted.order,groups.map((_,i)=>i),'Contiguous dependency-first contraction required');
 const owner=new Map();groups.forEach((group,i)=>group.forEach(v=>owner.set(v,i)));assert.equal(owner.size,implementation.length);
 const runtime=new Set(),pending=[...inventory.buildRoots,...contexts];while(pending.length){const v=pending.pop();if(runtime.has(v))continue;runtime.add(v);pending.push(...adjacency.get(v));}
 const projects=groups.map((owned,index)=>{const context=new Set(contexts),queue=[...owned,...contexts],seen=new Set();while(queue.length){const v=queue.pop();if(seen.has(v))continue;seen.add(v);for(const next of adjacency.get(v)){if(implementationSet.has(next)&&owner.get(next)!==index)continue;if(!implementationSet.has(next))context.add(next);queue.push(next);}}
  const configuredRoots=configuredNativeRoots(inventory.roots,owned,[...context],files);assert(configuredRoots.length<=limits.roots&&owned.length<=limits.ownedClosure,'Actual configured project exceeds native budget');assert.deepEqual([...configuredRoots].sort(),configuredFor(owned).sort(),'Precomputed context membership differs');
  return{id:'project-'+String(index).padStart(3,'0'),index,owned,roots:inventory.roots.filter(v=>owned.includes(v)),context:[...context],configuredRoots,dependencies:contracted.dependencies[index],runtime:owned.some(v=>runtime.has(v))};});
 const rootOwners=inventory.roots.map(root=>({root,project:owner.has(root)?owner.get(root):projects.findIndex(p=>p.configuredRoots.includes(root))}));assert(rootOwners.every(row=>row.project>=0),'Original configured context root has no designated owner');
 return{kind:'UNINSTALLED_NATIVE_REFERENCE_PLAN',ordinaryCompilerQualified:false,releaseAuthorized:false,limits,originalRoots:[...inventory.roots],rootOwners,components:ordered,projects};
}
