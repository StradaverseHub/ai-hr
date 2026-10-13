import { describe, expect, it } from 'vitest';
import golden from './fixtures/onehr/source-golden.json';
import { sourceFigure, sourceRound } from '../packs/performance/onehr/source-numeric';
describe('source numeric display parity',()=>{
 it('matches the isolated source export function, including binary64 halfway cases',()=>{
  expect(golden.ratingFigures.length).toBeGreaterThan(20);
  for(const c of golden.ratingFigures)expect(sourceFigure(c.value,c.mechanism==='B'?1:2),JSON.stringify(c)).toBe(c.expected);
 });
 it('uses the source’s even-integer tie for positive and negative percentages',()=>{
  expect([12.5,37.5,62.5,87.5,-1.5,-2.5].map(sourceRound)).toEqual([12,38,62,88,-2,-2]);
 });
});
