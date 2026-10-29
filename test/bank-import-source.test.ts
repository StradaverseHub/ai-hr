import {describe,it,expect} from 'vitest';
import {decodeBankImportSource} from '../lib/bank-import-source.server';
import {readImportFile,ImportFileError} from '../lib/import-file';
import {BANK_IMPORT_MAX_BYTES,BANK_IMPORT_MAX_ROWS,bankImportPercent,type BankImportProgress} from '../lib/bank-import-job';
import {parsePersonnelCsv} from '../lib/personnel-csv';
import {buildXlsx} from '../lib/spreadsheet';

describe('large Bank & Statutory source admission',()=>{
 it('decodes 100,001 actual CSV records past the old 900 KB boundary',async()=>{
  const csv='employee_code,tax_number\n'+Array.from({length:100001},(_,i)=>`EMP${i},T${i}\n`).join('');
  expect(Buffer.byteLength(csv)).toBeGreaterThan(900000);
  const decoded=await decodeBankImportSource('large.csv',Buffer.from(csv));
  expect(decoded.records).toHaveLength(100001);
  expect(decoded.records[0]).toEqual({employee_code:'EMP0',tax_number:'T0'});
  expect(decoded.records[100000]).toEqual({employee_code:'EMP100000',tax_number:'T100000'});
  expect(decoded.errors.size).toBe(0);
 },30000);
 it('bounds CSV rows and columns while scanning, before materializing the entire source',()=>{
  expect(()=>parsePersonnelCsv('employee_code,tax_number\nE1,T1\nE2,T2\nE3,T3','employee',3)).toThrow('limit');
  expect(()=>parsePersonnelCsv(Array.from({length:257},()=> 'a').join(','),'employee',3)).toThrow('limit');
 });
 it('keeps other importers at their existing file ceiling',async()=>{
  await expect(readImportFile(new File(['a'.repeat(900001)],'other.csv'))).rejects.toBeInstanceOf(ImportFileError);
 });
 it('retains quoted newlines, leading zeros and whole-file duplicate checks across batch boundaries',async()=>{
  const rows=Array.from({length:205},(_,i)=>`EMP${i},00${i}`);rows[204]='emp0,0000';
  const decoded=await decodeBankImportSource('sample.csv',Buffer.from('employee_code,bank_account_no\n'+rows.join('\n')));
  expect(decoded.errors.get(205)).toContain('row 1');expect(decoded.records[0].bank_account_no).toBe('000');
  const multiline=await decodeBankImportSource('quoted.csv',Buffer.from('employee_code,custom_holder_name\nEMP1,"First\nSecond"'));
  expect(multiline.records[0].custom_holder_name).toBe('First\nSecond');
 });
 it('detects duplicate Card IDs even when their rows span separate validation batches',async()=>{
  const rows=Array.from({length:205},(_,i)=>`EMP${i},CARD${i}`);rows[204]='EMP204,card0';
  const decoded=await decodeBankImportSource('cards.csv',Buffer.from('employee_code,card_id\n'+rows.join('\n')));
  expect([...decoded.errors.keys()]).toEqual([1,205]);
 });
 it('reads a genuine workbook through the same descriptor parser',async()=>{
  const bytes=await buildXlsx(['employee_code','tax_number'],[['EMP1','00012']]);
  expect((await decodeBankImportSource('bank.xlsx',Buffer.from(bytes))).records).toEqual([{employee_code:'EMP1',tax_number:'00012'}]);
 });
 it('refuses over-budget files and worksheet dimensions before producing CSV rows',async()=>{
  await expect(readImportFile({name:'huge.csv',size:BANK_IMPORT_MAX_BYTES+1} as File,{maxFileBytes:BANK_IMPORT_MAX_BYTES})).rejects.toMatchObject({code:'FILE_TOO_LARGE'});
  const XLSX=await import('xlsx'),wb=XLSX.utils.book_new(),ws=XLSX.utils.aoa_to_sheet([['employee_code','tax_number'],['EMP1','T1']]);
  ws['!ref']=`A1:B${BANK_IMPORT_MAX_ROWS+3}`;XLSX.utils.book_append_sheet(wb,ws,'Bank');
  await expect(decodeBankImportSource('range.xlsx',Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'})))).rejects.toMatchObject({code:'FILE_TOO_LARGE'});
 });
 it('calculates progress from durable checkpoints, including zero-row and completed jobs',()=>{
  const job={state:'importing',total:100001,processed:50000} as BankImportProgress;
  expect(bankImportPercent(job)).toBe(49);expect(bankImportPercent({...job,total:0})).toBe(0);
  expect(bankImportPercent({...job,state:'uploading',sourceBytes:100,uploadedBytes:50})).toBe(50);
 });
});
