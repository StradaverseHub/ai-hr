import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { verifyTenantChain } from '@/core/audit-chain';
import { Card, PageHeader } from '@/components/ui';
import { PdpaErasureForm } from '@/components/pdpa-erasure-form';

/**
 * Data Privacy & Audit Integrity — the DPO surface for ADR-0030. Shows the tamper-evidence verdict over
 * the append-only event log and runs the retention-guarded PII erasure. Admin/DPO-only.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PrivacyPage({ searchParams }: { searchParams: Promise<{ subject?: string }> }) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.privacy');
  const { subject } = await searchParams;
  const initialEmploymentId = subject && UUID.test(subject) ? subject : '';
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
        {/*
          COVERAGE, shown SEPARATELY from the tamper verdict. `verifyTenantChain` can only inspect rows
          that carry chain columns, and an event appended while AUDIT_HASH_CHAIN_ENABLED was off carries
          none — so "intact, N events verified" was previously rendered over a log that might be mostly
          unprotected, with the unprotected part silently excluded from N.

          RENDERED ON THE POSITIONAL FIGURE, not on `unchained` (review r3). The predicate here used to
          be `checked > 0 && unchained > 0`, which is ALSO the permanent shape of every healthy tenant
          that predates the chain: 0074 defers the historical backfill by design, so pre-arming events
          stay unchained forever. That banner would have been on for those tenants for good, saying
          nothing an admin could act on, and an actual arm→disarm→re-arm hole would have looked
          identical. `unchainedInsideChain` counts only events recorded AFTER the chain started, which
          is a hole and nothing else.
        */}
        {chain.unchainedInsideChain > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {t('chainPartial', { n: chain.unchainedInsideChain })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('integrityNote')}</p>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">{t('erasureTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('erasureNote')}</p>
        {initialEmploymentId && <p className="text-xs text-muted-foreground">{t('prefilled')}</p>}
        <PdpaErasureForm initialEmploymentId={initialEmploymentId} />
      </Card>
    </div>
  );
}
