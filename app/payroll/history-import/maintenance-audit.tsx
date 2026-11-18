'use client';
import Link from 'next/link';
import {HistoryMaintenanceImpacts} from './maintenance-impact';
import {useFormatter,useTranslations} from 'next-intl';
import type {PayrollHistoryMaintenanceDetail} from '@/lib/payroll-history-maintenance';
export function HistoryMaintenanceAudit({detail}:{detail:PayrollHistoryMaintenanceDetail}){
 const t=useTranslations('payrollHistoryMaintenance'),format=useFormatter();
 return <section className="mt-6 min-w-0 space-y-4 rounded-xl border border-border bg-card p-5" aria-label={t('audit')}><h2 className="font-semibold">{t('audit')}</h2><p className="text-sm text-muted-foreground">{t('auditHelp')}</p><p className="text-sm">{t('auditCount',{shown:detail.audit.length,total:detail.auditTotal})}</p><ol className="divide-y divide-border">{detail.audit.map(entry=><li key={entry.id} className="min-w-0 space-y-2 py-4 text-sm"><h3 className="font-medium">{t('revision',{number:entry.ordinal})} · {t.has(entry.operation)?t(entry.operation):t('auditChange')}</h3><p className="break-words text-muted-foreground">{entry.actor||t('notRecorded')} · {format.dateTime(new Date(entry.at),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}</p>{entry.reason&&<p className="break-words">{entry.reason}</p>}<Link className="inline-flex min-h-11 break-words items-center text-primary underline" href={'/payroll/history-import/logs/'+entry.attemptId}>{entry.sourceName||t('log')}</Link></li>)}</ol>{!detail.audit.length&&<p className="text-sm text-muted-foreground">{t('notRecorded')}</p>}<div className="space-y-2 rounded-lg bg-muted/50 p-4 text-sm"><h3 className="font-medium">{t('impact')}</h3><p>{t('impactHelp')}</p><HistoryMaintenanceImpacts items={detail.impact}/></div></section>;
}
