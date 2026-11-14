'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/money';
import type { DeskRow } from './desk-model';
import type { RewardCellField } from '../../actions';
import { useReviewDesk } from './review-desk';

/** Optional columns a viewer may hide so the table fits a laptop screen without scrolling sideways. */
export const OPTIONAL_COLUMNS = ['talent', 'performance', 'currentBasic', 'crBefore', 'special', 'crAfter', 'months', 'lump'] as const;
export type OptionalColumn = typeof OPTIONAL_COLUMNS[number];
/** Hidden by default: with these off the default table fits a 1366 px screen next to the side menu. */
export const DEFAULT_HIDDEN: readonly OptionalColumn[] = ['crBefore', 'special', 'crAfter'];
const STORAGE_KEY = 'aihr.rewards.review.columns.v1';

function readHidden(): OptionalColumn[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed.filter((c): c is OptionalColumn => (OPTIONAL_COLUMNS as readonly string[]).includes(c));
  } catch { /* storage unavailable: keep the defaults */ }
  return [...DEFAULT_HIDDEN];
}

const money = (cents: number | null, locale: string) => cents == null ? '—' : formatMoney(cents === 0 ? 0 : cents / 100, 'MYR', locale);
const pct = (bp: number | null, locale: string) => bp == null ? '—' : `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(bp / 100)}%`;
const decimal = (bp: number | null, locale: string) => bp == null ? '—' : new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bp / 10000);
/** The stored override as the input shows it (percent, multiplier or MYR). */
const inputText = (field: RewardCellField, value: number | string | null) => value == null ? '' : typeof value === 'string' ? value : String(value / (field === 'multiplierBp' ? 10000 : 100));

/** One editable cell: the stored override (highlighted, with Reset) or the calculated value as a placeholder. */
function EditCell({ row, field, label, placeholder, step }: { row: DeskRow; field: 'meritBp' | 'promotionBp' | 'specialBp' | 'multiplierBp' | 'lumpCents'; label: string; placeholder: string; step: string }) {
  const { save } = useReviewDesk();
  const t = useTranslations('rewards.desk.cell');
  const stored = inputText(field, row.inputs[field]);
  const [draft, setDraft] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setDraft(stored); }, [stored]);
  const commit = async (value: string) => {
    if (value === stored || busy) return;
    setBusy(true); setError('');
    const result = await save(row.id, field, value);
    setBusy(false);
    if (!result.ok) { setError(result.error); setDraft(stored); }
  };
  const edited = row.overrides[field];
  return <span className="inline-flex flex-col items-end gap-0.5">
    <input aria-label={`${label} · ${row.name}`} inputMode="decimal" type="text" value={draft} placeholder={placeholder} disabled={busy} aria-invalid={!!error || undefined}
      onChange={event => setDraft(event.target.value)} onBlur={event => void commit(event.target.value.trim())}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { setDraft(stored); } }}
      data-step={step} className={`h-7 w-[4.5rem] rounded border px-1.5 text-right text-[13px] tabular-nums ${edited ? 'border-primary bg-amber-50 font-semibold dark:bg-amber-950' : 'border-border bg-background'}`} />
    {edited && <button type="button" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => void commit('')} className="text-[11px] text-primary underline">{t('reset')}</button>}
    {error && <span role="alert" className="max-w-40 whitespace-normal text-[11px] text-destructive">{error}</span>}
  </span>;
}

function PromotionCell({ row }: { row: DeskRow }) {
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
    {row.promotionGrade && <EditCell row={row} field="promotionBp" label={`${r('promotion')} %`} placeholder="10" step="0.01" />}
    {error && <span role="alert" className="max-w-40 whitespace-normal text-[11px] text-destructive">{error}</span>}
  </span>;
}

/**
 * 37f82412 — the full-width People table. Grouped headings (Employee, Pay now, Salary increase, Bonus, Flags),
 * a sticky header row and Employee column, a sticky Total row, 13 px text and right-aligned figures. Editable
 * cells save one at a time through the review owner; the row, tiles and Total row then show the server's
 * recalculated figures. The Columns menu hides optional columns (remembered in this browser only).
 */
