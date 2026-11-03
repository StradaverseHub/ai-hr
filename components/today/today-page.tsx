import {Suspense,type ReactNode} from 'react';
import {getLocale,getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {mayUseAssistant} from '@/core/assistant-grant';
import {readEmployeeHomeGreetingIdentity} from '@/core/employee-home';
import {viewerIdentity} from '@/lib/viewer';
import {HR_LOCAL_TZ,todayInKualaLumpur} from '@/lib/hr-date';
import {greetingFor,greetingName,todayAudience,type TodayAudience} from '@/lib/today/audience';
import {TodayAsk} from './today-ask';
import {TodaySectionSkeleton} from './today-ui';
import {AtAGlanceSection,DoneForYouSection,NeedsYouSection,WatchingSection,needsYouHeading} from './sections';

/** Today (AI v2 Phase 1, W3, owner-approved mock-ups Main.dc.html and TodayEmployee.dc.html): the home screen
 * for every role, at `/`.
 *
 * The greeting and date render at once from the HR date owner (lib/hr-date). The viewer's name, the Ask bar
 * and each section stream inside their own Suspense boundary (the Inbox badge pattern, 9c9359b98), so the
 * slowest owner holds back only its own part. The existing dashboard for the viewer's role and theme is handed
 * in as `more` and drawn under a quiet "More" heading, unchanged.
 *
 * Layout by audience (lib/today/audience.ts): an HR administrator gets Needs you, Done for you and Watching
 * side by side; everyone else (employee, manager, payroll partner) gets Needs you and Done for you beside the
 * At a glance panel. Which sections run never widens what a read may return: every read is the viewer's own,
 * under row-level security. There is no HR capacity strip yet (Phase 2, W15). */
export async function TodayPage({session,scopeIds,employmentId,notice,more,needs={},why,now=new Date()}:{
 session:SessionContext;scopeIds:readonly string[];employmentId?:string;
 /** Needs you: every waiting decision ("See all"), and the leave recommendation the approver asked to open. */
 needs?:Readonly<{all?:boolean;recommend?:string}>;
 /** AI v2 W5: At a glance's "Why?" panel the person opened (`leave:<leave type id>`). */
 why?:string;
 /** A page-level message for the person (the module-unavailable explanation), shown above the greeting. */
 notice?:ReactNode;more:ReactNode;now?:Date;
}){
 const [t,locale]=await Promise.all([getTranslations('today'),getLocale()]);
 const audience=todayAudience(session),today=todayInKualaLumpur(now);
 const hour=Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:HR_LOCAL_TZ}).format(now));
 const greeting=t(greetingFor(hour));
 const dateLine=new Intl.DateTimeFormat(locale,{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${today}T00:00:00Z`));
 const common={session,scopeIds,audience,today,locale};
 const admin=audience.layout==='administrator';
 return <div data-today={audience.layout} className="mx-auto w-full max-w-[72rem] min-w-0 space-y-8">
  {notice}
  <header className="space-y-1">
   <h1 className="text-2xl font-semibold tracking-tight text-balance">
    <Suspense fallback={greeting}><GreetingWithName session={session} employmentId={employmentId} period={greetingFor(hour)}/></Suspense>
   </h1>
   <p data-today-date={today} className="text-sm text-muted-foreground">{dateLine}</p>
  </header>
  <Suspense fallback={null}><AskSlot session={session} audience={audience}/></Suspense>
  {admin?<div className="grid items-start gap-6 lg:grid-cols-3">
   <Suspense fallback={<TodaySectionSkeleton title={t('needsYou')} rows={3}/>}><NeedsYouSection {...common} {...needs}/></Suspense>
   <Suspense fallback={<TodaySectionSkeleton title={t('doneForYou')}/>}><DoneForYouSection {...common}/></Suspense>
   <Suspense fallback={<TodaySectionSkeleton title={t('watching')}/>}><WatchingSection {...common}/></Suspense>
  </div>:<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
   <div className="min-w-0 space-y-6">
    <Suspense fallback={<TodaySectionSkeleton title={t(needsYouHeading(audience))} rows={3}/>}><NeedsYouSection {...common} {...needs}/></Suspense>
    <Suspense fallback={<TodaySectionSkeleton title={t('doneForYou')} rows={1}/>}><DoneForYouSection {...common}/></Suspense>
   </div>
   <Suspense fallback={<TodaySectionSkeleton title={t('atAGlance')} rows={2}/>}><AtAGlanceSection {...common} employmentId={employmentId} why={why}/></Suspense>
  </div>}
  <section aria-labelledby="today-more" data-today-more className="min-w-0 space-y-4 border-t border-border pt-6">
   <h2 id="today-more" className="text-sm font-medium text-muted-foreground">{t('more')}</h2>
   {more}
  </section>
 </div>;
}

/** The viewer's given name: the salary-free Home identity for someone with an own employment, otherwise the
 * name the top bar already shows. Never blocks the greeting: no name, or a failed read, keeps "Good morning". */
async function GreetingWithName({session,employmentId,period}:{session:SessionContext;employmentId?:string;period:ReturnType<typeof greetingFor>}){
 const t=await getTranslations('today');
 const name=await readEmployeeHomeGreetingIdentity(session,employmentId).then(identity=>identity.name)
  .catch(()=>viewerIdentity(session).then(viewer=>viewer.name)).catch(()=>null);
 const first=greetingName(name);
 return first?t(`${period}Name`,{name:first}):t(period);
}

/** The Ask bar, offered only to someone the Assistant can answer (the same gate AI Centre Ask uses). */
async function AskSlot({session,audience}:{session:SessionContext;audience:TodayAudience}){
 const access=await mayUseAssistant(session).catch(()=>({allowed:false as const}));
 if(!access.allowed)return null;
 const t=await getTranslations('today');
 const personal=audience.layout==='personal';
 return <TodayAsk label={t('askLabel')} placeholder={t(personal?'askPlaceholderPersonal':'askPlaceholderAdmin')} submitLabel={t('askSubmit')}
  openingLabel={t('askOpening')} suggestionsLabel={t('suggestions')}
  suggestions={personal?[t('suggestLeave'),t('suggestClaim'),t('suggestPay'),t('suggestLetter')]:[]}/>;
}
