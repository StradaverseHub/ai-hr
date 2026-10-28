'use client';
import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import { lumpAction, previewRewardLumpAction } from '../actions';
import type { previewRewardLump } from '@/packs/rewards/service';

type Preview = Awaited<ReturnType<typeof previewRewardLump>>;
type Mode = 'auto' | 'set' | 'withhold';
export type UnitLumpValue = {
  unitId: string; revision: number; unitName: string; scope: string; editable: boolean;
  suggestedLumpCents: number; lumpUnitCents: number | null; reason: string | null;
  decision: { at: string | null; actorName: string | null; reason: string | null } | null;
};
/**
 * 4e3e1af7 / c28db2f0 — the unit lump sum as three explicit choices, with the per-plan effect of the amount shown
 * (and recalculated by the server as it is typed) before saving. Withholding needs a confirmation and a reason.
 */
export function UnitLumpSum({ value: v }: { value: UnitLumpValue }) {
  const t = useTranslations('rewards'), locale = useLocale();
  const [mode, setMode] = useState<Mode>(v.lumpUnitCents == null ? 'auto' : v.lumpUnitCents === 0 ? 'withhold' : 'set');
  const [amount, setAmount] = useState(v.lumpUnitCents ? String(v.lumpUnitCents / 100) : '');
  const [reason, setReason] = useState(v.reason ?? ''), [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [, start] = useTransition();
  const money = (cents: number) => formatMoney(cents / 100, 'MYR');
  const percent = (bp: number | null) => bp == null ? '—' : `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bp / 100)}%`;
  const typed = amount.trim() === '' ? null : Math.round(Number(amount) * 100);
  const validAmount = typed != null && Number.isFinite(typed) && typed >= 1;
  const candidate = mode === 'auto' ? null : mode === 'withhold' ? 0 : validAmount ? typed : undefined;
  useEffect(() => {
    if (candidate === undefined) return;
    const timer = setTimeout(() => start(async () => {
      const result = await previewRewardLumpAction(v.unitId, v.revision, candidate);
      if (result.ok) { setPreview(result.preview); setError(''); } else setError(result.error);
    }), 300);
    return () => clearTimeout(timer);
  }, [candidate, v.unitId, v.revision]);
  const people = preview && preview.plans.every(p => p.count != null) ? preview.plans.reduce((n, p) => n + (p.count ?? 0), 0) : null;
  const reasonShort = reason.trim().length < 10;
  const choose = (next: Mode) => { setMode(next); setConfirming(false); };
  const options: [Mode, string, string][] = [
    ['auto', t('lumpChoice.auto', { amount: money(v.suggestedLumpCents) }), t('lumpChoice.autoHelp')],
    ['set', t('lumpChoice.set'), t('lumpChoice.setHelp')],
    ['withhold', t('lumpChoice.withhold'), t('lumpChoice.withholdHelp')],
  ];
  return <div className="space-y-4">
    {v.decision && <p role="note" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      {t('lumpChoice.withheldNote', { name: v.decision.actorName ?? t('lumpChoice.someone'), date: v.decision.at ?? '—' })}{v.decision.reason ? ` “${v.decision.reason}”` : ''}</p>}
    {v.editable ? <form action={lumpAction} className="space-y-3">
      <input type="hidden" name="unitId" value={v.unitId} /><input type="hidden" name="revision" value={v.revision} /><input type="hidden" name="mode" value={mode} />
      <p className="text-sm text-muted-foreground">{v.scope}</p>
      <fieldset className="space-y-2"><legend className="sr-only">{t('unitAmount')}</legend>
        {options.map(([key, label, help]) => <label key={key} className="flex items-start gap-2 text-sm">
          <input type="radio" name="choice" value={key} checked={mode === key} onChange={() => choose(key)} className="mt-1" />
          <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{help}</span></span>
        </label>)}
      </fieldset>
      {mode === 'set' && <Field label={t('unitAmount')}><input type="number" min="0.01" step="0.01" name="lump" required value={amount} onChange={e => setAmount(e.target.value)} className={inputCls} /></Field>}
      {mode === 'set' && validAmount && typed! > v.suggestedLumpCents && <p role="alert" className="text-sm text-amber-800 dark:text-amber-200">{t('lumpChoice.aboveSuggestion', { amount: money(v.suggestedLumpCents) })}</p>}
      <Field label={mode === 'withhold' ? t('lumpChoice.reasonRequired') : t('lumpChoice.reasonOptional')}><input name="reason" maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} className={`${inputCls} min-w-72`} /></Field>
      {mode === 'withhold' ? (confirming
        ? <div className="space-y-2 rounded-md border border-destructive/40 p-3">
            <p className="text-sm font-medium">{people == null ? t('lumpChoice.confirmAll', { unit: v.unitName }) : t('lumpChoice.confirm', { count: people, unit: v.unitName })}</p>
            <div className="flex gap-2"><Button type="submit" variant="destructive" disabled={reasonShort}>{t('lumpChoice.withhold')}</Button><Button type="button" variant="outline" onClick={() => setConfirming(false)}>{t('lumpChoice.cancel')}</Button></div>
          </div>
        : <><Button type="button" variant="destructive" disabled={reasonShort} onClick={() => setConfirming(true)}>{t('lumpChoice.withhold')}</Button>{reasonShort && <p className="text-xs text-muted-foreground">{t('lumpChoice.reasonHelp')}</p>}</>)
        : <Button type="submit" variant="secondary" disabled={mode === 'set' && !validAmount}>{t('unitBonus.saveLumpFor', { unit: v.unitName })}</Button>}
    </form> : <p className="text-sm">{t('unitAmount')}: <strong className="tabular-nums">{v.lumpUnitCents == null ? t('lumpChoice.auto', { amount: money(v.suggestedLumpCents) }) : v.lumpUnitCents === 0 ? t('lumpChoice.withhold') : money(v.lumpUnitCents)}</strong></p>}
    {preview && <div className="overflow-x-auto"><table className="w-full text-sm" aria-live="polite">
      <caption className="pb-2 text-left font-medium">{t('lumpImpact.title', { amount: money(preview.lumpUnitCents) })}</caption>
      <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th scope="col" className="px-2 py-2 text-left">{t('unitBonus.plan')}</th>{preview.plans.map(p => <th key={p.plan} scope="col" className="px-2 py-2 text-right">{t(p.plan)}</th>)}</tr></thead>
      <tbody className="divide-y divide-border">
        <tr><th scope="row" className="px-2 py-2 text-left font-normal">{t('lumpImpact.people')}</th>{preview.plans.map(p => <td key={p.plan} className="px-2 py-2 text-right tabular-nums">{p.count ?? '—'}</td>)}</tr>
        <tr><th scope="row" className="px-2 py-2 text-left font-normal">{t('lumpImpact.cost')}</th>{preview.plans.map(p => <td key={p.plan} className="px-2 py-2 text-right tabular-nums">{money(p.lumpCents)}</td>)}</tr>
        <tr><th scope="row" className="px-2 py-2 text-left font-normal">{t('lumpImpact.balance')}</th>{preview.plans.map(p => <td key={p.plan} className={`px-2 py-2 text-right tabular-nums ${p.balanceCents < 0 ? 'font-semibold text-destructive' : ''}`}>{money(p.balanceCents)}</td>)}</tr>
        <tr><th scope="row" className="px-2 py-2 text-left font-normal">{t('lumpImpact.used')}</th>{preview.plans.map(p => <td key={p.plan} className={`px-2 py-2 text-right tabular-nums ${p.over ? 'font-semibold text-destructive' : ''}`}>{percent(p.usedBp)}</td>)}</tr>
        <tr><th scope="row" className="px-2 py-2 text-left font-normal">{t('lumpImpact.amendments')}</th>{preview.plans.map(p => <td key={p.plan} className="px-2 py-2 text-right tabular-nums">{p.amendments == null ? '—' : p.amendments > 0 ? <Link className="text-primary hover:underline" href={`/rewards/${v.unitId}?view=review&check=BUD-05#checks`}>{t('lumpImpact.viewList', { count: p.amendments })}</Link> : 0}</td>)}</tr>
      </tbody>
    </table>
    {preview.plans.some(p => p.over) && <p role="alert" className="mt-2 text-sm text-destructive">{preview.exempt ? t('lumpImpact.overExempt') : t('lumpImpact.overBlocked')}</p>}
    <p className="mt-2 text-xs text-muted-foreground">{t('lumpImpact.amendmentsHelp')}</p></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
