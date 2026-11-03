/** AI v2 W5 — the claim limit "Why?" on the employee's own Claims page, rendered.
 *
 * The claims owner is a fixture returning one claim type's balance for the selected own employment, as
 * getEmployeeClaimTypes does. The page puts a "Why?" beside the balance panel for the selected type; following it
 * (`why=claim:<type>`) draws the explanation under the panel with the owner's own figures, the policy version and
 * "Ask AI Centre about this" for someone the Assistant can answer. The link keeps only the chosen employment, so
 * nothing else on the page (a draft, a dialog) is reopened by it. Expected figures are the fixture's, literally. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {withAiCentre} from './helpers/ai-centre-messages';
import {resolveServerTree} from './helpers/server-tree';

const messages=withAiCentre('en',en);
const OWN=vi.hoisted(()=>'5b9c9f7f-bd09-4d8d-a34d-201b1abf79e2');
const state=vi.hoisted(()=>({types:vi.fn(),assistant:true,currency:vi.fn()}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator}=await import('next-intl');
 const base=(await import('../messages/en.json')).default;
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const merged=merge('en',base);
 return {getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:merged,namespace:namespace as never}),getLocale:async()=>'en'};
});
vi.mock('@/lib/session',()=>({getSession:async()=>({tenantId:'fictional-tenant',userId:'login',personId:'own-person'})}));
vi.mock('@/lib/authz',()=>({requireModule:async()=>undefined}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('notFound');},useRouter:()=>({push:vi.fn()})}));
vi.mock('@/core/read',()=>({myEmployment:async()=>null,myOwnEmploymentSubjects:async()=>[{employmentId:OWN,personName:'Fictional owner',company:'Fictional Ceria Sdn Bhd',employeeCode:'F-1'}]}));
vi.mock('@/packs/claims/service',()=>({getEmployeeClaimTypes:state.types,listClaimsForEmployment:async()=>[],claimRecordFacts:async()=>new Map()}));
vi.mock('@/app/claims/actions',()=>({cancelClaimAction:vi.fn(),deleteDraftAction:vi.fn(),submitClaimAction:vi.fn(),submitDraftsAction:vi.fn()}));
vi.mock('@/core/assistant-grant',()=>({mayUseAssistant:async()=>({allowed:state.assistant})}));
vi.mock('@/core/mobile-claims',()=>({currencyOfEmployment:state.currency}));
import Page from '../app/claims/page';

const TYPE='77777777-7777-4777-8777-777777777777';
const balance={claimTypeId:TYPE,typeCode:'TRV',typeName:'Travel',items:[],annualLimit:2000,usedThisYear:620,reservedThisYear:120,remainingThisYear:1380,monthlyLimit:null,usedThisMonth:0,
 remainingThisMonth:null,perClaimCap:500,lifetimeLimit:null,usedLifetime:0,claimsUsedThisYear:3,maxClaimsPerYear:null,blockLimit:null,usedThisBlock:0,remainingThisBlock:null,blockEndsOn:null,
 policyValidFrom:'2026-01-01',policyGradeScoped:false};
const text=(el:Element|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const show=async(why?:string)=>{
 const tree=await resolveServerTree(await Page({searchParams:Promise.resolve({employmentId:OWN,...(why?{why}:{})})}));
 return render(<NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">{tree}</NextIntlClientProvider>);
};
beforeEach(()=>{state.assistant=true;state.types.mockReset().mockResolvedValue([{id:TYPE,code:'TRV',name:'Travel',requiresReceipt:false,rateConfig:null,isMileage:false,maxReceiptAgeDays:45,items:[],formFields:[],balance}]);
 state.currency.mockReset().mockResolvedValue('MYR');});
afterEach(cleanup);

describe('the claim limit Why? on Claims',()=>{
 it('offers Why? beside the selected type\'s balance, keeping only the chosen employment',async()=>{
  const view=await show();
  const link=within(view.container).getByRole('link',{name:'Why? Why is my Travel limit this figure?'});
  expect(link).toHaveAttribute('href',`/claims?employmentId=${OWN}&why=claim%3A${TYPE}`);expect(link).toHaveAttribute('aria-expanded','false');
  expect(view.container.querySelector('[data-why-panel]')).toBeNull();
  // Nothing is read for the panel until it is asked for.
  expect(state.currency).not.toHaveBeenCalled();
 });
 it('opens the explanation in place with the claims owner\'s figures, the policy version and Ask AI Centre',async()=>{
  const view=await show(`claim:${TYPE}`);
  const panel=view.container.querySelector('[data-why-panel="claim"]')!;
  expect(panel).not.toBeNull();
  expect(text(panel.querySelector('h3'))).toBe('Your Travel limit');
  expect([...panel.querySelectorAll('[data-why-figures] > div')].map(div=>[text(div.querySelector('dt')),text(div.querySelector('dd'))])).toEqual([
   ['Yearly limit','MYR 2,000.00'],['Used this year','MYR 620.00'],['Of which waiting for approval','MYR 120.00'],['Left this year','MYR 1,380.00'],['Most for one claim','MYR 500.00']]);
  expect([...panel.querySelectorAll('[data-why-note]')].map(text)[0]).toBe('These limits come from the policy for all grades, in force from Jan 1, 2026.');
  expect(within(panel as HTMLElement).getByRole('button',{name:'Ask AI Centre about this'})).toBeTruthy();
  expect(within(panel as HTMLElement).getByRole('link',{name:'Close'})).toHaveAttribute('href',`/claims?employmentId=${OWN}`);
  expect(within(view.container).getByRole('link',{name:'Why? Why is my Travel limit this figure?'})).toHaveAttribute('aria-expanded','true');
  expect(state.currency).toHaveBeenCalledWith(expect.anything(),OWN);
  expect(state.types).toHaveBeenCalledTimes(1);
 });
 it('shows the figures without Ask to someone the Assistant cannot answer, and nothing for a type that is not theirs',async()=>{
  state.assistant=false;
  const quiet=await show(`claim:${TYPE}`);
  expect(quiet.container.querySelector('[data-why-panel="claim"]')).not.toBeNull();expect(quiet.container.querySelector('[data-why-ask]')).toBeNull();
  cleanup();
  const stranger=await show('claim:88888888-8888-4888-8888-888888888888');
  expect(stranger.container.querySelector('[data-why-panel]')).toBeNull();
 });
});
