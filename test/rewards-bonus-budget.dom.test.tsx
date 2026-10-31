import {afterEach,expect,it} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import en from '../messages/en.json';
import {BonusBudgetCards} from '../app/(app)/rewards/[unitId]/bonus-budget';
import {blankBudget} from '../packs/rewards/engine';
import {defaultPolicy} from '../packs/rewards/model';

const t=(key:string)=>key.split('.').reduce((value:any,part)=>value[part],en.rewards);
const fixture=()=>({unit:{policy:{...defaultPolicy(2026),patTarget:6200000000,patActual:5890000000,targetMonthsBp:20000,multiplierBp:7800}},
 budgets:{standard:{...blankBudget(),bonusPayrollCents:3140000,bonusPoolCents:5966000,standardBonusCents:5756400,bonusUsedCents:5756400,balanceCents:209600},h:{...blankBudget(),bonusPoolCents:345800,standardBonusCents:141900,bonusUsedCents:141900,balanceCents:203900}},
 bonusCounts:{standard:{eligible:5,increases:0,reductions:0,lump:0},h:{eligible:1,increases:0,reductions:0,lump:0}},suggestedMultiplierBp:7800});
afterEach(cleanup);
it('renders the two approved reference pools separately and explains their saved construction',()=>{
 render(<BonusBudgetCards value={fixture()} t={t} locale="en"/>);
 const standard=within(screen.getByRole('heading',{name:en.rewards.standard}).closest('header')!.parentElement!);
 const h=within(screen.getByRole('heading',{name:en.rewards.h}).closest('header')!.parentElement!);
 expect(standard.getAllByText('96.5%').length).toBeGreaterThan(0);
 expect(h.getAllByText('41.0%').length).toBeGreaterThan(0);
 expect(standard.getByText(en.rewards.bonusPresentation.within)).toBeVisible();
 expect(h.getByText(en.rewards.bonusPresentation.under)).toBeVisible();
 expect(standard.getByText('1.90')).toBeInTheDocument();
 expect(standard.getByText('MYR 31,400.00')).toBeInTheDocument();
 expect(standard.getByText('MYR 59,660.00')).toBeInTheDocument();
 expect(standard.getByText('MYR 57,564.00 / MYR 59,660.00')).toBeInTheDocument();
 expect(standard.getAllByText('MYR 2,096.00').length).toBeGreaterThan(0);
 expect(standard.getByText('MYR 62,000,000.00')).toBeInTheDocument();
 expect(standard.getByText('MYR 58,900,000.00')).toBeInTheDocument();
 expect(h.getByText('MYR 1,419.00 / MYR 3,458.00')).toBeInTheDocument();
 expect(h.getAllByText('MYR 2,039.00').length).toBeGreaterThan(0);
 expect(h.queryByText('MYR 59,660.00')).toBeNull();
});
it('renders saved PAT cents and fractional ringgit without multiplying monetary figures by one hundred',()=>{
 const v=fixture();v.unit.policy.patTarget=10000000;v.unit.policy.patActual=10000000;
 Object.assign(v.budgets.standard,{bonusPayrollCents:123456,bonusPoolCents:246912,standardBonusCents:123456,bonusUsedCents:123456,balanceCents:123456});
 render(<BonusBudgetCards value={v} t={t} locale="en"/>);
 const standard=within(screen.getByRole('heading',{name:en.rewards.standard}).closest('header')!.parentElement!);
 expect(standard.getAllByText('MYR 100,000.00')).toHaveLength(2);
 expect(standard.queryByText('MYR 10,000,000.00')).toBeNull();
 expect(standard.getByText('MYR 1,234.56 / MYR 2,469.12')).toBeInTheDocument();
 expect(standard.getAllByText('MYR 1,234.56').length).toBeGreaterThan(0);
});
it('shows reductions as subtraction and preserves independent category membership counts',()=>{
 const v=fixture();Object.assign(v.budgets.standard,{increasesCents:10000,reductionsCents:20000,lumpCents:5000,bonusUsedCents:5751400,balanceCents:214600});
 v.bonusCounts.standard={eligible:5,increases:1,reductions:2,lump:1};
 render(<BonusBudgetCards value={v} t={t} locale="en"/>);
 const standard=within(screen.getByRole('heading',{name:en.rewards.standard}).closest('header')!.parentElement!);
 const row=within(standard.getByRole('rowheader',{name:new RegExp(en.rewards.reductionsCents)}).closest('tr')!);
 expect(row.getByText('MYR -200.00')).toBeVisible();expect(row.getByText('2')).toBeVisible();
 expect(standard.getByRole('meter')).toHaveAttribute('aria-valuetext','96.4%');
});
it('does not turn positive spending against no funding into successful zero utilisation',()=>{
 const v=fixture();v.budgets.standard.bonusPoolCents=0;v.budgets.standard.balanceCents=-5756400;
 render(<BonusBudgetCards value={v} t={t} locale="en"/>);
 const standard=within(screen.getByRole('heading',{name:en.rewards.standard}).closest('header')!.parentElement!);
 expect(standard.getByText(en.rewards.bonusPresentation.over)).toBeVisible();
 expect(standard.getByRole('meter')).toHaveAttribute('aria-valuetext',en.rewards.bonusPresentation.over);
 expect(standard.queryByText('0.0%')).toBeNull();expect(standard.getAllByText('MYR -57,564.00').length).toBeGreaterThan(0);
});
it('does not invent category counts from a partial confidential roster',()=>{
 const v:{[K in keyof ReturnType<typeof fixture>]:ReturnType<typeof fixture>[K]}=fixture();
 render(<BonusBudgetCards value={{...v,bonusCounts:{standard:null,h:v.bonusCounts.h}}} t={t} locale="en"/>);
 expect(screen.getByText(en.rewards.bonusPresentation.restrictedCount)).toBeVisible();
});
