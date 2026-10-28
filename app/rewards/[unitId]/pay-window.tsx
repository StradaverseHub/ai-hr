import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Field, inputCls, tableWrapCls, theadCls, thCls, tbodyCls } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import { payWindowReasons, type CalculatedEntry } from '@/packs/rewards/engine';
import { payWindowKeepAction } from '../actions';
import { RewardSubmit } from '../submit-button';

type Row = Pick<CalculatedEntry, 'id' | 'source' | 'incrementReason' | 'payChange' | 'payWindowKept' | 'bonusBasicCents'>;
const knownKinds = ['promotion', 'increment', 'confirmation', 'salaryAdjustment'];
function useKindLabel() {
  const t = useTranslations('rewards.payWindow');
  return (kind: string | null) => kind == null ? t('kinds.unrecorded') : knownKinds.includes(kind) ? t(`kinds.${kind}`) : t('kinds.other');
}

/** 8ad87ae8 — "Salary adjusted in the window: not eligible for salary increase", with the date and type of change. */
export function PayWindowTag({ row, window }: { row: Row; window: { from: string; to: string } }) {
  const t = useTranslations('rewards.payWindow'), kind = useKindLabel(), locale = useLocale();
  const day = (iso: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  if (!row.payChange || !payWindowReasons.includes(row.incrementReason) && !row.payWindowKept) return null;
  return <span className="mt-1 block text-xs">
    <span className={`rounded-full px-2 py-0.5 font-medium ${row.payWindowKept ? 'bg-muted text-foreground' : 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100'}`}>{row.payWindowKept ? t('keptTag', { from: day(window.from), to: day(window.to) }) : t('tag', { from: day(window.from), to: day(window.to) })}</span>
    <span className="ml-2 text-muted-foreground">{kind(row.payChange.kind)} · {t('effective', { date: row.payChange.on })}</span>
  </span>;
}

/** Group Rewards' list of everyone with a basic-salary change in the exclusion window, with keep/exclude decisions. */
export function PayWindowExcluded({ unitId, revision, canEdit, window, rows, kept }: { unitId: string; revision: number; canEdit: boolean; window: { from: string; to: string }; rows: Row[]; kept: Record<string, string> }) {
  const t = useTranslations('rewards.payWindow'), kind = useKindLabel();
  const money = (cents: number) => formatMoney(cents / 100, 'MYR');
  const listed = rows.filter(r => r.payChange);
  return <section className="space-y-3">
    <div className="flex flex-wrap items-baseline justify-between gap-3"><h2 className="font-semibold">{t('listTitle')}</h2>
      <Link className="text-sm text-primary hover:underline" href={`/rewards/${unitId}/export?excluded=1`}>{t('export')}</Link></div>
    <p className="max-w-3xl text-sm text-muted-foreground">{t('listHelp', { from: window.from, to: window.to })}</p>
    <div className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{['employee', 'change', 'effectiveOn', 'currentBasic', 'adjustedBasic', 'status'].map(k => <th key={k} className={thCls}>{t(`columns.${k}`)}</th>)}</tr></thead>
      <tbody className={tbodyCls}>{listed.map(r => <tr key={r.id}>
        <td className="px-3 py-3"><span className="mr-2 font-mono text-xs text-muted-foreground">{r.source.employeeCode}</span>{r.source.name}</td>
        <td className="px-3 py-3">{kind(r.payChange!.kind)}</td>
        <td className="px-3 py-3 tabular-nums">{r.payChange!.on}</td>
        <td className="px-3 py-3 text-right tabular-nums">{money(r.source.basicCents)}</td>
        <td className="px-3 py-3 text-right tabular-nums">{money(r.bonusBasicCents)}</td>
        <td className="px-3 py-3">
          <p>{r.payWindowKept ? t('keptReason', { reason: kept[r.source.employmentId] ?? '' }) : payWindowReasons.includes(r.incrementReason) ? t('excluded') : r.incrementReason || t('excluded')}</p>
          {canEdit && <form action={payWindowKeepAction} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={revision} /><input type="hidden" name="entryId" value={r.id} /><input type="hidden" name="keep" value={String(!r.payWindowKept)} />
            <Field label={t('reason')}><input name="reason" required minLength={10} maxLength={1000} className={`${inputCls} min-w-56`} /></Field>
            <RewardSubmit type="submit" variant="secondary">{r.payWindowKept ? t('excludeAgain') : t('keepEligible')}</RewardSubmit>
          </form>}
        </td>
      </tr>)}</tbody></table>{!listed.length && <p className="p-6 text-sm text-muted-foreground">{t('none')}</p>}</div>
  </section>;
}
