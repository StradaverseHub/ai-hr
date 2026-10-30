/** @vitest-environment jsdom */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {CompensationMaintenancePanel} from '../components/assistant/compensation-maintenance-panel';
import {COMPENSATION_MAINTENANCE_ACTION as action} from '../lib/assistant-actions/compensation-maintenance-contract';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
const translation=vi.hoisted(()=>({messages:null as null|Record<string,unknown>}));
vi.mock('next-intl',()=>({useTranslations:()=>((key:string,values?:Record<string,string>)=>{let text:unknown=translation.messages;for(const part of key.split('.'))text=(text as Record<string,unknown>)?.[part];if(typeof text!=='string')return key;return text.replace(/\{(\w+)\}/g,(_,name:string)=>values?.[name]??name);}),useFormatter:()=>({dateTime:(date:Date)=>date.toISOString().slice(0,10)})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
const employmentId='61000000-0000-4000-8000-000000000002',compensationId='61000000-0000-4000-8000-000000000003',actionId='61000000-0000-4000-8000-000000000004',eventId='61000000-0000-4000-8000-000000000005',previousId='61000000-0000-4000-8000-000000000006';
const person={employmentId,employeeName:'Fictional Dana',employeeCode:'E-7',companyName:'Fictional Company'};
const fields={basicSalary:'2750.29',currency:'SGD',payMode:'monthly',paymentTerm:'monthly',rateAmount:null,remarks:'Fictional human salary change',effectiveFrom:'2026-06-01'};
const before={basicSalary:'2000.17',currency:'MYR',monthlyAllowance:'123.45',payMode:'monthly',paymentTerm:'monthly',rateAmount:null,remarks:'Fictional existing salary',validFrom:'2026-01-01',validTo:null as string|null,superseded:false};
const after={...before,basicSalary:fields.basicSalary,currency:fields.currency,remarks:fields.remarks,validFrom:fields.effectiveFrom};
const choices={kind:'choices',employees:[person],truncated:false,history:[{id:compensationId,fields:before,revision:'1'}]};
const content=(operation:'set'|'edit'|'supersede')=>({action,contractVersion:1,employmentId,subjectId:employmentId,operation,compensationId:operation==='set'?null:compensationId,fields:operation==='supersede'?null:fields});
const prepared=(operation:'set'|'edit'|'supersede'='set')=>({kind:'prepared',review:{action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64),createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),content:content(operation),review:{...person,subjectId:employmentId,operation,compensationId:operation==='set'?null:compensationId,recalculationPeriods:[],changes:operation==='set'?[{id:compensationId,before,after:{...before,validTo:fields.effectiveFrom}},{id:null,before:null,after}]:operation==='edit'?[{id:compensationId,before,after}]:[{id:compensationId,before,after:{...before,superseded:true}},{id:previousId,before:{...before,basicSalary:'1800.00',validFrom:'2025-01-01',validTo:'2026-01-01'},after:{...before,basicSalary:'1800.00',validFrom:'2025-01-01'}}]},consequence:'salary_history_changed_not_payroll_generated_approved_or_paid'}});
const completed={kind:'completed',receipt:{action,contractVersion:1,actionId,state:'completed',receipt:{kind:'maintained',subjectId:employmentId,employmentId,compensationId,eventId,operation:'set'}}};
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
const fetcher=vi.fn(),packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
beforeEach(()=>{translation.messages=null;fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function chooseEmployee(){await screen.findByRole('option',{name:/Fictional Dana/});await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(''));fireEvent.change(screen.getByLabelText('employee'),{target:{value:employmentId}});await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(''));}
async function fillSet(){await chooseEmployee();for(const key of ['basicSalary','currency','remarks','effectiveFrom'] as const)fireEvent.change(screen.getByLabelText('fields.'+key),{target:{value:fields[key]}});fireEvent.click(screen.getByLabelText('consent'));}
it('sends only human-entered exact salary values and requires separate review consent before confirming',async()=>{
 fetcher.mockResolvedValueOnce(json({...choices,history:[]})).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockResolvedValueOnce(json(completed));render(<CompensationMaintenancePanel/>);await fillSet();
 fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('heading',{name:'reviewTitle'});expect(packets()[2]).toEqual({action,operation:'prepare',input:content('set')});
 expect(screen.getAllByText('2750.29')).not.toHaveLength(0);expect(screen.getAllByText('SGD')).not.toHaveLength(0);expect(screen.getAllByText('123.45')).not.toHaveLength(0);expect(screen.getAllByText('2026-06-01')).not.toHaveLength(0);expect(screen.getByText('newRecord')).toBeTruthy();
 const confirm=screen.getByRole('button',{name:'confirm'}) as HTMLButtonElement;expect(confirm.disabled).toBe(true);fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(confirm);await screen.findByRole('heading',{name:'done'});
 expect(packets()[3]).toEqual({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64)}});
});
it('selects an existing record for removal and reviews the predecessor window',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared('supersede')));render(<CompensationMaintenancePanel/>);await chooseEmployee();fireEvent.change(screen.getByLabelText('operation'),{target:{value:'supersede'}});expect((screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('record'),{target:{value:compensationId}});fireEvent.click(screen.getByLabelText('consent'));fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('heading',{name:'reviewTitle'});
 expect(packets()[2]).toEqual({action,operation:'prepare',input:content('supersede')});expect(screen.getAllByText('1800.00')).toHaveLength(2);expect(screen.getByText('yes')).toBeTruthy();
});
it('recovers confirmation response loss by reopening the saved review without a second confirmation',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json(completed));render(<CompensationMaintenancePanel/>);await fillSet();fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('heading',{name:'reviewTitle'});fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(screen.getByRole('button',{name:'confirm'}));await screen.findByText('uncertain');fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'done'});
 expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(1);expect(packets()[4]).toEqual({action,operation:'reopen',actionId});
});
it('refuses a response that substitutes the employee or salary content',async()=>{
 const wrong=prepared();wrong.review.content.fields={...fields,basicSalary:'9999.99'};fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(wrong));render(<CompensationMaintenancePanel/>);await fillSet();fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByText('uncertainUnknown');expect(screen.queryByRole('heading',{name:'reviewTitle'})).toBeNull();expect(packets().filter(packet=>packet.operation==='confirm')).toEqual([]);
});
for(const [locale,messages]of Object.entries({en,ms,zh,vi:viMessages,th,ta}))it(`renders exact salary and adjacent windows with recovery controls in ${locale}`,async()=>{
 const copy=messages.assistant.workspace.compensationMaintenance;translation.messages=copy;fetcher.mockResolvedValueOnce(json(prepared()));const view=render(<main className="mx-auto max-w-4xl"><CompensationMaintenancePanel resumeActionId={actionId}/></main>);fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByRole('heading',{name:copy.reviewTitle});
 expect(screen.getByText(copy.consequence)).toBeTruthy();expect(screen.getAllByText('2750.29')).not.toHaveLength(0);expect(screen.getAllByText('SGD')).not.toHaveLength(0);expect(screen.getAllByText('2026-06-01')).not.toHaveLength(0);expect(screen.getByRole('button',{name:copy.confirm})).toBeTruthy();
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'chat-card-compensation-salary','real salary review panel; fictional salary and dates; scripted same-origin endpoint; no authenticated server journey');
},30000);
it('refuses confirmation of an expired review',async()=>{
 const expired=prepared();expired.review.createdAt=new Date(Date.now()-120000).toISOString();expired.review.expiresAt=new Date(Date.now()-60000).toISOString();fetcher.mockResolvedValueOnce(json(expired));render(<CompensationMaintenancePanel resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'reviewTitle'});expect(screen.getByText('expired')).toBeTruthy();expect((screen.getByRole('button',{name:'confirm'}) as HTMLButtonElement).disabled).toBe(true);
});
