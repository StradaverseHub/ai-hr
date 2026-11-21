import {describe,expect,it} from 'vitest';
import {latestApplicableMovementCandidates} from '../lib/movement-latest-applicable';
describe('latest applicable movement by business date',()=>{
 it('ignores entry order, future intents and compensated events',()=>{
  const rows=[{id:'current',effectiveDate:'2026-08-01',status:'applied'},{id:'future',effectiveDate:'2026-12-01',status:'pending'},{id:'deleted',effectiveDate:'2026-09-01',status:'reversed'},{id:'backdated-last',effectiveDate:'2026-02-01',status:'applied'}];
  expect(latestApplicableMovementCandidates(rows,'2026-11-17').map(row=>row.id)).toEqual(['current']);
  expect(latestApplicableMovementCandidates([...rows].reverse(),'2026-11-17').map(row=>row.id)).toEqual(['current']);
 });
 it('returns every same-day candidate for explicit resolution instead of choosing by entry time',()=>{
  expect(latestApplicableMovementCandidates([{id:'a',effectiveDate:'2026-10-01',status:'applied'},{id:'b',effectiveDate:'2026-10-01',status:'applied'}],'2026-11-17').map(row=>row.id)).toEqual(['a','b']);
  expect(latestApplicableMovementCandidates([{id:'future',effectiveDate:'2026-12-01',status:'pending'}],'2026-11-17')).toEqual([]);
 });
});
