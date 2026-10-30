/** @vitest-environment jsdom */
/** The floating Assistant window: where it appears, opening, docking, closing and one round trip. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const state=vi.hoisted(()=>({path:'/leave',ask:vi.fn()}));
vi.mock('next/navigation',()=>({usePathname:()=>state.path}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('../app/assistant/launcher-actions',()=>({askFromLauncherAction:state.ask}));
import {AssistantLauncher} from '../components/assistant/assistant-launcher';
const copy=en.assistant.launcher;
const show=(hiddenAreas:string[]=[],position:'bottom-right'|'bottom-left'='bottom-right')=>render(<NextIntlClientProvider locale="en" messages={en}><AssistantLauncher position={position} hiddenAreas={hiddenAreas as never}/></NextIntlClientProvider>);
beforeEach(()=>{state.path='/leave';state.ask.mockReset();});
afterEach(cleanup);
describe('floating Assistant',()=>{
 it('drops continuation after a refusal or uncertain second request rather than silently skipping it',async()=>{
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'first',conversationToken:'proof',answer:<p>First answer</p>}).mockRejectedValueOnce(Error('PRIVATE')).mockResolvedValueOnce({ok:true,exchangeId:'third',answer:<p>Third answer</p>});
  show();fireEvent.click(screen.getByRole('button',{name:copy.open}));
  const send=(question:string)=>{fireEvent.change(screen.getByLabelText(copy.question),{target:{value:question}});fireEvent.click(screen.getByRole('button',{name:copy.send}));};
  send('First');await screen.findByText('First answer');send('Second');await screen.findByRole('alert');send('Third');await screen.findByText('Third answer');expect(state.ask).toHaveBeenLastCalledWith({question:'Third',path:'/leave'});
 });
 it('is absent on the Assistant itself, in a hidden area and on an unknown area',()=>{
  for(const [path,hidden] of [['/assistant',[]],['/assistant/leave',[]],['/payroll',['payroll']],['/somewhere-else',[]]] as const){state.path=path;const view=show([...hidden]);expect(screen.queryByRole('button',{name:copy.open}),path).toBeNull();view.unmount();}
 });
 it('opens with the page area, docks as a side panel and back, and closes with Escape returning focus',()=>{
  state.path='/leave/history';show();
  fireEvent.click(screen.getByRole('button',{name:copy.open}));
  const dialog=screen.getByRole('dialog',{name:copy.title});expect(dialog).toHaveTextContent('About this page: Leave');
  expect(document.activeElement).toBe(screen.getByLabelText(copy.question));
  fireEvent.click(screen.getByRole('button',{name:copy.dock}));expect(screen.getByRole('dialog').className).toContain('inset-y-0');
  fireEvent.click(screen.getByRole('button',{name:copy.undock}));expect(screen.getByRole('dialog').className).not.toContain('inset-y-0');
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button',{name:copy.open}));
 });
 it('sends the question with the current path, shows the card and a link to the full Assistant',async()=>{
  state.ask.mockResolvedValue({ok:true,exchangeId:'exchange-9',answer:<p>ANSWER CARD</p>});show();
  fireEvent.click(screen.getByRole('button',{name:copy.open}));
  fireEvent.change(screen.getByLabelText(copy.question),{target:{value:'How much leave is left?'}});
  fireEvent.click(screen.getByRole('button',{name:copy.send}));
  expect(state.ask).toHaveBeenCalledWith({question:'How much leave is left?',path:'/leave'});
  await waitFor(()=>expect(screen.getByText('ANSWER CARD')).toBeInTheDocument());
  expect(screen.getByRole('link',{name:copy.openInAssistant})).toHaveAttribute('href','/assistant?e=exchange-9');
 });
 it('shows a refusal as an alert and keeps the window usable',async()=>{
  state.ask.mockResolvedValue({ok:false,message:en.assistant.err_budget_daily});show();
  fireEvent.click(screen.getByRole('button',{name:copy.open}));
  fireEvent.change(screen.getByLabelText(copy.question),{target:{value:'Hi'}});fireEvent.keyDown(screen.getByLabelText(copy.question),{key:'Enter'});
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(en.assistant.err_budget_daily));
  expect((screen.getByLabelText(copy.question) as HTMLTextAreaElement).readOnly).toBe(false);
 });
 it('keeps a delayed reply beside the question without pulling a scrolled-up reader down',async()=>{
  let finish!:(reply:unknown)=>void;
  state.ask.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));show();
  fireEvent.click(screen.getByRole('button',{name:copy.open}));
  fireEvent.change(screen.getByLabelText(copy.question),{target:{value:'Explain my leave'}});
  fireEvent.click(screen.getByRole('button',{name:copy.send}));
  expect(screen.getByRole('status')).toHaveTextContent(copy.working);
  expect(screen.getByText('Explain my leave')).toBeInTheDocument();
  const log=screen.getByRole('dialog').querySelector('[aria-live="polite"]') as HTMLDivElement;
  Object.defineProperties(log,{scrollHeight:{configurable:true,value:1000},clientHeight:{configurable:true,value:200}});
  log.scrollTop=120;fireEvent.scroll(log);
  await act(async()=>{finish({ok:true,exchangeId:'exchange-delayed',answer:<p>Delayed answer</p>});});
  expect(screen.getByText('Delayed answer')).toBeInTheDocument();expect(log.scrollTop).toBe(120);
  expect(screen.queryByRole('status')).toBeNull();
  // Sending is an explicit request to return to the latest turn.
  fireEvent.change(screen.getByLabelText(copy.question),{target:{value:'And tomorrow?'}});
  fireEvent.click(screen.getByRole('button',{name:copy.send}));
  expect(log.scrollTop).toBe(1000);
  await act(async()=>{finish({ok:true,exchangeId:'exchange-next',answer:<p>Next answer</p>});});
 });
 it('follows a reply while the reader is already near the latest turn',async()=>{
  let finish!:(reply:unknown)=>void;
  state.ask.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));show();
  fireEvent.click(screen.getByRole('button',{name:copy.open}));
  fireEvent.change(screen.getByLabelText(copy.question),{target:{value:'My balance'}});fireEvent.click(screen.getByRole('button',{name:copy.send}));
  const log=screen.getByRole('dialog').querySelector('[aria-live="polite"]') as HTMLDivElement;
  Object.defineProperties(log,{scrollHeight:{configurable:true,value:1000},clientHeight:{configurable:true,value:200}});
  log.scrollTop=780;fireEvent.scroll(log);
  Object.defineProperty(log,'scrollHeight',{configurable:true,value:1400});
  await act(async()=>{finish({ok:true,exchangeId:'exchange-near',answer:<p>Current balance</p>});});
  expect(log.scrollTop).toBe(1400);
 });
 it('continues from the last successful exchange only on the same page',async()=>{
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'exchange-parent',conversationToken:'scope-bound-parent',answer:<p>First answer</p>})
    .mockResolvedValueOnce({ok:false,message:'Try again'})
    .mockResolvedValue({ok:true,exchangeId:'exchange-next',answer:<p>Another answer</p>});
  const view=show();fireEvent.click(screen.getByRole('button',{name:copy.open}));
  const send=(question:string)=>{fireEvent.change(screen.getByLabelText(copy.question),{target:{value:question}});fireEvent.click(screen.getByRole('button',{name:copy.send}));};
  send('My leave');await screen.findByText('First answer');
  send('What about tomorrow?');await screen.findByRole('alert');
  expect(state.ask).toHaveBeenNthCalledWith(2,{question:'What about tomorrow?',path:'/leave',previousExchangeId:'exchange-parent',previousConversationToken:'scope-bound-parent'});
  send('Try that again');await screen.findByText('Another answer');
  expect(state.ask).toHaveBeenNthCalledWith(3,{question:'Try that again',path:'/leave'});
  state.path='/claims';view.rerender(<NextIntlClientProvider locale="en" messages={en}><AssistantLauncher position="bottom-right" hiddenAreas={[]}/></NextIntlClientProvider>);
  send('My claims');await waitFor(()=>expect(state.ask).toHaveBeenCalledTimes(4));
  expect(state.ask).toHaveBeenNthCalledWith(4,{question:'My claims',path:'/claims'});
 });
 it('starts fresh after a successful reply without a continuation token',async()=>{
  state.ask.mockResolvedValueOnce({ok:true,exchangeId:'exchange-signed',conversationToken:'signed-scope',answer:<p>Signed answer</p>})
    .mockResolvedValueOnce({ok:true,exchangeId:'exchange-unsigned',answer:<p>Fresh answer</p>})
    .mockResolvedValue({ok:true,exchangeId:'exchange-third',answer:<p>Third answer</p>});
  show();fireEvent.click(screen.getByRole('button',{name:copy.open}));
  const send=(question:string)=>{fireEvent.change(screen.getByLabelText(copy.question),{target:{value:question}});fireEvent.click(screen.getByRole('button',{name:copy.send}));};
  send('First');await screen.findByText('Signed answer');send('Second');await screen.findByText('Fresh answer');
  expect(state.ask).toHaveBeenNthCalledWith(2,{question:'Second',path:'/leave',previousExchangeId:'exchange-signed',previousConversationToken:'signed-scope'});
  send('Third');await screen.findByText('Third answer');
  expect(state.ask).toHaveBeenNthCalledWith(3,{question:'Third',path:'/leave'});
 });
 it('does not attach a late response from the page left behind to the new page',async()=>{
  let finish!:(reply:unknown)=>void;
  state.ask.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))
    .mockResolvedValue({ok:true,exchangeId:'exchange-claims',answer:<p>Claims answer</p>});
  const view=show();fireEvent.click(screen.getByRole('button',{name:copy.open}));
  fireEvent.change(screen.getByLabelText(copy.question),{target:{value:'My leave'}});fireEvent.click(screen.getByRole('button',{name:copy.send}));
  state.path='/claims';view.rerender(<NextIntlClientProvider locale="en" messages={en}><AssistantLauncher position="bottom-right" hiddenAreas={[]}/></NextIntlClientProvider>);
  await act(async()=>{finish({ok:true,exchangeId:'exchange-old-page',conversationToken:'old-page-token',answer:<p>Old page answer</p>});});
  fireEvent.change(screen.getByLabelText(copy.question),{target:{value:'My claims'}});fireEvent.click(screen.getByRole('button',{name:copy.send}));
  expect(state.ask).toHaveBeenNthCalledWith(2,{question:'My claims',path:'/claims'});
  await screen.findByText('Claims answer');
 });
 it('respects IME and Shift+Enter, and blocks repeated sends while a reply is pending',async()=>{
  let finish!:(reply:unknown)=>void;
  state.ask.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));show();
  fireEvent.click(screen.getByRole('button',{name:copy.open}));
  const question=screen.getByLabelText(copy.question);
  fireEvent.change(question,{target:{value:'我的假期'}});
  fireEvent.keyDown(question,{key:'Enter',isComposing:true});fireEvent.keyDown(question,{key:'Enter',shiftKey:true});
  expect(state.ask).not.toHaveBeenCalled();
  fireEvent.keyDown(question,{key:'Enter'});fireEvent.keyDown(question,{key:'Enter'});
  expect(state.ask).toHaveBeenCalledTimes(1);expect(question).toHaveAttribute('readonly');
  expect(screen.getByRole('button',{name:copy.working})).toBeDisabled();
  await act(async()=>{finish({ok:false,message:'Unavailable'});});
  expect(screen.getByRole('alert')).toHaveTextContent('Unavailable');expect(question).not.toHaveAttribute('readonly');
 });

});
