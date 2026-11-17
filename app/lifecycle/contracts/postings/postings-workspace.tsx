'use client';
import {useTransition} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {ActionButton} from '@/components/ui/action-button';
import type {ContractSharedPostingPage} from '@/packs/contracts/service';
import {movementPageHref} from '@/lib/personnel-movement-navigation';
import {SharedContractNavigation,ContractFeedback,contractDate} from '../shared-case-ui';
import {approveContractPostingAction,confirmContractPayrollAction} from './actions';
import {ContractPostingEditor} from './posting-editor';
export function ContractPostingsWorkspace({page,status,companyId,today,error,saved}:{page:ContractSharedPostingPage;status:'pending'|'approved'|'all';companyId?:string;today:string;error?:string;saved?:string}){
 const t=useTranslations('contractPostings');
 const router=useRouter(),[refreshing,startRefresh]=useTransition();
 const href=(nextStatus:string,nextOffset=0)=>{const query=new URLSearchParams({status:nextStatus});if(companyId)query.set('companyId',companyId);if(nextOffset)query.set('offset',String(nextOffset));return '/lifecycle/contracts/postings?'+query;};
 return <div className="v9-content"><SharedContractNavigation/><header className="v9-heading"><div><h1>{t('title')}</h1><p>{t('intro')}</p></div></header>
 <ContractFeedback error={error}/>{saved&&<p className="v9-notice" role="status">{t(saved==='pay'?'savedPay':saved==='edited'?'savedEdited':'savedApproved')}</p>}
 <section className="v9-panel v9-stack"><div className="contract-toolbar"><nav className="v9-tabs" aria-label={t('filterLabel')}>{(['pending','approved','all'] as const).map(value=><Link className={'v9-button'+(status===value?' v9-button-primary':'')} href={href(value)} key={value} aria-current={status===value?'page':undefined}>{t('filters.'+value)}</Link>)}</nav><p>{t('count',{count:page.total})}</p><ActionButton type="button" actionKind="loading" aria-busy={refreshing} className="v9-button" onClick={()=>startRefresh(()=>router.refresh())}>{t('refresh')}</ActionButton></div>
    <div className="v9-table-scroll"><table className="v9-table contract-table contract-posting-table" aria-label={t('title')}><thead><tr>{(['posting','employee','event','values','status','actions'] as const).map(column=><th key={column} scope="col">{t('columns.'+column)}</th>)}</tr></thead><tbody>
 {!page.rows.length&&<tr><td colSpan={6}><p className="v9-empty">{t('empty')}</p></td></tr>}
 {page.rows.map(row=>{const future=row.status==='approved'&&!row.movementAppliedAt;return <tr id={'posting-'+row.id} key={row.id}><td data-label={t('columns.posting')}><strong>{row.label}</strong><small>{row.caseNumber}</small></td><td data-label={t('columns.employee')}><strong>{row.employeeName}</strong><small>{row.employeeCode} · {row.companyName}</small></td><td data-label={t('columns.event')}>{t(row.eventType==='contractRenewal'?'renewal':'conversion')}<small>{t('periodCloses',{date:contractDate(row.current.previousEndDate)})}</small></td>
 <td data-label={t('columns.values')}><span>{t('starts',{date:contractDate(row.current.effectiveDate)})}</span>{row.current.endDate&&<small>{t('ends',{date:contractDate(row.current.endDate)})}</small>}{row.current.contractNumber&&<small>{t('contractNumber',{number:row.current.contractNumber})}</small>}{row.current.remarks&&<small>{row.current.remarks}</small>}{row.canEdit&&<details className="contract-posting-corrections"><summary>{t('inlineEdit')}</summary><ContractPostingEditor posting={row} inline/></details>}</td>
 <td data-label={t('columns.status')}><span className="contract-status">{t(row.status==='approved'?'approved':row.edited?'edited':'pending')}</span>{row.approverGroupName&&<small>{row.approverGroupName}</small>}{row.status==='pending'&&row.workflowReady===false&&<small>{t('awaitingWorkflow')}</small>}{future&&<small>{t(row.current.effectiveDate>today?'scheduled':'awaitingMovement',{date:contractDate(row.current.effectiveDate)})}</small>}{row.movementAppliedAt&&<small>{t('applied',{date:contractDate(row.movementAppliedAt)})}</small>}{row.canConfirmPay&&<small>{t('payPending')}</small>}</td>
 <td data-label={t('columns.actions')}><div className="v9-stack">{row.canApprove&&<form action={approveContractPostingAction}><input type="hidden" name="postingId" value={row.id}/><input type="hidden" name="revision" value={row.revision}/><ActionButton actionKind="saving" className="v9-button v9-button-primary">{t('approve')}</ActionButton></form>}
 <Link className="v9-button" href={movementPageHref(row.employmentId,'new')+'?posting='+encodeURIComponent(row.id)}>{t(row.canEdit?'edit':'view')}</Link>
 {row.canConfirmPay&&<form action={confirmContractPayrollAction} className="v9-stack"><input type="hidden" name="postingId" value={row.id}/><input type="hidden" name="caseRevision" value={row.caseRevision}/><label className="contract-pay-declaration"><input type="checkbox" name="confirmed" required/>{t('payDeclaration')}</label><ActionButton actionKind="saving" className="v9-button">{t('confirmPay')}</ActionButton></form>}</div></td></tr>;})}
 </tbody></table></div>
 <p className="v9-muted">{t('approvalRule')}</p>{(page.offset>0||page.offset+page.rows.length<page.total)&&<nav className="v9-tabs" aria-label={t('pagination')}>{page.offset>0&&<Link className="v9-button" href={href(status,Math.max(0,page.offset-page.limit))}>{t('previous')}</Link>}{page.offset+page.rows.length<page.total&&<Link className="v9-button" href={href(status,page.offset+page.limit)}>{t('next')}</Link>}</nav>}
 </section></div>;
}
