import Link from 'next/link';
import {unstable_rethrow} from 'next/navigation';
import {getLocale,getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {readEmployeeHomeIdentity} from '@/core/employee-home';
import {readHomeGreeting} from '@/core/employee-home-greetings';
import {Card,PageHeader} from '@/components/ui';

/** A notification links to an own-participation read, never a frozen free-text notification body.
 * Multiple employments require an explicit own selection; a foreign selector never falls back. */
export default async function HomeGreetingPage({params,searchParams}:{params:Promise<{id:string}>;
 searchParams:Promise<{employmentId?:string|string[]}>}){
 const {s}=await scopedSession(),t=await getTranslations('employeeHome.greetingDetail');
 const [{id},query,identity,locale]=await Promise.all([params,searchParams,readEmployeeHomeIdentity(s),getLocale()]);
 const requested=query.employmentId;
 const employmentId=requested===undefined&&identity.employments.length===1?identity.employments[0].employmentId:
  typeof requested==='string'&&identity.employments.some(row=>row.employmentId===requested)?requested:null;
 const header=<PageHeader title={t('title')} back={{href:'/',label:t('back')}}/>;
 if(!employmentId)return <div className="mx-auto max-w-2xl space-y-6">{header}<Card className="space-y-4 p-5">
  {requested!==undefined&&<p role="alert" className="text-sm">{t('unavailable')}</p>}
  <p className="text-sm">{identity.employments.length?t('choose'):t('unavailable')}</p>
  <ul className="space-y-3">{identity.employments.map(row=><li key={row.employmentId}>
   <Link className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={`/me/greetings/${encodeURIComponent(id)}?employmentId=${row.employmentId}`}>
    {row.employeeCode??t('employment')}{row.company?` · ${row.company}`:''}
   </Link>
  </li>)}</ul>
 </Card></div>;
 let view:Awaited<ReturnType<typeof readHomeGreeting>>;
 try{view=await readHomeGreeting(s,employmentId,id);}
 catch(error){unstable_rethrow(error);return <div className="mx-auto max-w-2xl space-y-6">{header}<Card className="p-5"><p role="alert" className="text-sm">{t('unavailable')}</p></Card></div>;}
 const date=new Intl.DateTimeFormat(locale,{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(view.occurrenceDate+'T00:00:00Z'));
 return <div className="mx-auto max-w-2xl space-y-6">{header}<Card className="space-y-5 p-5 sm:p-6">
  <p className="text-sm text-muted-foreground">{t(view.sentByMe?'sent':'received')} <time dateTime={view.occurrenceDate}>{date}</time></p>
  {view.state==='erased'?<p className="text-sm text-muted-foreground">{t('erased')}</p>:
   <p className="whitespace-pre-wrap text-base leading-relaxed [overflow-wrap:anywhere]">{view.message}</p>}
 </Card></div>;
}
