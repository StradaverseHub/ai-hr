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
    <div className="space-y-6">
      {/* df00b85f — Back points at ENTITLEMENTS, which is where this page is reached from and where the
          retired /admin/leave Summary listing now redirects. Aiming Back at the redirect stub would still
          arrive, but through a wasted hop. */}
      <PageHeader
        back={{ href: '/admin/leave/entitlements', label: t('backLabel') }}
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild>
            <a href="#leave-import-form">{t('uploadFile')}</a>
          </Button>
        }
      />
      <LeaveLedgerImport />
    </div>
  );
}
