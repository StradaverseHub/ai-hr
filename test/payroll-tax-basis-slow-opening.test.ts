/** Production, 23 November 2026: one tax-basis batch opening held the exclusive payroll-history lock for up to 40 s,
 * and every payroll page waited behind it. The worker now logs where that time went, with ids and durations only. */
import {describe,expect,it} from 'vitest';
import {reportSlowTaxBasisOpening,TAX_BASIS_SLOW_LOCKED_MS} from '../lib/payroll-tax-basis-timing';

const previewId='22222222-2222-4222-8222-222222222222';

describe('reportSlowTaxBasisOpening',()=>{
 it('stays silent below the threshold',()=>{
  const lines:string[]=[];
  reportSlowTaxBasisOpening(previewId,'opened',TAX_BASIS_SLOW_LOCKED_MS-1,TAX_BASIS_SLOW_LOCKED_MS+500,{subjects:900},line=>lines.push(line));
  expect(lines).toEqual([]);
 });

 it('names the hold, outcome, preview and every timed part at or above the threshold',()=>{
  const lines:string[]=[];
  const laps={historyLockWait:120,accessLockWait:4,loadPreview:35,settings:12,subjects:18_400,selectedSubjects:17_900,rules:1_100,sourceRows:310,noTp3Opening:2_050};
  reportSlowTaxBasisOpening(previewId,'opened',39_914,40_034,laps,line=>lines.push(line));
  expect(lines).toHaveLength(1);
  const [line]=lines;
  expect(line).toContain('held the payroll-history lock for 39914 ms');
  expect(line).toContain('total 40034 ms');
  expect(line).toContain('outcome opened');
  expect(line).toContain(previewId);
  expect(JSON.parse(line.slice(line.indexOf('{')))).toEqual(laps);
 });
});
