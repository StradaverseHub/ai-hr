// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {FlagsButton} from '../app/rewards/[unitId]/desk/header-actions';
function Opener(){return <FlagsButton/>;}
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {defaultPolicy} from '../packs/rewards/model';
import type {PlanBudget} from '../packs/rewards/engine';
import type {getRewardUnit} from '../packs/rewards/service';
import {SalaryIncreaseTable,deskMoney} from '../app/rewards/[unitId]/desk/salary-increase-table';
import {SummaryTiles,budgetTone} from '../app/rewards/[unitId]/desk/summary-tiles';
import {FlagsDrawer} from '../app/rewards/[unitId]/desk/flags-drawer';
import {ReviewDeskProvider} from '../app/rewards/[unitId]/desk/review-desk';
import type {DeskSummary} from '../app/rewards/[unitId]/desk/desk-model';
import type {RewardFlag} from '../packs/rewards/model';
import {changedRewardMatrixCells} from '../app/rewards/[unitId]/desk/reference-matrix';
import {BonusPoolWorking} from '../app/rewards/[unitId]/desk/bonus-pool-working';
vi.mock('next/link',()=>({default:({children,scroll:_s,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('../app/rewards/actions',()=>({saveRewardCell:vi.fn()}));
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
 it('shows salary and bonus per plan with used / pool, share, amount left and a status colour, and the applied multiplier only',()=>{
  const summary:DeskSummary={plans:{standard:{salaryUsedCents:44000,salaryPoolCents:65000,bonusUsedCents:180000,bonusPoolCents:200000},h:{salaryUsedCents:70000,salaryPoolCents:65000,bonusUsedCents:0,bonusPoolCents:0}},multiplierBp:12500,lump:{perPersonCents:50000,people:3,totalCents:150000,mode:'auto'},blocks:0,warnings:0,flags:0};
  render(wrap(<ReviewDeskProvider unitId="unit" revision={1} summary={summary} totals={{people:0,basicCents:0,newBasicCents:0,bonusCents:0,lumpCents:0}} flags={[]} rows={[]} filters={{}}><SummaryTiles lumpEditor={null}/></ReviewDeskProvider>));
  const salary=within(screen.getByRole('heading',{name:en.rewards.desk.tiles.salary}).closest('section,div')!.parentElement!);
  expect(salary.getByText('MYR 440.00 of MYR 650.00')).toBeTruthy();expect(salary.getByText('MYR 210.00 left')).toBeTruthy();expect(salary.getByText('MYR 50.00 over')).toBeTruthy();
  expect(screen.getByText('1.25')).toBeTruthy();
  // The suggested-multiplier working (PAT achievement, target months) is not part of the tile.
  expect(screen.queryByText(en.rewards.unitBonus.suggestedTitle)).toBeNull();
  expect(screen.getByText('MYR 500.00')).toBeTruthy();expect(screen.getByText('3')).toBeTruthy();expect(screen.getByText('MYR 1,500.00')).toBeTruthy();
  expect(screen.queryByRole('button',{name:en.rewards.desk.tiles.change})).toBeNull();
  expect(budgetTone(70000,65000,'salary')).toBe('over');expect(budgetTone(62000,65000,'salary')).toBe('near');expect(budgetTone(10000,65000,'salary')).toBe('ok');
  expect(budgetTone(150000,200000,'bonus')).toBe('near');expect(budgetTone(180000,200000,'bonus')).toBe('ok');
 });
 it('lists flags blockers first in plain words, with Go to person and Go to section',()=>{
  const flags:RewardFlag[]=[{severity:'warning',code:'BUD-07',message:'Standard bonus budget is less than 80% utilised.'},{severity:'block',code:'PRO-02',message:'A promotion needs a business case of at least 30 characters.',entryId:'entry'},{severity:'review',code:'CFG-01',message:'JG H bonus exceeds the 100% budget cap.'}];
  const summary:DeskSummary={plans:{standard:{salaryUsedCents:0,salaryPoolCents:0,bonusUsedCents:0,bonusPoolCents:0},h:{salaryUsedCents:0,salaryPoolCents:0,bonusUsedCents:0,bonusPoolCents:0}},multiplierBp:10000,lump:{perPersonCents:0,people:0,totalCents:0,mode:'auto'},blocks:1,warnings:1,flags:3};
  render(wrap(<ReviewDeskProvider unitId="unit" revision={1} summary={summary} totals={{people:0,basicCents:0,newBasicCents:0,bonusCents:0,lumpCents:0}} flags={flags} rows={[]} filters={{}}><Opener/><FlagsDrawer personLinks={{entry:'/rewards/unit?q=Fictional&person=entry'}} sectionHrefs={{'salary-increase':'#salary-increase',bonus:'#bonus',people:'#people'}}/></ReviewDeskProvider>));
  fireEvent.click(screen.getByRole('button',{name:/Flags \(3\)/}));
  const items=within(screen.getByRole('dialog')).getAllByRole('listitem');
  expect(items[0].textContent).toContain(en.rewards.flagText.promotionCase);
  expect(within(items[0]).getByRole('link',{name:en.rewards.desk.goToPerson}).getAttribute('href')).toBe('/rewards/unit?q=Fictional&person=entry');
  expect(items[1].textContent).toContain('Standard plan: less than 80% of the bonus budget is used.');
  expect(within(items[1]).getByRole('link',{name:en.rewards.desk.goToSection}).getAttribute('href')).toBe('#bonus');
  expect(items[2].textContent).toContain('JG H plan: bonus is over the 100% budget cap.');
  expect(within(items[2]).getByRole('link',{name:en.rewards.desk.goToSection}).getAttribute('href')).toBe('#bonus');
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
