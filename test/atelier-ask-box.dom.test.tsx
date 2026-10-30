/** @vitest-environment jsdom */
/** Dashboard and Assistant share the same in-place conversation owner. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const state=vi.hoisted(()=>({ask:vi.fn()}));
vi.mock('../app/assistant/launcher-actions',()=>({askFromWorkspaceAction:state.ask}));
import {AtelierAskBox} from '../components/atelier-ask-box';
const props={label:'Your question',placeholder:'Ask about your work',submitLabel:'Ask',suggestions:['My leave balance']};
const content=()=> <NextIntlClientProvider locale="en" messages={en}><AtelierAskBox {...props}/></NextIntlClientProvider>;
beforeEach(()=>state.ask.mockReset());afterEach(cleanup);
describe('Dashboard Assistant',()=>{
 it('fills a suggestion without sending and submits Enter only after composition has finished',()=>{
  const view=render(content());const question=screen.getByLabelText(props.label) as HTMLTextAreaElement;
  fireEvent.click(screen.getByRole('button',{name:props.suggestions[0]}));expect(question.value).toBe('My leave balance');expect(document.activeElement).toBe(question);expect(state.ask).not.toHaveBeenCalled();
  const submit=vi.spyOn(view.container.querySelector('form')!,'requestSubmit').mockImplementation(()=>{});
  fireEvent.keyDown(question,{key:'Enter',isComposing:true});fireEvent.keyDown(question,{key:'Enter',shiftKey:true});expect(submit).not.toHaveBeenCalled();fireEvent.keyDown(question,{key:'Enter'});expect(submit).toHaveBeenCalledTimes(1);submit.mockRestore();
 });
 it('keeps the question, waiting state, answer and follow-up on Dashboard without navigating to recent questions',async()=>{
  let resolve!:(value:unknown)=>void;state.ask.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));render(content());
  const question=screen.getByLabelText(props.label) as HTMLTextAreaElement;fireEvent.change(question,{target:{value:'What is my balance?'}});fireEvent.click(screen.getByRole('button',{name:props.submitLabel}));
  expect(screen.getByRole('log')).toHaveTextContent('What is my balance?');expect(screen.getByRole('log')).toHaveTextContent(en.assistant.workspace.chat.thinking);
  expect(question.readOnly).toBe(true);expect(screen.getByRole('button',{name:props.suggestions[0]})).toBeDisabled();
  await act(async()=>resolve({ok:true,exchangeId:'first',conversationToken:'proof',answer:<p>Annual leave: 12 days</p>}));expect(screen.getByText('Annual leave: 12 days')).toBeInTheDocument();expect(question.readOnly).toBe(false);expect(question.value).toBe('');
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'second',answer:<p>Pending leave: 2 days</p>});fireEvent.change(question,{target:{value:'And pending?'}});fireEvent.click(screen.getByRole('button',{name:props.submitLabel}));
  await waitFor(()=>expect(screen.getByText('Pending leave: 2 days')).toBeInTheDocument());expect(screen.getByText('Annual leave: 12 days')).toBeInTheDocument();expect(state.ask).toHaveBeenLastCalledWith({question:'And pending?',previousExchangeId:'first',previousConversationToken:'proof'});expect(window.location.search).toBe('');
 });
});
