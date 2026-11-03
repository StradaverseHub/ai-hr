/** Spec v21 (the AI v2 Phase 1 release merge of main 848c7be36): v20 plus main's two administrator-only, literal public
 * page guides, password_policy_guidance and correction_controls_guidance, as gated-turn context tools (main's own v9).
 * Superseded by v22, which serves the same guides as product_guidance topics (test/harness-spec-v22.test.ts). Its digest
 * stays recorded, and it is still exactly v20 with those two tools added: the current spec, reshaped to v21, hashes to it.
 * Pure; no provider, no database. */
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';

const V20_PUBLIC_CONTEXT=['product_destinations','product_guidance','available_actions'];
const MAIN_GUIDES=['password_policy_guidance','correction_controls_guidance'];

describe('spec v21',()=>{
 it('keeps its digest recorded after v20, before v22',()=>{
  expect(HARNESS_SPEC_DIGESTS[21]).toBe('66e0ce979b02bce1309df6be3f2ea5eba7a61404d3c1c63b902084717bc3cd83');
  expect(HARNESS_SPEC_DIGESTS[20]).toBe('87f846496918cf773ce778eefb288b1a41bf4c518d8e1463b9aa4d91755bda04');
  expect(HARNESS_SPEC.version).toBeGreaterThan(21);
 });
 it('was v20 with only the two guide tools added: the v21-shaped spec hashes to v21\'s recorded digest',()=>{
  const {guidanceTopics:_topics,...v20Offer}=HARNESS_SPEC.offer;
  expect(v20Offer.publicContextTools).toEqual(V20_PUBLIC_CONTEXT);
  expect(harnessSpecDigest({...HARNESS_SPEC,version:20,offer:v20Offer})).toBe(HARNESS_SPEC_DIGESTS[20]);
  expect(harnessSpecDigest({...HARNESS_SPEC,version:21,offer:{...v20Offer,publicContextTools:[...V20_PUBLIC_CONTEXT,...MAIN_GUIDES]}})).toBe(HARNESS_SPEC_DIGESTS[21]);
 });
});
