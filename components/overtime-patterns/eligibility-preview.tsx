'use client';

import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import type {OvertimeEligibilityPreview} from '@/packs/attendance/service';
import type {OvertimeIssue} from '@/lib/overtime-pattern-model';
import {OvertimeIssues} from './calculation-result';

const count=(total:{count:number;capped:boolean},format:(n:number)=>string)=>total.capped?`${format(total.count)}+`:format(total.count);

/** Board 4197534a — Preview: who matches today (same matching as the overtime calculation), who in those companies
 * does not, and what needs attention before the pattern can be switched on. */
export function OvertimeEligibilityPreviewPanel({preview,loading,failed,onRefresh,search,onSearch,onNextPage,settingsSummary,localIssues,details}:{preview:OvertimeEligibilityPreview|null;loading:boolean;failed:string|null;onRefresh:()=>void;search:string;onSearch:(text:string)=>void;onNextPage:()=>void;settingsSummary:string;localIssues:string[];details:{label:string;value:string}[]}) {
  const t=useTranslations('overtimePatterns.previewStep');
  const format=(n:number)=>new Intl.NumberFormat().format(n);
  const attention=(preview?preview.conflicts.length+preview.mayOverlap.length+(preview.scheduleGroup.employees.count?1:0)+(preview.issues?.length?1:0):0)+localIssues.length;
  return <div className="space-y-5">
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
        {details.map(item=><div key={item.label} className="contents"><dt className="text-muted-foreground">{item.label}</dt><dd>{item.value}</dd></div>)}
        <dt className="text-muted-foreground">{t('settings')}</dt><dd>{settingsSummary}</dd>
      </dl>
      <div className="grid grid-cols-3 gap-3">
        {[[preview?count(preview.matched,format):'—',t('matched')],[preview?count(preview.unmatched,format):'—',t('unmatched')],[format(attention),t('attention')]].map(([value,label])=><div key={label} className="rounded-xl border border-border p-4"><p className="text-2xl font-semibold tabular-nums">{value}</p><p className="text-sm text-muted-foreground">{label}</p></div>)}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-3"><button type="button" className="min-h-10 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50" disabled={loading} onClick={onRefresh}>{t(loading?'loading':'refresh')}</button>{preview?<span className="text-xs text-muted-foreground">{t('asOf',{date:preview.asOf})}</span>:null}</div>
    {failed?<p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">{failed}</p>:null}
    {localIssues.map(issue=><p key={issue} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">{issue}</p>)}
    {preview?<>
      {preview.conflicts.map(item=><p key={`${item.code}:${item.name}`} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"><span className="font-semibold">{t('conflictLabel')}</span> {t('conflict',{employees:item.employees,pattern:[item.code,item.name].filter(Boolean).join(' - ')})}</p>)}
      {preview.mayOverlap.map(item=><p key={`may:${item.code}:${item.name}`} className="rounded-lg border border-border p-3 text-sm"><span className="font-semibold">{t('mayOverlapLabel')}</span> {t('mayOverlap',{pattern:[item.code,item.name].filter(Boolean).join(' - ')})}</p>)}
      {preview.scheduleGroup.employees.count?<p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"><span className="font-semibold">{t('scheduleGroupLabel')}</span> {t('scheduleGroup',{employees:count(preview.scheduleGroup.employees,format),groups:preview.scheduleGroup.groups.join(', ')})}</p>:null}
      {preview.issues?.length?<div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"><p className="font-semibold">{t('missingSettings')}</p><OvertimeIssues issues={preview.issues as OvertimeIssue[]}/></div>:null}
      <section className="space-y-3 rounded-xl border border-border p-4" aria-labelledby="ot-preview-employees">
        <div className="flex flex-wrap items-end justify-between gap-3"><h3 id="ot-preview-employees" className="font-semibold">{t('employees')} <span className="text-xs font-normal text-muted-foreground">{t('asOfToday')}</span></h3>
          <label className="text-sm"><span className="sr-only">{t('searchEmployees')}</span><input type="search" className={inputCls} placeholder={t('searchEmployees')} value={search} onChange={event=>onSearch(event.target.value)}/></label></div>
        {preview.rows.length?<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/50 text-xs text-muted-foreground"><tr>{(['employee','company','grade','employmentType'] as const).map(key=><th key={key} scope="col" className="px-3 py-2 font-medium">{t(`columns.${key}`)}</th>)}</tr></thead>
          <tbody>{preview.rows.map(row=><tr key={row.employmentId} className="border-b border-border/60"><td className="px-3 py-2">{[row.employeeCode,row.name].filter(Boolean).join(' · ')}</td><td className="px-3 py-2">{row.companyName}</td><td className="px-3 py-2">{row.gradeName??'—'}</td><td className="px-3 py-2">{row.employmentType??'—'}</td></tr>)}</tbody></table></div>
          :<p className="text-sm text-muted-foreground">{t('noEmployees')}</p>}
        {preview.nextCursor?<button type="button" className="text-sm text-primary hover:underline" onClick={onNextPage}>{t('nextPage')}</button>:null}
      </section>
    </>:null}
  </div>;
}
