import * as React from 'react';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,expect,it,vi} from 'vitest';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import {HomeGreetingComposer} from '../components/employee-home/greeting-composer';
import type {HomeGreetingCommand} from '../lib/employee-home-greeting';
import {todayInKualaLumpur} from '../lib/hr-date';
import en from '../messages/en.json';
import zh from '../messages/zh.json';
import ms from '../messages/ms.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';

const sender='00000000-0000-4000-8000-000000000001',recipient='00000000-0000-4000-8000-000000000002';
const greeting='00000000-0000-4000-8000-000000000004';
const target={employmentId:recipient,name:'Fictional 李 தமிழ் ไทย Nguyễn',date:todayInKualaLumpur(),kind:'birthday' as const,years:null};
const receipt=(command:Readonly<HomeGreetingCommand>,state='sent')=>({version:1,employmentId:command.employmentId,nonce:command.nonce,greetingId:greeting,state});
const english=createTranslator({locale:'en',messages:en,namespace:'employeeHome.greetingSend'});
type Props=React.ComponentProps<typeof HomeGreetingComposer>;
function view(props:Partial<Props>={},locale='en',messages:typeof en=en){
 return <NextIntlClientProvider locale={locale} messages={messages}>
  <HomeGreetingComposer employmentId={sender} target={target} send={async command=>receipt(command)} {...props}/>
 </NextIntlClientProvider>;
}

