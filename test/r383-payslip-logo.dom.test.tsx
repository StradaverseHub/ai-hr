import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {PayslipCompanyLogo} from '../components/payslip-company-logo';
afterEach(cleanup);
describe('payslip document logo fallback',()=>{
 it('uses the existing scoped image URL with bounded aspect-preserving geometry',()=>{
  render(<PayslipCompanyLogo companyId="company-id" companyName="Company legal name"/>);
  const logo=screen.getByRole('img',{name:'Company legal name'});
  expect(logo.getAttribute('src')).toBe('/admin/organization/logo/company-id');
  expect(logo.className).toContain('object-contain');expect(logo.className).toContain('max-h-14');expect(logo.className).toContain('max-w-24');
 });
 it('hides a corrupt or unavailable mark while retaining the header legal name',()=>{
  render(<header><PayslipCompanyLogo companyId="company-id" companyName="Company legal name"/><h1>Company legal name</h1></header>);
  fireEvent.error(screen.getByRole('img'));
  expect(screen.queryByRole('img')).toBeNull();expect(screen.getByRole('heading',{name:'Company legal name'})).toBeTruthy();
 });
 it('does not carry one company failure into a different selected payslip company',()=>{
  const {rerender}=render(<PayslipCompanyLogo companyId="company-a" companyName="Company A"/>);
  fireEvent.error(screen.getByRole('img',{name:'Company A'}));expect(screen.queryByRole('img')).toBeNull();
  rerender(<PayslipCompanyLogo companyId="company-b" companyName="Company B"/>);
  const next=screen.getByRole('img',{name:'Company B'});
  expect(next.getAttribute('src')).toBe('/admin/organization/logo/company-b');
  fireEvent.error(next);expect(screen.queryByRole('img')).toBeNull();
 });

});
