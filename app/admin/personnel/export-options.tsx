'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { ExportDownloadLink } from '@/components/export-download-link';

export function PersonnelExportOptions({ pageHref, allHref, hasPage, hasEmployees }: {
  pageHref: string;
  allHref: string;
  hasPage: boolean;
  hasEmployees: boolean;
}) {
  const t = useTranslations('people.list');
  const common = useTranslations('common');
  const optionClass = 'block rounded-md px-3 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-2';
  return <Dialog.Root>
    <Dialog.Trigger className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent">
      {t('exportXlsx')}
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/>
      <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(26rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-2 rounded-lg border border-border bg-card p-4 shadow-lg">
        <div className="flex items-center justify-between gap-3">
          <Dialog.Title className="text-base font-semibold">{t('exportTitle')}</Dialog.Title>
          <Dialog.Close className="rounded-md border border-border px-3 py-2 text-sm">{common('close')}</Dialog.Close>
        </div>
        {hasPage
          ? <ExportDownloadLink className={optionClass} href={pageHref}>{t('exportCurrentPage')}</ExportDownloadLink>
          : <p className="px-3 py-2 text-sm text-muted-foreground">{t('exportCurrentPage')} · {t('exportEmpty')}</p>}
        {hasEmployees
          ? <ExportDownloadLink className={optionClass} href={allHref}>{t('exportAllDetails')}</ExportDownloadLink>
          : <p className="px-3 py-2 text-sm text-muted-foreground">{t('exportAllDetails')} · {t('exportEmpty')}</p>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
