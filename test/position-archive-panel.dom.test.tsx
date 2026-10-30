/** @vitest-environment jsdom */
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {PositionArchivePanel} from '../components/assistant/position-archive-panel';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
const translation=vi.hoisted(()=>({messages:{} as Record<string,unknown>}));
vi.mock('next-intl',()=>({useTranslations:(namespace:string)=>(key:string)=>{let value:unknown=translation.messages;for(const part of (namespace+'.'+key).split('.'))value=(value as Record<string,unknown>)?.[part];if(typeof value!=='string')throw Error('Missing translation '+key);return value;},useFormatter:()=>({dateTime:(date:Date)=>date.toISOString()})}));
vi.mock('next/link',()=>({default:({children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
const action='org.position.archive',positionId='84000000-0000-4000-8000-000000000001',companyId='84000000-0000-4000-8000-000000000002',actionId='84000000-0000-4000-8000-000000000003',eventId='84000000-0000-4000-8000-000000000004';
const subject={positionId,companyId,companyName:'Fictional Company',title:'Fictional Position',archived:false,inUse:false},choices={kind:'choices' as const,positions:[subject],truncated:false};
const human={action,contractVersion:1,positionId,expectedArchived:false,archived:true},copy=en.assistant.workspace.positionArchive;
const prepared=()=>({kind:'prepared',review:{action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64),createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),content:human,review:{positionId,companyId,companyName:subject.companyName,title:subject.title,archived:false,afterArchived:true},consequence:'catalogue_archive_state_only_no_assignment_or_access_change'}});
const completed=()=>({kind:'completed',receipt:{action,contractVersion:1,actionId,state:'completed',receipt:{kind:'recorded',positionId,companyId,title:subject.title,archived:true,eventId,semantics:'native_position_archive_current_record'}}});
const fetcher=vi.fn(),json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}),packets=()=>fetcher.mock.calls.map(call=>JSON.parse(call[1].body));
beforeEach(()=>{translation.messages=en;fetcher.mockReset();vi.stubGlobal('fetch',fetcher);});afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
async function prepare(){fireEvent.change(screen.getByLabelText(copy.position),{target:{value:positionId}});fireEvent.click(screen.getByRole('button',{name:copy.prepare}));await screen.findByText(copy.consent);}
it('posts only the selected archive intent, then requires a separate explicit confirmation',async()=>{
 fetcher.mockResolvedValueOnce(json(prepared())).mockResolvedValueOnce(json(completed()));render(<PositionArchivePanel initialChoices={choices}/>);await prepare();expect(packets()).toEqual([{action,operation:'prepare',input:human}]);const confirm=screen.getByRole('button',{name:copy.confirm}) as HTMLButtonElement;expect(confirm.disabled).toBe(true);fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(confirm);await screen.findByText(copy.completed);expect(packets()[1]).toEqual({action,operation:'confirm',confirmation:{action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64)}});
});
it('recovers uncertain confirmation through the same saved ID without retrying the effect',async()=>{
 fetcher.mockResolvedValueOnce(json(prepared())).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json(completed()));render(<PositionArchivePanel initialChoices={choices}/>);await prepare();fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(screen.getByRole('button',{name:copy.confirm}));await screen.findByText(copy.uncertain);fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByText(copy.completed);expect(packets().filter(p=>p.operation==='confirm')).toHaveLength(1);expect(packets()[2]).toEqual({action,operation:'reopen',actionId});
});
it('disables archive for the grid in-use subset',()=>{render(<PositionArchivePanel initialChoices={{...choices,positions:[{...subject,inUse:true}]}}/>);fireEvent.change(screen.getByLabelText(copy.position),{target:{value:positionId}});expect((screen.getByRole('button',{name:copy.prepare}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText(copy.inUse)).toBeTruthy();expect(fetcher).not.toHaveBeenCalled();});
it('refuses a substituted position in the server review',async()=>{const forged=prepared();forged.review.review.positionId=companyId;fetcher.mockResolvedValueOnce(json(forged));render(<PositionArchivePanel initialChoices={choices}/>);fireEvent.change(screen.getByLabelText(copy.position),{target:{value:positionId}});fireEvent.click(screen.getByRole('button',{name:copy.prepare}));await screen.findByRole('alert');expect(screen.queryByText(copy.consent)).toBeNull();});
it('keeps expired review confirmation disabled',async()=>{const old=prepared();old.review.createdAt=new Date(Date.now()-120000).toISOString();old.review.expiresAt=new Date(Date.now()-60000).toISOString();fetcher.mockResolvedValueOnce(json(old));render(<PositionArchivePanel initialChoices={choices} resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:copy.reopen}));await screen.findByText(copy.expired);expect((screen.getByRole('button',{name:copy.confirm}) as HTMLButtonElement).disabled).toBe(true);});
it('allows actor-only discard UI after native permission loss',async()=>{fetcher.mockResolvedValueOnce(json({kind:'retired',receipt:{action,contractVersion:1,actionId,state:'discarded'}}));render(<PositionArchivePanel initialChoices={{kind:'unavailable'}} resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:copy.discard}));await screen.findByText(copy.retired);expect(packets()).toEqual([{action,operation:'discard',confirmation:{action,contractVersion:1,actionId}}]);});
for(const [locale,messages]of Object.entries({en,ms,zh,ta,th,vi:viMessages}))it(`renders native before/after and saved recovery in ${locale}`,async()=>{translation.messages=messages;const t=messages.assistant.workspace.positionArchive;fetcher.mockResolvedValueOnce(json(prepared()));render(<PositionArchivePanel initialChoices={choices} resumeActionId={actionId}/>);fireEvent.click(screen.getByRole('button',{name:t.reopen}));await screen.findByText(t.consent);expect(screen.getByText(t.before)).toBeTruthy();expect(screen.getByText(t.after)).toBeTruthy();expect(screen.getByText(subject.title)).toBeTruthy();expect(screen.getByText(subject.companyName)).toBeTruthy();expect((screen.getByRole('button',{name:t.confirm}) as HTMLButtonElement).disabled).toBe(true);await captureAiReviewScreenshots(aiReviewDomHtml(document.body),locale,'chat-card-position-archive','real position catalogue component; fictional native before/after; scripted endpoint, no authenticated server journey');},120000);

