/** Pure optional-control contracts only; not database/provider enforcement evidence. */
import {describe,it,expect} from 'vitest';
import {optionalUsdToNanos,usdToNanos,requiresAiTaskRoot,requiresStrictAiSpend,STRICT_AI_SPEND_FEATURES} from '../lib/ai/spend-allocation';
describe('explicit optional USD policy',()=>{
 it.each(['',' ','\t\n'])('blank %j is no additional monetary threshold, never a numeric zero',value=>expect(optionalUsdToNanos(value)).toBeNull());
 it.each([['0',BigInt("0")],[' 0 ',BigInt("0")],['0.000000001',BigInt("1")],['1.000000001',BigInt("1000000001")],['9223372036.854775807',BigInt("9223372036854775807")]] as const)('preserves finite %s exactly including zero', (value,expected)=>expect(optionalUsdToNanos(value)).toBe(expected));
 it.each(['-1','Infinity','1e3','0.0000000001','9223372036.854775808','1.','NaN'])('malformed %s cannot turn into unlimited',value=>expect(()=>optionalUsdToNanos(value)).toThrow());
 it('retains old strict numeric parser and all actual native-root requirements',()=>{
  expect(()=>usdToNanos('')).toThrow();expect(()=>usdToNanos(' 1')).toThrow();expect(usdToNanos('0')).toBe(BigInt("0"));
  expect(STRICT_AI_SPEND_FEATURES).toHaveLength(8);for(const feature of STRICT_AI_SPEND_FEATURES){expect(requiresAiTaskRoot(feature)).toBe(true);expect(requiresStrictAiSpend(feature)).toBe(true);}
  expect(requiresAiTaskRoot('pay_rule_draft')).toBe(false);
 });
});
