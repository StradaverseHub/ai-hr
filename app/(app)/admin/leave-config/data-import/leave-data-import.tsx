'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card } from '@/components/ui';
import type { LeaveDataImportType } from '@/lib/leave-data-import';
import type { LeaveHistoryRunRow } from '@/lib/leave-history-import-schema';
import type { LeaveBfRunRow } from '@/lib/leave-bf-import-schema';
import { LeaveHistoryImport } from '../history-import/leave-history-import';
import { LeaveBfImport } from '../bf-import/leave-bf-import';
type Run = { type: 'history'; run: LeaveHistoryRunRow } | { type: 'bf'; run: LeaveBfRunRow };
export function LeaveDataImport({ initialType, historyRuns, bfRuns }: { initialType: LeaveDataImportType | null; historyRuns: LeaveHistoryRunRow[]; bfRuns: LeaveBfRunRow[] }) {
  const t = useTranslations('admin.leaveDataImport');
  const [type, setType] = useState(initialType);
  const [writing, setWriting] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const runs: Run[] = [...historyRuns.map(run => ({ type: 'history' as const, run })), ...bfRuns.map(run => ({ type: 'bf' as const, run }))].sort((a,b) => b.run.createdAt.localeCompare(a.run.createdAt) || a.type.localeCompare(b.type) || a.run.id.localeCompare(b.run.id));
  const selected = runs.find(item => `${item.type}:${item.run.id}` === expanded);
  return <div className="space-y-6">
    <Card className="p-5"><fieldset disabled={writing}><legend className="mb-3 font-semibold">{t('chooseType')}</legend><div className="flex flex-wrap gap-4">{(['history','bf'] as const).map(value => <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3"><input type="radio" name="leaveImportType" value={value} checked={type === value} onChange={() => { if (!writing) setType(value); }} />{t(value)}</label>)}</div></fieldset><p className="mt-3 text-sm text-muted-foreground">{t('changeType')}</p></Card>
    {!type ? <Card className="p-5"><p>{t('noSelection')}</p><Button className="mt-3" disabled>{t('downloadTemplate')}</Button></Card> : <section key={type} aria-label={t(type)}><div className="mb-3 rounded-lg bg-muted px-4 py-3 text-sm font-medium">{t('selectedType')}: {t(type)}</div>{type === 'history' ? <LeaveHistoryImport runs={[]} showRunLog={false} onCommitPending={setWriting} /> : <LeaveBfImport runs={[]} showRunLog={false} onCommitPending={setWriting} />}</section>}
    <Card className="p-5"><h2 className="mb-3 font-semibold">{t('historyTitle')}</h2>{runs.length === 0 ? <p className="text-sm text-muted-foreground">{t('historyEmpty')}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-muted-foreground"><th className="p-2">{t('when')}</th><th className="p-2">{t('importType')}</th><th className="p-2">{t('file')}</th><th className="p-2">{t('rows')}</th><th className="p-2">{t('imported')}</th><th className="p-2">{t('failed')}</th><th className="p-2">{t('details')}</th></tr></thead><tbody>{runs.map(item => <tr key={`${item.type}:${item.run.id}`} className="border-t border-border"><td className="whitespace-nowrap p-2">{new Date(item.run.createdAt).toLocaleString()}</td><td className="p-2">{t(item.type)}</td><td className="p-2">{item.run.fileName || t('pasted')}</td><td className="p-2">{item.run.totalRows}</td><td className="p-2">{item.run.importedRows}</td><td className="p-2">{item.run.failedRows}</td><td className="p-2"><Button variant="secondary" disabled={writing} onClick={() => setExpanded(`${item.type}:${item.run.id}`)}>{t('details')}</Button></td></tr>)}</tbody></table></div>}</Card>
    {selected && <section aria-label={`${t(selected.type)} ${t('details')}`}><p className="mb-2 text-sm font-medium">{t('importType')}: {t(selected.type)}</p>{selected.type === 'history' ? <LeaveHistoryImport key={expanded} historyOnly runs={[selected.run]} /> : <LeaveBfImport key={expanded} historyOnly runs={[selected.run]} onCommitPending={setWriting} />}</section>}
  </div>;
}
