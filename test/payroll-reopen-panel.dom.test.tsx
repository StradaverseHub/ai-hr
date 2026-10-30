// @vitest-environment jsdom
import React from 'react';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import viMessages from '../messages/vi.json';import th from '../messages/th.json';import ta from '../messages/ta.json';
const source=vi.hoisted(()=>({locale:'en',fetch:vi.fn()}));
const messages={en,ms,zh,vi:viMessages,th,ta};
vi.mock('next-intl',()=>({useTranslations:()=>((key:string)=>(messages[source.locale as keyof typeof messages].assistant.workspace.payrollReopen as Record<string,string>)[key]??key)}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
vi.mock('../components/ui',()=>({Button:({children,variant:_,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string})=><button {...props}>{children}</button>,inputCls:''}));
import {PayrollReopenPanel} from '../components/assistant/payroll-reopen-panel';
const id='10000000-0000-4000-8000-000000000001',batchId='10000000-0000-4000-8000-000000000002',action='payroll.reopen';
const t=en.assistant.workspace.payrollReopen;
const content={action,contractVersion:1,batchId,reason:'Human reason',confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true};
const review={action,contractVersion:1,actionId:id,reviewedDigest:'a'.repeat(64),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),content,review:{batchId,companyId:id,companyName:'Fictional Company',payPeriodId:id,payPeriod:'2026-10',runType:'regular',runSeq:1,cycleName:null,beforeStatus:'closed',afterStatus:'processed',beforePeriodStatus:'closed',afterPeriodStatus:'open',parentWillReopen:true,warnings:{paymentDisbursed:true,statutoryFiled:true,statutoryFiledCount:1,statutoryReportCount:2},paymentWarningMeaning:'recorded_payment_summary_export_not_verified_bank_settlement',consequence:'enable_later_payroll_edits_no_recalculation_payment_reversal_or_statutory_withdrawal'}};
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
beforeEach(()=>{source.locale='en';source.fetch.mockReset();vi.stubGlobal('fetch',source.fetch);});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('Payroll reopening human review',()=>{
 it.each(Object.keys(messages))('renders actual %s copy and never executes or recovers automatically',locale=>{source.locale=locale;render(<PayrollReopenPanel resumeActionId={id}/>);const copy=messages[locale as keyof typeof messages].assistant.workspace.payrollReopen;expect(screen.getByRole('button',{name:copy.recover})).toBeTruthy();expect(screen.getByText(copy.uncertain)).toBeTruthy();expect(source.fetch).not.toHaveBeenCalled();});
 it('requires authored reason and separate final consent, shows native consequences/export warnings, and preserves same ID after confirmation timeout',async()=>{
  render(<PayrollReopenPanel/>);source.fetch.mockResolvedValueOnce(json({kind:'choices',batches:[{batchId,companyName:'Fictional Company',payPeriod:'2026-10',cycleName:null}]}));fireEvent.click(screen.getByRole('button',{name:t.load}));await screen.findByLabelText(t.run);fireEvent.change(screen.getByLabelText(t.run),{target:{value:batchId}});fireEvent.change(screen.getByLabelText(t.reason),{target:{value:'Human reason'}});expect(screen.getByRole('button',{name:t.prepare}).hasAttribute('disabled')).toBe(true);fireEvent.click(screen.getByLabelText(t.authored));source.fetch.mockResolvedValueOnce(json({kind:'prepared',review}));fireEvent.click(screen.getByRole('button',{name:t.prepare}));await screen.findByText(t.parentReopens);expect(screen.getByText(t.consequence)).toBeTruthy();expect(screen.getByRole('button',{name:t.confirm}).hasAttribute('disabled')).toBe(true);fireEvent.click(screen.getByLabelText(t.confirmConsent));source.fetch.mockRejectedValueOnce(Error('PRIVATE provider failure'));fireEvent.click(screen.getByRole('button',{name:t.confirm}));await screen.findByText(t.uncertain);expect(screen.queryByText('PRIVATE provider failure')).toBeNull();expect(source.fetch.mock.calls.map(call=>JSON.parse(call[1].body)).at(-1)).toEqual({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId:id,reviewedDigest:'a'.repeat(64)}});
  source.fetch.mockResolvedValueOnce(json({kind:'prepared',review}));fireEvent.click(screen.getByRole('button',{name:t.recover}));await screen.findByText(t.parentReopens);expect(JSON.parse(source.fetch.mock.calls.at(-1)![1].body)).toEqual({action,operation:'reopen',actionId:id});
 });
});
