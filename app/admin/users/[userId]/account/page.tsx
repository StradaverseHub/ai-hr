import Link from 'next/link';
import type {ReactNode} from 'react';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {X} from 'lucide-react';
import {requireAdmin,isGroupAdmin} from '@/lib/authz';
import {readAccountOverview,readManagedAccount,readManagedAccountHistory,type AccountSummary} from '@/core/account-management';
import {readLastSignIns} from '@/core/last-sign-in';
import {readLoginMergeState} from '@/core/login-merge';
import {adminCompanies,listCompanies} from '@/core/read';
import {internalSelected} from '@/lib/internal-auth/config';
import {formatDmy,formatDmyTime} from '@/lib/date-display';
import {ActionButton} from '@/components/ui/action-button';
import {Field,RoleTag,btnGhost,inputCls} from '@/components/ui';
import {archiveUserAction,assignRoleAction,revokeRoleAction,setAssistantGrantAction} from '../../../actions';
import {ROLES} from '../../data';
import {ManualSubmit} from '../../manual-submit';
import {PasswordUnlock} from '../../password-unlock';
import {SecurityPageHeader} from '../../security-page';
import {AccountControls,type EditCommand} from './account-controls';
import {AuthenticatorControlDialog,ResetPasswordDialog} from './account-dialogs';
import {historyLabelKey,historyShowsActor} from './history-model';
import {LoginMergePanel} from './merge-panel';

/** Board 0735d1b7 — one page per login, opened by View/Edit on Security Center > Users: Account information, Account
 * actions (only those that fit the account's status), Edit account information (everything the old in-list Edit panel
 * held), the login merge facts and Security history. Every action keeps its existing owner, authority and audit; this
 * page adds no account command. A login whose internal credential the administrator may not manage (outside their
 * companies, or sign-in owned by another provider) still shows its summary and roles, with the reason the credential
 * actions are unavailable, instead of a missing page. */
