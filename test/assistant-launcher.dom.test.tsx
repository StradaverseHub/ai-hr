/** @vitest-environment jsdom */
/** The floating Assistant window: where it appears, opening, docking, closing and one round trip. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
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
});
