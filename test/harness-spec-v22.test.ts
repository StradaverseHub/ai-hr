/** Spec v22 (the AI v2 Phase 1 release merge, coordinator decision of 3 November 2026): v20 plus the folded guidance
 * topics. Superseded by v23 (test/harness-spec-v23.test.ts); its digest stays recorded and the v22-shaped spec (v23's
 * changes reverted, test/harness-spec-shapes.ts) still hashes to it. Main's two administrator page guides are product_guidance topics (password_policy, correction_controls)
 * instead of v21's two extra tools, which put an HR administrator's biggest turn over the provider's 32-tool ceiling.
 * The deterministic parts: the version and its digest; every earlier digest kept; v22 is exactly v20 with
 * offer.guidanceTopics added (the v20-shaped spec hashes to v20's recorded digest); the topics are the ones the
 * product_guidance owner serves and declares in its input schema; and each topic runs the capability it replaces.
 * Pure; no provider, no database. */
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';
import {CONTEXT_TOOL_SPECS,GUIDANCE_TOPICS} from '../core/product-context/tools';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {v22ShapedSpec} from './harness-spec-shapes';

describe('spec v22',()=>{
 it('keeps its digest recorded after v21, before v23, and every earlier digest',()=>{
  expect(HARNESS_SPEC.version).toBeGreaterThan(22);expect(HARNESS_SPEC_DIGESTS[22]).toBe(harnessSpecDigest(v22ShapedSpec()));
  expect(HARNESS_SPEC_DIGESTS[22]).toBe('23c7a0b27b5d0029510b44935af4b07dd27d25aa34f1ff2607d0075f075e85d3');
  expect(HARNESS_SPEC_DIGESTS[21]).toBe('66e0ce979b02bce1309df6be3f2ea5eba7a61404d3c1c63b902084717bc3cd83');
  expect(HARNESS_SPEC_DIGESTS[20]).toBe('87f846496918cf773ce778eefb288b1a41bf4c518d8e1463b9aa4d91755bda04');
  expect(Object.keys(HARNESS_SPEC_DIGESTS).map(Number).slice(0,22)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22]);
 });
 it('is v20 with only the guidance topics added: v20\'s three public context tools, and the v20-shaped spec hashes to v20',()=>{
  expect(HARNESS_SPEC.offer.publicContextTools).toEqual(['product_destinations','product_guidance','available_actions']);
  expect(HARNESS_SPEC.offer.guidanceTopics).toEqual(['password_policy','correction_controls']);
  const v22=v22ShapedSpec(),{guidanceTopics:_topics,...v20Offer}=v22.offer;
  expect(harnessSpecDigest({...v22,version:20,offer:v20Offer})).toBe(HARNESS_SPEC_DIGESTS[20]);
  expect(harnessSpecDigest({...v22,version:20})).not.toBe(HARNESS_SPEC_DIGESTS[20]);
 });
 it('names exactly the topics product_guidance serves and declares, each the capability it replaces as a tool',()=>{
  expect([...GUIDANCE_TOPICS]).toEqual([...HARNESS_SPEC.offer.guidanceTopics]);
  expect((CONTEXT_TOOL_SPECS.product_guidance.inputSchema as unknown as {properties:{topic:{enum:string[]}}}).properties.topic.enum).toEqual([...GUIDANCE_TOPICS]);
  expect((CONTEXT_TOOL_SPECS.product_guidance.inputSchema as unknown as {required:string[]}).required).toEqual(['query']);
  expect(TERAS_CAPABILITIES.filter(row=>row.topic).map(row=>[row.topic,row.name,row.admin,row.module])).toEqual([
   ['password_policy','password_policy_guidance',true,null],['correction_controls','correction_controls_guidance',true,'payroll']]);
 });
});
