import { describe, expect, it } from 'vitest';
import { promotionStandingReason, type TalentHistory } from '../packs/performance/onehr/talent-model';
const stars: TalentHistory[] = [2026, 2025, 2024].map(year => ({ year, category: 'Star' }));
describe('source promotion standing rules', () => {
 it('qualifies consecutive current years and higher categories', () => {
  expect(promotionStandingReason(stars, null, 2026)).toBe('3 years Star or above, no promotion');
  expect(promotionStandingReason(stars.map(h => ({...h,category:'Super Star'})), null, 2026)).not.toBeNull();
 });
 it('does not infer a missing year, a stale run, or an improvement year', () => {
  expect(promotionStandingReason(stars.slice(0,2),null,2026)).toBeNull();
  expect(promotionStandingReason(stars,null,2027)).toBeNull();
  expect(promotionStandingReason([{year:2026,category:'PIP/Improvement'},...stars.slice(1)],null,2026)).toBeNull();
 });
 it('excludes a promotion within the run but includes the preceding boundary year', () => {
  expect(promotionStandingReason(stars,'2024-01-01',2026)).toBeNull();
  expect(promotionStandingReason(stars,'2023-12-31',2026)).not.toBeNull();
 });
 it('preserves explicitly empty rules and custom rule order', () => {
  expect(promotionStandingReason(stars,null,2026,[])).toBeNull();
  expect(promotionStandingReason(stars,null,2026,[{years:2,minimum:'Solid Core'},{years:3,minimum:'Star'}])).toBe('2 years Solid Core or above, no promotion');
 });
});
