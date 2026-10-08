'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { importCommitAction, importPreviewAction, type ImportState } from '../../actions';

const TONE = { ok: 'text-emerald-700 dark:text-emerald-400', duplicate: 'text-amber-700 dark:text-amber-400', error: 'text-destructive' } as const;

export function ImportHires({ companies }: { companies: { id: string; name: string }[] }) {
  const t = useTranslations('lifecycle');
  const [pv, preview, previewing] = useActionState<ImportState, FormData>(importPreviewAction, {});
  const [done, commit, committing] = useActionState<ImportState, FormData>(importCommitAction, {});
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <form action={preview} className="grid gap-3 sm:grid-cols-2">
          <Field label={t('import.file')} required className="col-span-full"><input name="file" type="file" accept=".xlsx" required className={inputCls} /></Field>
          <Field label={t('import.defaultCompany')}>
            <select name="defaultCompanyId" className={inputCls}><option value="">—</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </Field>
          <div className="flex items-end gap-3">
            <Button type="submit" disabled={previewing}>{t('import.preview')}</Button>
            <a href="/lifecycle/onboarding/import/template" className="text-sm text-primary underline-offset-2 hover:underline">{t('import.template')}</a>
          </div>
          <p className="col-span-full text-xs text-muted-foreground">{t('import.rules')}</p>
        </form>
        {pv.error && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{pv.error}</p>}
      </Card>

      {pv.preview && !done.result && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3 text-sm">
            <span className="font-medium">{t('import.summary', { ok: pv.preview.ok, duplicate: pv.preview.duplicate, error: pv.preview.error })}</span>
            {pv.preview.skippedColumns.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{t('import.skipped', { columns: pv.preview.skippedColumns.join(', ') })}</p>}
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">{t('import.row')}</th><th className="px-3 py-2">{t('case.name')}</th><th className="px-3 py-2">{t('case.employeeNo')}</th><th className="px-3 py-2">{t('case.joinDate')}</th><th className="px-3 py-2">{t('common.status')}</th></tr></thead>
              <tbody className="divide-y divide-border">
                {pv.preview.rows.map((r) => (
                  <tr key={`${r.sheet}-${r.row}`}>
                    <td className="px-3 py-1.5 tabular-nums">{r.sheet} · {r.row}</td><td className="px-3 py-1.5">{r.input.fullName}</td><td className="px-3 py-1.5">{r.input.employeeNo}</td><td className="px-3 py-1.5 tabular-nums">{r.input.joinDate}</td>
                    <td className={`px-3 py-1.5 ${TONE[r.status]}`}>{t(`import.status.${r.status}`)}{r.reason ? ` — ${r.reason}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pv.preview.ok > 0 && (
            <form action={commit} className="border-t border-border px-4 py-3">
              <input type="hidden" name="rows" value={JSON.stringify(pv.preview.rows)} />
              <Button type="submit" disabled={committing}>{t('import.commit', { count: pv.preview.ok })}</Button>
            </form>
          )}
        </Card>
      )}
      {done.error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{done.error}</p>}
      {done.result && (
        <Card className="space-y-2 p-4 text-sm">
          <p className="font-medium">{t('import.created', { count: done.result.created.length })}</p>
          <ul className="list-disc pl-5">{done.result.created.map((c) => <li key={c.number}><a className="text-primary underline-offset-2 hover:underline" href={`/lifecycle/onboarding/${c.number}`}>{c.number}</a> · {c.requisition}</li>)}</ul>
          {done.result.failed.length > 0 && <><p className="font-medium text-destructive">{t('import.failed', { count: done.result.failed.length })}</p><ul className="list-disc pl-5 text-destructive">{done.result.failed.map((f) => <li key={f.row}>{t('import.row')} {f.row}: {f.reason}</li>)}</ul></>}
        </Card>
      )}
    </div>
  );
}
