import {requireAdmin} from '@/lib/authz';
import {readManagedAccount,readManagedAccountHistory} from '@/core/account-management';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {AccountControls} from './account-controls';
import {SecurityPageHeader} from '../../security-page';
export default async function AccountPage({params}:{params:Promise<{userId:string}>}){
 const ctx=await requireAdmin(),{userId}=await params,t=await getTranslations('accountManagement');
 const account=await readManagedAccount(ctx,userId).catch(()=>null);if(!account)notFound();
 return <div className="mx-auto w-full space-y-6"><SecurityPageHeader title={t('title')}/>
 <dl className="grid gap-4 rounded-lg border border-border p-5 sm:grid-cols-2 lg:grid-cols-4">
 <div><dt className="text-sm text-muted-foreground">{t('username')}</dt><dd className="break-all font-medium">{account.username}</dd></div>
 <div><dt className="text-sm text-muted-foreground">{t('email')}</dt><dd className="break-all">{account.email}</dd></div>
 <div><dt className="text-sm text-muted-foreground">{t('status')}</dt><dd>{t(account.status)}</dd></div>
 <div><dt className="text-sm text-muted-foreground">{t('activeUntil')}</dt><dd>{account.activeUntil??'—'}</dd></div></dl>
 <AccountControls userId={userId}/>
 <section className="space-y-3"><h2 className="font-medium">{t('history')}</h2><ul className="divide-y divide-border rounded-lg border border-border">{(await readManagedAccountHistory(ctx,userId)).map((event,index)=><li key={index} className="space-y-1 p-4 text-sm"><p>{event.event_type.startsWith('app-user.account-')?t(event.event_type.slice('app-user.account-'.length)):t('consumed')}</p><p className="text-muted-foreground">{new Date(event.occurred_at).toISOString()} · {event.actor_id??t('system')}</p>{event.reason&&<p>{event.reason}</p>}</li>)}</ul></section></div>;
}
