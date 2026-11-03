/** Spec v22 (the AI v2 Phase 1 release merge, coordinator decision of 3 November 2026): v20 plus the folded guidance
 * topics. Main's two administrator page guides are product_guidance topics (password_policy, correction_controls)
 * instead of v21's two extra tools, which put an HR administrator's biggest turn over the provider's 32-tool ceiling.
 * The deterministic parts: the version and its digest; every earlier digest kept; v22 is exactly v20 with
 * offer.guidanceTopics added (the v20-shaped spec hashes to v20's recorded digest); the topics are the ones the
 * product_guidance owner serves and declares in its input schema; and each topic runs the capability it replaces.
 * Pure; no provider, no database. */
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';
import {CONTEXT_TOOL_SPECS,GUIDANCE_TOPICS} from '../core/product-context/tools';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';

describe('spec v22',()=>{
 it('is version 22 with its digest recorded, and every earlier digest is kept',()=>{
  expect(HARNESS_SPEC.version).toBe(22);expect(HARNESS_SPEC_DIGESTS[22]).toBe(harnessSpecDigest());
  expect(HARNESS_SPEC_DIGESTS[22]).toBe('23c7a0b27b5d0029510b44935af4b07dd27d25aa34f1ff2607d0075f075e85d3');
  expect(HARNESS_SPEC_DIGESTS[21]).toBe('66e0ce979b02bce1309df6be3f2ea5eba7a61404d3c1c63b902084717bc3cd83');
  expect(HARNESS_SPEC_DIGESTS[20]).toBe('87f846496918cf773ce778eefb288b1a41bf4c518d8e1463b9aa4d91755bda04');
  expect(Object.keys(HARNESS_SPEC_DIGESTS).map(Number)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22]);
 });
 it('is v20 with only the guidance topics added: v20\'s three public context tools, and the v20-shaped spec hashes to v20',()=>{
  expect(HARNESS_SPEC.offer.publicContextTools).toEqual(['product_destinations','product_guidance','available_actions']);
  expect(HARNESS_SPEC.offer.guidanceTopics).toEqual(['password_policy','correction_controls']);
  const {guidanceTopics:_topics,...v20Offer}=HARNESS_SPEC.offer;
  expect(harnessSpecDigest({...HARNESS_SPEC,version:20,offer:v20Offer})).toBe(HARNESS_SPEC_DIGESTS[20]);
  expect(harnessSpecDigest({...HARNESS_SPEC,version:20})).not.toBe(HARNESS_SPEC_DIGESTS[20]);
 });
 it('names exactly the topics product_guidance serves and declares, each the capability it replaces as a tool',()=>{
  expect([...GUIDANCE_TOPICS]).toEqual([...HARNESS_SPEC.offer.guidanceTopics]);
  expect((CONTEXT_TOOL_SPECS.product_guidance.inputSchema as unknown as {properties:{topic:{enum:string[]}}}).properties.topic.enum).toEqual([...GUIDANCE_TOPICS]);
  expect((CONTEXT_TOOL_SPECS.product_guidance.inputSchema as unknown as {required:string[]}).required).toEqual(['query']);
  expect(TERAS_CAPABILITIES.filter(row=>row.topic).map(row=>[row.topic,row.name,row.admin,row.module])).toEqual([
   ['password_policy','password_policy_guidance',true,null],['correction_controls','correction_controls_guidance',true,'payroll']]);
 });
});
