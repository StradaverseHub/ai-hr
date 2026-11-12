import {requireAdmin} from '@/lib/authz';
import {readManagedAccount,readManagedAccountHistory} from '@/core/account-management';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {formatDmy,formatDmyTime} from '@/lib/date-display';
import {AccountControls} from './account-controls';
import {AuthenticatorControlDialog,ResetPasswordDialog} from './account-dialogs';
import {historyLabelKey,historyShowsActor} from './history-model';
import {btnGhost} from '@/components/ui';
import {SecurityPageHeader} from '../../security-page';
export default async function AccountPage({params}:{params:Promise<{userId:string}>}){
 const ctx=await requireAdmin(),{userId}=await params,t=await getTranslations('accountManagement'),h=await getTranslations('accountManagement.historyEvent');
 const account=await readManagedAccount(ctx,userId).catch(()=>null);if(!account)notFound();
 const history=await readManagedAccountHistory(ctx,userId);
 const name=account.name??account.username,action=`${btnGhost.replace('h-9','min-h-11')} whitespace-normal`;
 return <div className="mx-auto w-full space-y-6"><SecurityPageHeader title={t('title')}/>
 <dl className="grid gap-4 rounded-lg border border-border p-5 sm:grid-cols-2 lg:grid-cols-4">
 <div><dt className="text-sm text-muted-foreground">{t('username')}</dt><dd className="break-all font-medium">{account.username}</dd></div>
 <div><dt className="text-sm text-muted-foreground">{t('email')}</dt><dd className="break-all">{account.email}</dd></div>
 <div><dt className="text-sm text-muted-foreground">{t('status')}</dt><dd>{t(account.status)}</dd></div>
 <div><dt className="text-sm text-muted-foreground">{t('activeUntil')}</dt><dd>{formatDmy(account.activeUntil)}</dd></div>
 <div className="sm:col-span-2 lg:col-span-4"><dt className="text-sm text-muted-foreground">{t('authenticator.requirement')}</dt><dd>{account.exemptionUntil?t('pausedUntil',{until:formatDmyTime(new Date(account.exemptionUntil))}):t('authenticator.statusRequired')}</dd></div></dl>
 {account.status==='active'&&<div className="flex flex-wrap gap-2"><ResetPasswordDialog userId={userId} name={name} username={account.username} triggerClassName={action}/><AuthenticatorControlDialog userId={userId} name={name} exemptionUntil={account.exemptionUntil} triggerClassName={action}/></div>}
 <AccountControls userId={userId}/>
 <section className="space-y-3"><h2 className="font-medium">{t('history')}</h2><ul className="divide-y divide-border rounded-lg border border-border">{history.map((event,index)=>{
  const until=event.expires_at&&/^\d+$/.test(event.expires_at)?formatDmyTime(new Date(Number(event.expires_at))):'';
  const text=h(historyLabelKey(event.event_type),{until});
  return <li key={index} className="space-y-1 p-4 text-sm"><p>{historyShowsActor(event.event_type)?h('byActor',{event:text,actor:event.actor_name??t('system')}):text}</p><p className="tabular-nums text-muted-foreground">{formatDmyTime(new Date(event.occurred_at))}</p>{event.reason&&<p>{event.reason}</p>}</li>;})}</ul></section></div>;
}
