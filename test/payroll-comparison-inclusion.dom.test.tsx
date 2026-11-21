/** The ready-company comparison's coverage line, "Not included" panel, never-ran line and empty states, rendered from
 * every maintained catalogue (English asserted word for word). Fictional company names. */
import * as React from 'react';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
import {PayrollComparisonInclusionNotice,payrollComparisonEmptyMessage} from '../app/reports/payroll-comparison/inclusion';
import type {PayrollComparisonInclusion} from '../lib/payroll-comparison-result';

afterEach(cleanup);
const translator=(locale:string,messages:unknown)=>createTranslator({locale,messages:messages as typeof en,namespace:'payrollComparison',timeZone:'Asia/Kuala_Lumpur',onError:error=>{throw error;}}) as unknown as (key:string,values?:Record<string,string|number|Date>)=>string;
const inclusion:PayrollComparisonInclusion={
 includedCompanyIds:['a','b'],withPayrollCount:6,neverRanCount:1,
 excluded:[
  {companyId:'c',company:'Fictional Gamma Sdn Bhd',reasons:[{code:'previousNotClosed',period:'2026-09'}]},
  {companyId:'d',company:'Fictional Delta Sdn Bhd',reasons:[{code:'missingPayroll',period:'2026-10'}]},
  {companyId:'e',company:'Fictional Epsilon Sdn Bhd',reasons:[{code:'draftPayroll',period:'2026-10'},{code:'stalePayroll',period:'2026-10'}]},
 ],
};

describe('ready-company comparison coverage',()=>{
 it('says which companies the rows and totals cover, which are left out and why',()=>{
  render(<PayrollComparisonInclusionNotice inclusion={inclusion} t={translator('en',en)}/>);
  expect(screen.getByRole('status').textContent).toBe('Comparing 2 of 6 companies with payroll. Rows and totals cover these companies only.');
  expect(screen.getByRole('heading',{name:'Not included'})).toBeTruthy();
  const items=screen.getAllByRole('listitem').map(item=>item.textContent);
  expect(items).toEqual([
   'Fictional Gamma Sdn Bhd: September 2026 not closed yet',
   'Fictional Delta Sdn Bhd: No payroll run in October 2026',
   'Fictional Epsilon Sdn Bhd: October 2026 still a draft; October 2026 needs reprocess',
  ]);
  expect(screen.getByText('1 company in this scope has never run payroll and is left out.')).toBeTruthy();
 });

 it('shows nothing extra when every company with payroll is included, and an empty state when none is',()=>{
  const {container}=render(<PayrollComparisonInclusionNotice inclusion={{...inclusion,excluded:[],neverRanCount:0,includedCompanyIds:['a'],withPayrollCount:1}} t={translator('en',en)}/>);
  expect(container.querySelector('h2')).toBeNull();
  expect(payrollComparisonEmptyMessage(null,translator('en',en))).toBeNull();
  expect(payrollComparisonEmptyMessage({...inclusion,includedCompanyIds:[]},translator('en',en))).toBe('No company is ready to compare for these months. See Not included for what each company needs.');
  expect(payrollComparisonEmptyMessage({includedCompanyIds:[],excluded:[],withPayrollCount:0,neverRanCount:3},translator('en',en))).toBe('No company in this scope has run payroll yet.');
 });

 it('renders from every maintained catalogue',()=>{
  for(const [locale,messages] of [['ms',ms],['ta',ta],['th',th],['vi',vi],['zh',zh]] as const){
   const t=translator(locale,messages);
   const {container,unmount}=render(<PayrollComparisonInclusionNotice inclusion={inclusion} t={t}/>);
   expect(container.textContent,locale).toContain('Fictional Delta Sdn Bhd');
   expect(container.textContent,locale).not.toContain('inclusion.');
   expect(payrollComparisonEmptyMessage({...inclusion,includedCompanyIds:[]},t),locale).not.toContain('inclusion.');
   unmount();
  }
 });
});
