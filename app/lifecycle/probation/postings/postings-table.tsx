'use client';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {ActionButton} from '@/components/ui/action-button';
import {formatDmy,formatDmyTime} from '@/lib/date-display';
import {postingValueChanges,type PersonnelPostingEvent,type PersonnelPostingSource,type PersonnelPostingValues} from '@/lib/personnel-posting';
import {movementPageHref} from '@/lib/personnel-movement-navigation';

/** What the queue needs from a posting (packs/personnel-postings/service PersonnelPosting, serialisable). */
export type PostingTableRow = {
  id: string; label: string; employmentId: string; employeeName: string | null; employeeCode: string | null; source: PersonnelPostingSource;
  eventType: PersonnelPostingEvent; proposed: PersonnelPostingValues; edited: PersonnelPostingValues | null; current: PersonnelPostingValues;
  displayStatus: 'pending' | 'edited' | 'approved' | 'rejected'; editedBy: { name: string | null } | null; editedAt: string | null;
  approvedBy: { name: string | null } | null; approvedAt: string | null; approverGroupName: string | null;
  createdAt: string; revision: number; canApprove: boolean; canEdit: boolean;
};

/** Edit opens the employee's New Event page prefilled from the posting (screen 8). */
export function postingEditHref(row: { id: string; employmentId: string }) {
  return movementPageHref(row.employmentId, 'new') + '?posting=' + encodeURIComponent(row.id);
}

export function PostingsTable({rows,approveAction}:{rows:PostingTableRow[];approveAction:(data:FormData)=>void|Promise<void>}){
 const t=useTranslations('personnelPostings');
 const changeText=(event:PersonnelPostingEvent,values:PersonnelPostingValues)=>event==='confirmation'
  ?t('change.confirmation',{date:formatDmy(values.effectiveDate)})
  :t('change.probationExtension',{end:formatDmy(values.endDate??null),date:formatDmy(values.effectiveDate)});
 const fieldLabel=(field:'effectiveDate'|'endDate'|'remarks')=>field==='effectiveDate'?t('fields.effectiveDate'):field==='endDate'?t('fields.endDate'):t('fields.remarks');
 const shown=(field:'effectiveDate'|'endDate'|'remarks',value:string|null)=>value==null||value===''?'—':field==='remarks'?value:formatDmy(value);
 const columns=['posting','employee','from','eventType','change','created','status','actions'] as const;
 return <table className="pct-table pct-compact">
  <thead><tr>{columns.map(key=><th key={key} scope="col">{key==='actions'?<span className="pct-sr">{t('columns.actions')}</span>:t('columns.'+key)}</th>)}</tr></thead>
  {!rows.length?<tbody><tr><td colSpan={columns.length}><p className="pct-empty">{t('empty')}</p></td></tr></tbody>:
  <tbody>{rows.map(row=>{
   const changes=row.edited?postingValueChanges(row.proposed,row.edited):[];
   const group=row.approverGroupName??t('unknownGroup');
   return <tr key={row.id} data-posting={row.label} data-status={row.displayStatus}>
    <td data-label={t('columns.posting')} className="pct-num"><b>{row.label}</b></td>
    <td data-label={t('columns.employee')}>{row.employeeName??'—'}{row.employeeCode&&<small>{row.employeeCode}</small>}</td>
    <td data-label={t('columns.from')}><span className="pct-pill">{t('sources.'+row.source)}</span></td>
    <td data-label={t('columns.eventType')}><b className="pct-small">{t('events.'+row.eventType)}</b></td>
    <td data-label={t('columns.change')}>{changeText(row.eventType,row.current)}{row.current.remarks&&<small>{t('change.remarks',{remarks:row.current.remarks})}</small>}
     {row.displayStatus==='edited'&&changes.length>0&&<small data-testid="posting-edited-note">{t('editedNote',{name:row.editedBy?.name??t('someone'),date:formatDmy(row.editedAt),
      changes:changes.map(c=>t('fieldChange',{field:fieldLabel(c.field),before:shown(c.field,c.before),after:shown(c.field,c.after)})).join('; ')})}</small>}</td>
    <td data-label={t('columns.created')} className="pct-num">{formatDmyTime(row.createdAt)}</td>
    <td data-label={t('columns.status')}>{row.displayStatus==='approved'
     ?<><span className="pct-pill" data-tone="ok">{t('status.approved')}</span>{row.approvedBy&&<small>{row.approvedBy.name??t('someone')}{row.approvedAt?' · '+formatDmy(row.approvedAt):''}</small>}</>
     :<span className="pct-pill" data-tone="warn">{row.displayStatus==='edited'?t('status.edited'):t('status.pending')}</span>}</td>
    <td data-label={t('columns.actions')}>{row.displayStatus!=='approved'&&<div className="pct-row pct-actions">
     {row.canApprove
      ?<form action={approveAction}><input type="hidden" name="postingId" value={row.id}/><input type="hidden" name="revision" value={row.revision}/><ActionButton actionKind="saving" className="pct-btn pct-btn-sm pct-btn-pri">{t('approve')}</ActionButton></form>
      :<small>{t('approveOnlyGroup',{group})}</small>}
     {row.canEdit&&<Link className="pct-btn pct-btn-sm" href={postingEditHref(row)} aria-label={t('editLabel',{posting:row.label})}>{t('edit')}</Link>}
    </div>}</td>
   </tr>;})}</tbody>}
 </table>;
}
