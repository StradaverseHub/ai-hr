/** Public organisation guidance is a topic of the existing context tool, never an effect or private workflow read. */
import {expect,it} from 'vitest';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';
import {GUIDANCE_TOPICS,CONTEXT_TOOL_SPECS} from '../core/product-context/tools';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {TERAS_READS,terasEntity} from '../core/semantic-model/generate';
import {KIT_CAPABILITIES} from '../core/improvement/kit-registry';
import {v23ShapedSpec} from './harness-spec-shapes';
it('appends v24 and retains the exact v23 declaration and digest',()=>{
 expect(HARNESS_SPEC.version).toBe(24);expect(harnessSpecDigest()).toBe(HARNESS_SPEC_DIGESTS[24]);
 expect(harnessSpecDigest(v23ShapedSpec())).toBe('0052cefe8d066154db37c62bc213dfb26eabcbe0cc861577103212d6e4e5f0c5');
 expect(HARNESS_SPEC_DIGESTS[23]).toBe(harnessSpecDigest(v23ShapedSpec()));
 expect(Object.keys(HARNESS_SPEC_DIGESTS).map(Number)).toEqual(Array.from({length:24},(_,index)=>index+1));
 expect({...HARNESS_SPEC,version:23,offer:{...HARNESS_SPEC.offer,guidanceTopics:['password_policy','correction_controls']}}).toEqual(v23ShapedSpec());
});
it('registers one literal public topic with no input handles or additional provider binding',()=>{
 expect(GUIDANCE_TOPICS).toEqual(HARNESS_SPEC.offer.guidanceTopics);
 expect(CONTEXT_TOOL_SPECS.product_guidance.inputSchema).toMatchObject({properties:{topic:{enum:['password_policy','correction_controls','organisation_tagging']}}});
 const read=TERAS_READS.find(row=>row.name==='organisation_tagging_guidance')!;expect(read.input).toEqual([]);
 const entity=terasEntity(read.entity);expect(entity).toMatchObject({module:null,audience:'admin',page:'/admin/organization/organisation-tagging',owners:['core/explainers/capabilities.ts#organisationTaggingGuidance']});
 expect(entity.fields.map(field=>field.name)).toEqual(['page','purpose','navigation','humanBoundary','provenance']);
 expect(TERAS_CAPABILITIES.find(row=>row.name===read.name)).toMatchObject({topic:'organisation_tagging',admin:true,module:null,worker:null});
 expect(KIT_CAPABILITIES.some(row=>row.declaration.name===read.name)).toBe(true);
});
