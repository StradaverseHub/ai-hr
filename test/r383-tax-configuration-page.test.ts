import fs from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {createTranslator} from 'next-intl';
import {describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({locale:'en',get:vi.fn()}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({tenantId:'synthetic'})}));
vi.mock('../localization/registry',()=>({packFor:()=>({statutory:{getTaxSelection:state.get}})}));
vi.mock('../app/admin/personnel/[employmentId]/tax-selection-actions',()=>({savePayrollTaxSelectionAction:async()=>{}}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('NOT_FOUND');}}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:state.locale,namespace,messages:JSON.parse(fs.readFileSync(`messages/${state.locale}.json`,'utf8'))})}));
import Page from '../app/payroll/[batchId]/tax-configuration/[employmentId]/page';
const batchId='11111111-1111-4111-8111-111111111111';
const employmentId='22222222-2222-4222-8222-222222222222';
const props=(batch=batchId)=>({params:Promise.resolve({batchId:batch,employmentId}),searchParams:Promise.resolve({})});
describe('direct payroll tax selection route',()=>{
 it.each(['en','ms','zh','ta','th','vi'])('loads a valid employer-period context and the five choices in %s',async locale=>{
  state.locale=locale;state.get.mockResolvedValue({employeeCode:'SYNTH',companyId:batchId,companyName:'Synthetic employer',payPeriod:'2026-07',scheme:'resident',version:1,transitionState:'resolved'});
  const html=renderToStaticMarkup(await Page(props()));
  expect(state.get).toHaveBeenLastCalledWith({tenantId:'synthetic'},employmentId,batchId);
  expect(html).toContain('Synthetic employer');
  expect(html).toMatch(/<option value="resident"[^>]*selected=""/);
  for(const scheme of ['resident','non_resident','rep','knowledge_worker','c_suite'])expect(html).toContain(`value="${scheme}"`);
  expect(html).toContain('name="expectedPayPeriod" value="2026-07"');
  expect(html).not.toContain('name="approvalReference"');
  expect(html).not.toContain('MISSING_MESSAGE');
 });
 it('header Back preserves only the shared allowed payroll return and valid job context',async()=>{
  state.locale='en';state.get.mockResolvedValue({employeeCode:'SYNTH',companyId:batchId,companyName:'Synthetic employer',payPeriod:'2026-07',scheme:'resident',version:1,transitionState:'resolved'});
  const job='33333333-3333-4333-8333-333333333333';
  const safe=renderToStaticMarkup(await Page({params:props().params,searchParams:Promise.resolve({from:'/payroll?year=2026&months=7&error=old',job})}));
  const q=new URLSearchParams({from:'/payroll?year=2026&months=7',job});
  expect(safe).toContain(`href="/payroll/${batchId}/reprocess?${String(q).replaceAll('&','&amp;')}"`);
  expect(safe).toContain('name="payrollJob" value="'+job+'"');
  const hostile=renderToStaticMarkup(await Page({params:props().params,searchParams:Promise.resolve({from:'https://foreign.example/path',job:'bad-job'})}));
  expect(hostile).toContain(`href="/payroll/${batchId}/reprocess"`);expect(hostile).not.toContain('foreign.example');expect(hostile).not.toContain('bad-job');
 });
 it.each(['rep',null])('unresolved recognised %s category is not submitted as a preselected approval',async scheme=>{
  state.locale='en';state.get.mockResolvedValue({employeeCode:'SYNTH',companyId:batchId,companyName:'Synthetic employer',payPeriod:'2026-07',scheme,version:1,transitionState:'confirmation_required'});
  const html=renderToStaticMarkup(await Page(props()));
  expect(html).toMatch(/<option value=""[^>]*selected=""/);expect(html).not.toMatch(/<option value="rep"[^>]*selected=""/);
 });
 it('refuses malformed route identity before calling the authorized reader',async()=>{
  state.get.mockClear();await expect(Page(props('11111111-1111-4111-111111111111'))).rejects.toThrow('NOT_FOUND');
  expect(state.get).not.toHaveBeenCalled();
 });
});
