import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {HomeAccessError,ownHomeSubjectSelection} from '@/core/employee-home';
import {readOwnNoticeBoard} from '@/core/employee-home-notices';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {Button,Card,PageHeader,SectionHeader} from '@/components/ui';
import {OwnNoticeEmploymentChoice} from '@/components/notice/own-employment-choice';

/** Full own Notice board: bounded summaries, database search and exact matching totals. */
export default async function MyNoticesPage({searchParams}:{searchParams?:Promise<Record<string,string|string[]|undefined>>}){
 const s=await getSession(),t=await getTranslations('notices'),params=await searchParams??{};
 const single=(key:string)=>{const value=params[key];if(Array.isArray(value))notFound();return value;};
 const employmentId=single('employmentId'),query=(single('q')??'').trim().slice(0,120),category=(single('category')??'').trim().slice(0,80);
 const rawPage=single('page'),page=rawPage&&/^\d+$/.test(rawPage)?Number(rawPage):1;
 const selection=await ownHomeSubjectSelection(s,employmentId).catch(error=>{if(error instanceof HomeAccessError&&error.code==='employmentUnavailable')notFound();throw error;});
 const me=selection.subject,result=me?await readOwnNoticeBoard(s,me.employmentId,{query,category,page}):null;
 const href=(page:number)=>'/notices?'+new URLSearchParams({employmentId:me!.employmentId,...(query?{q:query}:{}),...(category?{category}:{}),page:String(page)});
 return <div className="mx-auto max-w-3xl space-y-6">
  <PageHeader title={t('myTitle')} description={t('myDescription')}/>
  <OwnNoticeEmploymentChoice subjects={selection.subjects} selectedId={me?.employmentId??null} action="/notices"
   labels={{employment:t('ownEmployment'),choose:t('chooseOwnEmployment'),show:t('showOwnEmployment'),employeeCodeUnavailable:t('ownEmployeeCodeUnavailable')}}/>
  {!result?<p role="status" className="text-sm text-muted-foreground">{selection.state==='choose'?t('chooseOwnEmploymentHelp'):t('noOwnEmployment')}</p>:<>
   <form action="/notices" method="get" className="flex flex-wrap items-end gap-3">
    <input type="hidden" name="employmentId" value={me!.employmentId}/>
    <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm font-medium">{t('searchContent')}
     <input type="search" name="q" maxLength={120} defaultValue={query} className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base"/>
    </label>
    <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm font-medium">{t('category')}
     <input name="category" maxLength={80} defaultValue={category} placeholder={t('allCategories')} className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base"/>
    </label>
    <Button type="submit" variant="outline" className="min-h-11">{t('applyFilter')}</Button>
   </form>
   <p role="status" className="text-sm text-muted-foreground">{t('matchingCounts',{total:result.total,unread:result.unread,required:result.acknowledgementRequired})}</p>
   <nav aria-label={t('noticePagination')} className="flex flex-wrap items-center justify-between gap-3 text-sm">
    {result.page>1?<Link className="inline-flex min-h-11 items-center underline" href={href(result.page-1)}>{t('previousPage')}</Link>:<span/>}
    <span>{t('pageOf',{page:result.page,pages:result.pages})}</span>
    {result.page<result.pages?<Link className="inline-flex min-h-11 items-center underline" href={href(result.page+1)}>{t('nextPage')}</Link>:<span/>}
   </nav>
   <Card data-tour="notices-mine">
    <SectionHeader title={t('myListTitle')} count={result.total}/>
    <ul className="divide-y divide-border">
     {result.items.length===0&&<li className="px-4 py-6 text-sm text-muted-foreground">{query||category?t('noMatchingNotices'):t('myEmpty')}</li>}
     {result.items.map(n=><li key={n.id} className="px-4 py-4">
      <Link href={`/notices/${n.id}?employmentId=${me!.employmentId}`} className="block min-h-11 space-y-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
       <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {n.pinned&&<span className="font-medium text-foreground">{t('pinnedBadge')}</span>}<span>{n.category??t('generalCategory')}</span>
        {n.firstViewedAt==null&&<span className="rounded-full bg-primary/10 px-2 py-1 text-primary">{t('newBadge')}</span>}
        {n.requiresAcknowledgement&&<span>{n.acknowledgedAt?t('acknowledgedBadge'):t('acknowledgementRequiredBadge')}</span>}
       </span>
       <span className="block break-words text-base font-medium">{n.title}</span>
       <span className="block truncate text-sm text-muted-foreground">{n.summary}</span>
       <span className="block text-xs text-muted-foreground">{t('publishedByOn',{date:n.publishedAt?todayInKualaLumpur(n.publishedAt):'—',by:n.publishedBy??t('senderUnavailable')})}</span>
      </Link>
     </li>)}
    </ul>
   </Card>
  </>}
 </div>;
}
