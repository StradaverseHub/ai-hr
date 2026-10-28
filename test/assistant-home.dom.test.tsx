/** @vitest-environment jsdom */
/** Assistant home: the hero question box with chips, and the "My work" / "Calendar" tabs. Presentation
 * only; each panel is an existing home card with its own authorized reader, proved by its own suite. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {AssistantHomeTabs} from '../components/assistant/assistant-home-tabs';
import {WorkspaceComposer} from '../components/assistant/workspace-composer';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
afterEach(cleanup);
const labels={tabs:'Your work and calendar',work:'My work',calendar:'Calendar'};
describe('Assistant home tabs',()=>{
 it('opens on My work, mounts only the selected panel and switches by click and arrow keys',()=>{
  render(<AssistantHomeTabs labels={labels} work={<p>WORK PANEL</p>} calendar={<p>CALENDAR PANEL</p>}/>);
  const [work,calendar]=screen.getAllByRole('tab');
  expect(work).toHaveAttribute('aria-selected','true');expect(calendar).toHaveAttribute('tabindex','-1');
  expect(screen.getByRole('tabpanel')).toHaveTextContent('WORK PANEL');expect(screen.queryByText('CALENDAR PANEL')).toBeNull();
  fireEvent.click(calendar);expect(screen.getByRole('tabpanel')).toHaveTextContent('CALENDAR PANEL');expect(screen.queryByText('WORK PANEL')).toBeNull();
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby',calendar.id);
  fireEvent.keyDown(calendar,{key:'ArrowRight'});expect(work).toHaveAttribute('aria-selected','true');expect(document.activeElement).toBe(work);
  fireEvent.keyDown(work,{key:'End'});expect(calendar).toHaveAttribute('aria-selected','true');
 });
 it.each([['en',en],['ms',ms],['zh',zh],['ta',ta],['th',th],['vi',viMessages]] as const)('%s has every home string, with the name in each named greeting',(_l,copy)=>{
  const home=(copy as typeof en).assistant.home;
  for(const key of ['morning','afternoon','evening'] as const)expect(home[key]).toContain('{name}');
  for(const key of ['morningNoName','afternoonNoName','eveningNoName','tabs','myWork','calendar','noEmployment','privacy'] as const)expect(home[key].length).toBeGreaterThan(0);
 });
});
describe('hero question box',()=>{
 const props={action:vi.fn(async()=>{}),tasks:[{id:'leave_balance' as never,label:'My leave balance',prompt:'What is my leave balance?'}],
  labels:{tasks:'Quick tasks',taskHint:'Choose one to fill the box',question:'Your question',placeholder:'Ask about your work',ask:'Send',working:'Working…',scope:'Answers use only what you can already see.'}};
 it('keeps the labelled box, send inside it, and chips that only fill the box',()=>{
  render(<WorkspaceComposer {...props} layout="hero"/>);
  const box=screen.getByLabelText('Your question') as HTMLTextAreaElement,send=screen.getByRole('button',{name:'Send'}) as HTMLButtonElement;
  expect(send.disabled).toBe(true);expect(box.closest('div')!.contains(send)).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'My leave balance'}));
  expect(box.value).toBe('What is my leave balance?');expect(document.activeElement).toBe(box);expect(props.action).not.toHaveBeenCalled();expect(send.disabled).toBe(false);
  // Chips follow the box in reading order.
  expect(box.compareDocumentPosition(screen.getByRole('button',{name:'My leave balance'}))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 });
});
