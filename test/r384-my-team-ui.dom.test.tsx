import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import vn from '../messages/vi.json';
import {MyTeam,type MyTeamProps} from '../components/my-team/my-team';
import {teamSnapshot,teamNavigation,ids} from './fixtures/my-team-ui';
const catalogues={en,ms,zh,ta,th,vi:vn};
const fetcher=vi.fn();
beforeEach(()=>{vi.stubGlobal('fetch',fetcher);fetcher.mockReset();window.history.replaceState(null,'','/manage/my-team');});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function mount(snapshot=teamSnapshot(),locale:keyof typeof catalogues='en',overrides:Partial<MyTeamProps>={}){
 const errors:unknown[]=[];const approveAction=vi.fn().mockResolvedValue({ok:true}),reviewAction=vi.fn().mockResolvedValue({ok:true});
 const props={snapshot,query:snapshot.query,navigation:teamNavigation(),periodDataHref:'/manage/my-team/period',exportHref:'/manage/my-team/export',approveAction,reviewAction,...overrides};
 const view=(next:MyTeamProps=props)=><NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error=>errors.push(error)}><MyTeam {...next}/></NextIntlClientProvider>;
 return {...render(view()),props,view,errors,approveAction,reviewAction};
}
function deferred(){let resolve!:(value:unknown)=>void;const promise=new Promise(resolve_=>{resolve=resolve_;});return {promise,resolve};}
const response=(snapshot=teamSnapshot())=>({ok:true,json:async()=>({snapshot,navigation:teamNavigation()})});
describe('My Team client consumes canonical facts and preserves action context',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders grid, all three panel tabs and controls in %s without missing messages',async locale=>{
  const {errors}=mount(teamSnapshot(),locale);const messages=catalogues[locale].myTeam;const user=userEvent.setup();
  expect(screen.getByRole('heading',{name:messages.title})).toBeTruthy();expect(fetcher).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:/Synthetic A S-01/}));
  const drawer=await screen.findByRole('dialog');expect(drawer.className).toContain('w-full');expect(drawer.className).toContain('lg:w-[28rem]');
  for(const name of [messages.attendance,messages.leaveBalance,messages.roster]){await user.click(within(drawer).getByRole('tab',{name}));expect(within(drawer).getByRole('tabpanel')).toBeTruthy();}
  expect(within(drawer).getByRole('link',{name:messages.viewWeekRoster}).getAttribute('href')).toContain('2026-09-28');
  await user.keyboard('{Escape}');await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole('button',{name:/Synthetic A S-01/}));expect(errors).toEqual([]);
 });
 it('shows the complete week, pending request range, KL application date, attention badge and absent shift facts',()=>{
  const snapshot=teamSnapshot();snapshot.actionableApprovals[0].appliedAt='2026-10-01T20:30:00Z';snapshot.attention.push({kind:'absent',id:'absent',employmentId:ids.person,date:snapshot.today,lateMinutes:null,pendingLeave:true});
  mount(snapshot);
  expect(screen.getByText(/28 Sep.*4 Oct/)).toBeTruthy();expect(screen.getByText(/Synthetic A.*5 Oct.*6 Oct/)).toBeTruthy();
  expect(screen.getByText(/applied Fri, 2 Oct/)).toBeTruthy();expect(screen.getByLabelText('2 items need attention').textContent).toBe('2');
  expect(screen.getByText(/D · 08:30–17:30/).textContent).toContain(en.myTeam.noCheckIn);expect(screen.getByText(/D · 08:30–17:30/).textContent).toContain(en.myTeam.leavePending);
  const today=screen.getByRole('region',{name:en.myTeam.today});expect(today.className).toContain('grid-cols-2');expect(today.className).toContain('min-[900px]:grid-cols-3');expect(today.className).not.toContain('xl:grid-cols-6');
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
  expect(within(drawer).getByText(/2 Nov/)).toBeTruthy(); // Upcoming group is outside the selected period, not derived from its cells.
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
  await act(async()=>second.resolve(response(latest)));expect(await screen.findByRole('button',{name:/Latest team S-01/})).toBeTruthy();
  const old=teamSnapshot();old.query.anchorDate='2026-10-09';old.employees[0].name='Obsolete team';await act(async()=>first.resolve(response(old)));
  expect(screen.queryByRole('button',{name:/Obsolete team/})).toBeNull();expect(screen.getByRole('button',{name:/Latest team S-01/})).toBeTruthy();
 });
 it('keeps full-scope Today counts while the server filters the grid, and toggles a selected tile off',async()=>{
  const snapshot=teamSnapshot();snapshot.todaySummary.members=7;mount(snapshot);
  const tile=screen.getByRole('button',{name:/Late 0/});const filtered=teamSnapshot();filtered.todaySummary.members=7;filtered.query.tile='late';filtered.gridEmploymentIds=[];fetcher.mockResolvedValueOnce(response(filtered));
  fireEvent.click(tile);await screen.findByText(en.myTeam.empty);expect(tile.getAttribute('aria-pressed')).toBe('true');expect(screen.getByRole('button',{name:/Team members 7/})).toBeTruthy();
  fetcher.mockResolvedValueOnce(response(snapshot));fireEvent.click(tile);await screen.findByRole('button',{name:/Synthetic A S-01/});expect(tile.getAttribute('aria-pressed')).toBe('false');
 });
 it('submits exact per-date IDs only after an explicit selection, with company scope and a rejection reason',async()=>{
  const snapshot=teamSnapshot();snapshot.actionableApprovals[0].dateDecisionRequired=true;
  const {approveAction}=mount(snapshot);const user=userEvent.setup();
  await user.click(screen.getByRole('button',{name:en.myTeam.chooseDates}));const approve=screen.getByRole('button',{name:en.myTeam.approve});expect((approve as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button',{name:en.myTeam.reject}) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('checkbox',{name:/5 Oct/}));await user.type(screen.getByRole('textbox',{name:en.myTeam.rejectReason}),'Overlaps another request');
  fetcher.mockResolvedValueOnce(response(snapshot));await user.click(screen.getByRole('button',{name:en.myTeam.reject}));await waitFor(()=>expect(approveAction).toHaveBeenCalledTimes(1));
  const data=approveAction.mock.calls[0][0] as FormData;expect(data.get('requestId')).toBe(ids.request);expect(data.get('decision')).toBe('rejected');expect(data.get('rejectReason')).toBe('Overlaps another request');expect(data.getAll('dateIds')).toEqual([ids.date]);expect(data.getAll('companyIds')).toEqual([ids.company]);
 });
 it('marks only the displayed immutable punch fingerprint reviewed and renders finite server errors',async()=>{
  const snapshot=teamSnapshot();snapshot.attention=[{kind:'missing_punch',id:'missing',employmentId:ids.person,date:'2026-10-01',attendanceId:ids.attendance,fingerprint:'version-specific'}];
  const reviewAction=vi.fn().mockResolvedValue({ok:false,error:'review_changed'});mount(snapshot,'en',{reviewAction});await userEvent.setup().click(screen.getByRole('button',{name:en.myTeam.review}));
  expect(reviewAction).toHaveBeenCalledTimes(1);const data=reviewAction.mock.calls[0][0] as FormData;expect(data.get('attendanceId')).toBe(ids.attendance);expect(data.get('fingerprint')).toBe('version-specific');expect(data.get('scope')).toBe('direct');expect(await screen.findByRole('alert')).toHaveProperty('textContent',en.myTeam.error_review_changed);
 });
 it('shows unavailable attendance without fabricated zero counts, while roster links remain usable',()=>{
  const snapshot=teamSnapshot();snapshot.availability.attendance='unavailable';snapshot.todaySummary.checkedIn=null;snapshot.todaySummary.late=null;snapshot.todaySummary.absent=null;
  mount(snapshot);expect(screen.getByRole('button',{name:/Checked in —/})).toHaveProperty('disabled',true);expect(screen.getByRole('link',{name:en.myTeam.viewRoster})).toBeTruthy();
 });
 it('an incoming authorized server context replaces an old drawer and search draft without another period request',async()=>{
  const {rerender,props,view}=mount();fireEvent.change(screen.getByRole('textbox',{name:en.myTeam.search}),{target:{value:'Unsaved search'}});fireEvent.click(screen.getByRole('button',{name:/Synthetic A S-01/}));
  const next=teamSnapshot();next.query.companyIds=[];next.employees=[];next.gridEmploymentIds=[];next.attention=[];next.todaySummary.members=0;
  rerender(view({...props,snapshot:next,query:next.query}));await screen.findByText(en.myTeam.empty);expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByRole('textbox',{name:en.myTeam.search})).toHaveProperty('value','');expect(fetcher).not.toHaveBeenCalled();
  expect(new URL(screen.getByRole('link',{name:en.myTeam.exportCsv}).getAttribute('href')!,'https://synthetic.invalid').searchParams.getAll('companyIds')).toEqual(['']);
 });
});