for(const phase of ['fetch','stream'] as const)it(`enables same-ID user recovery after a never-settling ${phase}, without effect retry`,async()=>{
 let late:((response:Response)=>void)|undefined;
 const stalled=phase==='fetch'?()=>new Promise<Response>(resolve=>{late=resolve;}):()=>Promise.resolve(new Response(new ReadableStream<Uint8Array>({pull:()=>new Promise<void>(()=>{}),cancel:()=>new Promise<void>(()=>{})}),{headers:{'Content-Type':'application/json'}}));
 fetcher.mockResolvedValueOnce(json(prepared())).mockImplementationOnce(stalled).mockResolvedValueOnce(json(completed()));
 render(<PositionArchivePanel initialChoices={choices}/>);await prepare();vi.useFakeTimers();
 fireEvent.click(screen.getByLabelText(copy.consent));
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:copy.confirm}));await vi.advanceTimersByTimeAsync(15001);});vi.useRealTimers();
 await screen.findByText(copy.uncertain);const reopen=screen.getByRole('button',{name:copy.reopen}) as HTMLButtonElement;expect(reopen.disabled).toBe(false);
 fireEvent.click(reopen);await screen.findByText(copy.completed);
 expect(packets().filter(p=>p.operation==='confirm')).toHaveLength(1);expect(packets()[2]).toEqual({action,operation:'reopen',actionId});
 if(late){await act(async()=>{late!(json(completed()));await Promise.resolve();});expect(screen.getByText(copy.completed)).toBeTruthy();expect(packets()).toHaveLength(3);}
});

it('discloses retained-company deletion consequences and native handoff before prepare, final consent and same-ID recovery',async()=>{
 fetcher.mockResolvedValueOnce(json(prepared())).mockRejectedValueOnce(Error('Fictional lost confirmation response'));
 render(<PositionArchivePanel initialChoices={choices}/>);
 expect(screen.getByText(copy.retentionNotice)).toBeTruthy();expect(screen.getByRole('link',{name:copy.manual}).getAttribute('href')).toBe('/admin/settings/system-labels');expect(fetcher).not.toHaveBeenCalled();
 await prepare();expect(screen.getByText(copy.retentionReview)).toBeTruthy();expect(screen.getByLabelText(copy.consent)).toBeTruthy();
 fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(screen.getByRole('button',{name:copy.confirm}));await screen.findByText(copy.uncertain);
 expect(screen.getByText(copy.retentionNotice)).toBeTruthy();expect((screen.getByRole('button',{name:copy.reopen}) as HTMLButtonElement).disabled).toBe(false);
 expect(packets().filter(p=>p.operation==='confirm')).toHaveLength(1);
});
