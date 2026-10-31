// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../messages/en.json';
const ports=vi.hoisted(()=>({send:vi.fn(),refresh:vi.fn(),keep:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({reviewConversationAction:ports.send,keepCompetencyReflectionAction:ports.keep,saveAssessmentDraftAction:vi.fn()}));
import { ReviewConversation } from '../app/(app)/performance/workspace/review-conversation';
beforeEach(()=>{vi.clearAllMocks();ports.send.mockResolvedValue({revision:1,messages:[{id:'reply',role:'assistant',kind:'update',text:'Private draft updated',at:new Date().toISOString()}],draftUpdated:true});});
afterEach(cleanup);
describe('Performance conversation layout',()=>{
 it('offers an explicit starter draft action and disables it when the daily allowance is used',async()=>{
  ports.send.mockResolvedValue({revision:1,messages:[],draftUpdated:true,settingQuota:{remaining:0,limit:5}});
  render(<NextIntlClientProvider locale="en" messages={en}><ReviewConversation reviewId="review" stage="setting" initial={{revision:null,messages:[],settingQuota:{remaining:1,limit:5}}} aiEnabled labels={en.onehr.conversation}/></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('button',{name:en.onehr.conversation.starter}));
  await waitFor(()=>expect(ports.refresh).toHaveBeenCalledOnce());expect(ports.send.mock.calls[0][5]).toBe('starter');expect((screen.getByRole('button',{name:en.onehr.conversation.starter}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('0 of 5 suggestions left today · resets at midnight Malaysia time')).toBeTruthy();
 });
 it('places the active widget in the transcript scroll region above a separate composer',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><ReviewConversation reviewId="review" stage="results" initial={{revision:null,messages:[]}} aiEnabled labels={en.onehr.conversation}><form aria-label="Active assessment"><input aria-label="Actual result"/></form></ReviewConversation></NextIntlClientProvider>);
  const widget=screen.getByRole('form',{name:'Active assessment'}),composer=screen.getByLabelText(en.onehr.conversation.message).closest('form')!;
  expect(widget.closest('[data-review-scroll]')).toBeTruthy();expect(composer.closest('[data-review-scroll]')).toBeNull();
  expect(screen.getByRole('button',{name:en.onehr.conversation.next})).toBeTruthy();
 });
 it('shows the actual completed confirmation rather than calling it a private draft update',async()=>{
  ports.send.mockResolvedValue({revision:1,messages:[{id:'confirmation',role:'assistant',kind:'action',text:'KPI confirmed: Delivery.',at:new Date().toISOString()}],draftUpdated:true});
  render(<NextIntlClientProvider locale="en" messages={en}><ReviewConversation reviewId="review" stage="moderation" initial={{revision:null,messages:[]}} aiEnabled={false} labels={en.onehr.conversation}/></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.onehr.conversation.message),{target:{value:'Confirm KPI: Delivery'}});fireEvent.click(screen.getByRole('button',{name:en.onehr.conversation.send}));
  await waitFor(()=>expect(ports.refresh).toHaveBeenCalledOnce());expect(screen.getByText('KPI confirmed: Delivery.')).toBeTruthy();expect(screen.getByText(en.onehr.conversation.action)).toBeTruthy();expect(screen.queryByText(en.onehr.conversation.updated)).toBeNull();
 });
 it('refreshes the widget after a confirmed private draft update and displays deterministic local copy',async()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><ReviewConversation reviewId="review" stage="results" initial={{revision:null,messages:[]}} aiEnabled labels={en.onehr.conversation}/></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.onehr.conversation.message),{target:{value:'Record Delivery at 100'}});
  fireEvent.click(screen.getByRole('button',{name:en.onehr.conversation.send}));
  await waitFor(()=>expect(ports.refresh).toHaveBeenCalledOnce());
  expect(screen.getByText(en.onehr.conversation.updated)).toBeTruthy();
  expect(ports.send.mock.calls[0][4]).toBe('Record Delivery at 100');
 });
 it('renders a proposed reflection and saves only after the employee clicks its explicit control',async()=>{
  const card={id:'card',role:'assistant' as const,kind:'draft' as const,text:'Review this reflection.',at:new Date().toISOString(),reflection:{id:'skill',label:'Service delivery',text:'I completed the agreed service work.',originalNote:'',isDraft:true}};
  ports.keep.mockResolvedValue({revision:2,messages:[card,{id:'saved',role:'assistant',kind:'update',text:'Saved',at:card.at,keptReflectionId:'card'}],draftUpdated:true});
  render(<NextIntlClientProvider locale="en" messages={en}><ReviewConversation reviewId="review" stage="competency" initial={{revision:1,messages:[card]}} aiEnabled={false} labels={en.onehr.conversation}/></NextIntlClientProvider>);
  expect(screen.getByText(card.reflection.text)).toBeTruthy();expect(ports.keep).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:en.onehr.conversation.saveReflection}));
  await waitFor(()=>expect(ports.keep).toHaveBeenCalledWith('review','card'));expect((screen.getByRole('button',{name:en.onehr.conversation.reflectionSaved}) as HTMLButtonElement).disabled).toBe(true);expect(ports.refresh).toHaveBeenCalledOnce();
 });

});