describe('employee explicitly composes and sends a celebration greeting',()=>{
 it.each(Object.entries({en,zh,ms,vi:viMessages,th,ta}))('opens an editable, accessible %s draft and cancels without a command',async(locale,messages)=>{
  const user=userEvent.setup(),send=vi.fn(),t=createTranslator({locale,messages,namespace:'employeeHome.greetingSend'});
  render(view({send},locale,messages as typeof en));
  const trigger=screen.getByRole('button',{name:t('sayHi')});await user.click(trigger);
  expect(screen.getByRole('dialog',{name:t('title')})).toBeVisible();
  expect(screen.getByRole('textbox',{name:t('message')})).toHaveValue(t('birthdayMessage',{name:target.name!}));
  expect(send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:t('cancel')}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(send).not.toHaveBeenCalled();
  await waitFor(()=>expect(trigger).toHaveFocus());
 });
 it('sends only edited plain text with this own EMP and selected occurrence, then shows its exact receipt',async()=>{
  const user=userEvent.setup(),send=vi.fn(async(command:Readonly<HomeGreetingCommand>)=>receipt(command));
  render(view({send}));await user.click(screen.getByRole('button',{name:english('sayHi')}));
  const editor=screen.getByRole('textbox',{name:english('message')});
  await user.clear(editor);await user.type(editor,'  Fictional edited greeting 李 🎉  ');
  expect(screen.getByText(english('count',{count:Array.from('Fictional edited greeting 李 🎉').length,max:500}))).toBeVisible();
  expect(send).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:english('send')}));
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(english('sent')));
  expect(send).toHaveBeenCalledTimes(1);
  const command=send.mock.calls[0][0];
  expect(command).toEqual({version:1,employmentId:sender,recipientEmploymentId:recipient,kind:'birthday',
   occurrenceDate:target.date,nonce:expect.any(String),message:'Fictional edited greeting 李 🎉'});
  expect(Object.isFrozen(command)).toBe(true);
  expect(screen.queryByRole('button',{name:english('send')})).not.toBeInTheDocument();
 });
 it('keeps the same nonce and body across an uncertain response, close, reopen and explicit retry',async()=>{
  const user=userEvent.setup(),send=vi.fn<(command:Readonly<HomeGreetingCommand>)=>Promise<unknown>>()
   .mockRejectedValueOnce(Error('PRIVATE transport detail')).mockImplementation(async command=>receipt(command));
  render(view({send}));await user.click(screen.getByRole('button',{name:english('sayHi')}));
  await user.click(screen.getByRole('button',{name:english('send')}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(english('uncertain')));
  expect(screen.queryByText('PRIVATE transport detail')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox',{name:english('message')})).toHaveAttribute('readonly');
  await user.click(screen.getByRole('button',{name:english('close')}));
  await user.click(screen.getByRole('button',{name:english('sayHi')}));
  expect(send).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button',{name:english('retry')}));
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(english('sent')));
  expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[1][0]).toBe(send.mock.calls[0][0]);
 });
 it('coalesces rapid explicit submits while one command is in flight',async()=>{
  let finish!:(value:unknown)=>void;
  const pending=new Promise<unknown>(resolve=>{finish=resolve;});
  const send=vi.fn(async(_command:Readonly<HomeGreetingCommand>)=>pending),user=userEvent.setup();
  render(view({send}));await user.click(screen.getByRole('button',{name:english('sayHi')}));
  const form=screen.getByRole('textbox',{name:english('message')}).closest('form')!;
  fireEvent.submit(form);fireEvent.submit(form);expect(send).toHaveBeenCalledTimes(1);
  await act(async()=>finish(receipt(send.mock.calls[0][0])));
  expect(screen.getByRole('status')).toHaveTextContent(english('sent'));
 });
 it('never accepts a receipt from another selected employment as this command succeeding',async()=>{
  const user=userEvent.setup(),send=vi.fn(async(command:Readonly<HomeGreetingCommand>)=>({...receipt(command),employmentId:recipient}));
  render(view({send}));await user.click(screen.getByRole('button',{name:english('sayHi')}));
  await user.click(screen.getByRole('button',{name:english('send')}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(english('uncertain')));
  expect(screen.queryByText(english('sent'))).not.toBeInTheDocument();
 });
 it('drops the prior subject draft and ignores its late success after subject switching',async()=>{
  let finish!:(value:unknown)=>void;
  const pending=new Promise<unknown>(resolve=>{finish=resolve;});
  const send=vi.fn(async(_command:Readonly<HomeGreetingCommand>)=>pending),user=userEvent.setup();
  const mounted=render(view({send}));await user.click(screen.getByRole('button',{name:english('sayHi')}));
  await user.click(screen.getByRole('button',{name:english('send')}));
  mounted.rerender(view({send,employmentId:'00000000-0000-4000-8000-000000000005'}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await act(async()=>finish(receipt(send.mock.calls[0][0])));
  await user.click(screen.getByRole('button',{name:english('sayHi')}));
  expect(screen.queryByText(english('sent'))).not.toBeInTheDocument();
  expect(screen.getByRole('textbox',{name:english('message')})).not.toHaveAttribute('readonly');
 });
 it('refuses empty or over-limit edits without creating a send request',async()=>{
  const send=vi.fn(),user=userEvent.setup();render(view({send}));
  await user.click(screen.getByRole('button',{name:english('sayHi')}));
  const editor=screen.getByRole('textbox',{name:english('message')});
  for(const value of ['   ','a'.repeat(501)]){
   fireEvent.change(editor,{target:{value}});
   expect(screen.getByRole('button',{name:english('send')})).toBeDisabled();
   fireEvent.submit(editor.closest('form')!);expect(send).not.toHaveBeenCalled();
  }
 });
 it('renders an anniversary message and hostile-looking names as text',async()=>{
  const user=userEvent.setup(),name='<img src=x onerror=alert(1)>';
  render(view({target:{...target,kind:'anniversary',name,years:4}}));
  await user.click(screen.getByRole('button',{name:english('cheer')}));
  expect(screen.getByRole('textbox',{name:english('message')})).toHaveValue(english('anniversaryMessage',{name}));
  expect(document.querySelector('img')).toBeNull();
 });
 it('treats an erased retry receipt as terminal and never offers to recreate the message',async()=>{
  const user=userEvent.setup(),send=vi.fn(async(command:Readonly<HomeGreetingCommand>)=>receipt(command,'erased'));
  render(view({send}));await user.click(screen.getByRole('button',{name:english('sayHi')}));
  await user.click(screen.getByRole('button',{name:english('send')}));
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(english('erased')));
  expect(screen.queryByRole('button',{name:english('send')})).not.toBeInTheDocument();expect(send).toHaveBeenCalledTimes(1);
 });
});
