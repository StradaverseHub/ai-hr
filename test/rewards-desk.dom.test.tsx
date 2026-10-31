// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {defaultPolicy} from '../packs/rewards/model';
import type {PlanBudget} from '../packs/rewards/engine';
import type {getRewardUnit} from '../packs/rewards/service';
import {SalaryIncreaseTable,deskMoney} from '../app/(app)/rewards/[unitId]/desk/salary-increase-table';
import {SummaryStrip} from '../app/(app)/rewards/[unitId]/desk/summary-strip';
import {FlagsPanel} from '../app/(app)/rewards/[unitId]/desk/flags-panel';
import {changedRewardMatrixCells} from '../app/(app)/rewards/[unitId]/desk/reference-matrix';
import {BonusPoolWorking} from '../app/(app)/rewards/[unitId]/desk/bonus-pool-working';
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
const budget={payrollCents:1000000,pools:[50000,10000,5000],used:[30000,12000,2000],bonusPayrollCents:1000000,bonusPoolCents:200000,bonusUsedCents:180000,balanceCents:20000} as PlanBudget;
const view={roles:['gr'],unit:{id:'unit',status:'draft',kind:'annual',snapshotDate:'2026-10-29',policy:{...defaultPolicy(2026),patActual:90,patTarget:100,targetMonthsBp:20000}},budgets:{standard:budget,h:{...budget,pools:[0,0,0],used:[0,0,0],bonusPoolCents:0,bonusUsedCents:0}},returned:null,due:null} as unknown as Awaited<ReturnType<typeof getRewardUnit>>;
const wrap=(node:React.ReactNode)=><NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>;
afterEach(cleanup);
describe('Reward Desk step 1',()=>{
 it('renders a single salary comparison with merit, promotion, special and total, payroll shares, balances and meters',()=>{
  render(wrap(<SalaryIncreaseTable budgets={view.budgets}/>));const table=screen.getByRole('table',{name:en.rewards.desk.salary});
  expect(within(table).getAllByRole('row')).toHaveLength(5);
  expect(within(table).getByText('MYR 20.00 over')).toBeTruthy();expect(within(table).getByText('3.0% of payroll')).toBeTruthy();
  expect(within(table).getAllByRole('meter')).toHaveLength(8);
  expect(within(table).getByText('MYR 440.00 / MYR 650.00')).toBeTruthy();
 });
 it('marks a category overrun red even when the combined pool still has money, and links each summary to its section',()=>{
  render(wrap(<SummaryStrip value={view} holders={['Fictional BU CEO']}/>));
  expect(screen.getByText('Over budget')).toBeTruthy();expect(screen.getByText('Within budget')).toBeTruthy();expect(screen.getByText('Fictional BU CEO')).toBeTruthy();
  expect(screen.getAllByRole('link',{name:'Go to section'}).map(a=>a.getAttribute('href'))).toEqual(['#salary-increase','#bonus']);
  expect(screen.getByRole('link',{name:'Approval history'}).getAttribute('href')).toBe('#approvals');
 });
 it('makes the whole plain-language flag a link to its person or budget section without internal codes',()=>{
  render(wrap(<FlagsPanel unitId="unit" filtered={false} flags={[{severity:'block',code:'SAL-01',message:'Fictional person needs a salary correction.',entryId:'entry'},{severity:'warning',code:'BUD-01',message:'Bonus exceeds its pool.'}]}/>));
  expect(screen.getByRole('link',{name:/Fictional person/}).getAttribute('href')).toBe('/rewards/unit/people/entry');
  expect(screen.getByRole('link',{name:/Bonus exceeds/}).getAttribute('href')).toBe('#bonus');expect(screen.queryByText('SAL-01')).toBeNull();
 });
 it('links exempted pool warnings to the actual salary or bonus section',()=>{
  render(wrap(<FlagsPanel unitId="unit" filtered={false} flags={[{severity:'review',code:'CFG-01',message:'Standard merit exceeds its separate pool.'},{severity:'review',code:'CFG-01',message:'JG H bonus exceeds the 100% budget cap.'}]}/>));
  expect(screen.getByRole('link',{name:/Standard merit/}).getAttribute('href')).toBe('#salary-increase');
  expect(screen.getByRole('link',{name:/JG H bonus/}).getAttribute('href')).toBe('#bonus');
 });
 it('shows the pool working after the pool cards without changing the canonical pool amount',()=>{
  render(wrap(<BonusPoolWorking value={view}/>));expect(screen.getByText(en.rewards.desk.poolFormula)).toBeTruthy();expect(screen.getAllByText('MYR 2,000.00')).toHaveLength(1);expect(screen.getAllByText('90%')).toHaveLength(2);
 });
 it('counts changed reference cells and renders negative zero as MYR 0.00',()=>{
  expect(changedRewardMatrixCells({A:[1,2,3],B:[4,5]},{A:[1,9,3],B:[4,5]})).toBe(1);
  expect(changedRewardMatrixCells({A:[1,2],New:[0,0]},{A:[1,2]})).toBe(2);
  expect(deskMoney(-0,'en')).toBe('MYR 0.00');
 });
});