type Tier='active'|'pending'|'inactive';
type Status=AccountSummary['status']|'archived'|'left';
export default async function AccountPage({params}:{params:Promise<{userId:string}>}){
 const ctx=await requireAdmin(),{userId}=await params;
 const overview=await readAccountOverview(ctx,userId).catch(()=>null);if(!overview)notFound();
 const groupAdmin=isGroupAdmin(ctx),internal=internalSelected();
 const [t,h,u,d,account,history,lastSignIns,mergeState,companies]=await Promise.all([
  getTranslations('accountManagement'),getTranslations('accountManagement.historyEvent'),getTranslations('admin.users'),getTranslations('admin.users.directory'),
  readManagedAccount(ctx,userId).catch(()=>null),
  readManagedAccountHistory(ctx,userId).catch(()=>null),
  readLastSignIns(ctx,[userId]),
  groupAdmin?readLoginMergeState(ctx,userId).catch(()=>null):Promise.resolve(null),
  groupAdmin?listCompanies(ctx):adminCompanies(ctx),
 ]);
 const mergedAway=Boolean(mergeState?.mergedInto);
 const status:Status=overview.archivedAt?'archived':overview.leftEmployment?'left':account?.status??'active';
 const tier:Tier=status==='preparing'?'pending':status==='active'?'active':'inactive';
 const name=overview.name??(account?.name||null)??u('unlinkedLogin',{id:overview.loginSuffix??''});
 const action=`${btnGhost.replace('h-9','min-h-11')} whitespace-normal`;
 const returnTo=`/admin/users/${overview.id}/account`;
 const companyName=(id:string|null,known:string|null)=>id?known??companies.find(c=>c.id===id)?.name??d('unknownCompany'):u('groupWide');
 const kind=overview.personId&&overview.hasEmployment?'internal':'external';
 const signedIn=lastSignIns[overview.id];
 // The account's own commands, by status (board 07c98c36 owners). Reactivate and expiry need an enabled credential.
 const accountCommands:EditCommand[]=!account?[]:status==='active'?['reset-email']:status==='suspended'?['reactivate']:[];
 const editCommands:EditCommand[]=!account||status==='archived'||status==='left'||status==='preparing'?[]:status==='active'?['suspend','expiry']:['expiry'];
 const unavailable=!account&&tier!=='inactive'?d(internal?'unavailableScope':'unavailableProvider'):null;
 const roleOptions:readonly string[]=groupAdmin?ROLES:['hr_admin'];
 const canEditRoles=status==='active'&&!mergedAway;
 const info:[string,ReactNode][]=[
  [d('employeeId'),overview.employeeCode??'—'],
  [t('username'),<span key="u" className="break-all font-mono text-sm">{account?.username??'—'}</span>],
  [d('email'),<span key="e" className="break-all">{account?.email??overview.email??'—'}</span>],
  ...(groupAdmin?[[d('userTypeColumn'),d(`userTypeValue.${kind}`)] as [string,ReactNode]]:[]),
  [d('accountStatus'),<span key="s">{d(`tier.${tier}`)}{status!==tier&&<span className="block text-sm text-muted-foreground">{t(`statusDetail.${status}`)}</span>}</span>],
  [d('lastLogin'),signedIn?formatDmyTime(signedIn):d('neverLoggedIn')],
  [t('activeUntil'),account?.activeUntil?formatDmy(account.activeUntil):'—'],
  [t('authenticator.requirement'),account?.exemptionUntil?t('pausedUntil',{until:formatDmyTime(new Date(account.exemptionUntil))}):account?t('authenticator.statusRequired'):'—'],
 ];
 return <div className="mx-auto w-full space-y-6"><SecurityPageHeader title={t('pageTitle',{name})}/>
 <section aria-labelledby="account-information" className="space-y-3"><h2 id="account-information" className="font-medium">{t('section.information')}</h2>
  <dl className="grid gap-4 rounded-lg border border-border p-5 sm:grid-cols-2 lg:grid-cols-4">{info.map(([label,value])=><div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="break-words font-medium">{value}</dd></div>)}
   {overview.profileEmploymentId&&<div className="sm:col-span-2 lg:col-span-4"><dt className="text-sm text-muted-foreground">{t('personnelProfile')}</dt><dd><Link href={`/admin/personnel/${overview.profileEmploymentId}`} className="text-primary underline underline-offset-4">{t('openPersonnelProfile')}</Link></dd></div>}
  </dl></section>
 <section aria-labelledby="account-actions" className="space-y-3"><h2 id="account-actions" className="font-medium">{t('section.actions')}</h2>
  {unavailable&&<p className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">{unavailable}</p>}
  {status==='active'&&account&&<div className="flex flex-wrap gap-2"><ResetPasswordDialog userId={userId} name={name} username={account.username} triggerClassName={action}/><AuthenticatorControlDialog userId={userId} name={name} exemptionUntil={account.exemptionUntil} triggerClassName={action}/></div>}
  {accountCommands.length>0&&<AccountControls userId={userId} allowed={accountCommands}/>}
  {status==='active'&&account?.lockedAt&&groupAdmin&&internal&&<PasswordUnlock userId={userId} lockedAt={account.lockedAt}/>}
  {status==='expired'&&<p className="text-sm text-muted-foreground">{t('expiredHelp')}</p>}
  {status==='preparing'&&<div className="space-y-2"><p className="text-sm text-muted-foreground">{t('preparingHelp')}</p>{groupAdmin&&<Link href="/admin/users/create" className={action}>{u('resumeActivation')}</Link>}</div>}
  {status==='left'&&<p className="rounded-lg border border-border bg-muted/40 p-4 text-sm">{u('archivedCauseLeft')} {t('leftHelp')}</p>}
  {status==='archived'&&!mergedAway&&<div className="space-y-2"><p className="text-sm text-muted-foreground">{u('archivedCauseManual')}</p>
   {groupAdmin&&<form action={archiveUserAction}><input type="hidden" name="appUserId" value={overview.id}/><input type="hidden" name="archived" value="false"/><input type="hidden" name="returnTo" value={returnTo}/><ManualSubmit variant="outline">{u('restore')}</ManualSubmit></form>}</div>}
  {status==='archived'&&mergedAway&&<p className="text-sm text-muted-foreground">{t('mergedHelp')}</p>}
 </section>
 <section aria-labelledby="account-edit" className="space-y-4"><h2 id="account-edit" className="font-medium">{t('section.edit')}</h2>
  <div className="space-y-3 rounded-lg border border-border p-5"><h3 className="text-sm font-medium">{d('assignedRoles')}</h3>
   {overview.roles.length?<ul className="space-y-2">{overview.roles.map(g=><li key={g.id} className="flex flex-wrap items-center gap-2 text-sm"><RoleTag role={g.role} label={u(`role.${g.role}`)}/><span>{companyName(g.companyId,g.company)}</span>
    {canEditRoles&&(groupAdmin||(g.role==='hr_admin'&&g.companyId))&&<form action={revokeRoleAction} className="ml-auto"><input type="hidden" name="roleAssignmentId" value={g.id}/><input type="hidden" name="returnTo" value={returnTo}/><ActionButton type="submit" className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-destructive hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label={d('removeRole',{role:u(`role.${g.role}`),scope:companyName(g.companyId,g.company)})}><X aria-hidden="true" className="size-4"/>{d('remove')}</ActionButton></form>}
   </li>)}</ul>:<p className="text-sm text-muted-foreground">{u('noRoles')}</p>}
   {canEditRoles&&<form data-tour="admin-assign" action={assignRoleAction} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
    <input type="hidden" name="appUserId" value={overview.id}/><input type="hidden" name="returnTo" value={returnTo}/>
    <Field label={u('inviteRole')}><select name="role" required defaultValue="" className={inputCls}><option value="" disabled>{d('chooseRole')}</option>{roleOptions.map(r=><option key={r} value={r}>{u(`role.${r}`)}</option>)}</select></Field>
    <Field label={u('inviteScope')}><select name="companyId" required={!groupAdmin} defaultValue="" className={inputCls}>{groupAdmin?<option value="">{u('groupWide')}</option>:<option value="" disabled>{d('chooseCompany')}</option>}{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    <ManualSubmit variant="outline">{u('addRole')}</ManualSubmit>
   </form>}
  </div>
  {editCommands.length>0&&!mergedAway&&<AccountControls userId={userId} allowed={editCommands}/>}
  {groupAdmin&&status!=='preparing'&&!mergedAway&&<div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-5">
   <form action={setAssistantGrantAction} className="flex flex-wrap items-center gap-3"><span className="text-sm text-muted-foreground">{d('assistant')}: {d(overview.assistantGranted?'enabled':'off')}</span><input type="hidden" name="appUserId" value={overview.id}/><input type="hidden" name="granted" value={overview.assistantGranted?'false':'true'}/><input type="hidden" name="returnTo" value={returnTo}/><ManualSubmit variant="outline">{u(overview.assistantGranted?'assistantRevoke':'assistantGrant')}</ManualSubmit></form>
   {status!=='archived'&&status!=='left'&&<form action={archiveUserAction}><input type="hidden" name="appUserId" value={overview.id}/><input type="hidden" name="archived" value="true"/><input type="hidden" name="returnTo" value={returnTo}/><ManualSubmit variant="outline">{u('archive')}</ManualSubmit></form>}
  </div>}
 </section>
 <LoginMergePanel userId={userId} state={mergeState}/>
 {history&&<section className="space-y-3" aria-labelledby="account-history"><h2 id="account-history" className="font-medium">{t('history')}</h2>{history.length?<ul className="divide-y divide-border rounded-lg border border-border">{history.map((event,index)=>{
  const until=event.expires_at&&/^\d+$/.test(event.expires_at)?formatDmyTime(new Date(Number(event.expires_at))):'';
  const text=h(historyLabelKey(event.event_type),{until});
  return <li key={index} className="space-y-1 p-4 text-sm"><p>{historyShowsActor(event.event_type)?h('byActor',{event:text,actor:event.actor_name??t('system')}):text}</p><p className="tabular-nums text-muted-foreground">{formatDmyTime(new Date(event.occurred_at))}</p>{event.reason&&<p>{event.reason}</p>}</li>;})}</ul>:<p className="text-sm text-muted-foreground">{t('noHistory')}</p>}</section>}
 </div>;
}
