/** Spec v21 (the AI v2 Phase 1 release merge of main 848c7be36): v20 plus main's two administrator-only, literal public
 * page guides, password_policy_guidance and correction_controls_guidance, as context a gated turn keeps (main's own v9).
 * The deterministic parts: the version and its digest; every earlier digest kept; and v21 is exactly v20 with those two
 * tools added, nothing else (the v20-shaped object hashes to v20's recorded digest). Pure; no provider, no database. */
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';

const V20_PUBLIC_CONTEXT=['product_destinations','product_guidance','available_actions'];
const MAIN_GUIDES=['password_policy_guidance','correction_controls_guidance'];

describe('spec v21',()=>{
 it('is version 21 with its digest recorded, and every earlier digest is kept',()=>{
  expect(HARNESS_SPEC.version).toBe(21);expect(HARNESS_SPEC_DIGESTS[21]).toBe(harnessSpecDigest());
  expect(HARNESS_SPEC_DIGESTS[21]).toBe('66e0ce979b02bce1309df6be3f2ea5eba7a61404d3c1c63b902084717bc3cd83');
  expect(HARNESS_SPEC_DIGESTS[20]).toBe('87f846496918cf773ce778eefb288b1a41bf4c518d8e1463b9aa4d91755bda04');
  expect(HARNESS_SPEC_DIGESTS[19]).toBe('44e9708772ac71c0fcdc29b117769b34424fb21f4d5e1f45d1a3fe4795046b7c');
  expect(Object.keys(HARNESS_SPEC_DIGESTS).map(Number)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21]);
 });
 it('keeps main\'s two admin guides as gated-turn context, after v20\'s three public tools',()=>{
  expect(HARNESS_SPEC.offer.publicContextTools).toEqual([...V20_PUBLIC_CONTEXT,...MAIN_GUIDES]);
  expect(HARNESS_SPEC.offer.publicContextTools).not.toContain('product_capabilities');
 });
 it('is v20 with only those two tools added: the v20-shaped spec hashes to v20\'s recorded digest',()=>{
  const v20={...HARNESS_SPEC,version:20,offer:{...HARNESS_SPEC.offer,publicContextTools:V20_PUBLIC_CONTEXT}};
  expect(harnessSpecDigest(v20)).toBe(HARNESS_SPEC_DIGESTS[20]);
  // Either change alone is not v20: the tools and the version both move.
  expect(harnessSpecDigest({...v20,version:21})).not.toBe(HARNESS_SPEC_DIGESTS[21]);
  expect(harnessSpecDigest({...HARNESS_SPEC,version:20})).not.toBe(HARNESS_SPEC_DIGESTS[20]);
 });
});
