// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../messages/en.json';
const ports=vi.hoisted(()=>({send:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
vi.mock('../app/performance/onehr-actions',()=>({reviewConversationAction:ports.send,saveAssessmentDraftAction:vi.fn()}));
import { ReviewConversation } from '../app/performance/workspace/review-conversation';
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
 it('refreshes the widget after a confirmed private draft update and displays deterministic local copy',async()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><ReviewConversation reviewId="review" stage="results" initial={{revision:null,messages:[]}} aiEnabled labels={en.onehr.conversation}/></NextIntlClientProvider>);
  fireEvent.change(screen.getByLabelText(en.onehr.conversation.message),{target:{value:'Record Delivery at 100'}});
  fireEvent.click(screen.getByRole('button',{name:en.onehr.conversation.send}));
  await waitFor(()=>expect(ports.refresh).toHaveBeenCalledOnce());
  expect(screen.getByText(en.onehr.conversation.updated)).toBeTruthy();
  expect(ports.send.mock.calls[0][4]).toBe('Record Delivery at 100');
 });
});
