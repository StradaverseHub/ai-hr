/** Public organisation guidance is a topic of the existing context tool, never an effect or private workflow read. */
import {expect,it} from 'vitest';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,HARNESS_SPEC_STAGING_V24_ORGANISATION_DIGEST,harnessSpecDigest} from '../core/harness/spec';
import {GUIDANCE_TOPICS,CONTEXT_TOOL_SPECS} from '../core/product-context/tools';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {TERAS_READS,terasEntity} from '../core/semantic-model/generate';
import {KIT_CAPABILITIES} from '../core/improvement/kit-registry';
import {v24OrganisationShapedSpec,v25ShapedSpec,v26ShapedSpec,v27ShapedSpec} from './harness-spec-shapes';
it('merges main v25 and preserves the parallel deployed v24 digest',()=>{
 const v25=v25ShapedSpec();
 expect(v26ShapedSpec().version).toBe(26);
 expect(harnessSpecDigest(v26ShapedSpec())).toBe(HARNESS_SPEC_DIGESTS[26]);
 expect(harnessSpecDigest(v25)).toBe(HARNESS_SPEC_DIGESTS[25]);
 expect(harnessSpecDigest(v24OrganisationShapedSpec())).toBe(HARNESS_SPEC_STAGING_V24_ORGANISATION_DIGEST);
 expect(HARNESS_SPEC_STAGING_V24_ORGANISATION_DIGEST).toBe('3a76dffa0b7ae5c61c55a631e38bdf8d937a6b8955ef8f2f0a12b835ffb64a18');
 expect(HARNESS_SPEC_STAGING_V24_ORGANISATION_DIGEST).not.toBe(HARNESS_SPEC_DIGESTS[24]);
 expect(v26ShapedSpec()).toEqual({...v25,version:26,offer:{...v25.offer,guidanceTopics:[...v25.offer.guidanceTopics,'organisation_tagging']}});
});
it('registers one literal public topic with no input handles or additional provider binding',()=>{
 expect(GUIDANCE_TOPICS).toEqual(HARNESS_SPEC.offer.guidanceTopics);
 expect(CONTEXT_TOOL_SPECS.product_guidance.inputSchema).toMatchObject({properties:{topic:{enum:['password_policy','correction_controls','organisation_tagging','reward_reviews']}}});
 const read=TERAS_READS.find(row=>row.name==='organisation_tagging_guidance')!;expect(read.input).toEqual([]);
 const entity=terasEntity(read.entity);expect(entity).toMatchObject({module:null,audience:'admin',page:'/admin/organization/organisation-tagging',owners:['core/explainers/capabilities.ts#organisationTaggingGuidance']});
 expect(entity.fields.map(field=>field.name)).toEqual(['page','purpose','navigation','humanBoundary','provenance']);
 expect(TERAS_CAPABILITIES.find(row=>row.name===read.name)).toMatchObject({topic:'organisation_tagging',admin:true,module:null,worker:null});
 expect(KIT_CAPABILITIES.some(row=>row.declaration.name===read.name)).toBe(true);
});

it('v28 retires the Attendance formula topics and keeps the previous spec digest',()=>{
 const previous=v27ShapedSpec();
 expect(harnessSpecDigest(previous)).toBe(HARNESS_SPEC_DIGESTS[27]);
 expect(HARNESS_SPEC).toEqual({...previous,version:28,offer:{...previous.offer,guidanceTopics:[...v26ShapedSpec().offer.guidanceTopics,'reward_reviews']}});
 expect(harnessSpecDigest()).toBe(HARNESS_SPEC_DIGESTS[28]);
});
