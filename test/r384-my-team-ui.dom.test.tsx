import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import vn from '../messages/vi.json';
import {formatMyTeamCell,type MyTeamTranslate} from '../components/my-team/presentation';
import {createTranslator} from 'next-intl';
import {MyTeam,type MyTeamProps} from '../components/my-team/my-team';
import {teamSnapshot,teamNavigation,ids} from './fixtures/my-team-ui';
const catalogues={en,ms,zh,ta,th,vi:vn};
const fetcher=vi.fn();
beforeEach(()=>{vi.stubGlobal('fetch',fetcher);fetcher.mockReset();window.history.replaceState(null,'','/manage/my-team');});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function mount(snapshot=teamSnapshot(),locale:keyof typeof catalogues='en',overrides:Partial<MyTeamProps>={}){
 const errors:unknown[]=[];
 const props={snapshot,query:snapshot.query,navigation:teamNavigation(),periodDataHref:'/manage/my-team/period',exportHref:'/manage/my-team/export',...overrides};
 const view=(next:MyTeamProps=props)=><NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error=>errors.push(error)}><MyTeam {...next}/></NextIntlClientProvider>;
 return {...render(view()),props,view,errors};
}
function deferred(){let resolve!:(value:unknown)=>void;const promise=new Promise(resolve_=>{resolve=resolve_;});return {promise,resolve};}
const employeeButton=(name='Synthetic A')=>screen.getByRole('button',{name:`${name} S-01 Analyst`});
const response=(snapshot=teamSnapshot())=>({ok:true,json:async()=>({snapshot,navigation:teamNavigation()})});
describe('My Team client consumes canonical facts and preserves action context',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders grid, all three panel tabs and controls in %s without missing messages',async locale=>{
  const {errors}=mount(teamSnapshot(),locale);const messages=catalogues[locale].myTeam;const user=userEvent.setup();
  expect(screen.getByRole('heading',{name:messages.title})).toBeTruthy();expect(fetcher).not.toHaveBeenCalled();
  await user.click(employeeButton());
  const drawer=await screen.findByRole('dialog');expect(drawer.className).toContain('w-full');expect(drawer.className).toContain('lg:w-[28rem]');
  for(const name of [messages.attendance,messages.leaveBalance,messages.roster]){await user.click(within(drawer).getByRole('tab',{name}));expect(within(drawer).getByRole('tabpanel')).toBeTruthy();}
  expect(within(drawer).getByRole('link',{name:messages.viewWeekRoster}).getAttribute('href')).toContain('2026-09-28');
  await user.keyboard('{Escape}');await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(employeeButton());expect(errors).toEqual([]);
 });
 it.each(['week','month'] as const)('real local first-in/last-out appear in %s detail, panel and matching export presentation',async view=>{
  const snapshot=teamSnapshot();snapshot.query.view=view;const day=snapshot.employees[0].days[1];day.attendance!.checkInAt='09:00:00';day.attendance!.checkOutAt='18:00:00';mount(snapshot);
  const cell=screen.getByRole('button',{name:/Synthetic A.*Fri/});expect(cell.getAttribute('aria-label')).toContain('09:00–18:00');
  if(view==='week')expect(cell.textContent).toContain('09:00–18:00');else{cell.focus();expect((await screen.findByRole('tooltip')).textContent).toContain('09:00–18:00');}
  const t:MyTeamTranslate=createTranslator({locale:'en',messages:en,namespace:'myTeam'});const exported=formatMyTeamCell(day,snapshot.query.layers,'en',t,{today:snapshot.today,view}).exportText;
  expect(exported).toBe(view==='week'?'D · 09:00–18:00':'D');
  await userEvent.setup().click(cell);const drawer=await screen.findByRole('dialog');expect(within(drawer).getByText('09:00')).toBeTruthy();expect(within(drawer).getByText('18:00')).toBeTruthy();
 });
 // r392 (33930be9): the attention badge, pending-request titles and Today tile layout went with their sections.
 it('shows the complete week and the legend',()=>{
  mount();
  expect(screen.getByText(/Sep 28.*Oct 4/)).toBeTruthy();
  expect(screen.getByText(en.myTeam.status_upcoming)).toBeTruthy();
 });
 it('month cells expose full details on keyboard focus and panel tabs support arrow navigation and modal focus',async()=>{
  const snapshot=teamSnapshot();snapshot.query.view='month';mount(snapshot);const user=userEvent.setup();
  const cell=screen.getByRole('button',{name:/Synthetic A.*Fri/});cell.focus();
  const tooltip=await screen.findByRole('tooltip');expect(tooltip.textContent).toContain('08:30');expect(cell.getAttribute('aria-describedby')).toBe(tooltip.id);expect(cell.className).toContain('h-[30px]');
  await user.keyboard('{Enter}');const drawer=await screen.findByRole('dialog');expect(drawer.contains(document.activeElement)).toBe(true);
  const attendance=within(drawer).getByRole('tab',{name:en.myTeam.attendance});attendance.focus();await user.keyboard('{ArrowRight}');
  expect(within(drawer).getByRole('tab',{name:en.myTeam.leaveBalance}).getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(within(drawer).getByRole('tab',{name:en.myTeam.leaveBalance}));
  for(let index=0;index<12;index++){await user.tab();expect(drawer.contains(document.activeElement)).toBe(true);}
  expect(within(drawer).getByText(/Nov 2/)).toBeTruthy(); // Upcoming group is outside the selected period, not derived from its cells.
  await user.keyboard('{Escape}');await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(document.activeElement).toBe(cell);
 });
 it('switches all layers off without requests, retaining truthful status colours and full keyboard detail',()=>{
  const snapshot=teamSnapshot();snapshot.employees[0].days[1].attendance!.flag='late';
  mount(snapshot);const cell=screen.getByRole('button',{name:/Synthetic A.*Late/});
  for(const name of ['Roster','Attendance','Leave'])fireEvent.click(screen.getByRole('checkbox',{name}));
  expect(cell.textContent).toBe('');expect(cell.className).toContain('bg-amber-50');expect(cell.getAttribute('aria-label')).toContain('08:30');expect(fetcher).not.toHaveBeenCalled();
  expect(new URL(screen.getByRole('link',{name:en.myTeam.exportCsv}).getAttribute('href')!,'https://synthetic.invalid').searchParams.get('layers')).toBe('');
 });
 it('aborts an obsolete period request and ignores its late result even if fetch ignores abort',async()=>{
  const first=deferred(),second=deferred();fetcher.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);mount();
  fireEvent.click(screen.getByRole('button',{name:en.myTeam.next}));await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button',{name:en.myTeam.next}));await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  const latest=teamSnapshot();latest.query.anchorDate='2026-10-16';latest.employees[0].name='Latest team';
  await act(async()=>second.resolve(response(latest)));expect(await screen.findByRole('button',{name:'Latest team S-01 Analyst'})).toBeTruthy();
  const old=teamSnapshot();old.query.anchorDate='2026-10-09';old.employees[0].name='Obsolete team';await act(async()=>first.resolve(response(old)));
  expect(screen.queryByRole('button',{name:/Obsolete team/})).toBeNull();expect(employeeButton('Latest team')).toBeTruthy();
 });
 it('says attendance is unavailable instead of fabricating it, while roster links remain usable',()=>{
  const snapshot=teamSnapshot();snapshot.availability.attendance='unavailable';
  mount(snapshot);expect(screen.getByText(en.myTeam.sourceUnavailable.replace('{source}',en.myTeam.attendance))).toBeTruthy();expect(screen.getByRole('link',{name:en.myTeam.viewRoster})).toBeTruthy();
 });
 it('an incoming authorized server context replaces an old drawer and search draft without another period request',async()=>{
  const {rerender,props,view}=mount();fireEvent.change(screen.getByRole('textbox',{name:en.myTeam.search}),{target:{value:'Unsaved search'}});fireEvent.click(employeeButton());
  const next=teamSnapshot();next.query.companyIds=[];next.employees=[];next.gridEmploymentIds=[];next.attention=[];next.todaySummary.members=0;
  rerender(view({...props,snapshot:next,query:next.query}));await screen.findByText(en.myTeam.empty);expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByRole('textbox',{name:en.myTeam.search})).toHaveProperty('value','');expect(fetcher).not.toHaveBeenCalled();
  expect(new URL(screen.getByRole('link',{name:en.myTeam.exportCsv}).getAttribute('href')!,'https://synthetic.invalid').searchParams.getAll('companyIds')).toEqual(['']);
 });
});
