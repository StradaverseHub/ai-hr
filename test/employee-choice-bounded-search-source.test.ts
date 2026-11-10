/** Whole-source inverse and preservation only; not native behavior or speed. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {z} from 'zod';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const digest=z.string().regex(/^[0-9a-f]{64}$/);
const schema=z.object({version:z.literal(1),kind:z.literal('WHOLE_BOUNDED_SEARCH_SOURCE_INVERSE_NOT_EXECUTION'),base:z.literal('c5e36cb03095527ba1fb6a0e8fc2bf54080f2c46'),baseline:z.object({path:z.literal('test/performance/employee-choice-native-purpose-reader.ts'),sha256:digest}).strict(),successor:z.object({path:z.literal('test/performance/employee-choice-bounded-search-reader.ts'),sha256:digest}).strict(),preserved:z.record(z.string(),digest),steps:z.array(z.discriminatedUnion('kind',[
 z.object({kind:z.literal('same'),text:z.string()}).strict(),z.object({kind:z.literal('change'),before:z.string(),after:z.string()}).strict(),
])).min(1).max(100)}).strict();
const patch=schema.parse(JSON.parse(readFileSync('test/fixtures/employee-choice-bounded-search-inverse.json','utf8')));
const baseline=readFileSync(patch.baseline.path,'utf8'),successor=readFileSync(patch.successor.path,'utf8');
function inverse(value:string){
 let offset=0,original='';
 for(const step of patch.steps){const text=step.kind==='same'?step.text:step.after;if(value.slice(offset,offset+text.length)!==text)throw Error('Exact whole reviewed successor required');offset+=text.length;original+=step.kind==='same'?text:step.before;}
 if(offset!==value.length||sha(value)!==patch.successor.sha256||sha(original)!==patch.baseline.sha256)throw Error('Whole reviewed source identity required');return original;
}
// The preserved owners were re-pinned from the 693af41de slice to the integrated release bytes the
// bounded native controls now execute against. Each change is an intended later commit:
// core/employee-choice.ts ba36e359f, fb5710607, e52a55f4c, 9e32ad8ec, bd5f6dffc, ea84770aa;
// core/personnel-private-search.ts 47f1434e0, 129ea7ecf and the 9e04300eb Board 3 composition;
// exact-ASCII purpose SQL, owner factory and runtime ba36e359f; native purpose owner factory 30176ff6d;
// core/ai-principal.ts f283c2e7b. The successor and classic reader bytes themselves are unchanged.
it('inverts every successor byte to the complete frozen classic reader and preserves each authority/SQL/runtime owner',()=>{
 expect(sha(baseline)).toBe(patch.baseline.sha256);expect(inverse(successor)).toBe(baseline);
 for(const [path,hash]of Object.entries(patch.preserved))expect(sha(readFileSync(path,'utf8')),path).toBe(hash);
});
it('refuses changed matching/order/population/projection limits and any additional or missing source byte',()=>{
 for(const token of ['order by f.phase','row.name.toLowerCase().includes(q)',"captureInput(p)",'total>=offset&&matchedIds.length<limit','{...prepared,offset:0}',"counts[0].total!==matchedIds.length",'assertAiPresentationPrincipalTx(tx,ctx)']){
  expect(successor).toContain(token);expect(()=>inverse(successor.replace(token,token+'/* unreviewed */'))).toThrow();
 }
 expect(()=>inverse(successor+'\n')).toThrow();expect(()=>inverse(successor.slice(1))).toThrow();
});
it('retains the complete-ID helper byte for byte and declares exactly six real native controls',()=>{
 const marker='export async function readEmployeeChoiceIdsTx';expect(successor.slice(successor.indexOf(marker))).toBe(baseline.slice(baseline.indexOf(marker)));
 const native=readFileSync('test/employee-choice-bounded-search-native.test.ts','utf8');expect(native.match(/^it\('/gm)).toHaveLength(6);
 expect(native).not.toMatch(/\b(?:it|describe)\.(?:skip|todo|only)\b|\b(?:it|test)\.skipIf\b/);
 expect(native).toContain('projectionIds(statements)');expect(native).toContain('Number.MAX_SAFE_INTEGER');expect(native).toContain('await value.restoration()');
});
