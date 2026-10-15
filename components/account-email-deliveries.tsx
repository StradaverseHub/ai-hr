import {getTranslations} from 'next-intl/server';
import {Card,SectionHeader,btnPrimary} from '@/components/ui';
import type {AccountEmailDeliveryView} from '@/lib/account-email-model';
import {retryAccountEmailAction} from '@/app/admin/settings/notifications/actions';

export async function AccountEmailDeliveries({items,returnTo}:{items:AccountEmailDeliveryView[];returnTo:'/admin/settings/notifications'|'/admin/settings/email'}){
 const t=await getTranslations('accountEmail');
 return <Card className="p-5" data-tour="account-email-deliveries">
  <SectionHeader title={t('title')}/><p className="mb-4 text-sm text-muted-foreground">{t('help')}</p>
  {items.length===0?<p className="text-sm text-muted-foreground">{t('empty')}</p>:<ul className="divide-y divide-border">{items.map(item=><li key={item.id} className="space-y-3 py-4">
   <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
    <strong>{t(`kinds.${item.kind}`)}</strong><span className="break-all">{item.email}</span><span>{t(`statuses.${item.status}`)}</span>
    <span>{t('attempts')}: {item.attempts}</span><time dateTime={item.createdAt.toISOString()}>{item.createdAt.toISOString().slice(0,16).replace('T',' ')} UTC</time>
   </div>
   {item.error?<p className="text-sm text-muted-foreground">{t(`errors.${item.error}`)}</p>:null}
   {item.canRetry?<form action={retryAccountEmailAction} className="flex flex-wrap items-center gap-3">
    <input type="hidden" name="deliveryId" value={item.id}/><input type="hidden" name="returnTo" value={returnTo}/>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="acknowledged" value="true" required className="mt-1"/>{t(item.kind==='invitation'?'invitationAck':'recoveryAck')}</label>
    <button type="submit" className={btnPrimary}>{t(item.kind==='invitation'?'reissue':'retryRecovery')}</button>
   </form>:null}
  </li>)}</ul>}
 </Card>;
}
