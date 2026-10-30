/** @vitest-environment jsdom */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {QualificationMaintenancePanel} from '../components/assistant/qualification-maintenance-panel';
import {QUALIFICATION_MAINTENANCE_ACTION as action} from '../lib/assistant-actions/qualification-maintenance-contract';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
const translation=vi.hoisted(()=>({messages:null as null|Record<string,unknown>}));
vi.mock('next-intl',()=>({useTranslations:()=>((key:string,values?:Record<string,string>)=>{let text:unknown=translation.messages;for(const part of key.split('.'))text=(text as Record<string,unknown>)?.[part];if(typeof text!=='string')return values?.name??key;return text.replace(/\{(\w+)\}/g,(_,name:string)=>values?.[name]??name);}),useFormatter:()=>({dateTime:(date:Date)=>date.toISOString().slice(0,10)})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
const employmentId='60000000-0000-4000-8000-000000000002',qualificationId='60000000-0000-4000-8000-000000000003',actionId='60000000-0000-4000-8000-000000000004',eventId='60000000-0000-4000-8000-000000000005';
const person={employmentId,employeeName:'Fictional Dana',employeeCode:'E-7',companyName:'Fictional Company'};
const fields={qualification:'Bachelor',description:'Fictional study',fromYm:'2015-01',toYm:'2018-12',institute:'Fictional Institute',major:'History',graduationDate:'2018-12-14',result:'Pass',isHighest:true};
const choices={kind:'choices',employees:[person],truncated:false,qualifications:[{id:qualificationId,fields,revision:'1'}],options:[{value:'Bachelor',label:'Bachelor'}]};
const content=(operation:'add'|'update'|'archive')=>({action,contractVersion:1,employmentId,subjectId:employmentId,operation,qualificationId:operation==='add'?null:qualificationId,fields:operation==='archive'?null:fields});
const prepared=(operation:'add'|'update'|'archive'='add')=>({kind:'prepared',review:{action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64),createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),content:content(operation),review:{...person,subjectId:employmentId,operation,qualificationId:operation==='add'?null:qualificationId,before:operation==='add'?null:fields,after:operation==='archive'?null:fields,clearsHighestId:operation==='add'?qualificationId:null,clearsHighest:operation==='add'?{id:qualificationId,fields:{...fields,qualification:'Certificate',institute:'Fictional Earlier Institute'}}:null},consequence:'qualification_register_changed_not_employment_or_pay'}});
const completed={kind:'completed',receipt:{action,contractVersion:1,actionId,state:'completed',receipt:{kind:'maintained',subjectId:employmentId,employmentId,qualificationId,eventId,operation:'add'}}};
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
const fetcher=vi.fn(),packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
beforeEach(()=>{translation.messages=null;fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function chooseEmployee(){await screen.findByRole('option',{name:/Fictional Dana/});await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(''));fireEvent.change(screen.getByLabelText('employee'),{target:{value:employmentId}});await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(''));}
async function fillAdd(){await chooseEmployee();for(const key of ['qualification','description','fromYm','toYm','institute','major','graduationDate','result'] as const)fireEvent.change(screen.getByLabelText('fields.'+key),{target:{value:fields[key]}});fireEvent.click(screen.getByLabelText('fields.isHighest'));fireEvent.click(screen.getByLabelText('consent'));}
it('loads selected employee records, requires human input and reviews highest transfer before confirmation',async()=>{
 fetcher.mockResolvedValueOnce(json({...choices,qualifications:[]})).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockResolvedValueOnce(json(completed));
 render(<QualificationMaintenancePanel/>);await fillAdd();
 expect(packets()[0]).toEqual({action,operation:'choices',selection:{query:''}});expect(packets()[1]).toEqual({action,operation:'choices',selection:{query:'',employmentId}});
 fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('heading',{name:'reviewTitle'});
 expect(packets()[2]).toEqual({action,operation:'prepare',input:content('add')});expect(screen.getByText('highestTransfer')).toBeTruthy();expect(screen.getByText('Certificate')).toBeTruthy();expect(screen.getByText('Fictional Earlier Institute')).toBeTruthy();expect(screen.getByText('before: yes')).toBeTruthy();expect(screen.getByText('after: no')).toBeTruthy();expect(screen.getAllByText('Fictional Institute')).toHaveLength(1);
 const confirm=screen.getByRole('button',{name:'confirm'}) as HTMLButtonElement;expect(confirm.disabled).toBe(true);fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(confirm);
 await screen.findByRole('heading',{name:'done'});expect(packets()[3]).toEqual({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64)}});
});
it('archives only a chosen native record and shows its removal before confirmation',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared('archive')));
 render(<QualificationMaintenancePanel/>);await chooseEmployee();fireEvent.change(screen.getByLabelText('operation'),{target:{value:'archive'}});
 expect((screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('record'),{target:{value:qualificationId}});fireEvent.click(screen.getByLabelText('consent'));fireEvent.click(screen.getByRole('button',{name:'prepare'}));
 await screen.findByRole('heading',{name:'reviewTitle'});expect(packets()[2]).toEqual({action,operation:'prepare',input:content('archive')});expect(screen.getByText('Fictional Institute')).toBeTruthy();expect(screen.queryByText('highestTransfer')).toBeNull();
});
it('recovers a lost confirmation by reopening its saved id without a second confirm',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(prepared())).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json(completed));
 render(<QualificationMaintenancePanel/>);await fillAdd();fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByRole('heading',{name:'reviewTitle'});fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(screen.getByRole('button',{name:'confirm'}));
 await screen.findByText('uncertain');fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'done'});
 expect(packets()[4]).toEqual({action,operation:'reopen',actionId});expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(1);
});
it('refuses a response that substitutes the chosen employee',async()=>{
 const wrong='60000000-0000-4000-8000-0000000000ff',response=prepared();response.review.content.employmentId=wrong;response.review.content.subjectId=wrong;response.review.review.employmentId=wrong;response.review.review.subjectId=wrong;
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(response));render(<QualificationMaintenancePanel/>);await fillAdd();fireEvent.click(screen.getByRole('button',{name:'prepare'}));
 await screen.findByRole('alert');expect(screen.queryByRole('heading',{name:'reviewTitle'})).toBeNull();expect(packets().filter(packet=>packet.operation==='confirm')).toHaveLength(0);
});
it('clears draft values and consent when the operation changes',async()=>{
 fetcher.mockResolvedValueOnce(json(choices)).mockResolvedValueOnce(json(choices));render(<QualificationMaintenancePanel/>);await fillAdd();fireEvent.change(screen.getByLabelText('operation'),{target:{value:'update'}});
 expect((screen.getByLabelText('consent') as HTMLInputElement).checked).toBe(false);expect((screen.getByLabelText('fields.qualification') as HTMLInputElement).value).toBe('');expect((screen.getByRole('button',{name:'prepare'}) as HTMLButtonElement).disabled).toBe(true);
});
for(const [locale,messages]of Object.entries({en,ms,zh,vi:viMessages,th,ta})){
 it(`renders the canonical archive review and recovery controls in ${locale}`,async()=>{
  const copy=messages.assistant.workspace.qualificationMaintenance;translation.messages=copy;
  fetcher.mockResolvedValueOnce(json(prepared('archive')));const view=render(<main className="mx-auto max-w-4xl"><QualificationMaintenancePanel resumeActionId={actionId}/></main>);
  fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByRole('heading',{name:copy.reviewTitle});
  expect(screen.getByText(copy.consequence)).toBeTruthy();expect(screen.getByText(copy.operations.archive)).toBeTruthy();expect(screen.getByRole('button',{name:copy.confirm})).toBeTruthy();expect(screen.getByText(copy.fields.qualification)).toBeTruthy();
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'chat-card-qualification-archive','real qualification panel and controls; fictional qualification; scripted same-origin endpoint; no authenticated server journey');
 },30000);
 it(`identifies the previous highest qualification in ${locale}`,async()=>{
  const copy=messages.assistant.workspace.qualificationMaintenance;translation.messages=copy;
  fetcher.mockResolvedValueOnce(json(prepared('add')));const view=render(<main className="mx-auto max-w-4xl"><QualificationMaintenancePanel resumeActionId={actionId}/></main>);
  fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByRole('heading',{name:copy.reviewTitle});
  expect(screen.getByText('Fictional Earlier Institute')).toBeTruthy();expect(screen.getByText('Certificate')).toBeTruthy();expect(screen.getByText(copy.before+': '+copy.yes)).toBeTruthy();expect(screen.getByText(copy.after+': '+copy.no)).toBeTruthy();
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'chat-card-qualification-highest','real qualification panel and controls; fictional highest-qualification transfer; scripted same-origin endpoint; no authenticated server journey');
 },30000);
}
it('disables confirmation after the saved review expires',async()=>{
 const response=prepared('archive');response.review.createdAt=new Date(Date.now()-120000).toISOString();response.review.expiresAt=new Date(Date.now()-60000).toISOString();
 fetcher.mockResolvedValueOnce(json(response));render(<QualificationMaintenancePanel resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'reviewTitle'});
 expect(screen.getByText('expired')).toBeTruthy();expect((screen.getByRole('button',{name:'confirm'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByLabelText('confirmConsent')).toBeNull();
});
