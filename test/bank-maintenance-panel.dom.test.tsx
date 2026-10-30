/** @vitest-environment jsdom */
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {BankMaintenancePanel} from '../components/assistant/bank-maintenance-panel';
import {BANK_MAINTENANCE_ACTION as action} from '../lib/assistant-actions/bank-maintenance-contract';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
const translation=vi.hoisted(()=>({messages:null as null|Record<string,unknown>}));
vi.mock('next-intl',()=>({useTranslations:()=>((key:string,values?:Record<string,string>)=>{let text:unknown=translation.messages;for(const part of key.split('.'))text=(text as Record<string,unknown>)?.[part];if(typeof text!=='string')return values?`${key}:${Object.values(values).join('|')}`:key;return text.replace(/\{(\w+)\}/g,(_,name:string)=>values?.[name]??name);}),useFormatter:()=>({dateTime:(date:Date)=>date.toISOString().slice(0,10)})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));

const employmentId='60000000-0000-4000-8000-000000000002',subjectId='60000000-0000-4000-8000-000000000001',actionId='60000000-0000-4000-8000-000000000004';
const person={employmentId,subjectId,employeeName:'Fictional Dana',employeeCode:'E-7',companyName:'Fictional Company',supported:true};
const before={bankName:'Fictional old bank',bankAccountNo:'000-OLD',enableCustomHolderName:true,customHolderName:'Old payee',enableCustomHolderId:true,customHolderId:'OLD-ID'};
const after={bankName:'Fictional new bank',bankAccountNo:'000-NEW',enableCustomHolderName:false,customHolderName:null,enableCustomHolderId:false,customHolderId:null};
const prepared=()=>({kind:'prepared',review:{action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64),createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),content:{action,contractVersion:1,employmentId,subjectId,fields:after},review:{...person,country:'MY',before,after,sharedPerson:true},consequence:'bank_destination_saved_not_payment_processed_or_statutory_changed'}});
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}),fetcher=vi.fn();
beforeEach(()=>{translation.messages=null;fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('requires separate human confirmation and sends only the exact action id and reviewed digest',async()=>{fetcher.mockResolvedValueOnce(json(prepared())).mockRejectedValueOnce(Error('lost response'));render(<BankMaintenancePanel resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'reviewTitle'});expect((screen.getByRole('button',{name:'confirm'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByLabelText('confirmConsent'));fireEvent.click(screen.getByRole('button',{name:'confirm'}));await screen.findByRole('button',{name:'reopen'});const packet=JSON.parse(fetcher.mock.calls[1][1].body);expect(packet).toEqual({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64)}});expect(fetcher).toHaveBeenCalledTimes(2);});
it('refuses an expired bank review',async()=>{const body=prepared();body.review.expiresAt=new Date(Date.now()-60000).toISOString();fetcher.mockResolvedValueOnce(json(body));render(<BankMaintenancePanel resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('heading',{name:'reviewTitle'});expect(screen.queryByLabelText('confirmConsent')).toBeNull();expect((screen.getByRole('button',{name:'confirm'}) as HTMLButtonElement).disabled).toBe(true);});
for(const [locale,messages]of Object.entries({en,ms,zh,vi:viMessages,th,ta}))it(`renders exact bank/holder clear review in ${locale} on desktop/mobile`,async()=>{const copy=messages.assistant.workspace.bankMaintenance;translation.messages=copy;fetcher.mockResolvedValueOnce(json(prepared()));const view=render(<main className="mx-auto max-w-4xl"><BankMaintenancePanel resumeActionId={actionId}/></main>);fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByRole('heading',{name:copy.reviewTitle});expect(screen.getByText('000-OLD')).toBeTruthy();expect(screen.getByText('000-NEW')).toBeTruthy();expect(screen.getByText(copy.sharedNote)).toBeTruthy();expect(screen.getByText(copy.consequence)).toBeTruthy();await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'chat-card-bank-maintenance','real bank review panel; fictional bank/holder values; scripted same-origin endpoint; no authenticated server journey');},30000);
