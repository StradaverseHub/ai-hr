'use client';
import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import {probationReasonPage,type ProbationReconciliationView} from '@/lib/probation-reconciliation';

/** The reviewed no-case notice opens a SQL-paged list; a page read never starts intake. */
export function ProbationReconciliationStatus({data,query}:{data:ProbationReconciliationView;query:string}){
 const t=useTranslations('probation.reconciliation'),locale=useLocale();
 const page=(offset:number)=>{const p=new URLSearchParams(query);p.set('intakeOffset',String(offset));return '/lifecycle/probation?'+p.toString()+'#personnel-without-case';};
 return <section aria-label={t('title')} className="pct-reconciliation">
  <p className="pct-muted">{t('cadence')} {data.lastSuccessfulCheck?t('lastCheck',{time:new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(new Date(data.lastSuccessfulCheck))}):t('notChecked')}</p>
  {data.checkStale&&<p className="pct-warn" role="status">{t('stale')}</p>}
  {data.total>0&&<details id="personnel-without-case" open={data.offset>0||undefined}>
   <summary className="pct-warn">{t('missing',{count:data.total})}</summary>
   <p className="pct-muted">{t('buAdvisory')}</p>
   <div className="pct-tw"><table className="pct-table"><thead><tr><th>{t('employee')}</th><th>{t('company')}</th><th>{t('reason')}</th><th>{t('fix')}</th></tr></thead>
    <tbody>{data.rows.map(row=><tr key={row.employmentId}>
     <td data-label={t('employee')}>{row.employeeName}<small>{row.employeeCode??'—'}</small></td><td data-label={t('company')}>{row.companyName}</td>
     <td data-label={t('reason')}><ul>{row.reasons.length?row.reasons.map(reason=><li key={reason}>{t('reasons.'+reason,{grade:row.grade})}</li>):<li>{t('queued')}</li>}</ul>{row.missingBusinessUnit&&<small>{t('missingBu')}</small>}</td>
     <td data-label={t('fix')}><div className="pct-row">{[...new Set(row.reasons.map(reason=>probationReasonPage(reason,row.employmentId)))].map(href=><Link className="pct-link" key={href} href={href+(href.includes('/admin/personnel/')?'':'?company='+row.companyId)}>{href.endsWith('/settings')?t('settings'):href.endsWith('/forms')?t('forms'):href.endsWith('/routes')?t('routes'):href.includes('/admin/personnel/')?t('personnel'):t('intake')}</Link>)}</div></td>
    </tr>)}</tbody></table></div>
   {(data.offset>0||data.offset+data.rows.length<data.total)&&<nav className="pct-row" aria-label={t('pages')}>{data.offset>0&&<Link className="pct-btn" href={page(Math.max(0,data.offset-data.limit))}>{t('previous')}</Link>}{data.offset+data.rows.length<data.total&&<Link className="pct-btn" href={page(data.offset+data.limit)}>{t('next')}</Link>}</nav>}
  </details>}
 </section>;
}
