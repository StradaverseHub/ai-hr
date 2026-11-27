/** Board 0735d1b7 — the two duplicate tabs of Security Center > Users (group administrators only). One keyset page of
 * groups from core/login-duplicates.ts; each group is its own small GET form that opens the merge confirmation with
 * the chosen Master Login Account. Nothing is written here. */
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {MERGE_MAX_ACCOUNTS,readLoginDuplicates,type DuplicateAccount,type DuplicateGroup,type DuplicateTab} from '@/core/login-duplicates';
import {keysetPageState,parseKeysetPageQuery} from '@/lib/pagination';
import {Pager} from '@/components/pager';
import {Card,ErrorBanner,btnPrimary,tableWrapCls,theadCls,thCls} from '@/components/ui';
import {formatDmyTime} from '@/lib/date-display';
import {SecurityPageHeader} from '../security-page';
import {UsersTabs} from '../users-tabs';

export type DuplicatesSearch={page?:string;size?:string;after?:string;before?:string;last?:string;count?:string;error?:string};
const cell='px-3 py-2 align-top';

export async function AccountCells({account}:{account:DuplicateAccount}){
 const t=await getTranslations('admin.users.duplicates');
 return <>
  <td className={cell}><span className="font-medium">{account.name??'—'}</span>{account.mergedCount>0&&<span className="mt-1 block text-xs text-muted-foreground">{t('masterOf',{count:account.mergedCount})}</span>}</td>
  <td className={`${cell} tabular-nums`}>{account.employeeCode??'—'}</td>
  <td className={`${cell} break-all font-mono text-xs`}>{account.username??'—'}</td>
  <td className={`${cell} break-all`}>{account.email??'—'}</td>
  <td className={`${cell} tabular-nums`}>{account.icNumber??'—'}</td>
  <td className={cell}>{account.passportNumber??'—'}{account.passportNumber&&account.passportCountry&&<span className="block text-xs text-muted-foreground">{account.passportCountry}</span>}</td>
  <td className={cell}><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${account.status==='active'?'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300':'bg-muted text-muted-foreground'}`}>{t(`status.${account.status}`)}</span>
   {account.inactiveCause&&<span className="mt-1 block text-xs text-muted-foreground">{t(`inactiveCause.${account.inactiveCause}`)}</span>}</td>
  <td className={cell}>{t(`userType.${account.userType}`)}</td>
  <td className={`${cell} tabular-nums`}>{account.lastLogin?formatDmyTime(account.lastLogin):<span className="text-muted-foreground">{t('neverLoggedIn')}</span>}</td>
 </>;
}
export async function AccountHead({first}:{first:string}){
 const t=await getTranslations('admin.users.duplicates');
 return <thead className={theadCls}><tr>{[first,'employeeName','employeeId','username','email','icNumber','passportNumber','accountStatus','userType','lastLogin'].map(key=>
  <th key={key} scope="col" className={thCls}>{t(`column.${key}`)}</th>)}</tr></thead>;
}

function defaultMaster(group:DuplicateGroup){
 return group.lockedMasterId??group.accounts.find(a=>a.status==='active')?.appUserId??group.accounts[0]?.appUserId;
}
async function GroupCard({tab,group}:{tab:DuplicateTab;group:DuplicateGroup}){
 const t=await getTranslations('admin.users.duplicates');
 const chosen=defaultMaster(group),mergeable=!group.conflictingMasters&&group.accounts.length>=2&&group.accounts.length<=MERGE_MAX_ACCOUNTS;
 return <Card className="space-y-3 p-4">
  <form method="get" action="/admin/users/duplicates/merge" className="space-y-3" aria-label={t(`basis.${group.basis}`)}>
   <input type="hidden" name="tab" value={tab}/><input type="hidden" name="group" value={group.digest}/>
   {group.lockedMasterId&&<input type="hidden" name="master" value={group.lockedMasterId}/>}
   <div className="flex flex-wrap items-center justify-between gap-2">
    <h2 className="text-sm font-semibold">{t(`basis.${group.basis}`)} · {t('accountCount',{count:group.accounts.length})}</h2>
    {mergeable&&<button type="submit" className={`${btnPrimary} min-h-11`}>{t('merge')}</button>}
   </div>
   {group.differentProfiles&&<p role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">{t('differentProfiles')}</p>}
   {group.lockedMasterId&&<p className="text-sm text-muted-foreground">{t('lockedMaster')}</p>}
   {group.conflictingMasters&&<p role="note" className="text-sm text-destructive">{t('conflictingMasters')}</p>}
   {group.accounts.length>MERGE_MAX_ACCOUNTS&&<p role="note" className="text-sm text-muted-foreground">{t('tooMany',{max:MERGE_MAX_ACCOUNTS})}</p>}
   <div className={tableWrapCls}><table className="w-full min-w-[64rem] text-left text-sm"><AccountHead first="master"/>
    <tbody className="divide-y divide-border">{group.accounts.map(account=><tr key={account.appUserId}>
     <td className={cell}><input type="radio" name={group.lockedMasterId?undefined:'master'} value={account.appUserId} defaultChecked={account.appUserId===chosen}
      disabled={!mergeable||Boolean(group.lockedMasterId)} className="size-5" aria-label={t('chooseMaster',{name:account.name??account.email??account.appUserId})}/></td>
     <AccountCells account={account}/>
    </tr>)}</tbody></table></div>
  </form>
 </Card>;
}

export async function DuplicatesView({session:s,tab,searchParams}:{session:SessionContext;tab:DuplicateTab;searchParams:DuplicatesSearch}){
 const t=await getTranslations('admin.users.duplicates'),center=await getTranslations('securityCenter');
 const q=parseKeysetPageQuery(searchParams);
 const read=await readLoginDuplicates(s,tab,q);
 const state=keysetPageState(q,read,read.groups.map(g=>g.id));
 return <div className="mx-auto w-full space-y-6">
  <SecurityPageHeader title={center('users.title')}/>
  <UsersTabs active={tab}/>
  {searchParams.error&&<div role="alert"><ErrorBanner message={searchParams.error}/></div>}
  <p className="text-sm text-muted-foreground">{t(`help.${tab}`)}</p>
  {read.groups.length===0?<Card className="space-y-2 px-4 py-10 text-center"><p className="text-sm font-medium">{t(`empty.${tab}`)}</p><p className="text-sm text-muted-foreground">{t('emptyHelp')}</p>
   <Link href="/admin/personnel/duplicates" className="text-sm text-primary underline">{t('personnelDuplicates')}</Link></Card>
   :<>{read.groups.map(group=><GroupCard key={group.id} tab={tab} group={group}/>)}
    <Pager basePath={`/admin/users/duplicates/${tab}`} state={state} maxPageSize={100}/></>}
 </div>;
}
