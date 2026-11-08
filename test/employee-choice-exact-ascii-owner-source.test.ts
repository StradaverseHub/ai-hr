/** Source provenance only. Native equivalence and bounded cleanup need the
 * separate actual9-case qualification; this change map grants neither. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {z} from 'zod';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const baseline=readFileSync('test/fixtures/employee-choice-exact-ascii-owner-76b.source','utf8');
const factory=readFileSync('test/performance/employee-choice-exact-ascii-owner-factory.ts','utf8');
const patch=z.object({version:z.literal(1),kind:z.literal('REVIEWABLE_SOURCE_PROVENANCE_NOT_NATIVE_EQUIVALENCE'),baselineSha256:z.string().length(64),factorySha256:z.string().length(64),steps:z.array(z.discriminatedUnion('kind',[
 z.object({kind:z.literal('same'),text:z.string()}).strict(),z.object({kind:z.literal('change'),before:z.string(),after:z.string()}).strict(),
])).min(1).max(1000)}).strict().parse(JSON.parse(readFileSync('test/fixtures/employee-choice-exact-ascii-owner-inverse.json','utf8')));
function inverse(actual:string){
 let offset=0,result='';for(const step of patch.steps){const next=step.kind==='same'?step.text:step.after;if(actual.slice(offset,offset+next.length)!==next)throw Error('Exact reviewed source chunk required');offset+=next.length;result+=step.kind==='same'?step.text:step.before;}
 if(offset!==actual.length||sha(actual)!==patch.factorySha256||sha(result)!==patch.baselineSha256)throw Error('Complete reviewed source identity required');return result;
}
it('inverts EVERY factory byte through an explicit reviewed change map to the complete frozen76b source',()=>{
 expect(sha(baseline)).toBe('44c648ef808dc2a3db73480e315ed93b8830b4dd339980ac205af509ea7d3784');expect(patch.steps).toHaveLength(13);expect(inverse(factory)).toBe(baseline);
});
it('refuses changed guards, phase budgets, full native witnesses, and additional unreviewed bytes',()=>{
 for(const before of ["key!=='prosrc'","statement_timeout='1s'",'expect(current).toEqual(candidate);','adopt(custody,\'candidate\');']){expect(factory).toContain(before);expect(()=>inverse(factory.replace(before,before+'/* changed */'))).toThrow();}
 expect(()=>inverse(factory+'\n')).toThrow();
});
it('retains the public dynamic legacy wrapper and its failure restoration without granting it bounded-native evidence',()=>{
 expect(readFileSync('test/performance/employee-choice-exact-ascii-owner.ts','utf8')).toBe(`/** Legacy dynamic default binding; bounded callers use the private factory. */
import {owner} from '../harness';
import {exactAsciiEmployeeChoiceOwner,type ExactAsciiOwnership} from './employee-choice-exact-ascii-owner-factory';
import {preserveDiagnosticFailure} from './employee-choice-native-purpose-session';
const legacy=exactAsciiEmployeeChoiceOwner(()=>owner.client,()=> 'work');
export async function installExactAsciiEmployeeChoicePrototype(){
 let custody:ExactAsciiOwnership|undefined;
 try{return await legacy.install(value=>{custody=value;});}
 catch(error){await preserveDiagnosticFailure(async()=>{throw error;},async()=>{await custody?.remove();});throw error;}
}
`);
});
