'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/money';
import type { RewardPersonHistoryRow } from '@/packs/rewards/service';
import type { RewardCellField } from '../../actions';
import type { DeskRow } from './desk-model';
import { EditCell, PromotionCell } from './fields';
import { useReviewDesk } from './review-desk';
import { SaveStatus } from './header-actions';
import { flagText } from './flag-text';

/** Text edits share the table's revision queue and preserve a refused draft for correction. */
function TextEdit({ row, field, label, value, max, editable }: { row: DeskRow; field: 'note' | 'reason' | 'caseReason'; label: string; value: string; max: number; editable: boolean }) {
  const { save } = useReviewDesk();
  const [draft, setDraft] = useState(value), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(value); setError(''); }, [value, row.id]);
  if (!editable) return value ? <p className="whitespace-pre-wrap">{value}</p> : null;
  return <label className="block space-y-1"><span className="text-sm text-muted-foreground">{label}</span>
    <textarea rows={3} maxLength={max} value={draft} disabled={busy} aria-invalid={!!error || undefined} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      onChange={event => setDraft(event.target.value)} onBlur={async () => { if (draft.trim() === value) return; setBusy(true); const result = await save(row.id, field, draft); setBusy(false); setError(result.ok ? '' : result.error); }} />
    {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
  </label>;
}