export function PeopleGrid({ order, personHrefs, openId, emptyText, fullView }: { order: readonly string[]; personHrefs: Readonly<Record<string, string>>; openId: string | null; emptyText: string; fullView: boolean }) {
  const { rows, totals, setFlagsOpen } = useReviewDesk();
  const t = useTranslations('rewards'), d = useTranslations('rewards.desk'), g = useTranslations('rewards.desk.grid');
  const locale = useLocale();
  const [hidden, setHidden] = useState<OptionalColumn[]>([...DEFAULT_HIDDEN]);
  const [menu, setMenu] = useState(false);
  const loaded = useRef(false);
  useEffect(() => { if (!loaded.current) { loaded.current = true; setHidden(readHidden()); } }, []);
  const toggle = (column: OptionalColumn) => setHidden(previous => {
    const next = previous.includes(column) ? previous.filter(c => c !== column) : [...previous, column];
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
    return next;
  });
  const show = (column: OptionalColumn) => !hidden.includes(column);
  const employeeCols = 2 + (show('talent') ? 1 : 0) + (show('performance') ? 1 : 0);
  const payCols = (show('currentBasic') ? 1 : 0) + (show('crBefore') ? 1 : 0);
  const salaryCols = 4 + (show('special') ? 1 : 0) + (show('crAfter') ? 1 : 0);
  const bonusCols = 1 + (show('months') ? 1 : 0) + (show('lump') ? 1 : 0);
  const th = 'px-2 py-1.5 text-left text-[13px] font-medium text-muted-foreground whitespace-nowrap';
  const num = 'px-2 py-1 text-right text-[13px] tabular-nums whitespace-nowrap';
  const groupTh = 'border-b border-border px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground';
  const sticky = 'sticky left-0 z-10 bg-card';
  const list = order.map(id => rows[id]).filter((row): row is DeskRow => !!row);
  return <div className="space-y-2">
    <div className="relative flex justify-end">
      <button type="button" aria-expanded={menu} aria-controls="people-columns" onClick={() => setMenu(open => !open)} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent">{g('columns')}</button>
      {menu && <fieldset id="people-columns" className="absolute right-0 top-full z-30 mt-1 w-56 space-y-1 rounded-md border border-border bg-popover p-3 shadow-lg"><legend className="sr-only">{g('columns')}</legend>
        {OPTIONAL_COLUMNS.map(column => <label key={column} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={show(column)} onChange={() => toggle(column)} />{g(`column.${column}`)}</label>)}
      </fieldset>}
    </div>
    <div data-people-grid className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-card">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <caption className="sr-only">{t('people')}</caption>
        <thead className="sticky top-0 z-20 bg-card">
          <tr>
            <th scope="colgroup" colSpan={employeeCols} className={`${groupTh} ${sticky} z-30`}>{g('group.employee')}</th>
            {payCols > 0 && <th scope="colgroup" colSpan={payCols} className={groupTh}>{g('group.payNow')}</th>}
            <th scope="colgroup" colSpan={salaryCols} className={groupTh}>{g('group.salary')}</th>
            <th scope="colgroup" colSpan={bonusCols} className={groupTh}>{g('group.bonus')}</th>
            <th scope="col" rowSpan={2} className={`${groupTh} align-bottom`}>{d('flags')}</th>
          </tr>
          <tr className="border-b border-border">
            <th scope="col" className={`${th} ${sticky} z-30 min-w-44`}>{t('employee')}</th>
            <th scope="col" className={th}>{g('jg')}</th>
            {show('talent') && <th scope="col" className={th}>{g('column.talent')}</th>}
            {show('performance') && <th scope="col" className={th}>{g('column.performance')}</th>}
            {show('currentBasic') && <th scope="col" className={`${th} text-right`}>{g('column.currentBasic')}</th>}
            {show('crBefore') && <th scope="col" className={`${th} text-right`}>{g('column.crBefore')}</th>}
            <th scope="col" className={`${th} text-right`}>{g('merit')}</th>
            <th scope="col" className={`${th} text-right`}>{t('promotion')}</th>
            {show('special') && <th scope="col" className={`${th} text-right`}>{g('column.special')}</th>}
            <th scope="col" className={`${th} text-right`}>{g('total')}</th>
            <th scope="col" className={`${th} text-right`}>{g('newBasic')}</th>
            {show('crAfter') && <th scope="col" className={`${th} text-right`}>{g('column.crAfter')}</th>}
            {show('months') && <th scope="col" className={`${th} text-right`}>{g('column.months')}</th>}
            <th scope="col" className={`${th} text-right`}>{g('amount')}</th>
            {show('lump') && <th scope="col" className={`${th} text-right`}>{g('column.lump')}</th>}
          </tr>
        </thead>
        <tbody>
          {list.map(row => <tr key={row.id} className="border-b border-border hover:bg-muted/30">
            <th scope="row" className={`${sticky} px-2 py-1 text-left align-top font-normal`}>
              <Link scroll={false} href={personHrefs[row.id] ?? '#'} aria-current={openId === row.id ? 'true' : undefined} className="font-medium text-primary hover:underline">{row.name}</Link>
              <span className="block font-mono text-[11px] text-muted-foreground">{row.employeeCode}{row.leftOn ? ` · ${t('sourceRefresh.leftMarker', { date: row.leftOn })}` : ''}</span>
              {fullView && row.unverified && <span className="block text-[11px] text-destructive">{t('unverified')}</span>}
            </th>
            <td className="px-2 py-1 align-top whitespace-nowrap">{row.grade}{row.promotionGrade && ` → ${row.promotionGrade}`}</td>
            {show('talent') && <td className="px-2 py-1 align-top">{row.talent ?? '—'}</td>}
            {show('performance') && <td className="px-2 py-1 align-top">{row.performance ?? '—'}</td>}
            {show('currentBasic') && <td className={`${num} align-top`}>{money(row.basicCents, locale)}</td>}
            {show('crBefore') && <td className={`${num} align-top`}>{pct(row.crBeforeBp, locale)}</td>}
            <td className={`${num} align-top`}>{row.editable.increase ? <EditCell row={row} field="meritBp" label={g('merit')} placeholder={pct(row.meritBp, locale).replace('%', '')} step="0.01" /> : pct(row.meritBp, locale)}</td>
            <td className={`${num} align-top`}>{row.editable.increase ? <PromotionCell row={row} /> : row.promotionGrade ? pct(row.promotionBp, locale) : '—'}</td>
            {show('special') && <td className={`${num} align-top`}>{row.editable.increase ? <EditCell row={row} field="specialBp" label={g('column.special')} placeholder={pct(row.specialBp, locale).replace('%', '')} step="0.01" /> : pct(row.specialBp, locale)}</td>}
            <td className={`${num} align-top font-medium`}>{pct(row.totalIncreaseBp, locale)}</td>
            <td className={`${num} align-top font-medium`}>{money(row.newBasicCents, locale)}</td>
            {show('crAfter') && <td className={`${num} align-top`}>{pct(row.crAfterBp, locale)}</td>}
            {show('months') && <td className={`${num} align-top`}>{row.editable.bonus ? <span className="inline-flex flex-col items-end"><EditCell row={row} field="multiplierBp" label={g('multiplier')} placeholder={decimal(row.multiplierBp, locale)} step="0.01" /><span className="text-[11px] text-muted-foreground">{g('monthsValue', { months: decimal(row.bonusMonthsBp, locale) })}</span></span> : decimal(row.bonusMonthsBp, locale)}</td>}
            <td className={`${num} align-top`}>{money(row.bonusCents, locale)}</td>
            {show('lump') && <td className={`${num} align-top`}>{row.editable.lump ? <EditCell row={row} field="lumpCents" label={g('column.lump')} placeholder={(row.lumpCents / 100).toFixed(2)} step="0.01" /> : money(row.lumpCents, locale)}</td>}
            <td className="px-2 py-1 text-center align-top">{row.flag ? <button type="button" onClick={() => setFlagsOpen(true)} aria-label={g('rowFlags', { count: row.flagCount, name: row.name })}
              className={`inline-block size-2.5 rounded-full ${row.flag === 'block' ? 'bg-destructive' : 'bg-amber-500'}`} /> : <span className="text-muted-foreground">—</span>}</td>
          </tr>)}
        </tbody>
        {list.length > 0 && <tfoot className="sticky bottom-0 z-20 bg-muted">
          <tr className="font-semibold">
            <th scope="row" colSpan={employeeCols} className={`${sticky} bg-muted px-2 py-1.5 text-left`}>{g('totalRow', { count: totals.people })}</th>
            {show('currentBasic') && <td className={num}>{money(totals.basicCents, locale)}</td>}
            {show('crBefore') && <td />}
            <td colSpan={2 + (show('special') ? 1 : 0) + 1} />
            <td className={num}>{money(totals.newBasicCents, locale)}</td>
            {show('crAfter') && <td />}
            {show('months') && <td />}
            <td className={num}>{money(totals.bonusCents, locale)}</td>
            {show('lump') && <td className={num}>{money(totals.lumpCents, locale)}</td>}
            <td />
          </tr>
        </tfoot>}
      </table>
      {!list.length && <p className="p-6 text-sm text-muted-foreground">{emptyText}</p>}
    </div>
  </div>;
}
