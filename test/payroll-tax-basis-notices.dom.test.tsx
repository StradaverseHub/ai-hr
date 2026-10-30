import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {TaxBasisCorrectionNotice} from '../components/payroll-tax-basis-notice';
import {StatutoryReportPanel} from '../components/statutory-report-panel';
import {taxBasisNoticeBatchIds} from '../lib/payroll-tax-basis-notices';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
const batchId='12345678-1234-4234-8234-123456789012';
const reference={batchId,reference:'TAX-12345678',canOpen:true};
const strings={description:en.payrollTaxBasis.noticeOriginal,references:en.payrollTaxBasis.noticeReferences,view:en.payrollTaxBasis.noticeView};
afterEach(cleanup);
describe('visible tax-basis audit references',()=>{
 it.each([en,ms,zh,ta,th,vi])('shows original working separately from corrections in each supported language',messages=>{
  render(<TaxBasisCorrectionNotice references={[reference]} strings={{description:messages.payrollTaxBasis.noticeOriginal,references:messages.payrollTaxBasis.noticeReferences,view:messages.payrollTaxBasis.noticeView}}/>);
  expect(screen.getByRole('note')).toHaveTextContent(messages.payrollTaxBasis.noticeOriginal);
  expect(screen.getByRole('link',{name:'TAX-12345678'})).toHaveAttribute('href','/payroll/income-tax-recalculation/'+batchId);
 });
 it('keeps a readable reference without offering an administrative link to a denied reader',()=>{
  render(<TaxBasisCorrectionNotice references={[{...reference,canOpen:false}]} strings={strings}/>);
  expect(screen.getByRole('note')).toHaveTextContent('TAX-12345678');expect(screen.queryByRole('link')).toBeNull();
 });
 it('adds the correction notice to the actual statutory-report renderer without changing its money table',()=>{
  render(<StatutoryReportPanel result={{columns:[{key:'income',label:'Taxable income',numeric:true}],rows:[{income:5500}],totals:{income:5500},readiness:[],meta:{hasBatch:true,statutoryVersion:'fixture-2026'}}} strings={{heading:'Reviewed report',readinessTitle:'Missing information',noRows:'No rows'}} taxBasisNotice={{references:[reference],strings:{...strings,description:en.payrollTaxBasis.noticeApplied}}}/>);
  expect(screen.getByRole('note')).toHaveTextContent(en.payrollTaxBasis.noticeApplied);
  expect(within(screen.getByRole('table')).getByText('RM 5,500.00')).toBeVisible();
  expect(screen.getAllByText('RM 5,500.00')).toHaveLength(2);
 });
 it('renders nothing when a source has no correction and rejects malformed or duplicate reference identities',()=>{
  const {container}=render(<TaxBasisCorrectionNotice references={[]} strings={strings}/>);expect(container).toBeEmptyDOMElement();
  expect(taxBasisNoticeBatchIds([{batchId},{batchId:batchId.toUpperCase()},{batchId:'../../other'},{batchId:'javascript:alert(1)'},null])).toEqual([batchId]);
 });
});
