import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { Button, PageHeader } from '@/components/ui';
import { LeaveLedgerImport } from './leave-ledger-import';

export default async function LeaveImportPage() {
  const t = await getTranslations('admin.leave.import');
  // Trusted-HR-admin only. The importer supports multi-company files but rejects/flags rows outside the
  // acting admin's authority at preview time (analyze() authority check), so no company selector is needed.
  await requireAdmin();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/admin/leave', label: t('backLabel') }}
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild>
            <a href="#leave-import-form">{t('title')}</a>
          </Button>
        }
      />
      <LeaveLedgerImport />
    </div>
  );
}
