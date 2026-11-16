import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {ErrorBanner} from '@/components/ui';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {listPersonnelPostings} from '@/packs/personnel-postings/service';
import {approvePostingAction} from './actions';
import {PostingsTable} from './postings-table';
import '../tracker-parity.css';

const STATUSES=['pending','approved','all'] as const;
type Status=(typeof STATUSES)[number];
const one=(value:string|string[]|undefined)=>typeof value==='string'?value:undefined;

/** Probation Confirmation › Personnel postings (screen 7; lane M1 prototype PostingsPage). Rows are what row security lets
 * this user read; Approve is offered only to approver-group members and decided again by the database. */
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await requireScopedLifecycleModule(),query=await searchParams,t=await getTranslations('personnelPostings');
 const status:Status=(STATUSES as readonly string[]).includes(one(query.status)??'')?one(query.status) as Status:'pending';
 const offset=Math.max(0,Math.trunc(Number(one(query.offset)??0))||0);
 const page=await listPersonnelPostings(session,{status,source:'probation',offset,limit:50});
 const href=(next:{status?:Status;offset?:number})=>{const q=new URLSearchParams({status:next.status??status});if(next.offset)q.set('offset',String(next.offset));return '/lifecycle/probation/postings?'+q;};
 // The intro names the approver group when every listed posting has the same one (one company setting); otherwise it
 // says "the posting approver group", as each row's own "Only … can approve" line names its group.
 const groups=[...new Set(page.rows.map(row=>row.approverGroupName).filter((name):name is string=>!!name))];
 const group=groups.length===1?groups[0]:t('approverGroupFallback');
 return <main className="pct">
  <p className="pct-crumb">{t('breadcrumb')}</p>
  <header className="pct-ph"><div><h1>{t('title')}</h1><p>{t.rich('introGroup',{group,b:chunks=><b>{chunks}</b>})}</p></div></header>
  <ErrorBanner message={one(query.error)}/>
  <nav className="pct-seg" aria-label={t('filters.label')}>{STATUSES.map(value=><Link key={value} aria-current={status===value?'page':undefined} href={href({status:value,offset:0})}>{t('filters.'+value)}</Link>)}</nav>
  <section className="pct-tw" aria-label={t('title')}>
   <PostingsTable rows={page.rows} approveAction={approvePostingAction}/>
  </section>
  <p className="pct-note">{t('rule')}</p>
  {(page.offset>0||page.hasMore)&&<div className="pct-row">{page.offset>0&&<Link className="pct-btn" href={href({offset:Math.max(0,page.offset-page.limit)})}>{t('previous')}</Link>}{page.hasMore&&<Link className="pct-btn" href={href({offset:page.offset+page.limit})}>{t('next')}</Link>}</div>}
 </main>;
}
