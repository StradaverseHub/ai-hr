import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import golden from './fixtures/onehr/source-golden.json';
import { buildRatingRecordWorkbook } from '../packs/performance/onehr/rating-record-xlsx';
import { ratingRecordExportRow, ratingRecordHeaders, type RatingRecord } from '../packs/performance/onehr/rating-record-model';
const recordedAt=new Date();
const record:RatingRecord={reviewId:'review',lastEvent:'calibration_lock_or_reopen',recordedAt,frozenAt:null,snapshot:{employeeId:'000001',name:'=UNTRUSTED()',businessGroup:'Group',company:'Company',department:'Operations',grade:'12',title:'Engineer',mechanism:'B',selfScore:125.568,selfBand:'AE',weightCovered:7500,weightTotal:10000,managerScore:121.378,managerBand:'AE',performance:'OU',performanceSource:'bg',leadershipScore:17.5,leadershipMax:35,submitted:4,valid:true,competencyStatus:'reviewed',competencySelf:1,competencyReviewed:2.5,competencyMax:2.5,potentialScore:30,potentialMax:37.5,potential360Pct:50,potentialCompetencyPct:100,potentialBasis:'combined',computedPotential:'High',potential:'High',potentialSource:'manager',tiers:{bg:{performance:'OU',potential:'High'}},configuration:{lowMaxPct:40,midMaxPct:74,weight360:4000}}};
describe('Source rating record Excel contract',()=>{
 it('preserves all43 source headers and partial PM coverage beside its score',()=>{
  expect(ratingRecordHeaders).toEqual(golden.ratingExportHeaders);expect(ratingRecordHeaders).toHaveLength(43);
  const row=ratingRecordExportRow(record);expect(row).toHaveLength(43);
  expect(ratingRecordExportRow({...record,snapshot:{...record.snapshot,weightCovered:7450}})[10]).toBe(74);
  expect(row[8]).toBe(125.6);expect(row[10]).toBe(75);expect(row[11]).toBe(121.4);
  expect(row[28]).toBe(30);expect(row[29]).toBe(37.5);expect(row[40]).toBe(recordedAt.toISOString());
 });
 it('writes a real two-sheet workbook, literal names, leading zeros, and explanatory scope',()=>{
  const bytes=buildRatingRecordWorkbook({cycle:'Annual review',scope:'Company: Company',records:[record],generatedAt:recordedAt});
  expect(bytes.subarray(0,2).toString()).toBe('PK');
  const workbook=XLSX.read(bytes,{type:'buffer'});expect(workbook.SheetNames).toEqual(['Ratings','About']);
  const rows=XLSX.utils.sheet_to_json<(string|number)[]>(workbook.Sheets.Ratings,{header:1});
  expect(rows[0]).toEqual(golden.ratingExportHeaders);expect(rows[1][0]).toBe('000001');expect(rows[1][1]).toBe("'=UNTRUSTED()");
  expect(workbook.Sheets.Ratings.B2.f).toBeUndefined();expect(rows[1][28]).toBe(30);
  const about=XLSX.utils.sheet_to_json<(string|number)[]>(workbook.Sheets.About,{header:1});
  expect(about).toContainEqual(['Scope','Company: Company']);expect(about).toContainEqual(['People',1]);
  expect(JSON.stringify(rows)).not.toMatch(/justification|rater identity|Private calibration/);
 });
 it('exports an empty scope with headers and an honest zero-person About sheet',()=>{
  const wb=XLSX.read(buildRatingRecordWorkbook({cycle:'Annual',scope:'Scoped company',records:[],generatedAt:recordedAt}),{type:'buffer'});
  expect(XLSX.utils.sheet_to_json(wb.Sheets.Ratings,{header:1})).toEqual([[...ratingRecordHeaders]]);
  expect(XLSX.utils.sheet_to_json(wb.Sheets.About,{header:1})).toContainEqual(['People',0]);
 });
});
