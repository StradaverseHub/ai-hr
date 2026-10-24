import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {NoticeAcknowledgementForm} from '../components/notice/acknowledgement-form';
vi.mock('next-intl',()=>({useLocale:()=> 'en'}));
const labels={acknowledge:'Acknowledge this version',pending:'Saving acknowledgement',acknowledgedOn:'Acknowledged on {date}',unavailable:'Unavailable for this account',changed:'Reload and review the changed content',failed:'Could not save; try again'};
const base={noticeId:'notice',employmentId:'employment',contentVersion:2,acknowledgedAt:null,labels};
afterEach(cleanup);
describe('Explicit version acknowledgement controls',()=>{
 it('does not submit on viewing, posts the displayed identity/version and renders the persisted date',async()=>{
  const action=vi.fn(async(_state:unknown,form:FormData)=>{expect(Object.fromEntries(form.entries())).toEqual({noticeId:'notice',employmentId:'employment',contentVersion:'2'});return {acknowledgedAt:'2026-10-21T12:00:00.000Z'};});
  render(<NoticeAcknowledgementForm {...base} action={action}/>);expect(action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:labels.acknowledge}));
  await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('Acknowledged on'));
  expect(screen.queryByRole('button')).toBeNull();expect(action).toHaveBeenCalledTimes(1);
 });
 it('blocks a pending repeat and retains a specific safe retry message after refusal',async()=>{
  let finish!:(value:{error:'changed'})=>void;const action=vi.fn(()=>new Promise<{error:'changed'}>(resolve=>{finish=resolve;}));
  render(<NoticeAcknowledgementForm {...base} action={action}/>);
  fireEvent.click(screen.getByRole('button',{name:labels.acknowledge}));
  await waitFor(()=>expect(screen.getByRole('button',{name:labels.pending})).toBeDisabled());
  fireEvent.click(screen.getByRole('button',{name:labels.pending}));expect(action).toHaveBeenCalledTimes(1);
  await act(async()=>finish({error:'changed'}));
  expect(screen.getByRole('alert').textContent).toBe(labels.changed);expect(screen.getByRole('button',{name:labels.acknowledge})).toBeEnabled();
 });
 it('reopens a recorded acknowledgement as server truth without another command',()=>{
  const action=vi.fn();render(<NoticeAcknowledgementForm {...base} acknowledgedAt="2026-10-21T12:00:00.000Z" action={action}/>);
  expect(screen.getByRole('status').textContent).toContain('Acknowledged on');expect(screen.queryByRole('button')).toBeNull();expect(action).not.toHaveBeenCalled();
 });
});
