import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,ErrorBanner,PageHeader} from '@/components/ui';
import {ActionButton} from '@/components/ui/action-button';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {listPersonnelPostings} from '@/packs/personnel-postings/service';
import {formatDmy,formatDmyTime} from '@/lib/date-display';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {approveOffboardingPostingAction,rejectOffboardingPostingAction,retryOffboardingPostingAction} from './actions';
const one=(v:string|string[]|undefined)=>typeof v==='string'?v:undefined;
const STATUSES=['pending','approved','rejected','all'] as const;
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireScopedLifecycleModule(),q=await searchParams,t=await getTranslations('offboardingPostings'),common=await getTranslations('personnelPostings');
 const status=STATUSES.find(s=>s===one(q.status))??'pending';const offset=Math.max(0,Math.trunc(Number(one(q.offset)??0))||0);
 const page=await listPersonnelPostings(ctx,{source:'offboarding',status,offset,limit:50}),today=todayInKualaLumpur();
 const href=(next:number,s=status)=>'/lifecycle/offboarding/postings?'+new URLSearchParams({status:s,offset:String(next)});
 const groups=[...new Set(page.rows.map(p=>p.approverGroupName).filter(Boolean))];
 return <main className="mx-auto max-w-7xl space-y-6"><p className="text-sm text-muted-foreground">{t('breadcrumb')}</p><PageHeader title={t('title')} description={t('intro')}/>
  <ErrorBanner message={one(q.error)}/><p className="text-sm">{groups.length===1?t('approver',{group:groups[0]!}):t('approverPerPosting')}</p>
  <nav className="flex flex-wrap gap-2" aria-label={t('filters')} >{STATUSES.map(s=><Link key={s} className="rounded-lg border px-3 py-2 text-sm aria-[current=page]:bg-muted" aria-current={s===status?'page':undefined} href={href(0,s)}>{t('status.'+s)}</Link>)}</nav>
  <Card className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/40"><tr>{['posting','employee','source','change','created','status','due','actions'].map(k=><th key={k} className="px-4 py-3 font-medium">{t('columns.'+k)}</th>)}</tr></thead><tbody className="divide-y">
   {!page.rows.length&&<tr><td className="px-4 py-10 text-center text-muted-foreground" colSpan={8}>{t('empty')}</td></tr>}
   {page.rows.map(p=><tr key={p.id}><td className="px-4 py-4 font-medium">{p.label}</td><td className="px-4 py-4">{p.employeeName??'—'}<small className="block text-muted-foreground">{p.employeeCode}</small></td><td className="px-4 py-4">{t('resignation')}</td>
    <td className="min-w-64 px-4 py-4"><b>{t('event.'+p.eventType)}</b> · {formatDmy(p.current.effectiveDate)}
     {(['position','jobGrade','basicSalary'] as const).map(key=>p.current[key]!==undefined&&<div key={key} className="mt-1">{t('fields.'+key)}: {p.baseline?.[key]??'—'} → {p.current[key]}</div>)}
     {p.current.exitReason&&<div>{t('exitReason')}: {p.current.exitReason}</div>}{p.editedBy&&<small className="mt-1 block text-muted-foreground">{t('editedBy',{name:p.editedBy.name??'—'})}</small>}
    </td><td className="whitespace-nowrap px-4 py-4">{formatDmyTime(p.createdAt)}</td><td className="px-4 py-4">{t('status.'+p.displayStatus)}{p.rejectionReason&&<p className="mt-1 text-sm text-destructive">{p.rejectionReason}</p>}</td>
    <td className="whitespace-nowrap px-4 py-4">{p.dueOn?<span className={p.status==='pending'&&p.dueOn<today?'text-destructive':''}>{p.status==='pending'&&p.dueOn<today?t('overdue')+' · ':''}{formatDmy(p.dueOn)}</span>:t('noDueDate')}</td>
    <td className="min-w-48 px-4 py-4"><div className="flex flex-wrap gap-2">{p.status==='pending'&&<>
     {p.canApprove?<form action={approveOffboardingPostingAction}><input type="hidden" name="postingId" value={p.id}/><input type="hidden" name="revision" value={p.revision}/><ActionButton actionKind="saving" className="rounded-lg border bg-primary px-3 py-2 text-primary-foreground">{common('approve')}</ActionButton></form>:<span>{t('waitingFor',{group:p.approverGroupName??'—'})}</span>}
     {p.canEdit&&<Link className="rounded-lg border px-3 py-2" href={'/lifecycle/offboarding/postings/'+p.id+'/edit'}>{common('edit')}</Link>}
     {p.canApprove&&<details className="w-full"><summary className="cursor-pointer text-destructive">{t('reject')}</summary><form action={rejectOffboardingPostingAction} className="mt-2 space-y-2"><input type="hidden" name="postingId" value={p.id}/><input type="hidden" name="revision" value={p.revision}/><label className="block">{t('rejectionReason')}<textarea name="reason" required maxLength={2000} className="mt-1 w-full rounded-lg border p-2"/></label><ActionButton actionKind="saving" className="rounded-lg border px-3 py-2">{t('reject')}</ActionButton></form></details>}
     </>}{p.status==='rejected'&&p.canRetry&&<form action={retryOffboardingPostingAction}><input type="hidden" name="postingId" value={p.id}/><ActionButton actionKind="saving" className="rounded-lg border px-3 py-2">{t('retry')}</ActionButton></form>}</div></td>
   </tr>)}
  </tbody></table></Card><p className="text-sm text-muted-foreground">{t('rule')}</p><div className="flex gap-4">{offset>0&&<Link href={href(Math.max(0,offset-page.limit))}>{common('previous')}</Link>}{page.hasMore&&<Link href={href(offset+page.limit)}>{common('next')}</Link>}</div>
 </main>;
}
