// @vitest-environment jsdom
/** Board b945f0cc: the Off-cycle side of "Reviewing Team Rewards" and the Year-end cycle / Off-cycle switch. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
import {RewardsOffcycleDashboard} from '../app/rewards/offcycle-dashboard';
import {RewardsDashboardKindSwitch} from '../app/rewards/dashboard-kind-switch';
import type {RewardOffcycleDashboard} from '../packs/rewards/service';
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
const refresh=vi.hoisted(()=>vi.fn());
vi.mock('next/navigation',()=>({useRouter:()=>({refresh})}));
const saveKind=vi.hoisted(()=>vi.fn());
vi.mock('../app/rewards/dashboard-actions',()=>({saveDashboardKindAction:saveKind,saveDashboardAction:vi.fn()}));
const copies={en,ms,zh,ta,th,vi:viCopy};
const C1='aaaaaaaa-0000-4000-8000-000000000001',C2='aaaaaaaa-0000-4000-8000-000000000002';
const value:RewardOffcycleDashboard={cycle:{id:'cycle',name:'2026 Annual Compensation Review',year:2026},
 balances:[{companyId:C1,company:'Fictional Alpha',frozenCents:1_000_000,heldCents:250_000,consumedCents:150_000,availableCents:600_000},{companyId:C2,company:'Fictional Beta',frozenCents:50_000,heldCents:0,consumedCents:0,availableCents:50_000}],
 requests:[{id:'r1',kind:'adhoc',exception:false,status:'gr',returned:false,company:'Fictional Alpha',unit:'CHCE',effectiveFrom:'2027-03-01',due:'2027-02-10',daysUntilDue:5,people:1},
  {id:'r2',kind:'midyear',exception:false,status:'draft',returned:true,company:'Fictional Alpha',unit:'CHCE',effectiveFrom:'2027-07-01',due:null,daysUntilDue:null,people:4},
  {id:'r3',kind:'adhoc',exception:true,status:'approved',returned:false,company:'Fictional Beta',unit:'CHCE',effectiveFrom:'2027-10-01',due:null,daysUntilDue:null,people:1}],
 canRaise:true,canConfigure:false,blackout:false,midyearOpen:true,window:{from:'2027-06-01',to:'2027-06-30'}};
const show=(v:RewardOffcycleDashboard,locale:keyof typeof copies='en')=>render(<NextIntlClientProvider locale={locale} messages={copies[locale]} onError={error=>{throw error;}}><RewardsOffcycleDashboard value={v}/></NextIntlClientProvider>);
beforeEach(()=>{saveKind.mockReset();saveKind.mockResolvedValue(undefined);refresh.mockReset();});
afterEach(cleanup);

describe('Off-cycle dashboard (b945f0cc)',()=>{
 it('shows each company balance from the service figures, the viewer requests with status and due date, and the two buttons',()=>{
  show(value);
  const rows=screen.getAllByTestId('offcycle-company-balance');
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain('Fictional Alpha');
  expect(rows[0].textContent).toMatch(/6,000\.00 left/);
  expect(rows[0].textContent).toMatch(/Year-end remainder.*10,000\.00/);
  expect(rows[0].textContent).toMatch(/Held by requests.*2,500\.00/);
  expect(rows[0].textContent).toMatch(/Paid out.*1,500\.00/);
  const meter=screen.getAllByRole('meter')[0];
  expect(meter.getAttribute('aria-valuenow')).toBe('400000');expect(meter.getAttribute('aria-valuemax')).toBe('1000000');
  const requests=screen.getAllByTestId('offcycle-request');
  expect(requests.map(r=>r.textContent)).toEqual([
   expect.stringMatching(/Fictional Alpha · CHCE.*Ad-hoc request · In approval \(.+\).*2027-02-10/),
   expect.stringMatching(/Mid-year review · Returned/),
   expect.stringMatching(/Ad-hoc request · Budget exception.*· Approved/),
  ]);
  expect(screen.getByRole('link',{name:'Add mid-year recommendation'}).getAttribute('href')).toBe('/rewards/offcycle/new?kind=midyear');
  expect(screen.getByRole('link',{name:'New ad hoc request'}).getAttribute('href')).toBe('/rewards/offcycle/new?kind=adhoc');
  expect(screen.queryByRole('link',{name:'Off-cycle settings'})).toBeNull();
  expect(screen.getByTestId('offcycle-context').textContent).toBe('2026 Annual Compensation Review · Mid-year window 1 Jun 2027 – 30 Jun 2027');
 });
 it('says when the off-cycle year is not open, hides the buttons without permission and shows the blackout',()=>{
  const {unmount}=show({...value,cycle:null,balances:[],requests:[],canConfigure:true});
  expect(screen.getByRole('status').textContent).toBe(en.rewardDashboard.offcycle.notOpen);
  expect(screen.getByRole('link',{name:'Off-cycle settings'}).getAttribute('href')).toBe('/rewards/offcycle/settings');
  unmount();
  show({...value,canRaise:false,blackout:true,midyearOpen:false});
  expect(screen.queryByRole('link',{name:'New ad hoc request'})).toBeNull();
  expect(screen.getByText(en.rewardDashboard.offcycle.blackout)).toBeTruthy();
 });
 it('saves the Year-end cycle / Off-cycle switch and refreshes',async()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><RewardsDashboardKindSwitch kind="annual"/></NextIntlClientProvider>);
  expect(screen.getByRole('button',{name:'Year-end cycle'}).getAttribute('aria-pressed')).toBe('true');
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Off-cycle'}));});
  expect(saveKind).toHaveBeenCalledWith('offcycle');expect(refresh).toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'Off-cycle'}).getAttribute('aria-pressed')).toBe('true');
 });
 it.each(Object.keys(copies) as (keyof typeof copies)[])('renders every string in %s',locale=>{
  const view=show(value,locale);
  expect(view.container.textContent).not.toMatch(/rewardDashboard\.|rewards\./);
 });
});
