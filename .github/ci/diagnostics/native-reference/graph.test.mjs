/** Pure ownership graph models, never native compiler qualification. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planNativeReferences,dependencyOrder,REFERENCE_LIMITS} from './graph.mjs';
const file=(id,kind='implementation',extra={})=>({id,kind,...extra});
const inventory=(names,links=[],extra=[])=>({roots:names,buildRoots:[names[0]],files:[...names.map(name=>file(name)),...extra],edges:links.map(([from,to])=>({from,to}))});
const projectOf=(plan,id)=>plan.projects.findIndex(p=>p.owned.includes(id));
test('orders every native dependency before its consumer independently of configured-root alphabetic order',()=>{
 const plan=planNativeReferences(inventory(['a.ts','b.ts','c.ts'],[['a.ts','b.ts'],['b.ts','c.ts']]),{roots:1,ownedClosure:1});
 assert.deepEqual(plan.projects.map(p=>p.owned),[['c.ts'],['b.ts'],['a.ts']]);assert.deepEqual(plan.projects.map(p=>p.dependencies),[[],[0],[1]]);
 assert.deepEqual(plan.originalRoots,['a.ts','b.ts','c.ts']);assert.equal(plan.rootOwners.length,3);
});
test('keeps complete strongly-connected implementations together and refuses a root budget smaller than the cycle',()=>{
 const input=inventory(['a.ts','b.ts','c.ts'],[['a.ts','b.ts'],['b.ts','a.ts'],['c.ts','a.ts']]);
 const plan=planNativeReferences(input,{roots:2,ownedClosure:2});assert.equal(projectOf(plan,'a.ts'),projectOf(plan,'b.ts'));assert(projectOf(plan,'a.ts')<projectOf(plan,'c.ts'));
 assert.throws(()=>planNativeReferences(input,{roots:1,ownedClosure:2}),/Oversized native SCC/);
});
test('retains implementation dependency edges reached through real declaration context',()=>{
 const input=inventory(['a.ts','b.ts'],[['a.ts','context.d.ts'],['context.d.ts','b.ts']],[file('context.d.ts','declaration')]);
 const plan=planNativeReferences(input,{roots:1,ownedClosure:1});assert(projectOf(plan,'b.ts')<projectOf(plan,'a.ts'));assert.deepEqual(plan.projects[1].dependencies,[0]);
});
test('refuses an oversized nonroot implementation component without dropping the original single root',()=>{
 const names=Array.from({length:601},(_,i)=>'cycle-'+i+'.ts'),input={roots:[names[0]],buildRoots:[names[0]],files:names.map(name=>file(name)),edges:names.map((from,i)=>({from,to:names[(i+1)%names.length]}))};
 assert.throws(()=>planNativeReferences(input),/Oversized native SCC/);
});
test('refuses unknown edges, roots, runtime seeds and duplicate identities rather than accepting incomplete inventory',()=>{
 const valid=inventory(['a.ts','b.ts']);
 for(const mutate of [v=>v.edges.push({from:'a.ts',to:'missing.ts'}),v=>v.roots.push('missing.ts'),v=>v.buildRoots.push('foreign.ts'),v=>v.files.push(file('a.ts')),v=>v.roots.push('a.ts')]){const changed=structuredClone(valid);mutate(changed);assert.throws(()=>planNativeReferences(changed));}
});
test('an arbitrary noncontiguous DAG contraction that introduces a cycle is refused',()=>{
 assert.throws(()=>dependencyOrder([['a.ts','c.ts'],['b.ts']],[{from:'a.ts',to:'b.ts'},{from:'b.ts',to:'c.ts'}]),/Contracted project graph is cyclic/);
});
test('grouping is deterministic under file record order while original configured root order stays exact',()=>{
 const input=inventory(['z.ts','a.ts','n.ts'],[['z.ts','a.ts']]);const reversed={...input,files:[...input.files].reverse()};
 assert.deepEqual(planNativeReferences(input,{roots:1,ownedClosure:1}),planNativeReferences(reversed,{roots:1,ownedClosure:1}));
});
test('runtime producer closure remains explicit while unrelated implementations retain owners',()=>{
 const plan=planNativeReferences(inventory(['entry.ts','dependency.ts','other.ts'],[['entry.ts','dependency.ts']]),{roots:1,ownedClosure:1});
 assert.deepEqual(plan.projects.filter(p=>p.runtime).flatMap(p=>p.owned).sort(),['dependency.ts','entry.ts']);assert.equal(plan.projects.flatMap(p=>p.owned).length,3);
});
test('global declaration context can be shared but each original root has exactly one designated owner',()=>{
 const input=inventory(['a.ts','b.ts']);input.roots.unshift('global.d.ts');input.files.push(file('global.d.ts','declaration',{ambient:true}));
 const plan=planNativeReferences(input,{roots:1,ownedClosure:1});assert(plan.projects.every(p=>p.context.includes('global.d.ts')));assert.equal(plan.rootOwners.filter(row=>row.root==='global.d.ts').length,1);
});
test('JSON stays an explicit native context, not an invented declaration or duplicate implementation owner',()=>{
 const input=inventory(['a.ts','b.ts'],[['a.ts','data.json'],['b.ts','a.ts']],[file('data.json','json')]);
 const plan=planNativeReferences(input,{roots:1,ownedClosure:1});const a=plan.projects[projectOf(plan,'a.ts')],b=plan.projects[projectOf(plan,'b.ts')];
 assert(a.context.includes('data.json'));assert(!b.context.includes('data.json'));assert.deepEqual(plan.projects.flatMap(p=>p.owned).sort(),['a.ts','b.ts']);
});
test('every nonroot implementation remains owned exactly once inside fixed per-project envelopes',()=>{
 const input=inventory(['root.ts'],[['root.ts','nonroot.ts']],[file('nonroot.ts')]);const plan=planNativeReferences(input,{roots:1,ownedClosure:1});
 assert.deepEqual(plan.projects.flatMap(p=>p.owned).sort(),['nonroot.ts','root.ts']);assert(plan.projects.every(p=>p.owned.length<=600&&p.roots.length<=400));
});
test('larger, fractional or empty project limits cannot waive original resource or compiler acceptance boundaries',()=>{
 for(const limits of [{roots:401,ownedClosure:600},{roots:400,ownedClosure:601},{roots:0,ownedClosure:1},{roots:1.5,ownedClosure:1}])assert.throws(()=>planNativeReferences(inventory(['a.ts']),limits));
 assert.equal(REFERENCE_LIMITS.heapMiB,12288);assert.equal(REFERENCE_LIMITS.aggregateMs,720000);const p=planNativeReferences(inventory(['a.ts']));assert.equal(p.ordinaryCompilerQualified,false);assert.equal(p.releaseAuthorized,false);
});

test('global original declaration imports add native owner dependencies to every implementation consumer',()=>{
 const input=inventory(['a.ts','b.ts'],[['global.d.ts','b.ts']],[file('global.d.ts','declaration',{ambient:true})]);
 const plan=planNativeReferences(input,{roots:1,ownedClosure:1});assert(projectOf(plan,'b.ts')<projectOf(plan,'a.ts'));assert.deepEqual(plan.projects[projectOf(plan,'a.ts')].dependencies,[projectOf(plan,'b.ts')]);
});
