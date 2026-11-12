'use client';
import { useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import { useReviewDesk } from './review-desk';

const money = (cents: number, locale: string) => formatMoney(cents === 0 ? 0 : cents / 100, 'MYR', locale);
const toneText: Record<BudgetTone, string> = { ok: 'text-emerald-800 dark:text-emerald-300', near: 'text-amber-800 dark:text-amber-200', over: 'text-destructive' };
const toneBar: Record<BudgetTone, string> = { ok: 'bg-emerald-700 dark:bg-emerald-500', near: 'bg-amber-600', over: 'bg-destructive' };

/** Budget status colour: over the pool is red; the last 5% of a pool, or a bonus pool under 80% used, is amber. */
export type BudgetTone = 'ok' | 'near' | 'over';
export function budgetTone(used: number, pool: number, kind: 'salary' | 'bonus'): BudgetTone {
  if (used > pool) return 'over';
  if (pool > 0 && used * 100 >= pool * 95) return 'near';
  if (kind === 'bonus' && pool > 0 && used * 100 < pool * 80) return 'near';
  return 'ok';
}

function PlanLine({ label, used, pool, kind, showLeft }: { label: string; used: number; pool: number; kind: 'salary' | 'bonus'; showLeft: boolean }) {
  const t = useTranslations('rewards.desk'), locale = useLocale();
  const state = budgetTone(used, pool, kind), left = pool - used;
  const share = pool > 0 ? new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(used / pool) : '—';
  const width = pool > 0 ? Math.max(0, Math.min(100, used / pool * 100)) : used > 0 ? 100 : 0;
  return <div className="space-y-1">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[13px]"><span className="font-medium">{label}</span><span className={`tabular-nums font-semibold ${toneText[state]}`}>{share}</span></div>
    <p className="text-[13px] tabular-nums text-muted-foreground">{t('usedOf', { used: money(used, locale), pool: money(pool, locale) })}{showLeft && <span className={`ml-2 ${toneText[state]}`}>{t(left < 0 ? 'amountOver' : 'amountLeft', { amount: money(Math.abs(left), locale) })}</span>}</p>
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(width)} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={`h-full ${toneBar[state]}`} style={{ width: `${width}%` }} /></div>
  </div>;
}

/**
 * 37f82412 — one row of three tiles: Salary increase and Bonus per plan (Standard / JG H), and the Lump sum.
 * Figures come from the server's calculated budgets and update after every saved cell. The Change link
 * opens the existing unit lump-sum choices (use suggested / set amount / withhold) when they may be changed.
 */
export function SummaryTiles({ lumpEditor }: { lumpEditor: ReactNode | null }) {
  const { summary } = useReviewDesk();
  const t = useTranslations('rewards'), d = useTranslations('rewards.desk'), locale = useLocale();
  const [lumpOpen, setLumpOpen] = useState(false);
  const plans = ['standard', 'h'] as const;
  const decimal = (bp: number) => new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bp / 10000);
  return <div className="grid gap-3 lg:grid-cols-3">
    <Card className="min-w-0 space-y-3 p-4" aria-labelledby="tile-salary"><h2 id="tile-salary" className="font-semibold">{d('tiles.salary')}</h2>
      {plans.map(plan => <PlanLine key={plan} label={t(plan)} used={summary.plans[plan].salaryUsedCents} pool={summary.plans[plan].salaryPoolCents} kind="salary" showLeft />)}
    </Card>
    <Card className="min-w-0 space-y-3 p-4" aria-labelledby="tile-bonus"><h2 id="tile-bonus" className="font-semibold">{d('tiles.bonus')}</h2>
      {plans.map(plan => <PlanLine key={plan} label={t(plan)} used={summary.plans[plan].bonusUsedCents} pool={summary.plans[plan].bonusPoolCents} kind="bonus" showLeft={false} />)}
      <p className="text-[13px]">{d('tiles.multiplier')}: <strong className="tabular-nums">{summary.multiplierBp == null ? t('branchStructure') : decimal(summary.multiplierBp)}</strong></p>
    </Card>
    <Card className="relative min-w-0 space-y-2 p-4" aria-labelledby="tile-lump"><div className="flex items-center justify-between gap-2"><h2 id="tile-lump" className="font-semibold">{t('lumpSum')}</h2>
      {lumpEditor && <button type="button" aria-expanded={lumpOpen} aria-controls="lump-options" onClick={() => setLumpOpen(open => !open)} className="text-sm font-medium text-primary hover:underline">{d('tiles.change')}</button>}</div>
      <dl className="grid grid-cols-3 gap-2 text-[13px]">
        <div><dt className="text-muted-foreground">{d('tiles.perPerson')}</dt><dd className="font-semibold tabular-nums">{summary.lump.mode === 'withhold' ? t('lumpChoice.withhold') : money(summary.lump.perPersonCents, locale)}</dd></div>
        <div><dt className="text-muted-foreground">{d('tiles.people')}</dt><dd className="font-semibold tabular-nums">{summary.lump.people}</dd></div>
        <div><dt className="text-muted-foreground">{d('tiles.total')}</dt><dd className="font-semibold tabular-nums">{money(summary.lump.totalCents, locale)}</dd></div>
      </dl>
      {lumpEditor && lumpOpen && <div id="lump-options" role="dialog" aria-label={t('lumpSum')} className="absolute right-0 top-full z-30 mt-2 w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-4 shadow-lg">{lumpEditor}</div>}
    </Card>
  </div>;
}
