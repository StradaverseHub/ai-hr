'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { previewSourceRefreshAction, saveSourceRefreshAction } from '../actions';
import type { previewRewardSourceRefresh } from '@/packs/rewards/service';

type Preview = Awaited<ReturnType<typeof previewRewardSourceRefresh>>;
const categories = ['joined', 'left', 'confirmed', 'notice', 'grade', 'salary', 'other'] as const;
/** 40bf44f7 — Data centre refresh: preview what changed by category, then confirm or cancel. */
export function SourceRefresh({ unitId, revision, snapshotDate, today }: { unitId: string; revision: number; snapshotDate: string; today: string }) {
  const t = useTranslations('rewards.sourceRefresh'), router = useRouter();
  const [asOf, setAsOf] = useState(today), [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [busy, start] = useTransition();
  const rows = preview ? categories.filter(c => c !== 'other' || preview.people.other.length) : [];
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t('title')}>
    <h3 className="font-medium">{t('title')}</h3>
    <p className="text-sm text-muted-foreground">{t('help', { date: snapshotDate })}</p>
    <div className="flex flex-wrap items-end gap-3">
      <Field label={t('asOf')}><input type="date" value={asOf} min={snapshotDate} max={today} disabled={busy} onChange={event => { setAsOf(event.target.value); setPreview(null); setError(''); }} className={inputCls} /></Field>
      <Button type="button" variant="outline" disabled={busy || !asOf} onClick={() => start(async () => {
        setError(''); const result = await previewSourceRefreshAction(unitId, revision, asOf);
        if (result.ok) setPreview(result.preview); else { setPreview(null); setError(result.error); }
      })}>{t('preview')}</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {preview && <div className="space-y-3 rounded-md border border-border p-4">
      <h4 className="font-medium">{t('willChange', { date: preview.asOf })}</h4>
      <ul className="divide-y divide-border text-sm">{rows.map(c => <li key={c} className="py-2">
        {preview.people[c].length ? <details><summary className="flex cursor-pointer justify-between gap-3"><span>{t(`category.${c}`)}</span><span className="tabular-nums">{preview.people[c].length}</span></summary>
          <ul className="mt-2 space-y-1 pl-4 text-muted-foreground">{preview.people[c].map(p => <li key={p.employmentId}><span className="mr-2 font-mono text-xs">{p.employeeCode}</span>{p.name}</li>)}</ul></details>
          : <p className="flex justify-between gap-3"><span>{t(`category.${c}`)}</span><span className="tabular-nums">0</span></p>}
      </li>)}</ul>
      <p className="text-sm text-muted-foreground">{t('confirmHelp')}</p>
      <div className="flex flex-wrap gap-3">
        <Button type="button" disabled={busy} onClick={() => start(async () => {
          setError(''); const result = await saveSourceRefreshAction(unitId, revision, preview.asOf, preview.digest);
          setPreview(null); if (result.ok) router.refresh(); else setError(result.error);
        })}>{t('confirm')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => setPreview(null)}>{t('cancel')}</Button>
      </div>
    </div>}
  </section>;
}