it('keeps the sent words and an honest thinking state in place during the native command',async()=>{
 let finish!:(value:unknown)=>void;ports.send.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 render(<NextIntlClientProvider locale="en" messages={en}><ReviewConversation reviewId="review" stage="results" initial={{revision:null,messages:[]}} aiEnabled labels={en.onehr.conversation}/></NextIntlClientProvider>);
 const box=screen.getByLabelText(en.onehr.conversation.message);fireEvent.change(box,{target:{value:'remark: My own current evidence.'}});fireEvent.click(screen.getByRole('button',{name:en.onehr.conversation.send}));
 await waitFor(()=>expect(ports.send).toHaveBeenCalledOnce());expect(screen.getByRole('status')).toHaveTextContent(en.assistant.workspace.chat.thinking);expect(screen.getByText('remark: My own current evidence.')).toBeInTheDocument();expect(box).toBeDisabled();expect(box).toHaveValue('');
 await act(async()=>{finish({revision:1,messages:[{id:'done',role:'assistant',kind:'guide',text:'Please review your recorded words.',at:'2026-10-30T00:00:00Z'}]});});
 expect(screen.queryByRole('status')).toBeNull();expect(screen.getByText('Please review your recorded words.')).toBeInTheDocument();expect(box).not.toBeDisabled();expect(ports.refresh).not.toHaveBeenCalled();
});


it.each(['response','throw'])('restores the exact original draft after a %s failure and permits an explicit retry',async(failure)=>{
 const original='  remark: My own current evidence.  ';
 if(failure==='response')ports.send.mockResolvedValueOnce({error:'Please try again.'});
 else ports.send.mockRejectedValueOnce(new Error('Please try again.'));
 render(<NextIntlClientProvider locale="en" messages={en}><ReviewConversation reviewId="review" stage="results" initial={{revision:7,messages:[]}} aiEnabled labels={en.onehr.conversation}/></NextIntlClientProvider>);
 const box=screen.getByLabelText(en.onehr.conversation.message);fireEvent.change(box,{target:{value:original}});fireEvent.click(screen.getByRole('button',{name:en.onehr.conversation.send}));
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Please try again.'));
 expect(box).toHaveValue(original);expect(box).not.toBeDisabled();expect(screen.queryByRole('status')).toBeNull();expect(ports.refresh).not.toHaveBeenCalled();
 expect(ports.send.mock.calls[0][2]).toBe(7);expect(ports.send.mock.calls[0][4]).toBe(original.trim());
 fireEvent.click(screen.getByRole('button',{name:en.onehr.conversation.send}));
 await waitFor(()=>expect(ports.refresh).toHaveBeenCalledOnce());
 expect(ports.send).toHaveBeenCalledTimes(2);expect(ports.send.mock.calls[1][2]).toBe(7);expect(ports.send.mock.calls[1][4]).toBe(original.trim());expect(box).toHaveValue('');expect(screen.queryByRole('alert')).toBeNull();
});
