/** HTTP boundary only. Financial-model and real PDF parity are separate database/app checks. */
import {randomUUID} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {GET as payslipGet} from '../app/(app)/me/payslip/[payslipId]/pdf/route';
import {GET as eaGet} from '../app/(app)/me/ea/[employmentId]/pdf/route';
const mocks=vi.hoisted(()=>({document:vi.fn(),ea:vi.fn(),payslipPdf:vi.fn(),eaPdf:vi.fn(),eaLabels:vi.fn(),locale:'en'}));
vi.mock('../lib/session',()=>({getSession:async()=>({tenantId:'fictional-tenant',userId:'fictional-user',personId:'fictional-person',roles:['employee']})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>mocks.locale}));
vi.mock('../app/(app)/me/payslip/document',()=>({myPayslipDocument:mocks.document}));
vi.mock('../lib/payslip-pdf',()=>({renderPayslipPdf:mocks.payslipPdf}));
vi.mock('../core/reporting',()=>({myEaStatement:mocks.ea}));
vi.mock('../lib/ea-pdf',()=>({renderEaPdf:mocks.eaPdf,EaLayoutFitError:class extends Error{}}));
vi.mock('../lib/ea-pdf-labels',()=>({eaPdfLabels:mocks.eaLabels}));
const id=randomUUID(),companyId=randomUUID();
const request=(path:string)=>new Request(`https://fictional.example.invalid${path}`);
const session=expect.objectContaining({userId:'fictional-user',personId:'fictional-person'});
beforeEach(()=>{
 vi.clearAllMocks();mocks.locale='en';mocks.document.mockResolvedValue(null);mocks.ea.mockResolvedValue(null);
 mocks.payslipPdf.mockResolvedValue(new Uint8Array([1,2,3]));mocks.eaPdf.mockResolvedValue(new Uint8Array([4,5,6]));mocks.eaLabels.mockResolvedValue({fictional:true});
});
describe('own document endpoints retain owner checks and private responses',()=>{
 it.each(['inline','attachment'])('uses the exact own payslip document model for %s without accepting a caller subject',async(disposition)=>{
  const document={p:{id,payPeriod:'2025-03',employeeCode:'FICTIONAL-001',runType:'bonus',runSeq:2},data:{fictional:'recorded snapshot'},strings:{labels:{fictional:'labels'}}};
  mocks.document.mockResolvedValue(document);
  const response=await payslipGet(request(`/me/payslip/${id}/pdf?disposition=${disposition}&personId=foreign`),{params:Promise.resolve({payslipId:id})});
  expect(mocks.document).toHaveBeenCalledWith(session,id);expect(mocks.payslipPdf).toHaveBeenCalledWith(document.data,document.strings.labels);
  expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Content-Disposition')).toBe(`${disposition}; filename="payslip-2025-03-bonus-2-FICTIONAL-001.pdf"`);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1,2,3]));
 });
 it('never passes a malformed payslip ID to the reader, and makes an unavailable/foreign refusal indistinguishable',async()=>{
  const malformed=await payslipGet(request('/me/payslip/invalid/pdf'),{params:Promise.resolve({payslipId:'invalid'})});
  expect(mocks.document).not.toHaveBeenCalled();
  const denied=await payslipGet(request(`/me/payslip/${id}/pdf`),{params:Promise.resolve({payslipId:id})});
  for(const response of [malformed,denied]){expect(response.status).toBe(404);expect(response.headers.get('Cache-Control')).toBe('private, no-store');expect(await response.text()).toBe('Not found');}
  expect(mocks.payslipPdf).not.toHaveBeenCalled();
 });
 it.each(['en','ms'])('uses one canonical EA DTO for inline and download in %s',async(lang)=>{
  const ea={year:'2025',employer:{name:'Fictional paying employer'},employee:{name:'Fictional employee'},partB:{salary:1234.56},partC:{},partD:{},partE:{},formDate:'2026-02-28',statutoryVersion:'fictional-version',overrides:[{field:'salary',amended:1234.56}]};
  mocks.ea.mockResolvedValue(ea);
  const url=`/me/ea/${id}/pdf?year=2025&company=${companyId}&lang=${lang}`;
  const inline=await eaGet(request(`${url}&disposition=inline`),{params:Promise.resolve({employmentId:id})});
  const download=await eaGet(request(url),{params:Promise.resolve({employmentId:id})});
  expect(mocks.ea).toHaveBeenCalledWith(session,{employmentId:id,companyId,year:'2025'});
  expect(mocks.eaPdf.mock.calls[0][0]).toEqual(ea);expect(mocks.eaPdf.mock.calls[1][0]).toEqual(ea);
  expect(mocks.eaLabels).toHaveBeenCalledWith(lang,{year:'2025',version:'fictional-version'});
  expect(inline.headers.get('Content-Disposition')).toMatch(/^inline;/);expect(download.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  for(const response of [inline,download]){expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('private, no-store');expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4,5,6]));}
 });
 it.each(['year=garbled','year=2025-03','year=','company=invalid','company='])('refuses an invalid EA selection %s without silently returning a different form',async(query)=>{
  const response=await eaGet(request(`/me/ea/${id}/pdf?${query}`),{params:Promise.resolve({employmentId:id})});
  expect(response.status).toBe(404);expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(mocks.ea).not.toHaveBeenCalled();expect(mocks.eaPdf).not.toHaveBeenCalled();
 });
 it('does not render or reveal an unavailable/foreign EA result',async()=>{
  const response=await eaGet(request(`/me/ea/${id}/pdf?year=2025&company=${companyId}`),{params:Promise.resolve({employmentId:id})});
  expect(response.status).toBe(404);expect(response.headers.get('Cache-Control')).toBe('private, no-store');expect(await response.text()).toBe('Not found');expect(mocks.eaPdf).not.toHaveBeenCalled();
 });
 it.each(['zh','vi','ta','th'])('uses the supported English document when the UI is %s and no document language is selected',async(locale)=>{
  mocks.locale=locale;mocks.ea.mockResolvedValue({year:'2025',employer:{name:'Fictional employer'},employee:{name:'Fictional employee'}});
  await eaGet(request(`/me/ea/${id}/pdf?year=2025`),{params:Promise.resolve({employmentId:id})});
  expect(mocks.eaLabels).toHaveBeenCalledWith('en',expect.anything());expect(mocks.eaPdf).toHaveBeenCalledWith(expect.anything(),expect.anything(),{locale:'en'});
 });
});
