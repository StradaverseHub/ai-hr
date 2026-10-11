import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { requireModule, isGroupAdmin } from '@/lib/authz';
import { PageHeader, Card, SectionHeader, ErrorBanner, btnPrimary } from '@/components/ui';
import { notificationEmailCategories, notificationEmailErrors } from '@/lib/notification-email-model';
import { readNotificationEmailPolicy, readNotificationEmailDeliveries } from '@/core/notification-email';
import { readNotificationEmailTransport } from '@/core/notification-email-delivery';
import { saveWorkflowEmailPolicy, retryWorkflowEmail } from './actions';
export default async function WorkflowEmailPage({searchParams}:{searchParams:Promise<{saved?:string;error?:string}>}) {
  const {s}=await scopedAdmin();await requireModule('notifications');
  const t=await getTranslations('workflowEmail'),query=await searchParams;
  const [policy,deliveries,relay]=await Promise.all([readNotificationEmailPolicy(s),readNotificationEmailDeliveries(s),readNotificationEmailTransport()]);
  const mayWrite=isGroupAdmin(s),enabled=new Set(policy.filter(p=>p.enabled).map(p=>p.category));
  return <div className="max-w-5xl space-y-6">
    <PageHeader title={t('title')} description={t('description')}/>
    <ErrorBanner message={query.error?t('error'):undefined}/>
    {query.saved==='1'&&<p role="status" className="text-sm">{t('saved')}</p>}
    <Card className="space-y-3 p-5"><p role="status" className="text-sm font-medium">{t(!relay?'upgradeRequired':relay.ready?'relayReady':'relayOff')}</p><p className="text-sm text-muted-foreground">{t('policyHelp')}</p></Card>
    <Card className="p-5"><SectionHeader title={t('policyTitle')}/>
      <form action={saveWorkflowEmailPolicy} className="space-y-4">
        <fieldset disabled={!mayWrite} className="grid gap-3 sm:grid-cols-2">
          {notificationEmailCategories.map(category=><label key={category} className="flex items-center gap-2 text-sm"><input type="checkbox" name="category" value={category} defaultChecked={enabled.has(category)}/>{t(`categories.${category}`)}</label>)}
        </fieldset>
        {mayWrite?<button type="submit" className={btnPrimary}>{t('savePolicy')}</button>:<p className="text-sm text-muted-foreground">{t('groupAdminHelp')}</p>}
      </form>
    </Card>
    <Card className="p-5"><SectionHeader title={t('deliveries')}/><p className="mb-4 text-sm text-muted-foreground">{t('deliveriesHelp')}</p>
      {!deliveries.length?<p className="text-sm text-muted-foreground">{t('noDeliveries')}</p>:<ul className="divide-y divide-border">{deliveries.map(d=><li key={d.id} className="space-y-3 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"><strong>{notificationEmailCategories.find(c=>c===d.category)?t(`categories.${d.category}`):t('category')}</strong><span>{t(`statuses.${d.status}`)}</span><span>{t('attempts')}: {d.attempts}</span><time dateTime={d.createdAt.toISOString()}>{d.createdAt.toISOString().slice(0,16).replace('T',' ')} UTC</time></div>
        {notificationEmailErrors.find(e=>e===d.error)&&<p className="text-sm text-muted-foreground">{t(`errors.${d.error}`)}</p>}
        {mayWrite&&d.status==='failed'&&<form action={retryWorkflowEmail} className="flex flex-wrap items-center gap-3"><input type="hidden" name="deliveryId" value={d.id}/><label className="flex items-start gap-2 text-sm"><input type="checkbox" name="acknowledged" value="true" required className="mt-1"/>{t('retryAck')}</label><button type="submit" className={btnPrimary}>{t('retry')}</button></form>}
      </li>)}</ul>}
    </Card>
  </div>;
}
