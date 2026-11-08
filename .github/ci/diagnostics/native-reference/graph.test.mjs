/** Pure ownership graph models, never native compiler qualification. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planNativeReferences,dependencyOrder,REFERENCE_LIMITS,configuredNativeRoots} from './graph.mjs';
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
 assert.throws(()=>planNativeReferences(input,{roots:1,ownedClosure:1}),/Oversized native SCC or required context/);
 const plan=planNativeReferences(input,{roots:2,ownedClosure:1});assert(projectOf(plan,'b.ts')<projectOf(plan,'a.ts'));assert.deepEqual(plan.projects[1].dependencies,[0]);
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
 assert.throws(()=>planNativeReferences(input,{roots:1,ownedClosure:1}),/Oversized native SCC or required context/);
 const plan=planNativeReferences(input,{roots:2,ownedClosure:1});assert(plan.projects.every(p=>p.context.includes('global.d.ts')));assert.equal(plan.rootOwners.filter(row=>row.root==='global.d.ts').length,1);
});
test('JSON stays an explicit native context, not an invented declaration or duplicate implementation owner',()=>{
 const input=inventory(['a.ts','b.ts'],[['a.ts','data.json'],['b.ts','a.ts']],[file('data.json','json')]);
 assert.throws(()=>planNativeReferences(input,{roots:1,ownedClosure:1}),/Oversized native SCC or required context/);
 const plan=planNativeReferences(input,{roots:2,ownedClosure:1});const a=plan.projects[projectOf(plan,'a.ts')],b=plan.projects[projectOf(plan,'b.ts')];
 assert(a.context.includes('data.json'));assert(!b.context.includes('data.json'));assert.deepEqual(plan.projects.flatMap(p=>p.owned).sort(),['a.ts','b.ts']);
});
test('every nonroot implementation remains owned exactly once inside fixed per-project envelopes',()=>{
 const input=inventory(['root.ts'],[['root.ts','nonroot.ts']],[file('nonroot.ts')]);const plan=planNativeReferences(input,{roots:1,ownedClosure:1});
 assert.deepEqual(plan.projects.flatMap(p=>p.owned).sort(),['nonroot.ts','root.ts']);assert(plan.projects.every(p=>p.owned.length<=600&&p.configuredRoots.length<=1));
});
test('larger, fractional or empty project limits cannot waive original resource or compiler acceptance boundaries',()=>{
 for(const limits of [{roots:401,ownedClosure:600},{roots:400,ownedClosure:601},{roots:0,ownedClosure:1},{roots:1.5,ownedClosure:1}])assert.throws(()=>planNativeReferences(inventory(['a.ts']),limits));
 assert.equal(REFERENCE_LIMITS.heapMiB,12288);assert.equal(REFERENCE_LIMITS.aggregateMs,720000);const p=planNativeReferences(inventory(['a.ts']));assert.equal(p.ordinaryCompilerQualified,false);assert.equal(p.releaseAuthorized,false);
});

test('global original declaration imports add native owner dependencies to every implementation consumer',()=>{
 const input=inventory(['a.ts','b.ts'],[['global.d.ts','b.ts']],[file('global.d.ts','declaration',{ambient:true})]);
 assert.throws(()=>planNativeReferences(input,{roots:1,ownedClosure:1}),/Oversized native SCC or required context/);
 const plan=planNativeReferences(input,{roots:2,ownedClosure:1});assert(projectOf(plan,'b.ts')<projectOf(plan,'a.ts'));assert.deepEqual(plan.projects[projectOf(plan,'a.ts')].dependencies,[projectOf(plan,'b.ts')]);
});

test('all nonroot SCC members count as configured roots independently of the larger owned-closure cap',()=>{
 const names=Array.from({length:401},(_,i)=>'nonroot-'+i+'.ts'),input={roots:[names[0]],buildRoots:[names[0]],files:names.map(name=>file(name)),edges:names.map((from,i)=>({from,to:names[(i+1)%names.length]}))};
 assert.throws(()=>planNativeReferences(input),/Oversized native SCC or required context/);
 const small=inventory(['a.ts','b.ts','c.ts'],[['a.ts','b.ts'],['b.ts','c.ts'],['c.ts','a.ts']]);
 assert.throws(()=>planNativeReferences(small,{roots:4,ownedClosure:2}),/Oversized native SCC/);
});
test('required ambient/declaration/JSON context cannot be omitted to make an indivisible component fit',()=>{
 const input=inventory(['a.ts'],[['a.ts','nonroot.ts'],['nonroot.ts','a.ts'],['nonroot.ts','data.json']],[file('nonroot.ts'),file('global.d.ts','declaration',{ambient:true}),file('data.json','json')]);
 assert.throws(()=>planNativeReferences(input,{roots:3,ownedClosure:2}),/Oversized native SCC or required context/);
 const plan=planNativeReferences(input,{roots:4,ownedClosure:2});assert.deepEqual(new Set(plan.projects[0].configuredRoots),new Set(['a.ts','nonroot.ts','global.d.ts','data.json']));
 const globals=Array.from({length:400},(_,i)=>file('global-'+i+'.d.ts','declaration',{ambient:true}));
 assert.throws(()=>planNativeReferences(inventory(['entry.ts'],[],globals)),/Oversized native SCC or required context/);
});
test('context union determines packing without crossing another implementation owner or double-counting shared context',()=>{
 const input=inventory(['a.ts','b.ts'],[['a.ts','a.json'],['b.ts','b.json']],[file('a.json','json'),file('b.json','json')]);
 const split=planNativeReferences(input,{roots:3,ownedClosure:2});assert.equal(split.projects.length,2);assert(split.projects.every(p=>p.configuredRoots.length===2));
 const shared=inventory(['a.ts','b.ts'],[['a.ts','shared.json'],['b.ts','shared.json']],[file('shared.json','json')]);
 const merged=planNativeReferences(shared,{roots:3,ownedClosure:2});assert.equal(merged.projects.length,1);assert.equal(merged.projects[0].configuredRoots.length,3);
 const crossed=inventory(['a.ts','b.ts'],[['a.ts','b.ts'],['b.ts','b.json']],[file('b.json','json')]);
 const boundary=planNativeReferences(crossed,{roots:2,ownedClosure:1});assert(!boundary.projects[projectOf(boundary,'a.ts')].context.includes('b.json'));
});
test('configured membership preserves original order and rejects aliases, duplicate contexts and hidden implementation inputs',()=>{
 const records=[file('a.ts'),file('nonroot.ts'),file('global.d.ts','declaration'),file('data.json','json')];
 assert.deepEqual(configuredNativeRoots(['global.d.ts','a.ts'],['nonroot.ts','a.ts'],['data.json','global.d.ts'],records),['global.d.ts','a.ts','nonroot.ts','data.json']);
 for(const alias of ['.','a/./b.ts','a/../b.ts','a//b.ts','./a.ts'])assert.throws(()=>planNativeReferences(inventory([alias])));
 assert.throws(()=>configuredNativeRoots(['a.ts'],['a.ts'],['global.d.ts','global.d.ts'],records));
 assert.throws(()=>configuredNativeRoots(['a.ts'],['a.ts'],['nonroot.ts'],records));
});
