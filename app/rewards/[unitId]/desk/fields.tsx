'use client';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/money';
import type { DeskRow } from './desk-model';
import type { RewardCellField } from '../../actions';
import { useReviewDesk } from './review-desk';

/** The stored override as the input shows it (percent, multiplier or MYR). */
const inputText = (field: RewardCellField, value: number | string | null) => value == null ? '' : typeof value === 'string' ? value : String(value / (field === 'multiplierBp' ? 10000 : 100));

/** One editable cell: the stored override (highlighted, with Reset) or the calculated value as a placeholder. */
export function EditCell({ row, field, label, placeholder, step, suggested = false }: { row: DeskRow; field: 'meritBp' | 'promotionBp' | 'specialBp' | 'multiplierBp' | 'lumpCents'; label: string; placeholder: string; step: string; suggested?: boolean }) {
  const { save } = useReviewDesk();
  const t = useTranslations('rewards.desk.cell');
  const stored = inputText(field, row.inputs[field]);
  const [draft, setDraft] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setDraft(stored); setError(''); }, [stored, row.id]);
  const commit = async (value: string) => {
    if (value === stored || busy) return;
    setBusy(true); setError('');
    const result = await save(row.id, field, value);
    setBusy(false);
    if (!result.ok) { setError(result.error); setDraft(stored); }
  };
  const edited = row.overrides[field];
  const p = useTranslations('rewards.desk.panel');
  const locale = useLocale();
  const suggestion = row.suggested?.[field];
  const format = (value: number) => field === 'multiplierBp' ? new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value / 10000) : field === 'lumpCents' ? formatMoney(value / 100, 'MYR', locale) : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value / 100)}%`;
  const difference = row.differences?.[field];
  return <span className="inline-flex flex-col items-end gap-0.5">
    <input aria-label={`${label} · ${row.name}`} inputMode="decimal" type="text" value={draft} placeholder={placeholder} disabled={busy} aria-invalid={!!error || undefined}
      onChange={event => setDraft(event.target.value)} onBlur={event => void commit(event.target.value.trim())}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { setDraft(stored); } }}
      data-step={step} className={`h-7 w-[4.5rem] rounded border px-1.5 text-right text-[13px] tabular-nums ${edited ? 'border-primary bg-amber-50 font-semibold dark:bg-amber-950' : 'border-border bg-background'}`} />
    {edited && <button type="button" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => void commit('')} className="text-[11px] text-primary underline">{suggested ? p('useSuggested') : t('reset')}</button>}
    {suggested && suggestion != null && <span className="max-w-56 text-right text-xs text-muted-foreground">{p('suggested', { value: format(suggestion) })}{field === 'meritBp' ? ` · ${row.talent ?? '—'} ${p(`range.${row.rangePosition}`)}` : ''}{edited && difference != null && difference !== 0 ? ` · ${p('difference', { value: `${difference > 0 ? '+' : '−'}${format(Math.abs(difference))}` })}` : ''}</span>}
    {row.withhold?.[field === 'multiplierBp' ? 'bonus' : field === 'lumpCents' ? 'lump' : 'increase'] && <span className="text-xs font-medium text-amber-900 dark:text-amber-200">{p('withheld')}</span>}
    {error && <span role="alert" className="max-w-40 whitespace-normal text-[11px] text-destructive">{error}</span>}
  </span>;
}

export function PromotionCell({ row, suggested = false }: { row: DeskRow; suggested?: boolean }) {
  const { save } = useReviewDesk();
  const t = useTranslations('rewards.desk.cell'), r = useTranslations('rewards');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = async (grade: string) => {
    setBusy(true); setError('');
    const result = await save(row.id, 'promotionGrade', grade);
    setBusy(false);
    if (!result.ok) setError(result.error);
  };
  return <span className="inline-flex flex-col items-end gap-0.5">
    <select aria-label={`${r('promotion')} · ${row.name}`} value={row.promotionGrade ?? ''} disabled={busy} onChange={event => void change(event.target.value)}
      className={`h-7 rounded border px-1 text-[13px] ${row.overrides.promotionGrade ? 'border-primary bg-amber-50 font-semibold dark:bg-amber-950' : 'border-border bg-background'}`}>
      <option value="">{t('noPromotion')}</option>
      {[...new Set([...(row.promotionGrade ? [row.promotionGrade] : []), ...row.promotionGrades])].map(grade => <option key={grade} value={grade}>{t('toGrade', { grade })}</option>)}
    </select>
    {row.promotionGrade && <EditCell row={row} field="promotionBp" label={`${r('promotion')} %`} placeholder={String((row.promotionBp ?? 0) / 100)} step="0.01" suggested={suggested} />}
    {error && <span role="alert" className="max-w-40 whitespace-normal text-[11px] text-destructive">{error}</span>}
  </span>;
}
