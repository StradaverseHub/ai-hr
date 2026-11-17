/** Adoption inventory supplements native/DOM behavior proofs; no whole-array fallback may return on these pages. */
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
it('keeps every remaining shared panel on its bounded purpose port',()=>{
 for(const file of ['app/payroll/transactions/fixed/page.tsx','app/payroll/transactions/tp1/page.tsx','app/payroll/transactions/tp3/page.tsx','app/payroll/transactions/zakat/page.tsx','app/payroll/individual-payslip/page.tsx','app/admin/loans/page.tsx']){
  const source=readFileSync(file,'utf8');expect(source.length).toBeGreaterThan(1000);expect(source,file).toContain('sharedEmployeePicker(');expect(source,file).not.toMatch(/await listEmployees\(|employees=\{panelEmployees\}|employees=\{pickerEmployees\}/);
 }
 const history=readFileSync('app/attendance/application-history/page.tsx','utf8');expect(history).toContain('omitEmployees:true');expect(history).toContain("endpoint:'/api/attendance/application-history/employees'");expect(history).not.toContain('options.employees.map');
 const draft=readFileSync('app/admin/personnel/new/page.tsx','utf8');expect(draft).toContain('draftManagerChoices(');expect(draft).not.toContain('listManagerCandidates(session');
});
