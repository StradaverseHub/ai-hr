import { describe, it, expect } from 'vitest';
import { DEFAULT_PAYSLIP_INFORMATION_FIELDS, PAYSLIP_INFORMATION_FIELDS, selectPayslipInformation } from '../core/payslip-information';
import { renderPayslipPdf } from '../lib/payslip-pdf';
import { labels, data } from './fixtures/payslip-pdf-fixture';
import { PDFDocument } from 'pdf-lib';
const names = Object.fromEntries(PAYSLIP_INFORMATION_FIELDS.map(k => [k,k])) as Record<typeof PAYSLIP_INFORMATION_FIELDS[number],string>;
describe('company payslip information presentation', () => {
 it('continues a single oversized field across pages without dropping the field',async()=>{const bytes=await renderPayslipPdf({...data,informationRows:[{label:'Branch',value:'Synthetic organization description '.repeat(800)}]},labels);expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(2);});
 it('defaults retain twelve existing fields, hide nine organisation fields, omit blank but preserve zero', () => {
  expect(DEFAULT_PAYSLIP_INFORMATION_FIELDS).toHaveLength(12);
  const rows=selectPayslipInformation({employee:'Ada',identityNumber:'  ',daysWorked:0,branch:'North'},null,names);
  expect(rows.map(r=>r.key)).toEqual(['employee','daysWorked']);
  expect(rows[1].value).toBe('0');
 });
 it('each of 21 settings independently hides its label/value with deterministic order', () => {
  const values=Object.fromEntries(PAYSLIP_INFORMATION_FIELDS.map(k=>[k,'value-'+k]));
  for(const k of PAYSLIP_INFORMATION_FIELDS) {
   expect(selectPayslipInformation(values,[k],names)).toEqual([{key:k,label:k,value:'value-'+k}]);
   expect(selectPayslipInformation(values,PAYSLIP_INFORMATION_FIELDS.filter(x=>x!==k),names).some(x=>x.key===k)).toBe(false);
  }
  expect(selectPayslipInformation(values,[],names)).toEqual([]);
 });
 it('renders all enabled long fields across sheets without mutating financial values', async () => {
  const before=JSON.stringify(data);
  const rows=PAYSLIP_INFORMATION_FIELDS.map(k=>({label:k,value:(k+' organisation description ').repeat(6)}));
  const bytes=await renderPayslipPdf({...data,basic:0,informationRows:rows},labels);
  expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  expect(JSON.stringify(data)).toBe(before);
 });
});
