import { describe, expect, it } from 'vitest';
import golden from './fixtures/onehr/source-golden.json';
import { sourceFigure, sourceRound,sourceGroupedFigure } from '../packs/performance/onehr/source-numeric';
describe('source numeric display parity',()=>{
 it('retains fractional evidence figures while grouping whole units like the source',()=>{
  expect([5150000,5150000.25,100.12345,-1234.5,.0000001,-.00001,0].map(sourceGroupedFigure)).toEqual(['5,150,000','5,150,000.25','100.12345','-1,234.5','1e-07','-1e-05','0']);
 });
 it('matches the isolated source export function, including binary64 halfway cases',()=>{
  expect(golden.ratingFigures.length).toBeGreaterThan(20);
  for(const c of golden.ratingFigures)expect(sourceFigure(c.value,c.mechanism==='B'?1:2),JSON.stringify(c)).toBe(c.expected);
 });
 it('uses the source’s even-integer tie for positive and negative percentages',()=>{
  expect([12.5,37.5,62.5,87.5,-1.5,-2.5].map(sourceRound)).toEqual([12,38,62,88,-2,-2]);
 });
});
