import {readFileSync} from 'node:fs';
import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({subject:vi.fn(),contains:vi.fn(),payslips:vi.fn(),individual:vi.fn(),zakat:vi.fn(),audit:vi.fn()}));
const ctx={tenantId:'trusted-tenant'},ids=['trusted-a','trusted-b'];
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:{tenantId:'trusted-tenant'},scopeIds:['trusted-a','trusted-b']})}));
vi.mock('../core/read',()=>({employeePickerSubject:m.subject,employeeListContains:m.contains,listCompanies:async()=>[{id:'trusted-a',name:'Company A'}]}));
vi.mock('../core/payroll-view',()=>({listProcessedPayslipsAcross:m.payslips,exportIndividualTxnsCsv:m.individual,exportZakatTxnsCsv:m.zakat,INDIVIDUAL_TXN_STATUS_FILTERS:['draft','processed']}));
vi.mock('../core/pay-components',()=>({listPayComponents:async()=>[]}));
vi.mock('../core/payroll-audit/access-log',()=>({recordPayrollExportAcross:m.audit}));
vi.mock('../localization/registry',async original=>({...await original<typeof import('../localization/registry')>(),packFor:()=>({companyStatutory:{list:async()=>[]}})}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async()=> (key:string)=>key}));
import {GET as history} from '../app/payroll/transaction-view/history-export/route';
import {GET as grid} from '../app/payroll/transaction-view/grid-export/route';
import {GET as individual} from '../app/payroll/transaction-view/export/route';
import {GET as zakat} from '../app/payroll/transactions/zakat/history-export/route';
const request=(query:string)=>new Request('https://hr.example/export?'+query);
beforeEach(()=>{vi.clearAllMocks();m.subject.mockResolvedValue({employmentId:'employee-a',employeeCode:'A01',name:'Name A',company:'Company A'});m.contains.mockResolvedValue(true);m.payslips.mockResolvedValue([]);m.individual.mockResolvedValue({content:'CSV\n',filename:'individual.csv'});m.zakat.mockResolvedValue({content:'ZAKAT\n',filename:'zakat.csv'});});
it('keeps XLSX current/all populations independent from exact employee lookup and preserves header-only grids',async()=>{
 for(const route of [history,grid]){
  const response=await route(request('employmentId=employee-a&companyId=trusted-a&year=2026&month=7'));
  expect(m.subject).toHaveBeenLastCalledWith(ctx,'employee-a',ids);expect(m.payslips).toHaveBeenLastCalledWith(ctx,expect.objectContaining({companyIds:['trusted-a'],employmentId:'employee-a',year:2026}));
  expect(response.headers.get('content-type')).toContain('application/vnd.ms-excel');
  const workbook=await response.text();expect(workbook).toContain('<x:ExcelWorkbook>');expect(workbook).toContain('<thead>');
 }
 m.subject.mockResolvedValue(null);m.payslips.mockClear();await grid(request('employmentId=foreign&companyId=foreign&year=2026'));expect(m.payslips).not.toHaveBeenCalled();
 await history(request('scope=current&employmentId=foreign&companyId=foreign&year=2026'));expect(m.payslips).toHaveBeenLastCalledWith(ctx,expect.objectContaining({companyIds:ids,employmentId:undefined}));
 m.subject.mockResolvedValue({employmentId:'employee-a',name:'Name A'});await history(request('scope=all&employmentId=employee-a&companyId=trusted-a&year=2026'));
 expect(m.payslips).toHaveBeenLastCalledWith(ctx,{companyIds:ids,employmentId:undefined,year:undefined,month:undefined,cycle:undefined});
 expect(m.payslips.mock.calls.every(([,input])=>!('limit' in input))).toBe(true);
});
it('keeps CSV exact membership, scope narrowing, invalid-selection fallback and original output',async()=>{
 expect(await (await individual(request('employmentId=employee-a&companyId=trusted-a&year=2026'))).text()).toBe('CSV\n');
 expect(m.contains).toHaveBeenLastCalledWith(ctx,'employee-a',ids);expect(m.individual).toHaveBeenLastCalledWith(ctx,expect.objectContaining({companyIds:['trusted-a'],employmentId:'employee-a',year:2026}));
 expect(await (await zakat(request('hEmploymentId=employee-a&hCompanyId=trusted-a&hYear=2026'))).text()).toBe('ZAKAT\n');expect(m.zakat).toHaveBeenLastCalledWith(ctx,expect.objectContaining({companyIds:['trusted-a'],employmentId:'employee-a',year:2026}));
 m.contains.mockResolvedValue(false);
 await individual(request('employmentId=foreign&companyId=foreign'));expect(m.individual).toHaveBeenLastCalledWith(ctx,expect.objectContaining({companyIds:ids,employmentId:undefined}));
 await zakat(request('hEmploymentId=foreign&hCompanyId=foreign'));expect(m.zakat).toHaveBeenLastCalledWith(ctx,expect.objectContaining({companyIds:ids,employmentId:undefined}));
});
it('adopts exact lookup ports on every detail/PDF/adjacent export path without a full-directory fallback',()=>{
 const headers=['app/attendance/individual/[date]/page.tsx','app/payroll/transactions/fixed/[id]/page.tsx','app/payroll/transactions/tp1/new/page.tsx','app/payroll/transactions/tp1/[year]/[month]/page.tsx','app/payroll/transactions/tp1/[year]/[month]/pdf/route.ts','app/payroll/transactions/tp3/pdf/route.ts','app/payroll/transactions/zakat/election/page.tsx','app/payroll/pcb-detail/slip-data.ts','app/payroll/transaction-view/history-export/route.ts','app/payroll/transaction-view/grid-export/route.ts'];
 for(const file of [...headers,'app/payroll/transaction-view/export/route.ts','app/payroll/transactions/zakat/history-export/route.ts']){
  const source=readFileSync(file,'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');expect(source.length).toBeGreaterThan(800);expect(source,file).not.toContain('listEmployees');expect(source,file).toContain(headers.includes(file)?'employeePickerSubject(s,':'employeeListContains(s,');
 }
});
