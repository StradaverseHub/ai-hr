import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {selectOwnEmployment,OwnEmploymentSelectionError} from '../lib/own-employment-selection';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const source=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
describe('selected web-clock transport contract',()=>{
 it('requires an exact validated own selection whenever more than one employment is live',()=>{
  const rows=[{employmentId:a},{employmentId:b}];
  expect(selectOwnEmployment(rows,b)).toBe(rows[1]);
  expect(selectOwnEmployment([rows[0]])).toBe(rows[0]);
  for(const selected of [undefined,'',a+'/../'+b,'33333333-3333-4333-8333-333333333333'])expect(()=>selectOwnEmployment(rows,selected)).toThrow(OwnEmploymentSelectionError);
 });
 it('carries the same server-selected subject through read, submit, receipt and removal',()=>{
  const client=source('app/attendance/clock/clock-client.tsx');
  expect(client).toContain('new URLSearchParams({employmentId:initial.employmentId');
  expect(client).toContain('Object.entries({employmentId:initial.employmentId,action:direction,requestId');
  expect(client).toContain("'&employmentId='+encodeURIComponent(initial.employmentId)");
  expect(client).toContain('removalCommand.current??={employmentId:initial.employmentId');
  expect(client).toContain('value.employmentId!==initial.employmentId');
  const route=source('app/api/attendance/clock/route.ts');
  expect(route).toContain("ownEmploymentSelection.safeParse(selected)");
  expect(route).toContain("url.searchParams.getAll('employmentId').length>1");
  expect(route).toContain("captureEmployeeClock(session,{employmentId:typeof selected==='string'?selected:undefined");
  expect(route).toContain("ownClockReceipt(session,url.searchParams.get('requestId')??'',url.searchParams.get('employmentId')??undefined)");
 });
});