function Withhold({ row, award, editable }: { row: DeskRow; award: 'increase' | 'bonus' | 'lump'; editable: boolean }) {
  const { save } = useReviewDesk();
  const t = useTranslations('rewards.desk.panel');
  const saved = row.withhold?.[award] ?? '';
  const [enabled, setEnabled] = useState(!!saved), [reason, setReason] = useState(saved), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setEnabled(!!saved); setReason(saved); setError(''); }, [saved, row.id]);
  const commit = async (value: string, removing = false) => {
    if (!removing && value.trim().length < 10) { setError(t('withholdReasonRequired')); return; }
    if (value === saved) return;
    setBusy(true); const result = await save(row.id, 'withhold', JSON.stringify({ award, reason: value })); setBusy(false);
    if (!result.ok) { setError(result.error); setEnabled(!!saved || !!value); } else setError('');
  };
  if (!editable) return saved ? <p className="text-xs text-muted-foreground">{t('withheld')}: {saved}</p> : null;
  return <div className="space-y-2 pt-2">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => { setEnabled(event.target.checked); setError(''); if (!event.target.checked) void commit('', true); }} />{t('withhold', { award: t(`award.${award}`) })}</label>
    {enabled && <label className="block space-y-1 text-xs text-muted-foreground">{t('withholdReason')}<textarea rows={2} value={reason} disabled={busy} maxLength={1000} aria-invalid={!!error || undefined} onChange={event => setReason(event.target.value)} onBlur={() => void commit(reason.trim())} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" /></label>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

function CaseDecision({ row, field }: { row: DeskRow; field: 'erDecision' | 'pipDecision' }) {
  const t = useTranslations('rewards');
  const { save } = useReviewDesk();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const options = field === 'erDecision' ? ['pending','in','out'] : ['pending','lift','confirm'];
  return <label className="block space-y-1"><span className="text-sm text-muted-foreground">{t(field)}</span>
    <select value={row[field]} disabled={busy} onChange={async event => { setBusy(true); const result = await save(row.id, field, event.target.value); setBusy(false); setError(result.ok ? '' : result.error); }} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm">{options.map(value => <option key={value} value={value}>{t(`case.${value}`)}</option>)}</select>
    {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
  </label>;
}

/** Live panel values come from the same server projection as the table, including an off-page person. */
export function PersonPanel({ entryId, year, history, noteMax }: { entryId: string; year: number; history: readonly RewardPersonHistoryRow[]; noteMax: number }) {
  const desk = useReviewDesk();
  const row = desk.rows[entryId];
  const t = useTranslations('rewards'), p = useTranslations('rewards.desk.panel');
  const locale = useLocale();
  if (!row) return null;
  const money = (cents: number | null | undefined) => cents == null ? '—' : formatMoney(cents / 100, 'MYR', locale);
  const pct = (bp: number | null | undefined) => bp == null ? '—' : `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bp / 100)}%`;
  const decimal = (bp: number | null | undefined) => bp == null ? '—' : new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bp / 10000);
  const line = (label: string, value: ReactNode, strong = false) => <div className="flex items-baseline justify-between gap-4 py-2"><dt className="text-muted-foreground">{label}</dt><dd className={`text-right tabular-nums ${strong ? 'font-semibold' : 'font-medium'}`}>{value}</dd></div>;
  const percentage = (field: 'meritBp' | 'specialBp', label: string) => row.editable.increase ? <EditCell row={row} field={field} label={label} placeholder={String((row[field] ?? 0) / 100)} step="0.01" suggested /> : pct(row[field]);
  const flags = desk.flags.filter(flag => flag.entryId === entryId);
  return <div className="space-y-5 text-sm" data-reward-person-panel={entryId}>
    <div className="flex flex-wrap items-center justify-between gap-2"><SaveStatus />{row.viewOnlyStage && <p className="text-xs text-muted-foreground">{p('viewOnly', { role: t(`${['bu','bg','gr','ctro','ec','payroll'].includes(row.viewOnlyStage) ? 'roles' : 'stages'}.${row.viewOnlyStage}`) })}</p>}</div>
    <dl className="divide-y divide-border">{line(t('talent'), row.talent ?? '—')}{line(t('performance'), row.performance ?? '—')}</dl>
    <section><h3 className="mb-1 font-semibold">{t('desk.tiles.salary')}</h3><dl className="divide-y divide-border">
      {line(t('currentPay'), money(row.basicCents))}
      {row.crBeforeBp != null && line(t('compaRatioBefore'), pct(row.crBeforeBp))}
      {line(t('merit'), <div className="space-y-1">{percentage('meritBp', `${t('merit')} %`)}<p>{money(row.meritCents)}</p></div>)}
      {line(t('promotion'), <div className="space-y-1">{row.editable.increase ? <PromotionCell row={row} suggested /> : <span>{row.promotionGrade ?? '—'} · {pct(row.promotionBp)}</span>}<p>{money(row.promotionCents)}</p></div>)}
      {line(t('special'), <div className="space-y-1">{percentage('specialBp', `${t('special')} %`)}<p>{money(row.specialCents)}</p></div>)}
      {line(t('newPay'), money(row.newBasicCents), true)}
      {row.crAfterBp != null && line(t('compaRatioAfter'), pct(row.crAfterBp))}
      {line(t('incrementEligibility'), row.incrementReason || t('eligible'))}
    </dl><Withhold row={row} award="increase" editable={row.editable.increase} /></section>
    {row.promotionGrade && <TextEdit row={row} field="reason" label={t('businessCase')} value={row.businessCase} max={4000} editable={row.notesEditable} />}
    <section><h3 className="mb-1 font-semibold">{t('desk.tiles.bonus')}</h3><dl className="divide-y divide-border">
      {row.bonusBasicCents !== row.basicCents && line(t('payWindow.bonusBasic'), money(row.bonusBasicCents))}
      {line(t('bonusMultiplier'), row.editable.bonus ? <EditCell row={row} field="multiplierBp" label={t('bonusMultiplier')} placeholder={decimal(row.multiplierBp)} step="0.01" suggested /> : decimal(row.multiplierBp))}
      {line(t('desk.grid.column.months'), decimal(row.bonusMonthsBp))}
      {line(t('bonus'), money(row.bonusCents), true)}
    </dl><Withhold row={row} award="bonus" editable={row.editable.bonus} />
    <dl>{line(t('lumpSum'), row.editable.lump ? <EditCell row={row} field="lumpCents" label={t('lumpSum')} placeholder={String(row.lumpCents / 100)} step="0.01" suggested /> : money(row.lumpCents))}</dl>
    <Withhold row={row} award="lump" editable={row.editable.lump} /><p className="mt-2 text-xs text-muted-foreground">{row.bonusReason || t('eligible')}</p></section>
    <PersonHistory row={row} year={year} history={history} />
    {(row.erCase || row.pipCase) && <section className="space-y-3"><h3 className="font-semibold">{p('caseDecision')}</h3>
      {row.erCase && (row.casesEditable ? <CaseDecision row={row} field="erDecision" /> : line(t('erDecision'), t(`case.${row.erDecision}`)))}
      {row.pipCase && (row.casesEditable ? <CaseDecision row={row} field="pipDecision" /> : line(t('pipDecision'), t(`case.${row.pipDecision}`)))}
      <TextEdit row={row} field="caseReason" label={t('caseReason')} value={row.caseReason} max={3000} editable={row.casesEditable} />
    </section>}
    {!row.promotionGrade && row.businessCase && <section><h3 className="mb-1 font-semibold">{t('desk.person.businessCase')}</h3><TextEdit row={row} field="reason" label={t('businessCase')} value={row.businessCase} max={4000} editable={row.notesEditable} /></section>}
    {row.newBasicCents != null && <section><h3 className="mb-1 font-semibold">{t('desk.person.notes')}</h3><TextEdit row={row} field="note" label={t('desk.person.notes')} value={row.note} max={noteMax} editable={row.notesEditable} /></section>}
    <section><h3 className="mb-2 font-semibold">{t('desk.flags')}</h3>{flags.length ? <ul className="space-y-2">{flags.map((flag,index) => { const words = flagText(flag); return <li key={index} className="flex gap-2"><span className="h-fit shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{t(`severity.${flag.severity}`)}</span><span>{flag.code.startsWith('WITHHOLD-') ? p('withheldReason', { reason: flag.message.replace(/^Withheld: /,'') }) : words ? t(`flagText.${words.key}`, { plan: words.plan ? t(words.plan) : '', part: words.part ? t(`flagText.parts.${words.part}`) : '' }) : flag.message}</span></li>; })}</ul> : <p className="text-muted-foreground">{t('desk.person.noFlags')}</p>}</section>
  </div>;
}

function PersonHistory({ row, year, history }: { row: DeskRow; year: number; history: readonly RewardPersonHistoryRow[] }) {
  const t = useTranslations('rewards.desk.panel'), r = useTranslations('rewards');
  const locale = useLocale();
  const money = (cents: number | null | undefined) => cents == null ? '—' : formatMoney(cents / 100, 'MYR', locale);
  const decimal = (bp: number | null | undefined, scale: number) => bp == null ? '—' : new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bp / scale);
  const current = <tr className="border-t border-border"><th scope="row" className="px-2 py-2 text-left font-medium">{year}<span className="block text-xs font-normal text-muted-foreground">{t('notFinal')}</span></th><td className="px-2 py-2">{row.talent ?? '—'}</td><td className="px-2 py-2">{row.performance ?? '—'}</td><td className="px-2 py-2 text-right">{row.withhold?.increase ? t('withheld') : row.historyIncreaseBp == null ? '—' : `${decimal(row.historyIncreaseBp,100)}%`}{row.promotionGrade && <abbr title={r('promotion')}> P</abbr>}</td><td className="px-2 py-2 text-right">{row.withhold?.increase ? t('withheld') : money(row.incrementCents)}</td><td className="px-2 py-2 text-right">{row.withhold?.bonus ? t('withheld') : money(row.bonusCents)}</td><td className="px-2 py-2 text-right">{decimal(row.paidBonusMonthsBp,10000)}</td></tr>;
  const past = [year,year-1,year-2].flatMap(wanted => {
    const records = history.filter(item => item.year === wanted && (wanted !== year || item.kind === 'offcycle'));
    if (wanted === year && !records.length) return [];
    return records.length ? records.map((item,index) => <tr key={`${wanted}:${index}`} className="border-t border-border"><th scope="row" className="px-2 py-2 text-left font-medium">{wanted}{item.kind === 'offcycle' && <span className="block text-xs font-normal text-muted-foreground">{t('offcycle')}</span>}</th><td className="px-2 py-2">{item.talent ?? '—'}</td><td className="px-2 py-2">{item.performance ?? '—'}</td><td className="px-2 py-2 text-right">{item.withheld?.increase ? t('withheld') : item.totalIncreaseBp == null ? '—' : `${decimal(item.totalIncreaseBp,100)}%`}{item.promoted && <abbr title={r('promotion')}> P</abbr>}</td><td className="px-2 py-2 text-right">{item.withheld?.increase ? t('withheld') : money(item.incrementCents)}</td><td className="px-2 py-2 text-right">{item.withheld?.bonus ? t('withheld') : money(item.bonusCents)}</td><td className="px-2 py-2 text-right">{decimal(item.bonusMonthsBp,10000)}</td></tr>) : [<tr key={wanted} className="border-t border-border"><th scope="row" className="px-2 py-2 text-left font-medium">{wanted}</th><td colSpan={6} className="px-2 py-2 text-muted-foreground">— · {t('notOnRecord')}</td></tr>];
  });
  return <section><h3 className="mb-2 font-semibold">{t('history')}</h3><div className="overflow-x-auto rounded-md border border-border"><table className="w-full text-[13px] tabular-nums"><thead className="bg-muted/40"><tr>{['year','talent','performance','incrementPercent','incrementMoney','bonusMoney','bonusMonths'].map(key => <th key={key} scope="col" className="px-2 py-2 text-left font-medium">{t(`historyColumn.${key}`)}</th>)}</tr></thead><tbody>{current}{past}</tbody></table></div></section>;
}
