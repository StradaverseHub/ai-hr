/** Board 0735d1b7 — the Users tab bar: All Users, Duplicate IC / Passport and Duplicate Work Email Address. The two
 * duplicate tabs are group-administrator screens (the same people who can invite users); a company-level
 * administrator sees no tab bar. The counts are capped ("1,000+") and come from one statement of the duplicate owner. */
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {isGroupAdmin} from '@/lib/authz';
import type {SessionContext} from '@/db/client';
import {countLoginDuplicateGroups} from '@/core/login-duplicates';

export type UsersTab='all'|'identity'|'email';
const TABS:readonly {key:UsersTab;href:string}[]=[
 {key:'all',href:'/admin/users'},
 {key:'identity',href:'/admin/users/duplicates/identity'},
 {key:'email',href:'/admin/users/duplicates/email'},
];
/** "1,000+" above the list cap, the exact number below it. */
export const tabCount=(n:number)=>n>1000?'1,000+':String(n);

/** `session`: the page's already-authorized session (each page calls its guard first). */
export async function UsersTabs({active,session}:{active:UsersTab;session:SessionContext}){
 if(!isGroupAdmin(session))return null;
 const [t,counts]=await Promise.all([getTranslations('admin.users.tabs'),countLoginDuplicateGroups(session).catch(()=>null)]);
 return <nav aria-label={t('label')} className="overflow-x-auto border-b border-border">
  <ul className="flex min-w-max gap-1">{TABS.map(tab=>{
   const count=tab.key==='all'||!counts?null:counts[tab.key];
   const current=tab.key===active;
   return <li key={tab.key}><Link href={tab.href} aria-current={current?'page':undefined}
    className={`inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring ${current?'border-primary font-medium text-foreground':'border-transparent text-muted-foreground hover:text-foreground'}`}>
    {t(tab.key)}{count!==null&&<span className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${count>0?'bg-amber-500/10 text-amber-800 dark:text-amber-300':'bg-muted text-muted-foreground'}`}>{tabCount(count)}</span>}
   </Link></li>;
  })}</ul>
 </nav>;
}
