/** ADR 0181 J2, imports: the adaptive size of a set-based import group (core/import-set-group.ts). Pure rules, no
 * database. */
import {describe,expect,it} from 'vitest';
import {nextImportGroupSize,rememberImportGroupPass} from '../core/import-set-group';

const limits={max:64,targetMs:200,ceilingMs:400,fixedMultiple:2};

describe('the next set-based import group size',()=>{
 it('doubles from the first group while its own rate stays under the ceiling',()=>{
  expect(nextImportGroupSize([{rows:16,wallMs:40}],16,limits)).toBe(32);
  // 16 rows in 300 ms: 21 rows would reach the 400 ms ceiling at that rate.
  expect(nextImportGroupSize([{rows:16,wallMs:300}],16,limits)).toBe(21);
 });
 it('fills the target from a straight line through two groups of different sizes',()=>{
  // Fixed 20 ms, 2 ms a row: (200 - 20) / 2 = 90 rows, capped at double the last group and at the maximum.
  expect(nextImportGroupSize([{rows:16,wallMs:52},{rows:32,wallMs:84}],32,limits)).toBe(64);
  expect(nextImportGroupSize([{rows:16,wallMs:52},{rows:32,wallMs:84}],32,{...limits,max:200})).toBe(64);
  expect(nextImportGroupSize([{rows:32,wallMs:84},{rows:64,wallMs:148}],64,{...limits,max:200})).toBe(90);
 });
 it('spreads a large fixed cost, but never past the ceiling',()=>{
  // Fixed 150 ms, 5 ms a row: the target becomes 2 x 150 = 300 ms, so (300 - 150) / 5 = 30 rows.
  expect(nextImportGroupSize([{rows:8,wallMs:190},{rows:16,wallMs:230}],16,limits)).toBe(30);
  // Fixed 300 ms: 2 x 300 would exceed the 400 ms ceiling, so (400 - 300) / 5 = 20 rows.
  expect(nextImportGroupSize([{rows:8,wallMs:340},{rows:16,wallMs:380}],16,limits)).toBe(20);
 });
 it('never goes below two rows, and a line that does not rise falls back to growth',()=>{
  expect(nextImportGroupSize([{rows:8,wallMs:900},{rows:16,wallMs:1800}],16,limits)).toBe(2);
  expect(nextImportGroupSize([{rows:8,wallMs:80},{rows:16,wallMs:60}],16,limits)).toBe(32);
 });
 it('keeps the last two passes of different sizes',()=>{
  expect(rememberImportGroupPass([{rows:16,wallMs:40},{rows:32,wallMs:70}],{rows:16,wallMs:45})).toEqual([{rows:32,wallMs:70},{rows:16,wallMs:45}]);
  expect(rememberImportGroupPass([{rows:16,wallMs:40}],{rows:32,wallMs:70})).toEqual([{rows:16,wallMs:40},{rows:32,wallMs:70}]);
 });
});
