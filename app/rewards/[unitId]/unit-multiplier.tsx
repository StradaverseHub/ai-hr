'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { previewRewardMultiplierAction, saveRewardMultiplierAction } from '../actions';
import type { previewRewardMultiplier } from '@/packs/rewards/service';
import type { calculateRewards } from '@/packs/rewards/engine';

type Preview = Awaited<ReturnType<typeof previewRewardMultiplier>>;
export type UnitMultiplierValue = {
  unitId: string; revision: number; unitName: string; scope: string; multiplierBp: number | null; suggestedMultiplierBp: number;
  suggestion: Omit<ReturnType<typeof calculateRewards>['suggestion'], 'affordableBp'> | null; branch: boolean; canConfigure: boolean;
};
/** bcd7cc0f — how the suggested unit multiplier is worked out, and a reasoned, previewed override (Group Rewards, Draft only). */
export function UnitMultiplier({ value: v }: { value: UnitMultiplierValue }) {
  const t = useTranslations('rewards'), locale = useLocale(), router = useRouter();
  const [input, setInput] = useState(v.multiplierBp == null ? '' : String(v.multiplierBp / 10000)), [reason, setReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [saved, setSaved] = useState(false), [busy, start] = useTransition();
  const decimal = (n: number, digits = 2) => new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  const percent = (bp: number | null) => bp == null ? '—' : `${decimal(bp / 100, 1)}%`;
  const candidate = input.trim() === '' ? null : Math.round(Number(input) * 10000);
  const invalid = candidate != null && (!Number.isFinite(candidate) || candidate < 0);
  const current = preview && preview.requestedBp === candidate ? preview : null;
  const reasonShort = reason.trim().length < 10;
  const s = v.suggestion;
  const edit = (next: string) => { setInput(next); setPreview(null); setError(''); setSaved(false); };
  if (v.branch) return <p className="text-sm text-muted-foreground">{t('unitBonus.branchNotUsed')}</p>;
  return <div className="space-y-4">
    <section className="space-y-2 rounded-md border border-border p-4" aria-label={t('unitBonus.suggestedTitle')}>
      <h3 className="font-medium">{t('unitBonus.suggestedTitle')}: <span className="tabular-nums">{decimal(v.suggestedMultiplierBp / 10000)}</span></h3>
      {s && <dl className="divide-y divide-border text-sm">{[
        [t('unitBonus.achievement'), percent(s.achievementBp)],
        [t('unitBonus.targetMonths'), decimal(s.targetMonthsBp / 10000)],
        [t('unitBonus.poolMultiplier'), decimal(s.poolMultiplierBp / 10000)],
        [t('unitBonus.rule'), t('unitBonus.ruleText')],
      ].map(([label, text]) => <div key={label} className="flex justify-between gap-4 py-2"><dt>{label}</dt><dd className="text-right font-medium tabular-nums">{text}</dd></div>)}</dl>}
      {s?.patActualMissing && <p role="note" className="text-sm text-amber-800 dark:text-amber-200">{t('unitBonus.patMissing')}</p>}
    </section>
    <p className="text-sm text-muted-foreground">{t('unitBonus.bothPlans')}</p>
    {v.canConfigure && <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{v.scope}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('multiplierAuto')}><input type="number" min="0" step="0.01" name="multiplier" value={input} onChange={e => edit(e.target.value)} placeholder={t('automatic')} className={inputCls} /></Field>
        <Field label={t('unitBonus.reason')}><input name="reason" required minLength={10} maxLength={2000} value={reason} onChange={e => { setReason(e.target.value); setSaved(false); }} className={`${inputCls} min-w-72`} /></Field>
        <Button type="button" variant="outline" disabled={busy || invalid} onClick={() => start(async () => {
          setError(''); setSaved(false);
          const result = await previewRewardMultiplierAction(v.unitId, v.revision, candidate);
          if (result.ok) setPreview(result.preview); else { setPreview(null); setError(result.error); }
        })}>{t('unitBonus.checkImpact')}</Button>
      </div>
      {reasonShort && <p className="text-xs text-muted-foreground">{t('unitBonus.reasonHelp')}</p>}
      {current && <div className="space-y-2 rounded-md border border-border p-4">
        <table className="w-full text-sm"><caption className="pb-2 text-left font-medium">{t('unitBonus.checkImpact')}</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th scope="col" className="px-2 py-2 text-left">{t('unitBonus.plan')}</th><th scope="col" className="px-2 py-2 text-right">{t('unitBonus.usedNow')}</th><th scope="col" className="px-2 py-2 text-right">{t('unitBonus.usedWith', { multiplier: decimal(current.effectiveBp / 10000) })}</th></tr></thead>
          <tbody className="divide-y divide-border">{current.plans.map(p => <tr key={p.plan}><th scope="row" className="px-2 py-2 text-left font-normal">{t(p.plan)}</th><td className="px-2 py-2 text-right tabular-nums">{percent(p.nowBp)}</td><td className={`px-2 py-2 text-right tabular-nums ${p.over ? 'font-semibold text-destructive' : ''}`}>{percent(p.afterBp)}{p.over && ` · ${t('unitBonus.overBudget')}`}</td></tr>)}</tbody>
        </table>
        {current.blocked && <p role="alert" className="text-sm text-destructive">{t('unitBonus.overBlocked')}</p>}
        {!current.blocked && current.plans.some(p => p.over) && <p className="text-sm">{t('unitBonus.overExempt')}</p>}
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="button" disabled={busy || !current || current.blocked || reasonShort} onClick={() => start(async () => {
        if (!current) return; setError('');
        const result = await saveRewardMultiplierAction(v.unitId, v.revision, candidate, reason, current.digest);
        if (result.ok) { setPreview(null); setReason(''); setSaved(true); router.refresh(); } else { setPreview(null); setError(result.error); }
      })}>{t('unitBonus.saveUnitMultiplierFor', { unit: v.unitName })}</Button>
      {saved && <p role="status" className="text-sm">{t('unitBonus.multiplierSaved')}</p>}
    </div>}
  </div>;
}
