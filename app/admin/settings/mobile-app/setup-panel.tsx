import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui';

/** Only what the page has already re-verified. The signed setup itself is never rendered or posted. */
export type MobileSetupPanelView =
  | { state: 'unavailable' }
  | { state: 'ready'; link: string; qr: string | null; organization: string; name: string; expires: string; expiresSoon: boolean };

export function MobileSetupPanel({ view }: { view: MobileSetupPanelView }) {
  const t = useTranslations('mobileAppSetup');
  if (view.state !== 'ready') {
    return <Card className="p-6"><p role="status" className="text-sm leading-relaxed text-muted-foreground">{t('unavailable')}</p></Card>;
  }
  return <Card className="space-y-6 p-6">
    {view.expiresSoon && <p role="alert" className="rounded-lg border border-border bg-muted/40 p-4 text-sm">{t('expiresSoon', { date: view.expires })}</p>}
    <dl className="grid gap-4 text-sm sm:grid-cols-3">
      <div><dt className="text-muted-foreground">{t('workplace')}</dt><dd className="mt-1 font-medium">{view.name}</dd></div>
      <div><dt className="text-muted-foreground">{t('organizationCode')}</dt><dd className="mt-1 font-medium">{view.organization}</dd></div>
      <div><dt className="text-muted-foreground">{t('validUntil')}</dt><dd className="mt-1 font-medium">{view.expires}</dd></div>
    </dl>
    {view.qr && <Image src={view.qr} alt={t('qrAlt')} width={224} height={224} unoptimized className="rounded-lg bg-white"/>}
    <div>
      <p className="text-sm font-medium">{t('linkLabel')}</p>
      <p className="mt-1 break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">{view.link}</p>
    </div>
    <div>
      <h2 className="text-base font-semibold">{t('stepsTitle')}</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t('stepInstall')}</li>
        <li>{t('stepOpen')}</li>
        <li>{t('stepConfirm')}</li>
      </ol>
    </div>
    <p className="text-xs text-muted-foreground">{t('noCredentials')}</p>
  </Card>;
}
