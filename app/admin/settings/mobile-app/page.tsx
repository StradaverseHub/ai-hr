import { getLocale, getTranslations } from 'next-intl/server';
import { toDataURL } from 'qrcode';
import { requireAdmin } from '@/lib/authz';
import { HR_LOCAL_TZ } from '@/lib/hr-date';
import { readMobileSetupForAdmin } from '@/core/mobile-workplace-setup';
import { PageHeader } from '@/components/ui';
import { MobileSetupPanel, type MobileSetupPanelView } from './setup-panel';

/**
 * System Configuration › Mobile app (ADR-0161). Read-only: the platform issues each customer's signed
 * workplace setup, and this page shows it only after re-verifying it for this server and this tenant.
 */
export default async function MobileAppSetupPage() {
  const s = await requireAdmin();
  const [t, setup, locale] = await Promise.all([getTranslations('mobileAppSetup'), readMobileSetupForAdmin(s), getLocale()]);
  let view: MobileSetupPanelView = { state: 'unavailable' };
  if (setup.state === 'ready') {
    // A QR that cannot be drawn leaves the link itself, which is the same setup.
    const qr = await toDataURL(setup.link, { errorCorrectionLevel: 'M', margin: 4, width: 448 }).catch(() => null);
    const expires = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: HR_LOCAL_TZ }).format(new Date(setup.expiresAt * 1000));
    view = { state: 'ready', link: setup.link, qr, organization: setup.organization, name: setup.name, expires, expiresSoon: setup.expiresSoon };
  }
  return <div className="mx-auto max-w-3xl space-y-6">
    <PageHeader title={t('title')} description={t('description')}/>
    <MobileSetupPanel view={view}/>
  </div>;
}
