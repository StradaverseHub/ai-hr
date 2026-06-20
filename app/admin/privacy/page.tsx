import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { verifyTenantChain } from '@/core/audit-chain';
import { Card, PageHeader } from '@/components/ui';
import { PdpaErasureForm } from '@/components/pdpa-erasure-form';

/**
 * Data Privacy & Audit Integrity — the DPO surface for ADR-0030. Shows the tamper-evidence verdict over
 * the append-only event log and runs the retention-guarded PII erasure. Admin/DPO-only.
 */
export default async function PrivacyPage() {
  const s = await requireAdmin();
  const t = await getTranslations('admin.privacy');
  const chain = await verifyTenantChain(s);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />

      <Card className="space-y-2 p-4">
        <h2 className="text-sm font-semibold">{t('integrityTitle')}</h2>
        {chain.checked === 0 ? (
          <p className="text-sm text-muted-foreground">{t('chainDisabled')}</p>
        ) : chain.valid ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <span aria-hidden>●</span>
            {t('chainIntact', { n: chain.checked })}
          </p>
        ) : (
          <div className="space-y-1">
            <p className="text-sm font-medium text-rose-700 dark:text-rose-400">{t('chainBroken', { seq: chain.firstBadSeq ?? 0 })}</p>
            <ul className="list-disc pl-5 text-xs text-rose-700 dark:text-rose-400">
              {chain.issues.slice(0, 20).map((i, idx) => (
                <li key={idx}>{t('issueLine', { seq: i.chainSeq, problem: i.problem })}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('integrityNote')}</p>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">{t('erasureTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('erasureNote')}</p>
        <PdpaErasureForm />
      </Card>
    </div>
  );
}
