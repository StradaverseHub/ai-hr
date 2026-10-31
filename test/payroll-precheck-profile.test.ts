import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {payrollPrecheckProfileHref} from '../lib/payroll-precheck-profile';
const id='11111111-1111-4111-8111-111111111111';
describe('Payroll pre-check correction destinations',()=>{
 it.each(['missingCompensation','zeroBasic','unpayablePayMode','tp3YearMismatch','staleBasicComponent','currencyMismatch','nothingPayable'] as const)('opens the existing editable Payroll tab for %s',issue=>{
  expect(payrollPrecheckProfileHref(id,issue)).toBe(`/admin/personnel/${id}?tab=payroll`);
 });
 it.each(['missingStatutory','missingBank','hrdfSubjectUnregistered'] as const)('opens Bank and Statutory for %s',issue=>{
  expect(payrollPrecheckProfileHref(id,issue)).toBe(`/admin/personnel/${id}?tab=bankStatutory`);
 });
 it('keeps a supplied identity inside the path segment rather than introducing a redirect/query',()=>{
  expect(payrollPrecheckProfileHref('../elsewhere?tab=profile#x','missingBank')).toBe('/admin/personnel/..%2Felsewhere%3Ftab%3Dprofile%23x?tab=bankStatutory');
 });
 it('wires both actual batch link groups and the persisted run scope to their shared owners',()=>{
  const page=readFileSync(new URL('../app/(app)/payroll/[batchId]/page.tsx',import.meta.url),'utf8');
  expect(page).toContain("payrollPrecheckProfileHref(r.employmentId, 'nothingPayable')");
  expect(page).toContain('payrollPrecheckProfileHref(r.employmentId, key)');
  expect(page).not.toContain('href={`/people/${r.employmentId}`}');
  expect(page).toMatch(/payrollReadiness\(s,\s*\{\s*companyId: batch.companyId,\s*payPeriod: batch.payPeriod,\s*scope,/);
  const target=readFileSync(new URL('../app/(app)/admin/personnel/[employmentId]/page.tsx',import.meta.url),'utf8');
  expect(target).toContain('await requireWorkforceAccess()');expect(target).toContain('tabKey="payroll"');expect(target).toContain('tabKey="bankStatutory"');
 });
});
