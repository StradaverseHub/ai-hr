import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {profileTestingDates,profileTestingDigest,assertProfileTestingInvariant,assertProfileTestingJournal,verifyOptionalProfileTestingPdf} from '../scripts/profile-testing-fixture-proof.mjs';

const temporary:string[]=[];
afterEach(()=>{for(const directory of temporary.splice(0))fs.rmSync(directory,{recursive:true,force:true});});
describe('shared Profile/Testing fixture evidence refusal',()=>{
 it('uses the preceding complete payroll month across a year boundary and rejects normalized bad dates',()=>{
  expect(profileTestingDates('2027-01-01')).toMatchObject({payPeriod:'2026-12',hiredOn:'2025-01-01',concurrentOn:'2027-01-01',oldHiredOn:'2024-01-01',oldEndedOn:'2025-12-31'});
  expect(profileTestingDates('2028-03-01').payPeriod).toBe('2028-02');
  for(const date of ['2026-02-30','2026-13-01','2026-1-01','2026-00-01','not-a-date'])expect(()=>profileTestingDates(date)).toThrow('Canonical local date');
 });
 it('rejects altered migration bytes, order, timestamp, missing and appended rows',()=>{
  const expected=[{when:1791900000040,sha256:'a'.repeat(64)},{when:1791900000041,sha256:'b'.repeat(64)}];
  const applied=expected.map(row=>({created_at:String(row.when),hash:row.sha256}));
  expect(()=>assertProfileTestingJournal(expected,applied)).not.toThrow();
  for(const altered of [applied.slice(1),[...applied,applied[0]],[...applied].reverse(),[{...applied[0],hash:'c'.repeat(64)},applied[1]],[applied[0],{...applied[1],created_at:'1791900000042'}]])expect(()=>assertProfileTestingJournal(expected,altered)).toThrow('Exact applied source');
 });
 it('requires the same physical database and original immutable fact digest',()=>{
  const initial={connection:{database:'ai_hr_board19_profile_testing_browser',oid:'12345'},digest:profileTestingDigest({version:'original',releasedPay:'original'})};
  expect(()=>assertProfileTestingInvariant(initial,structuredClone(initial))).not.toThrow();
  expect(()=>assertProfileTestingInvariant(initial,{...initial,connection:{...initial.connection,oid:'12346'}})).toThrow('preserve all observations');
  expect(()=>assertProfileTestingInvariant(initial,{...initial,digest:profileTestingDigest({version:'edited',releasedPay:'original'})})).toThrow();
  expect(()=>assertProfileTestingInvariant(initial,{...initial,digest:profileTestingDigest({version:'original',releasedPay:'edited'})})).toThrow();
  expect(()=>assertProfileTestingInvariant(initial,null)).toThrow();
 });
 it('records a missing browser PDF honestly and refuses incomplete or fabricated evidence',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'profile-testing-proof-'));temporary.push(directory);
  const fixture={releasedPayroll:{payslipId:'slip',employmentId:'employee',pdfRoute:'/me/payslip/slip/pdf'}};
  expect(verifyOptionalProfileTestingPdf(directory,fixture)).toEqual({status:'not_yet_observed'});
  fs.writeFileSync(path.join(directory,'released-pdf-observation.json'),JSON.stringify({actualBrowserDownload:false}),{mode:0o600});
  expect(()=>verifyOptionalProfileTestingPdf(directory,fixture)).toThrow('incomplete real PDF');
  // Deliberately invalid bytes exercise refusal only; these are never an acceptance artifact.
  fs.writeFileSync(path.join(directory,'released-payslip.pdf'),'not an actual PDF'.repeat(10),{mode:0o600});
  expect(()=>verifyOptionalProfileTestingPdf(directory,fixture)).toThrow('binding differs');
  fs.chmodSync(path.join(directory,'released-payslip.pdf'),0o644);
  expect(()=>verifyOptionalProfileTestingPdf(directory,fixture)).toThrow('Owned private');
 });
});
