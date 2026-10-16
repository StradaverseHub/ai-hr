import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import messages from '../messages/en.json';
import {AssistantConversation} from '../components/assistant-conversation';
import {__resetUnsavedGuards,firstDirtyGuard} from '../lib/unsaved-changes';
import type {ConversationView} from '../core/assistant-conversation';
const action=vi.hoisted(()=>({load:vi.fn(),submit:vi.fn(),confirm:vi.fn(),reset:vi.fn(),rate:vi.fn(),prepareFeedback:vi.fn(),push:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:action.push})}));
vi.mock('next/link',()=>({default:({href,children,...props}:{href:string;children:React.ReactNode})=><a href={href} {...props}>{children}</a>}));
vi.mock('next-intl',()=>({useFormatter:()=>({dateTime:(value:Date)=>value.toISOString()}),useTranslations:(namespace:string)=>(key:string)=>key.split('.').reduce((value,part)=>(value as Record<string,unknown>)?.[part],namespace.split('.').reduce((value,part)=>(value as Record<string,unknown>)?.[part],messages as unknown))??key}));
vi.mock('../app/assistant/actions',()=>({loadAssistantConversationAction:action.load,submitAssistantConversationAction:action.submit,confirmAssistantProposalAction:action.confirm,newAssistantConversationAction:action.reset,rateAssistantReplyAction:action.rate,prepareAssistantFeedbackAction:action.prepareFeedback}));
const cid='123e4567-e89b-42d3-a456-426614174000',eid='123e4567-e89b-42d3-a456-426614174001',pid='123e4567-e89b-42d3-a456-426614174002';
const initial=():ConversationView=>({id:cid,revision:1,pending:false,messages:[]});
const answered=():ConversationView=>({id:cid,revision:2,pending:false,messages:[{id:eid,question:'Earlier question',askedAt:'2026-10-16T01:00:00.000Z',helpful:null,reply:{kind:'guide',text:'Private previous answer',tables:[],links:[],evidence:[]}}]});
beforeEach(()=>{vi.resetAllMocks();__resetUnsavedGuards();action.load.mockResolvedValue({ok:true,view:initial()});action.submit.mockResolvedValue({ok:true,view:answered()});action.rate.mockResolvedValue({ok:true});});
afterEach(()=>{cleanup();__resetUnsavedGuards();});
async function ready(){render(<AssistantConversation/>);await waitFor(()=>expect(screen.getByRole('button',{name:'New conversation'})).toBeEnabled());return screen.getByRole('textbox');}
describe('shared conversation interaction boundaries',()=>{
 it('Enter submits a question, while Shift+Enter and IME composition never send or confirm',async()=>{
  const text=await ready();fireEvent.change(text,{target:{value:'My leave balance'}});
  fireEvent.keyDown(text,{key:'Enter',shiftKey:true});fireEvent.keyDown(text,{key:'Enter',isComposing:true,keyCode:229});expect(action.submit).not.toHaveBeenCalled();expect(action.confirm).not.toHaveBeenCalled();
  fireEvent.keyDown(text,{key:'Enter'});await waitFor(()=>expect(action.submit).toHaveBeenCalledOnce());expect(action.submit.mock.calls[0][0]).toMatchObject({conversationId:cid,revision:1,question:'My leave balance',intent:'question'});expect(action.confirm).not.toHaveBeenCalled();
 });
 it('requires the separate reviewed dialog to confirm an exact existing proposal',async()=>{
  const view=answered();view.messages[0].reply={kind:'awaitingConfirmation',text:'Review this employee',proposalId:pid,proposalRevision:1,tables:[{columns:['Employee','Cause'],rows:[['Fictional Employee · Company A','Bank corrected']]}],links:[],evidence:[]};view.messages[0].proposalStatus='awaiting';action.load.mockResolvedValue({ok:true,view});action.confirm.mockResolvedValue({ok:true,view:{...view,revision:3,messages:view.messages.map(message=>({...message,proposalStatus:'completed'}))}});
  await ready();expect(action.confirm).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:messages.assistantConversation.confirm}));const dialog=await screen.findByRole('alertdialog');expect(action.confirm).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button',{name:messages.assistantConversation.confirm}));await waitFor(()=>expect(action.confirm).toHaveBeenCalledOnce());expect(action.confirm.mock.calls[0][0]).toMatchObject({conversationId:cid,conversationRevision:2,proposalId:pid,proposalRevision:1});expect(action.submit).not.toHaveBeenCalled();await waitFor(()=>expect(screen.queryByRole('button',{name:messages.assistantConversation.confirm})).not.toBeInTheDocument());
 });
 it('drops sensitive client history on failed fresh access and refresh never repeats the question',async()=>{
  action.load.mockResolvedValueOnce({ok:true,view:answered()}).mockResolvedValueOnce({ok:false,code:'scopeChanged'}).mockResolvedValueOnce({ok:true,view:initial()});await ready();expect(screen.getByText('Private previous answer')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Refresh conversation'}));await waitFor(()=>expect(screen.queryByText('Private previous answer')).not.toBeInTheDocument());expect(action.submit).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Refresh conversation'}));await waitFor(()=>expect(screen.getByText(messages.assistantConversation.empty)).toBeInTheDocument());expect(action.submit).not.toHaveBeenCalled();
 });
 it('keeps an unsent question when leaving is cancelled and only continues after explicit discard',async()=>{
  const text=await ready();fireEvent.change(text,{target:{value:'Unsent private question'}});const proceed=vi.fn();expect(firstDirtyGuard()).not.toBeNull();act(()=>firstDirtyGuard()!.prompt(proceed));
  const dialog=await screen.findByRole('alertdialog');fireEvent.click(within(dialog).getByRole('button',{name:'Keep editing'}));expect(proceed).not.toHaveBeenCalled();expect(text).toHaveValue('Unsent private question');
  act(()=>firstDirtyGuard()!.prompt(proceed));fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button',{name:'Discard and continue'}));expect(proceed).toHaveBeenCalledOnce();expect(text).toHaveValue('');
 });
 it('renders model HTML and arbitrary URLs as plain text, with no active script or model link',async()=>{
  const view=answered();view.messages[0].reply.text='[Open](https://untrusted.invalid) <script>untrusted()</script>';action.load.mockResolvedValue({ok:true,view});await ready();expect(screen.getByText(view.messages[0].reply.text)).toBeInTheDocument();expect(document.querySelector('script')).toBeNull();expect(document.querySelector('a[href*="untrusted.invalid"]')).toBeNull();
 });
 it('does not allow a late response from an unmounted scope to overwrite the new workspace',async()=>{
  let finish!:(value:unknown)=>void;const gate=new Promise(resolve=>finish=resolve);action.submit.mockReturnValue(gate);const mounted=render(<AssistantConversation key="scope-a"/>);await waitFor(()=>expect(screen.getByRole('button',{name:'New conversation'})).toBeEnabled());fireEvent.change(screen.getByRole('textbox'),{target:{value:'Question in A'}});fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});await waitFor(()=>expect(action.submit).toHaveBeenCalledOnce());mounted.rerender(<AssistantConversation key="scope-b"/>);await waitFor(()=>expect(action.load).toHaveBeenCalledTimes(2));finish({ok:true,view:answered()});await waitFor(()=>expect(screen.queryByText('Private previous answer')).not.toBeInTheDocument());
 });
 it('prepares an editable Feedback handoff from an exact recorded reply without submitting Feedback or another question',async()=>{
  action.load.mockResolvedValue({ok:true,view:answered()});action.prepareFeedback.mockResolvedValue({ok:true,id:pid,view:answered()});
  await ready();fireEvent.click(screen.getByRole('button',{name:messages.assistantConversation.feedbackDraft}));
  await waitFor(()=>expect(action.prepareFeedback).toHaveBeenCalledOnce());
  expect(action.prepareFeedback.mock.calls[0][0]).toMatchObject({conversationId:cid,conversationRevision:2,exchangeId:eid});
  expect(action.push).toHaveBeenCalledWith('/feedback?assistantDraft='+pid);expect(action.submit).not.toHaveBeenCalled();expect(action.confirm).not.toHaveBeenCalled();
 });

});
