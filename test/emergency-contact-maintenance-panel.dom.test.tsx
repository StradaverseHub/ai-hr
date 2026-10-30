/** @vitest-environment jsdom */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {EmergencyContactMaintenancePanel} from '../components/assistant/emergency-contact-maintenance-panel';
import {EMERGENCY_CONTACT_MAINTENANCE_ACTION as action} from '../lib/assistant-actions/emergency-contact-maintenance-contract';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
const translation=vi.hoisted(()=>({messages:null as null|Record<string,unknown>}));
vi.mock('next-intl',()=>({useTranslations:()=>((key:string,values?:Record<string,string>)=>{let text:unknown=translation.messages;for(const part of key.split('.'))text=(text as Record<string,unknown>)?.[part];if(typeof text!=='string')return values?`${key}:${Object.values(values).join('|')}`:key;return text.replace(/\{(\w+)\}/g,(_,name:string)=>values?.[name]??name);}),useFormatter:()=>({dateTime:(date:Date)=>date.toISOString().slice(0,10)})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
const employmentId='60000000-0000-4000-8000-000000000002',subjectId='60000000-0000-4000-8000-000000000001',contactId='60000000-0000-4000-8000-000000000003',actionId='60000000-0000-4000-8000-000000000004',eventId='60000000-0000-4000-8000-000000000005';
const person={employmentId,subjectId,employeeName:'Fictional Dana',employeeCode:'E-7',companyName:'Fictional Company'};
const fields={fullName:'Fictional Contact',relationship:'Spouse',mobilePhone:'000-FICTIONAL',homePhone:null,address:'Fictional Address',remarks:'Human note',priority:'primary'};
const previous={...fields,fullName:'Fictional Previous Primary',relationship:'Parent',mobilePhone:'000-PREVIOUS'};
const choices={kind:'choices',employees:[person],truncated:false,contacts:[{id:contactId,fields,revision:'1'}],options:[{value:'Spouse',label:'Spouse'}]};
const content=(operation:'add'|'update'|'archive')=>({action,contractVersion:1,employmentId,subjectId,operation,contactId:operation==='add'?null:contactId,fields:operation==='archive'?null:fields});
const prepared=(operation:'add'|'update'|'archive'='add')=>({kind:'prepared',review:{action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64),createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),content:content(operation),review:{...person,operation,contactId:operation==='add'?null:contactId,before:operation==='add'?null:fields,after:operation==='archive'?null:fields,demotesPrimary:operation==='add'?{id:contactId,fields:previous}:null,sharedPerson:true},consequence:'shared_person_emergency_register_changed_not_employment_or_pay'}});
const completed={kind:'completed',receipt:{action,contractVersion:1,actionId,state:'completed',receipt:{kind:'maintained',subjectId,employmentId,contactId,eventId,operation:'add',sharedPerson:true}}};
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
const fetcher=vi.fn(),packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
beforeEach(()=>{translation.messages=null;fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function chooseEmployee(){await screen.findByRole('option',{name:/Fictional Dana/});await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(''));fireEvent.change(screen.getByLabelText('employee'),{target:{value:employmentId}});await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(''));}
async function fillAdd(){await chooseEmployee();for(const key of ['fullName','relationship','mobilePhone','address','remarks'] as const)fireEvent.change(screen.getByLabelText('fields.'+key),{target:{value:fields[key]}});fireEvent.change(screen.getByLabelText('fields.priority'),{target:{value:'primary'}});fireEvent.click(screen.getByLabelText('consent'));}
it('uses the selected PERSON subject, shows shared-person scope and exact previous-primary demotion before confirmation',async()=>{
 fetcher.mockResolvedValueOnce(json({...choices,contacts:[]})).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockResolvedValueOnce(json(completed));render(<EmergencyContactMaintenancePanel/>);await fillAdd();
 fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('heading',{name:'reviewTitle'});expect(packets()[2]).toEqual({action,operation:'prepare',input:content('add')});expect(screen.getByText('Fictional Previous Primary')).toBeTruthy();expect(screen.getByText('000-PREVIOUS')).toBeTruthy();expect(screen.getByText('after: priorities.secondary')).toBeTruthy();expect(screen.getByText('sharedNote')).toBeTruthy();
 const confirm=screen.getByRole('button',{name:'confirm'}) as HTMLButtonElement;expect(confirm.disabled).toBe(true);fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(confirm);await screen.findByRole('heading',{name:'done'});expect(packets()[3]).toEqual({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64)}});
});
it('archives only a chosen contact without inventing field edits',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared('archive')));render(<EmergencyContactMaintenancePanel/>);await chooseEmployee();fireEvent.change(screen.getByLabelText('operation'),{target:{value:'archive'}});expect((screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('record'),{target:{value:contactId}});fireEvent.click(screen.getByLabelText('consent'));fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('heading',{name:'reviewTitle'});expect(packets()[2]).toEqual({action,operation:'prepare',input:content('archive')});expect(screen.queryByText('primaryTransfer')).toBeNull();
});
it('recovers a lost confirmation by reopening the same id without a second confirm',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json(completed));render(<EmergencyContactMaintenancePanel/>);await fillAdd();fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('heading',{name:'reviewTitle'});fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(screen.getByRole('button',{name:'confirm'}));await screen.findByText('uncertain');fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'done'});expect(packets()[4]).toEqual({action,operation:'reopen',actionId});expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(1);
});
it('refuses a review substituting the chosen person even when the employment id is unchanged',async()=>{
 const wrong='60000000-0000-4000-8000-0000000000ff',response=prepared();response.review.content.subjectId=wrong;response.review.review.subjectId=wrong;fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(response));render(<EmergencyContactMaintenancePanel/>);await fillAdd();fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('alert');expect(screen.queryByRole('heading',{name:'reviewTitle'})).toBeNull();
});
it('clears contact values and consent on operation changes',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(choices));render(<EmergencyContactMaintenancePanel/>);await fillAdd();fireEvent.change(screen.getByLabelText('operation'),{target:{value:'update'}});expect((screen.getByLabelText('consent') as HTMLInputElement).checked).toBe(false);expect((screen.getByLabelText('fields.fullName') as HTMLInputElement).value).toBe('');expect((screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement).disabled).toBe(true);
});
it('keeps priority-like arbitrary contact names exact rather than translating them',async()=>{
 const response=prepared('archive');response.review.review.before!.fullName='primary';fetcher.mockResolvedValueOnce(json(response));render(<EmergencyContactMaintenancePanel resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'reviewTitle'});expect(screen.getByText('primary')).toBeTruthy();
});
it('disables confirmation after the review expires',async()=>{
 const response=prepared('archive');response.review.createdAt=new Date(Date.now()-120000).toISOString();response.review.expiresAt=new Date(Date.now()-60000).toISOString();fetcher.mockResolvedValueOnce(json(response));render(<EmergencyContactMaintenancePanel resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'reviewTitle'});expect((screen.getByRole('button',{name:'confirm'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByLabelText('confirmConsent')).toBeNull();
});
for(const [locale,messages]of Object.entries({en,ms,zh,vi:viMessages,th,ta}))for(const operation of ['add','archive'] as const)it(`renders shared-person ${operation} review in ${locale} on desktop/mobile`,async()=>{
 const copy=messages.assistant.workspace.emergencyContactMaintenance;translation.messages=copy;fetcher.mockResolvedValueOnce(json(prepared(operation)));const view=render(<main className="mx-auto max-w-4xl"><EmergencyContactMaintenancePanel resumeActionId={actionId}/></main>);fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByRole('heading',{name:copy.reviewTitle});expect(screen.getByText(copy.sharedNote)).toBeTruthy();expect(screen.getByText(copy.consequence)).toBeTruthy();if(operation==='add'){expect(screen.getByText('Fictional Previous Primary')).toBeTruthy();expect(screen.getByText(copy.after+': '+copy.priorities.secondary)).toBeTruthy();}
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,`chat-card-emergency-contact-${operation}`,'real emergency contact panel and controls; fictional shared-person contact; scripted same-origin endpoint; no authenticated server journey');
},30000);
