/** Board 0735d1b7 — Merge confirmation (group administrators only). Lists every account of the current group, marks the
 * Master Login Account, flags different Personnel Profiles and offers, unticked, only the roles, company access and AI
 * assistant access the other accounts hold and the master does not. The save (mergeLoginsAction) re-reads the group
 * under the Access lock and refuses a stale screen. A merge combines logins only; HR records are untouched. */
import Link from 'next/link';
import type {ReactNode} from 'react';
import {getTranslations} from 'next-intl/server';
import {requireGroupAdministration} from '@/lib/security-center-authz';
import {isGroupDigest,MERGE_MAX_ACCOUNTS,readLoginDuplicateGroup} from '@/core/login-duplicates';
import {MERGE_CONFIRMATION,readMergeOffer} from '@/core/login-merge';
import {ActionNavigateForm} from '@/components/action-navigate-form';
import {Card,ErrorBanner,Field,inputCls,tableWrapCls} from '@/components/ui';
import {SecurityPageHeader} from '../../security-page';
import {ManualSubmit} from '../../manual-submit';
import {AccountCells,AccountHead} from '../duplicates-view';
import {mergeLoginsAction} from '../actions';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function MergeLoginsPage({searchParams}:{searchParams:Promise<{tab?:string;group?:string;master?:string;error?:string}>}){
 const s=await requireGroupAdministration(),sp=await searchParams,t=await getTranslations('admin.users.duplicates'),users=await getTranslations('admin.users');
 const tab=sp.tab==='email'?'email':'identity',back=`/admin/users/duplicates/${tab}`;
 const group=isGroupDigest(sp.group)?await readLoginDuplicateGroup(s,sp.group):null;
 const shell=(body:ReactNode)=><div className="mx-auto w-full space-y-6"><SecurityPageHeader title={t('mergeTitle')}/>
  {sp.error&&<div role="alert"><ErrorBanner message={sp.error}/></div>}{body}</div>;
 if(!group)return shell(<Card className="space-y-3 p-5"><p className="text-sm">{t('groupGone')}</p><Link href={back} className="text-sm text-primary underline">{t('backToTab')}</Link></Card>);
 const requested=sp.master&&UUID.test(sp.master)?sp.master.toLowerCase():null;
 const master=group.lockedMasterId??group.accounts.find(a=>a.appUserId===requested)?.appUserId??null;
 if(!master||group.conflictingMasters||group.accounts.length>MERGE_MAX_ACCOUNTS)
  return shell(<Card className="space-y-3 p-5"><p className="text-sm">{t(group.conflictingMasters?'conflictingMasters':group.accounts.length>MERGE_MAX_ACCOUNTS?'tooMany':'chooseMasterFirst',{max:MERGE_MAX_ACCOUNTS})}</p>
   <Link href={back} className="text-sm text-primary underline">{t('backToTab')}</Link></Card>);
 const others=group.accounts.filter(a=>a.appUserId!==master);
 const offer=await readMergeOffer(s,master,others.map(a=>a.appUserId));
 const name=(id:string)=>{const a=group.accounts.find(x=>x.appUserId===id);return a?.name??a?.email??id;};
 const scope=(companyName:string|null)=>companyName??users('groupWide');
 const ordered=[group.accounts.find(a=>a.appUserId===master)!,...others];
 return shell(<ActionNavigateForm action={mergeLoginsAction} className="space-y-6">
  <input type="hidden" name="tab" value={tab}/><input type="hidden" name="group" value={group.digest}/><input type="hidden" name="basis" value={group.basis}/>
  <input type="hidden" name="master" value={master}/>{others.map(a=><input key={a.appUserId} type="hidden" name="merged" value={a.appUserId}/>)}
  <Card className="space-y-3 p-5">
   <h2 className="font-semibold">{t(`basis.${group.basis}`)} · {t('accountCount',{count:group.accounts.length})}</h2>
   <p className="text-sm text-muted-foreground">{t('mergeHelp')}</p>
   {group.differentProfiles&&<p role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">{t('differentProfilesMerge')}</p>}
   <div className={tableWrapCls}><table className="w-full min-w-[64rem] text-left text-sm"><AccountHead first="role"/>
    <tbody className="divide-y divide-border">{ordered.map(account=><tr key={account.appUserId} className={account.appUserId===master?'bg-primary/5':undefined}>
     <td className="px-3 py-2 align-top"><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${account.appUserId===master?'bg-primary/15 text-primary':'bg-muted text-muted-foreground'}`}>{t(account.appUserId===master?'masterBadge':'mergedBadge')}</span></td>
     <AccountCells account={account}/>
    </tr>)}</tbody></table></div>
  </Card>
  <Card className="space-y-3 p-5">
   <h2 className="font-semibold">{t('carryTitle')}</h2>
   <p className="text-sm text-muted-foreground">{t('carryHelp')}</p>
   {offer.roles.length===0&&!offer.assistantFrom?<p className="text-sm">{t('carryNothing')}</p>:<ul className="space-y-2">
    {offer.roles.map(grant=><li key={grant.roleAssignmentId}><label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" name="carryRole" value={grant.roleAssignmentId} className="mt-1 size-5"/>
     <span>{t('carryRole',{role:users(`role.${grant.role}`),scope:scope(grant.companyName),from:name(grant.appUserId)})}</span></label></li>)}
    {offer.assistantFrom&&<li><label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" name="carryAssistant" className="mt-1 size-5"/><span>{t('carryAssistant',{from:name(offer.assistantFrom)})}</span></label></li>}
   </ul>}
  </Card>
  <Card className="space-y-4 p-5">
   <p className="text-sm">{t('mergeEffect',{count:others.length})}</p>
   <Field label={t('reason')}><textarea name="reason" required minLength={5} maxLength={500} className={`${inputCls} min-h-20`}/></Field>
   <Field label={t('confirmationLabel',{word:MERGE_CONFIRMATION})}><input name="confirmation" required autoComplete="off" pattern={MERGE_CONFIRMATION} className={`${inputCls} min-h-11 max-w-xs`}/></Field>
   <div className="flex flex-wrap items-center gap-3"><ManualSubmit>{t('mergeSubmit',{count:others.length})}</ManualSubmit><Link href={back} className="text-sm text-primary underline">{t('cancel')}</Link></div>
  </Card>
 </ActionNavigateForm>);
}
