/** @vitest-environment jsdom */
/** Home's redirecting ask box: visible wait state, protected edits and IME-safe submission. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const state=vi.hoisted(()=>({pending:false,ask:vi.fn(async()=>{})}));
vi.mock('react-dom',async original=>({...await original<typeof import('react-dom')>(),useFormStatus:()=>({pending:state.pending})}));
vi.mock('../app/assistant/actions',()=>({askAssistantAction:state.ask}));
import {AtelierAskBox} from '../components/atelier-ask-box';
const props={label:'Your question',placeholder:'Ask about your work',submitLabel:'Ask',suggestions:['My leave balance']};
const content=()=> <NextIntlClientProvider locale="en" messages={en}><AtelierAskBox {...props}/></NextIntlClientProvider>;
afterEach(()=>{cleanup();state.pending=false;state.ask.mockClear();});
describe('Atelier home Assistant ask box',()=>{
 it('fills a suggestion without sending and submits Enter only after composition has finished',()=>{
  const view=render(content());const question=screen.getByLabelText(props.label) as HTMLTextAreaElement;
  fireEvent.click(screen.getByRole('button',{name:props.suggestions[0]}));
  expect(question.value).toBe('My leave balance');expect(document.activeElement).toBe(question);expect(state.ask).not.toHaveBeenCalled();
  const submit=vi.spyOn(view.container.querySelector('form')!,'requestSubmit').mockImplementation(()=>{});
  fireEvent.keyDown(question,{key:'Enter',isComposing:true});fireEvent.keyDown(question,{key:'Enter',shiftKey:true});expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(question,{key:'Enter'});expect(submit).toHaveBeenCalledTimes(1);submit.mockRestore();
 });
 it('shows a visible localized waiting message and protects the submitted question and shortcuts',()=>{
  const view=render(content());const question=screen.getByLabelText(props.label) as HTMLTextAreaElement;
  fireEvent.change(question,{target:{value:'What is my balance?'}});
  state.pending=true;view.rerender(content());
  expect(screen.getByRole('status')).toHaveTextContent(en.assistant.workspace.working);
  expect(screen.getByRole('status')).not.toHaveClass('sr-only');
  expect(screen.getByRole('button',{name:en.assistant.workspace.working})).toBeDisabled();
  expect(screen.getByRole('button',{name:en.assistant.workspace.working})).toHaveAttribute('aria-busy','true');
  expect(question.readOnly).toBe(true);expect(screen.getByRole('button',{name:props.suggestions[0]})).toBeDisabled();
  const submit=vi.spyOn(view.container.querySelector('form')!,'requestSubmit').mockImplementation(()=>{});
  fireEvent.keyDown(question,{key:'Enter'});expect(submit).not.toHaveBeenCalled();submit.mockRestore();
  state.pending=false;view.rerender(content());expect(question.value).toBe('What is my balance?');expect(question.readOnly).toBe(false);
  expect(screen.getByRole('button',{name:props.submitLabel})).toBeEnabled();expect(state.ask).not.toHaveBeenCalled();
 });
});
