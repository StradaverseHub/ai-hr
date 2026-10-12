'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useFormStatus } from 'react-dom';
import { Button, Card, inputCls, tableWrapCls, thCls, theadCls, tbodyCls } from '@/components/ui';
import type { attendanceClockData } from '@/packs/attendance/service';

type Data = Awaited<ReturnType<typeof attendanceClockData>>;
type Entry = { id?: string; punchAt: string; direction: 'in' | 'out'; key: string };

function SaveButton({ dirty }: { dirty: boolean }) {
  const { pending } = useFormStatus();
  const t = useTranslations('attendance.clockData');
  return <Button type="submit" disabled={pending || !dirty}>{t(pending ? 'saving' : 'save')}</Button>;
}

export function AttendanceClockData({ data, employmentId, date, action }: {
  data: Data;
  employmentId: string;
  date: string;
  action: (form: FormData) => Promise<void>;
}) {
  const t = useTranslations('attendance.clockData');
  const locale = useLocale();
  const initial = () => data.rows.filter(r => !r.voidedAt).map(r => ({ id: r.id, punchAt: r.punchAt, direction: r.direction, key: r.id }));
  const [editing, setEditing] = useState(false);
  const [entries, setEntries] = useState<Entry[]>(initial);
  const [error, setError] = useState('');
  const raw = useRef<HTMLDialogElement>(null);
  const nextEntry = useRef(0);
  const dirty = editing && JSON.stringify(entries) !== JSON.stringify(initial());

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const rowSource = (row: Data['rows'][number]) => t(row.method === 'admin' ? 'admin' : row.method === 'import' ? 'import' : row.captureId ? 'web' : 'legacy');
  const source = (entry: Entry) => {
    const row = data.rows.find(r => r.id === entry.id);
    return !row || row.punchAt !== entry.punchAt || row.direction !== entry.direction ? t('admin') : rowSource(row);
  };
  const cancel = () => {
    if (dirty && !window.confirm(t('discard'))) return;
    setEditing(false);
    setEntries(initial());
    setError('');
  };
  const restore = (row: Data['rows'][number]) => {
    if (entries.some(e => e.punchAt === row.punchAt && e.direction === row.direction)) {
      setError(t('duplicate'));
      raw.current?.close();
      return;
    }
    setEntries(old => [...old, { id: row.id, punchAt: row.punchAt, direction: row.direction, key: row.id }]);
    setEditing(true);
    setError('');
    raw.current?.close();
  };
  const timestamp = (iso: string) => new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur',
  }).format(new Date(iso));

  return (
    <Card className="overflow-hidden" data-clock-data-editor>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h2 className="font-semibold">{t('title')}</h2>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => raw.current?.showModal()}>{t('raw')}</Button>
          {!editing && <Button type="button" variant="outline" onClick={() => setEditing(true)}>{t('edit')}</Button>}
        </div>
      </div>
      <form action={action} onSubmit={e => {
        const keys = entries.map(r => r.punchAt + ':' + r.direction);
        if (new Set(keys).size !== keys.length) { e.preventDefault(); setError(t('duplicate')); }
      }}>
        <input type="hidden" name="employmentId" value={employmentId} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="clockChanges" value={JSON.stringify({
          version: 1, baseline: data.baseline, entries: entries.map(({ key, ...entry }) => entry),
        })} />
        {error && <p role="alert" className="p-4 text-sm text-destructive">{error}</p>}
        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}><tr>
              {['time', 'direction', 'source', 'status'].map(k => <th key={k} className={thCls}>{t(k)}</th>)}
              {editing && <th className={thCls}>{t('action')}</th>}
            </tr></thead>
            <tbody className={tbodyCls}>
              {entries.map((entry, i) => <tr key={entry.key}>
                <td className="p-3">{editing ? (
                  <input type="time" step="1" aria-label={t('time')} required className={inputCls} value={entry.punchAt}
                    onChange={e => setEntries(old => old.map((x, n) => n === i ? {
                      ...x, punchAt: e.target.value.length === 5 ? e.target.value + ':00' : e.target.value,
                    } : x))} />
                ) : entry.punchAt}</td>
                <td className="p-3">{editing ? (
                  <select aria-label={t('direction')} className={inputCls} value={entry.direction}
                    onChange={e => setEntries(old => old.map((x, n) => n === i ? { ...x, direction: e.target.value as 'in' | 'out' } : x))}>
                    <option value="in">{t('in')}</option><option value="out">{t('out')}</option>
                  </select>
                ) : t(entry.direction)}</td>
                <td className="p-3">{source(entry)}</td>
                <td className="p-3">{t(editing ? 'proposed' : 'used')}</td>
                {editing && <td className="p-3"><Button type="button" variant="outline"
                  onClick={() => setEntries(old => old.filter((_, n) => n !== i))}>{t('remove')}</Button></td>}
              </tr>)}
              {!entries.length && <tr><td colSpan={editing ? 5 : 4} className="p-4 text-muted-foreground">{t('empty')}</td></tr>}
            </tbody>
          </table>
        </div>
        {editing && <div className="space-y-4 border-t p-4">
          <Button type="button" variant="outline" onClick={() => {
            const key = 'new-' + (++nextEntry.current);
            setEntries(old => [...old, { key, punchAt: '', direction: 'in' }]);
          }}>{t('add')}</Button>
          <label className="block text-sm">{t('reason')}
            <textarea required name="reason" maxLength={500} className={inputCls + ' mt-1 min-h-20 w-full'} />
          </label>
          <p className="text-sm text-muted-foreground">{t('saveHint')}</p>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={cancel}>{t('cancel')}</Button>
            <SaveButton dirty={dirty} />
          </div>
        </div>}
      </form>
      <dialog ref={raw} aria-labelledby="raw-clock-title"
        className="m-auto max-h-[85dvh] w-[min(72rem,95vw)] overflow-auto rounded-xl border bg-background p-5 text-foreground shadow-xl backdrop:bg-black/50">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="raw-clock-title" className="text-lg font-semibold">{t('raw')}</h2>
          <Button type="button" variant="outline" onClick={() => raw.current?.close()}>{t('close')}</Button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">{t('rawHint')}</p>
        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}><tr>
              {['time', 'direction', 'source', 'evidence', 'status', 'action'].map(k => <th key={k} className={thCls}>{t(k)}</th>)}
            </tr></thead>
            <tbody className={tbodyCls}>{data.rows.map(row => <tr key={row.id}>
              <td className="p-3 tabular-nums">{row.punchAt}</td>
              <td className="p-3">{t(row.direction)}</td>
              <td className="p-3">{rowSource(row)}</td>
              <td className="p-3">
                {row.captureId && row.photoAvailable && <a className="text-primary underline"
                  href={'/api/attendance/photo/' + row.captureId} target="_blank" rel="noreferrer">{t('photo')}</a>}
                {row.lat != null && row.lng != null && <span className="block">{row.lat.toFixed(6)}, {row.lng.toFixed(6)}</span>}
                {row.importRun && <a className="text-primary underline" href={'/attendance/import/logs/' + row.importRun}>{row.importFile || t('import')}</a>}
              </td>
              <td className="p-3">
                {t(row.voidedAt ? 'removed' : 'used')}
                {row.voidedAt && <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  {row.voidedBy} · {timestamp(row.voidedAt)}<br />{row.voidReason}
                </p>}
              </td>
              <td className="p-3">{row.voidedAt && <Button type="button" variant="outline"
                disabled={entries.some(e => e.id === row.id)} onClick={() => restore(row)}>{t('restore')}</Button>}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </dialog>
    </Card>
  );
}
