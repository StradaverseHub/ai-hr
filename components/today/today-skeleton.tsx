import {getTranslations} from 'next-intl/server';
import {TodaySectionSkeleton} from './today-ui';

/** The route's loading skeleton for `/` (app/loading.tsx): the greeting, the Ask bar and three columns of quiet
 * rows. It names no section, because it cannot know yet which layout the viewer gets. */
export async function TodaySkeleton(){
 const tCommon=await getTranslations('common');
 return <div role="status" aria-live="polite" aria-busy="true" data-today-loading className="route-loading mx-auto w-full max-w-[72rem] min-w-0 space-y-8">
  <span className="sr-only">{tCommon('loading')}</span>
  <div aria-hidden className="space-y-2.5">
   <div className="h-7 w-64 max-w-full animate-pulse rounded-md bg-muted/80 motion-reduce:animate-none"/>
   <div className="h-3.5 w-48 max-w-full animate-pulse rounded-md bg-muted/50 motion-reduce:animate-none"/>
  </div>
  <div aria-hidden className="h-14 animate-pulse rounded-xl border border-border bg-muted/30 motion-reduce:animate-none"/>
  <div aria-hidden className="grid items-start gap-6 lg:grid-cols-3">
   <TodaySectionSkeleton rows={3}/><TodaySectionSkeleton/><TodaySectionSkeleton/>
  </div>
 </div>;
}
