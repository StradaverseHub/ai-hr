import {getLocale,getTranslations} from 'next-intl/server';
import Link from 'next/link';
import {Badge,btnGhost,btnPrimary,inputCls} from '@/components/ui';
import type {AccountEmailDeliveryView} from '@/lib/account-email-model';
import {accountEmailPreview} from '@/lib/account-email-content';
import {internalSelected} from '@/lib/internal-auth/config';
import {emailDisplayClock,formatEmailTimestamp} from '@/lib/email-display-clock';
import {retryAccountEmailAction} from '@/app/(app)/admin/settings/notifications/actions';

type History={fromDate?:string;toDate?:string;hasMore:boolean;nextCursor?:string;before?:string};
export async function AccountEmailDeliveries({items,returnTo,history}:{items:AccountEmailDeliveryView[];returnTo:'/admin/settings/notifications'|'/admin/settings/email';history?:History}){
 const [t,auth,locale]=await Promise.all([getTranslations('accountEmail'),getTranslations('internalAuth'),getLocale()]);
 const clock=emailDisplayClock();
 const query=new URLSearchParams({...history?.fromDate?{fromDate:history.fromDate}:{},...history?.toDate?{toDate:history.toDate}:{}});
 const newest=returnTo+(query.size?'?'+query.toString():'');
 const older=new URLSearchParams(query);if(history?.nextCursor)older.set('before',history.nextCursor);
 return <section className="space-y-4" data-tour="account-email-deliveries" aria-labelledby="account-mail-history">
  <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="account-mail-history" className="text-lg font-semibold">{t('title')}</h2><span className="text-xs text-muted-foreground">{clock.label} · {clock.timeZone}</span></div>
  <p className="max-w-3xl text-sm text-muted-foreground">{t('help')}</p>
  {history&&<form action={returnTo} className="flex flex-wrap items-end gap-3"><label className="space-y-1 text-sm"><span className="block">{t('fromDate')}</span><input type="date" name="fromDate" defaultValue={history.fromDate} className={inputCls}/></label><label className="space-y-1 text-sm"><span className="block">{t('toDate')}</span><input type="date" name="toDate" defaultValue={history.toDate} className={inputCls}/></label><button className={btnGhost} type="submit">{t('filter')}</button><Link className={btnGhost} href={returnTo}>{t('clearFilters')}</Link></form>}
  {history&&<nav aria-label={t('pagination')} className="flex items-center justify-between gap-3"><span className="text-sm text-muted-foreground">{t('pageSize',{count:items.length})}</span><div className="flex gap-2">{history.before&&<Link href={newest} className={btnGhost}>{t('newest')}</Link>}{history.hasMore&&<Link href={returnTo+'?'+older.toString()} className={btnGhost}>{t('older')}</Link>}</div></nav>}
  {items.length===0?<p className="rounded-xl border border-border p-6 text-sm text-muted-foreground">{t(history?.fromDate||history?.toDate?'noMatchingEmails':'empty')}</p>:<div className="overflow-x-auto rounded-xl border border-border"><table className="w-full text-left text-sm"><thead className="bg-muted/40 text-muted-foreground"><tr>{(['message','recipient','status','dateTime','actions'] as const).map(key=><th key={key} scope="col" className="px-4 py-3 font-medium">{t(key)}</th>)}</tr></thead><tbody className="divide-y divide-border">{items.map(item=>{
   const preview=internalSelected()?accountEmailPreview(item.kind):{subject:t(`kinds.${item.kind}`),text:t('providerManagedPreview')};
   return <tr key={item.id} className="align-top"><td className="min-w-48 px-4 py-4"><p className="font-medium">{preview.subject}</p><p className="mt-1 text-xs text-muted-foreground">{t(`kinds.${item.kind}`)}</p></td><td data-email-recipient className="min-w-72 break-all px-4 py-4">{item.email}{item.account&&<p className="mt-1 text-xs text-muted-foreground">{auth('organization')}: {item.account.organization} · {auth('username')}: {item.account.username}</p>}</td><td className="px-4 py-4"><Badge variant={item.status==='failed'?'danger':item.status==='sent'?'success':'default'}>{t(`statuses.${item.status}`)}</Badge>{item.error&&<p className="mt-2 max-w-xs text-xs text-muted-foreground">{t(`errors.${item.error}`)}</p>}</td><td className="whitespace-nowrap px-4 py-4"><time dateTime={item.createdAt.toISOString()}>{formatEmailTimestamp(item.createdAt,clock,locale)}</time></td><td className="min-w-56 px-4 py-4">
    <details><summary className="cursor-pointer font-medium underline-offset-4 hover:underline">{t('viewEmail')}</summary><div className="mt-3 min-w-64 max-w-xl space-y-3 rounded-lg bg-muted/40 p-4"><p className="text-xs text-muted-foreground">{t('previewHelp')}</p><p className="font-medium">{preview.subject}</p><p className="whitespace-pre-wrap text-sm">{preview.text}</p><dl className="space-y-1 break-all text-xs text-muted-foreground"><div><dt className="inline">{t('reference')}: </dt><dd className="inline">{item.id}</dd></div><div><dt className="inline">{t('attempts')}: </dt><dd className="inline">{item.attempts}</dd></div></dl></div></details>
    {item.canRetry?<details className="mt-3"><summary className="cursor-pointer font-medium underline-offset-4 hover:underline">{t(item.status==='sent'?'resend':item.kind==='invitation'?'reissue':'retryRecovery')}</summary><form action={retryAccountEmailAction} className="mt-3 max-w-sm space-y-3"><input type="hidden" name="deliveryId" value={item.id}/><input type="hidden" name="kind" value={item.kind}/><input type="hidden" name="returnTo" value={returnTo}/><label className="flex items-start gap-2 text-sm"><input type="checkbox" name="acknowledged" value="true" required className="mt-1"/>{t(item.kind==='invitation'?'invitationAck':'recoveryAck')}</label><button type="submit" className={btnPrimary}>{t(item.status==='sent'?'resend':item.kind==='invitation'?'reissue':'retryRecovery')}</button></form></details>:item.resendUnavailable?<p className="mt-3 text-xs text-muted-foreground">{t(`resendUnavailable.${item.resendUnavailable}`)}</p>:null}
   </td></tr>;
  })}</tbody></table></div>}
 </section>;
}
