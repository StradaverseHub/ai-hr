/** Board 0ec0ee00, stage 2 — the Individual Transaction upload limits have one owner; fictional rows only. */
import {describe,expect,it} from 'vitest';
import {parseIndividualImport} from '../lib/individual-txn-import-contract';
import {INDIVIDUAL_IMPORT_HEADERS} from '../lib/payroll-txn-import-schema';
import {INDIVIDUAL_IMPORT_MAX_BYTES,INDIVIDUAL_IMPORT_MAX_CSV_BYTES,INDIVIDUAL_IMPORT_MAX_RECORDS,individualImportPercent} from '../lib/individual-import-job';
import {toCsv} from '../lib/csv';

const row=(i:number)=>['200001','Fictional Person','2026-08','M1','OT','2026-08-15','amount','',String(i+1),'fictional'];
const csv=(count:number)=>toCsv([[...INDIVIDUAL_IMPORT_HEADERS.monthly],...Array.from({length:count},(_,i)=>row(i))]);
const refusal=(run:()=>unknown)=>{try{run();return 'accepted';}catch(e){return (e as Error).message;}};

describe('Individual Transaction upload limits (0ec0ee00)',()=>{
 it('holds 10,000 transactions in one upload and refuses one more as too many rows',()=>{
  expect(INDIVIDUAL_IMPORT_MAX_RECORDS).toBe(10_000);expect(INDIVIDUAL_IMPORT_MAX_BYTES).toBe(10*1024*1024);
  expect(parseIndividualImport(csv(INDIVIDUAL_IMPORT_MAX_RECORDS),'monthly')).toHaveLength(10_000);
  expect(refusal(()=>parseIndividualImport(csv(INDIVIDUAL_IMPORT_MAX_RECORDS+1),'monthly'))).toBe('tooManyRows');
 });
 it('keeps a text ceiling well above a full 10,000-row sheet and refuses more than it',()=>{
  expect(new TextEncoder().encode(csv(INDIVIDUAL_IMPORT_MAX_RECORDS)).byteLength).toBeLessThan(INDIVIDUAL_IMPORT_MAX_CSV_BYTES/4);
  const long=toCsv([[...INDIVIDUAL_IMPORT_HEADERS.monthly],...Array.from({length:9_000},(_,i)=>[...row(i).slice(0,9),'x'.repeat(900)])]);
  expect(refusal(()=>parseIndividualImport(long,'monthly'))).toBe('contentTooLarge');
 });
 it('reports progress that reaches 100% only when the work has finished',()=>{
  expect(individualImportPercent(3_780,9_000,false)).toBe(42);
  expect(individualImportPercent(9_000,9_000,false)).toBe(99);
  expect(individualImportPercent(9_000,9_000,true)).toBe(100);
  expect(individualImportPercent(0,0,false)).toBe(0);
 });
});
