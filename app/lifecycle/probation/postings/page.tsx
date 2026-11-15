import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {ErrorBanner} from '@/components/ui';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {listPersonnelPostings} from '@/packs/personnel-postings/service';
import {approvePostingAction} from './actions';
import {PostingsTable} from './postings-table';

const STATUSES=['pending','approved','all'] as const;
type Status=(typeof STATUSES)[number];
const one=(value:string|string[]|undefined)=>typeof value==='string'?value:undefined;

/** Probation Confirmation › Personnel postings (screen 7). Rows are what row security lets this user read; Approve is
 * offered only to approver-group members and decided again by the database. */
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await requireScopedLifecycleModule(),query=await searchParams,t=await getTranslations('personnelPostings');
 const status:Status=(STATUSES as readonly string[]).includes(one(query.status)??'')?one(query.status) as Status:'pending';
 const offset=Math.max(0,Math.trunc(Number(one(query.offset)??0))||0);
 const page=await listPersonnelPostings(session,{status,offset,limit:50});
 const href=(next:{status?:Status;offset?:number})=>{const q=new URLSearchParams({status:next.status??status});if(next.offset)q.set('offset',String(next.offset));return '/lifecycle/probation/postings?'+q;};
 return <main>
  <header className="v9-heading"><div><p className="v9-muted">{t('breadcrumb')}</p><h1>{t('title')}</h1><p>{t('intro')}</p></div></header>
  <ErrorBanner message={one(query.error)}/>
  <section className="probation-stats" aria-label={t('filters.label')}>{STATUSES.map(value=><Link key={value} className="v9-button" aria-current={status===value?'page':undefined} href={href({status:value,offset:0})}>{t('filters.'+value)}</Link>)}</section>
  <section className="v9-panel v9-stack" aria-label={t('title')}>
   <PostingsTable rows={page.rows} approveAction={approvePostingAction}/>
   <p className="v9-muted">{t('rule')}</p>
   <div className="probation-actions">{page.offset>0&&<Link className="v9-button" href={href({offset:Math.max(0,page.offset-page.limit)})}>{t('previous')}</Link>}{page.hasMore&&<Link className="v9-button" href={href({offset:page.offset+page.limit})}>{t('next')}</Link>}</div>
  </section>
 </main>;
}
