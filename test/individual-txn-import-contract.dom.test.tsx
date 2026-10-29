import {describe,it,expect} from 'vitest';
import {parseIndividualImport} from '../lib/individual-txn-import-contract';
import {INDIVIDUAL_IMPORT_HEADERS} from '../lib/payroll-txn-import-schema';
import {toCsv} from '../lib/csv';
import {buildIndividualTxnWorkbook} from '../lib/individual-txn-import-workbook';
import type {TxnTemplateReference} from '../lib/import-template-xlsx';
describe('individual import data contracts',()=>{
 it('has exactly the requested ordered business columns for each method',()=>{
  expect(INDIVIDUAL_IMPORT_HEADERS.monthly).toEqual(['Employee ID','Employee Name (Optional)','Month with Year','Pay Cycle','Pay Item','Effective Date','Input Type','Quantity','Amount','Remark']);
  expect(INDIVIDUAL_IMPORT_HEADERS.daily).toEqual(['Employee ID','Employee Name (Optional)','Month with Year','Pay Cycle','Pay Item','Effective Date','Quantity','Remarks']);
 });
 it('keeps payroll month independent of work date and preserves every daily row',()=>{
  const csv=toCsv([[...INDIVIDUAL_IMPORT_HEADERS.daily],['0001','','2026-08','Monthly','OT','2026-07-30','2','first'],['0001','','2026-08','Monthly','OT','2026-07-31','2','second']]);
  const rows=parseIndividualImport(csv,'daily');expect(rows).toHaveLength(2);expect(rows.map(r=>r.transaction_date)).toEqual(['2026-07-30','2026-07-31']);expect(rows.map(r=>r.__pay_period)).toEqual(['2026-08','2026-08']);expect(rows[0].employee_id).toBe('0001');expect(rows[0].__method).toBe('daily');
 });
 it('rejects wrong-method, duplicate, missing and reordered headers before mapping rows',()=>{
  const row=['E1','','2026-08','Monthly','OT','2026-08-01','hours','2','',''];
  const csv=toCsv([[...INDIVIDUAL_IMPORT_HEADERS.monthly],row]);expect(()=>parseIndividualImport(csv,'daily')).toThrow('templateMismatch');
  for(const headers of [[...INDIVIDUAL_IMPORT_HEADERS.monthly].reverse(),[...INDIVIDUAL_IMPORT_HEADERS.monthly].slice(1),[...INDIVIDUAL_IMPORT_HEADERS.monthly].map((v,i)=>i===1?'Employee ID':v)])expect(()=>parseIndividualImport(toCsv([headers,row]),'monthly')).toThrow('templateMismatch');
 });
 it('generates real workbooks with the correct first worksheet and non-executable text references',async()=>{
  const reference:TxnTemplateReference={headings:{employees:'Employees',employeeId:'Employee ID',employeeName:'Employee Name',company:'Company',department:'Department',payItems:'Pay Items',payItemCode:'Code',payItemName:'Pay Item',payItemKind:'Kind',payItemInput:'Input Type',cycles:'Cycles',cycleCode:'Code',cycleLabel:'Name',kinds:'Kinds',kindCode:'Code',kindLabel:'Name',example:'Example',note:'Instructions'},employees:[{code:'0001',name:'=HYPERLINK("https://example.invalid")',company:'Example',department:''}],payItems:[{code:'BONUS',name:'Bonus',kind:'bonus',input:''}],cycles:[],kinds:[]};
  const XLSX=await import('xlsx');
  for(const method of ['monthly','daily'] as const){
   const bytes=await buildIndividualTxnWorkbook(method,reference,[{name:'Monthly',code:'ME',company:'Example'}],'Instructions');
   const workbook=XLSX.read(bytes,{type:'array'});expect(workbook.SheetNames[0]).toBe(method==='monthly'?'Monthly Transactions':'Daily Transactions');
   const first=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1});expect(first[0]).toEqual(INDIVIDUAL_IMPORT_HEADERS[method]);
   expect(workbook.Sheets.Employees.A2.v).toBe('0001');expect(workbook.Sheets.Employees.B2.f).toBeUndefined();expect(workbook.Sheets.Employees.B2.t).toBe('s');
  }
 });
 it('retains exact monthly unit and amount strings instead of treating input type as transaction kind',()=>{
  const row=parseIndividualImport(toCsv([[...INDIVIDUAL_IMPORT_HEADERS.monthly],['E1','Example','2026-08','ME','BONUS','2026-07-31','amount','','14.50','note']]),'monthly')[0];
  expect(row).toMatchObject({__input_unit:'amount',amount:'14.50',kind:'',__configured_cycle:'ME',__pay_period:'2026-08',notes:'note'});
 });
});
